/**
 * vi.mock() emission, shared by every spec kind.
 *
 * This used to live inline in rscSpec, which meant client specs got no mocks at
 * all: a client component importing next/navigation, or calling a server action
 * through useActionState, blew up on import. constrainedSpec had the same hole —
 * a layout importing "server-only" failed at collection time.
 *
 * The two modes differ in exactly one way, and it matters:
 *
 *   rsc     — allowlist, then mock every remaining project-local import. A server
 *             component's whole job is fetching, so its imports are data access
 *             and stubbing them is the point.
 *   client  — allowlist ONLY. A client component's imports are mostly UI and
 *             helpers: mocking `cn` would strip every className off the markup,
 *             and mocking @/components/ui/button would replace the very button
 *             the interaction tests click. Anything not on the list is left real.
 */
import path from "node:path";
import type {
  ComponentInfo,
  DataDepInfo,
  ModuleImportInfo,
  NextjsApiRoute,
  PropValue,
  TodoRecorder,
} from "../types.ts";
import { type DepFieldResolver, fieldValueLiteral, mockLiteral } from "./mockValues.ts";
import { withRouteParams } from "./registry.ts";

export type MockMode = "client" | "rsc";

export interface EmittedMocks {
  /** vi.mock(...) statements, in import source order. */
  statements: string[];
  /** Specifiers actually mocked — for the run report. */
  mocked: string[];
}

/**
 * Modules whose real implementation must survive: React itself, asset imports,
 * and the Next.js surface that is not on the allowlist below.
 *
 * Only consulted in "rsc" mode — "client" mode reaches nothing past the
 * allowlist, so this regex never has to grow to protect it.
 */
const MOCK_SKIP =
  /^(react($|\/)|next\/(?!navigation|headers|cache)|.*\.(css|scss|sass|less|svg|png|jpe?g|gif|woff2?)$)/;

/**
 * Bindings whose modules must stay real even in "rsc" mode: pure, synchronous,
 * class-string producers. Mocking them strips every className off the markup —
 * or, with the generic async stub, injects a Promise where a string belongs and
 * className renders as "[object Promise]".
 *
 * Membership is checked against the module-side (IMPORTED) name, so
 * `import { cn as cx }` is still recognised. The decision is made per MODULE,
 * merging every import statement of the same specifier: collectModuleImports
 * emits one ModuleImportInfo per statement, and exempting one statement while
 * another statement's mock replaces the whole module factory would erase the
 * very binding the exemption promised to keep.
 *
 *   every imported binding pure → the module is not mocked at all;
 *   mixed pure + data           → the module IS mocked, and each pure binding
 *                                 gets a synchronous join stub (under the
 *                                 module-side export name) beside the data stubs.
 *
 * Names the render graph adds (ModuleImportInfo.mergedNames) are COVERED by a
 * forced factory but never FORCE one: the mock decision is evidence of what
 * this render needs, and no file relying on the mock named them.
 */
const PURE_UTILITY_BINDINGS = new Set(["cn", "clsx", "cva", "twMerge", "tw"]);

/**
 * A `use*`-shaped binding is a React hook, and a hook's contract is a VALUE:
 * `await 5 === 5`, so a sync mock under an `await` still works, while `.map`
 * on a Promise is a crash. Whatever `awaited` says, a hook-shaped binding is
 * therefore never mocked async. This is the general rule the hand-written
 * known-sync factories already encode one specifier at a time —
 * navigationMock's usePathname/useRouter/useParams, swrMock's useSWR reads,
 * all synchronous. A hook that genuinely returns a Promise is a DIFFERENT
 * contract; it must be stated by the source's own annotation, not guessed
 * from a call site that happens to write `await`.
 */
export function isHookContract(name: string): boolean {
  return /^use[A-Z]/.test(name);
}

/**
 * Class-string producer stand-in for a pure binding inside a mocked module:
 * synchronous and string-valued, because the component drops its result
 * straight into className — vi.fn(async …) there renders "[object Promise]".
 */
const PURE_UTILITY_STUB = `vi.fn((...args: unknown[]) => args.filter(Boolean).join(" "))`;

interface MergedBinding {
  /** Module-side export name — `cn` for `import { cn as cx }`. The returns map
   * is keyed by it, since that is what the declaration is named. */
  moduleName?: string;
  local: string;
  isDefault: boolean;
  pure: boolean;
  /** The declaration is a module-side data constant (ModuleImportInfo
   * .dataExports): a value read, never a dep to stub. */
  data: boolean;
  /** The name only exists because the render graph imports it — no file that
   * relies on the MOCK named it. It must be COVERED by the factory (a mocked
   * module serves every importer), but it must never FORCE the mock: lib/utils,
   * pure for the unit's `{ cn }`, gained a graph-only `timeAgo` and got mocked
   * `async () => ({})` — a promise rendered as a child, an empty container. */
  graphOnly?: boolean;
}

interface MergedModule {
  /** Original specifier texts (dataDeps records these, not the re-based one). */
  specifiers: Set<string>;
  bindings: MergedBinding[];
  /** Module-side export name → its own return annotation, merged across the
   * declarations that import from this module. See ModuleImportInfo. */
  returns: Map<string, { value: PropValue; sync: boolean }>;
  /**
   * The specifier names an installed package rather than a project file:
   * resolved into node_modules, or bare and unresolvable (the fixture's
   * zustand is not installed at generation time — a package the resolver
   * cannot reach is still a package, not an alias). Alias-shaped specifiers
   * ("@/…", "~/", "#…") are local even when unresolvable, so a resolution
   * regression keeps the old behaviour instead of silently un-mocking data.
   */
  pkg: boolean;
}

/** See MergedModule.pkg. */
function looksLikePackage(specifier: string, resolvedPath: string | undefined): boolean {
  if (resolvedPath) return resolvedPath.includes("node_modules");
  if (/^[./]/.test(specifier)) return false;
  if (/^(@\/|~\/|#)/.test(specifier)) return false;
  return true;
}

/** Default and namespace entries have no module-side name; the local stands in. */
function membershipName(mi: ModuleImportInfo, index: number): string {
  return mi.importedNames?.[index] ?? mi.names[index] ?? "";
}

function mergeInto(groups: Map<string, MergedModule>, mi: ModuleImportInfo, key: string): void {
  let group = groups.get(key);
  if (!group) {
    group = { specifiers: new Set(), bindings: [], returns: new Map(), pkg: false };
    groups.set(key, group);
  }
  group.specifiers.add(mi.specifier);
  group.pkg = group.pkg || looksLikePackage(mi.specifier, mi.resolvedPath);
  for (const [name, r] of Object.entries(mi.importedReturns ?? {})) group.returns.set(name, r);
  mi.names.forEach((local, i) => {
    // A `type` specifier is erased at compile time, so the module does not
    // export that name at RUNTIME. It can neither force a mock — every shadcn
    // `ui/*` module's `import { cva, type VariantProps }` did, and the factory
    // that follows replaced `cva` with a class-string stub, which turned the
    // app's own `const buttonVariants = cva(…)` into a string — nor be a factory
    // entry: `VariantProps: vi.fn(…)` bound a name no importer can call.
    if (mi.typeOnlyNames?.includes(local)) return;
    const moduleName = membershipName(mi, i);
    const isDefault = mi.hasDefault && i === 0;
    const graphOnly = !isDefault && mi.mergedNames?.includes(local) === true;
    // Dedup on the MODULE-side name: the factory keys on it, and two files
    // importing { toast } and { toast as t } must produce ONE `toast:` entry,
    // not two — a duplicate key in the factory object is at best noise. A
    // default is NOT that binding: its module-side name is only the local
    // text, and `default:` coexists with a same-named export.
    const existing =
      group.bindings.find(
        (b) =>
          !isDefault &&
          !b.isDefault &&
          (b.moduleName ?? b.local) === moduleName &&
          (!b.graphOnly || graphOnly),
      ) ??
      (!graphOnly ? group.bindings.find((b) => b.local === local) : undefined) ??
      (graphOnly
        ? group.bindings.find((b) => b.local === local && (b.moduleName ?? b.local) === moduleName)
        : undefined);
    if (existing) return;
    group.bindings.push({
      local,
      moduleName,
      isDefault,
      pure: PURE_UTILITY_BINDINGS.has(membershipName(mi, i)) || mi.isPureModule === true,
      data: mi.dataExports?.includes(membershipName(mi, i)) ?? false,
      graphOnly,
    });
  });
}

/**
 * `specDir` is the absolute directory the spec will be written to. It matters:
 * vitest resolves a relative vi.mock() specifier against the file containing the
 * call, not against the component under test. Emitting the component's own
 * "./actions" verbatim would mock a sibling of the SPEC — usually a module that
 * does not exist, so the mock silently does nothing and the real module loads.
 * Colocated specs happen to be immune; specs under flawless/unit/ are not.
 */
/**
 * OpenAPI response example for a fetch shape, when the route table has one.
 * Shared by the mock emitter (Path B of the dep-return inference) and the
 * fetch-spec fixtures in templates.ts — one join, one normalisation.
 */
export function apiRouteFixture(
  urlTemplate: string,
  method: string,
  apiRoutes: NextjsApiRoute[] | undefined,
): unknown {
  if (!apiRoutes) return undefined;
  const wanted = normalizeApiPath(urlTemplate);
  for (const r of apiRoutes) {
    if (normalizeApiPath(r.path) !== wanted) continue;
    const body = r.responseBodies?.[method.toUpperCase()] ?? r.responseBodies?.GET;
    if (body !== undefined) return body;
  }
  return undefined;
}

/** Compare /api/x/{id}/y, /api/x/:id/y and /api/x/:buildingId/y as the same shape. */
export function normalizeApiPath(p: string): string {
  return p
    .replace(/\{[^}]+\}/g, ":_")
    .replace(/:[A-Za-z0-9_]+/g, ":_")
    .replace(/\/+$/, "");
}

// Source interpolated into an emitted block comment: a star-slash inside it
// (a literal * in a fetch path, say) would close the comment early and leave
// the tail as broken code in the generated spec.
function commentSafe(text: string): string {
  return text.split("*/").join("* /");
}

/**
 * The fixture an uncertain/unknown dep still gets: the annotation-derived
 * value the analyser stored, or the OpenAPI example joined here — emit time
 * is where the route table lives. Undefined means the dep really is a gap:
 * the {} stub, the TODO and the RSC skip escape all key off that.
 */
export function inferredDepReturn(
  dep: DataDepInfo,
  apiRoutes?: NextjsApiRoute[],
): { value: PropValue; provenance: "annotation" | "openapi" } | undefined {
  if (dep.inferredReturn) return dep.inferredReturn;
  if (dep.wrapsFetch) {
    const body = apiRouteFixture(dep.wrapsFetch.path, dep.wrapsFetch.method, apiRoutes);
    if (body !== undefined) return { provenance: "openapi", value: body as PropValue };
  }
  return undefined;
}

export function emitModuleMocks(
  info: ComponentInfo,
  mode: MockMode,
  specDir?: string,
  todo?: TodoRecorder,
  apiRoutes?: NextjsApiRoute[],
): EmittedMocks {
  const statements: string[] = [];
  const mocked: string[] = [];
  const seen = new Set<string>();

  const push = (mi: ModuleImportInfo, make: (spec: string) => string): void => {
    const spec = mockSpecifier(mi, specDir);
    if (seen.has(spec)) return;
    seen.add(spec);
    statements.push(make(spec));
    mocked.push(spec);
  };

  // RSC specs render their descendants, which import their own data modules;
  // the tree's imports join the unit's (deduped by specifier at analyse time,
  // and again through `seen`/`mergeInto` here). Client mode renders no async
  // server tree, so it stays on the unit's imports alone.
  const mockInputs =
    mode === "rsc"
      ? [...(info.moduleImports ?? []), ...(info.treeImports ?? [])]
      : (info.moduleImports ?? []);

  // Merge the data-path statements per module BEFORE deciding anything: the
  // pure-utility exemption and the mock factory must both see every binding the
  // component imports from a module, however many statements deliver them.
  const dataGroups = new Map<string, MergedModule>();
  if (mode === "rsc") {
    for (const mi of mockInputs) {
      if (!reachesDataPath(mi)) continue;
      // EVERY name a data-path statement imports is a module-side data
      // constant → the module stays out of the groups, and the mock loop
      // below passes it by entirely. The statement never stubs anything,
      // and a factory replacement for it would starve transitive importers
      // (json-ld reading SITE_INFO off a mock that only knew
      // SOURCE_CODE_GITHUB_REPO — the chanhdai collection wall).
      if (
        mi.dataExports !== undefined &&
        mi.names.length > 0 &&
        mi.names.every((_, i) => mi.dataExports?.includes(membershipName(mi, i)))
      ) {
        continue;
      }
      mergeInto(dataGroups, mi, mockSpecifier(mi, specDir));
    }
  }

  for (const mi of mockInputs) {
    if (mi.isTypeOnly) continue;

    // --- allowlist, evaluated before the kind/MOCK_SKIP gates ------------------
    // next/link is kind:"component" and is matched by MOCK_SKIP, so it would be
    // excluded twice over if these ran in the other order.
    if (mi.specifier === "server-only") {
      push(mi, () => `vi.mock("server-only", () => ({}));`);
      continue;
    }
    if (mi.specifier === "next/navigation") {
      push(mi, navigationMock);
      continue;
    }
    if (mi.specifier === "next/headers") {
      push(mi, headersMock);
      continue;
    }
    if (mi.specifier === "next/link") {
      push(mi, (spec) => linkPassthroughMock(mi, spec));
      continue;
    }
    if (mi.specifier === "swr") {
      push(mi, () => swrMock());
      continue;
    }
    if (mi.specifier.startsWith("next/font/")) {
      push(mi, (spec) => fontMock(mi, spec));
      continue;
    }
    if (mi.isServerAction) {
      push(mi, (spec) => serverActionMock(mi, spec, todo));
      continue;
    }

    // --- everything else: server specs only -----------------------------------
    if (mode === "client") continue;
    // An async server CHILD cannot mount here: React's client renderer refuses
    // an async function component, and a page containing one renders an empty
    // container — every assertion after that is against nothing. The child is
    // a data-fetching unit with its own spec, so this spec stubs it to null
    // rather than claiming anything about its markup. Only when EVERY name
    // imported from the module is such a component — a module mixing async and
    // sync exports would need a factory half stub, half real, which lies about
    // one of the halves.
    if (mi.kind === "component" && allAsyncComponents(mi)) {
      push(mi, (spec) => asyncChildStubMock(mi, spec));
      continue;
    }
    if (!reachesDataPath(mi)) continue;
    const group = dataGroups.get(mockSpecifier(mi, specDir));
    if (!group) continue;
    // Pure/data-only module → keep it real. GRAPH-ONLY names do not count:
    // the exemption asks "does any file that renders NEED this mocked?" —
    // lib/utils (pure `cn` for the unit) gained a graph-only `timeAgo` and
    // was mocked `async () => ({})`; a promise rendered as a child suspends
    // the tree and the spec asserted against an empty container.
    if (group.bindings.length > 0 && group.bindings.every((b) => b.pure || b.data || b.graphOnly))
      continue;
    // Module-factory completeness, guard half (defect #4, mechanism 2). A
    // vi.mock factory REPLACES the whole module; for a package the real
    // export surface cannot be read (node_modules is never parsed), so the
    // factory can only name what analysed files import — and a name no
    // analysed file CALLS is a pure guess. When EVERY binding is such a
    // guess, the honest factory is the one never emitted: leave the package
    // real. The dogfood's hand-verified green fix was exactly "zustand left
    // real"; a curried sync factory like `createStore<AppState>()((set) =>
    // …)` cannot survive any stub the emitter could guess, and the fixture
    // proved it: `createStore(...) is not a function` was the async `{}`
    // stub being CALLED, not a dropped export.
    if (group.pkg && !moduleHasEvidence(group, info)) continue;
    push(mi, (spec) => dataModuleMock(group, info, spec, todo, apiRoutes));
  }

  return { statements, mocked };
}

/**
 * Roots whose deps cannot be mocked coherently: bare + dotted callees mixed
 * on one binding, or one dotted path prefixing another. The emitter falls
 * back to the honest {} for these — and the RSC skip escape must fire too,
 * or the runtime crash on the missing member reads as an application
 * failure (FR-014's exact failure mode, confined to the conflict shapes).
 * One predicate, consumed by dataModuleMock AND uncertainEscape, so the
 * fallback and the escape can never disagree.
 */
export function dottedMockConflicts(deps: DataDepInfo[]): boolean {
  const byRoot = new Map<string, DataDepInfo[]>();
  for (const d of deps) {
    const group = byRoot.get(d.calleeRoot) ?? [];
    group.push(d);
    byRoot.set(d.calleeRoot, group);
  }
  for (const group of byRoot.values()) {
    const dotted = group.filter((d) => d.callee !== d.calleeRoot);
    if (dotted.length === 0) continue;
    if (dotted.length !== group.length) return true;
    if (dottedDepTree(dotted, () => "conflict-probe") === undefined) return true;
  }
  return false;
}

/**
 * Nested object source for dotted deps sharing one root binding:
 * db.query.users.findMany + db.query.posts.findFirst →
 * `{ query: { users: { findMany: <stub> }, posts: { findFirst: <stub> } } }`.
 * Undefined on any conflict — one path prefixing another, or two deps
 * claiming the same leaf differently — so the caller can fall back honestly.
 */
function dottedDepTree(
  deps: DataDepInfo[],
  stubOf: (dep: DataDepInfo, seed: string) => string,
): string | undefined {
  interface TreeNode {
    children: Map<string, TreeNode>;
    leaf?: string;
  }
  const root: TreeNode = { children: new Map() };
  for (const dep of deps) {
    const segs = dep.callee.split(".").slice(1);
    let cur = root;
    for (const [i, seg] of segs.entries()) {
      if (cur.leaf !== undefined) return undefined;
      const last = i === segs.length - 1;
      let next = cur.children.get(seg);
      if (!next) {
        next = { children: new Map() };
        cur.children.set(seg, next);
      }
      if (last) {
        if (next.children.size > 0) return undefined;
        // Two deps on the same full path (the call appears twice): the first
        // stub stands — same callee, same shape source.
        next.leaf ??= stubOf(dep, seg);
      }
      cur = next;
    }
  }
  const print = (node: TreeNode): string => {
    if (node.leaf !== undefined) return node.leaf;
    const entries = [...node.children.entries()].map(([k, v]) => `${k}: ${print(v)}`);
    return `{ ${entries.join(", ")} }`;
  };
  return print(root);
}

/**
 * The rsc-mode gates ahead of the data-module mock, shared by the merge
 * pre-pass — grouping an allowlisted statement here would double-mock it.
 */
/** Every name this declaration imports resolves to an async function. */
function allAsyncComponents(mi: ModuleImportInfo): boolean {
  const asyncSet = new Set(mi.asyncComponents ?? []);
  if (asyncSet.size === 0 || mi.names.length === 0) return false;
  return mi.names.every((_, i) => {
    const moduleName = mi.hasDefault && i === 0 ? "default" : membershipName(mi, i);
    return asyncSet.has(moduleName);
  });
}

/**
 * Replaces a module whose every imported name is an async server component
 * with null-rendering stubs. `() => null` and not a marker element: the page
 * spec claims nothing about the child, and any markup here could collide with
 * text the page's own assertions look for.
 */
function asyncChildStubMock(mi: ModuleImportInfo, spec: string): string {
  const entries = mi.names.map((_, i) => {
    const key = mi.hasDefault && i === 0 ? "default" : membershipName(mi, i);
    return `${key}: () => null`;
  });
  return `// ${mi.names.join(", ")}: async server child(ren) with their own specs — a client render cannot await them.
vi.mock(${JSON.stringify(spec)}, () => ({ ${entries.join(", ")} }));`;
}

function reachesDataPath(mi: ModuleImportInfo): boolean {
  if (mi.isTypeOnly || mi.isServerAction) return false;
  if (
    ["server-only", "next/navigation", "next/headers", "next/link"].includes(mi.specifier) ||
    mi.specifier.startsWith("next/font/")
  ) {
    return false;
  }
  return mi.kind === "value" && !MOCK_SKIP.test(mi.specifier);
}

/**
 * Bare and aliased specifiers ("next/link", "@/lib/dal") mean the same thing from
 * any file, so they pass through. Only a relative specifier has to be re-based
 * onto the spec's own directory.
 */
export function mockSpecifier(mi: ModuleImportInfo, specDir: string | undefined): string {
  if (!mi.specifier.startsWith(".")) return mi.specifier;
  if (!specDir || !mi.resolvedPath) return mi.specifier;
  let rel = path.relative(specDir, mi.resolvedPath).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.replace(/\.(tsx|ts|jsx|js)$/, "");
}

/**
 * swr@2.5 beta reads its cache with React 19's use(). The root layout's
 * preload() puts a LIVE Promise into the cache; a client badge's first
 * read hits it, use() throws the thenable, and renderToStaticMarkup —
 * which cannot await one — dies with "A component suspended while
 * responding to synchronous input" (aurorascharff RootLayout). A
 * deterministic sync surface fixes it for good: config is a pass-
 * through, preload does nothing, and reads answer empty-cache shapes
 * instead of thenables. The factory lists the module's public surface:
 * a missing export is a loud import-time error, so the superset is the
 * safe direction.
 */
function swrMock(): string {
  const read =
    "vi.fn(() => ({ data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() }))";
  return `vi.mock("swr", () => ({
  default: ${read},
  useSWR: ${read},
  SWRConfig: (props: { children?: unknown }) => props.children ?? null,
  SWRProvider: (props: { children?: unknown }) => props.children ?? null,
  preload: vi.fn(),
  mutate: vi.fn(),
  useSWRConfig: vi.fn(() => ({ mutate: vi.fn(), revalidate: vi.fn() })),
}));`;
}

function navigationMock(): string {
  // `routerMock` is hoisted, and it has to be.
  //
  // useRouter used to return a FRESH object with FRESH spies on every call, so
  // there was no handle to assert against: `router.push("/x")` inside a handler
  // wrote to a spy the spec could never see. A navigation is one of the few
  // things a click provably does, and it was unobservable.
  //
  // vi.hoisted is the only way to share a value INTO the factory: vi.mock
  // factories are lifted above every import in the module, so a plain const
  // declared here is still in the temporal dead zone when the factory runs.
  return `const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("notFound() called"); }),
  // These abort rendering in Next; a plain vi.fn() would let a guarded
  // component run straight past its own guard and crash on the data it guards.
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  permanentRedirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  usePathname: vi.fn(() => "/"),
  useRouter: vi.fn(() => routerMock),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
  // Layout-segment hooks: a component that imports next/navigation gets this
  // per-spec mock INSTEAD of the global one, so every hook the global factory
  // exports has to be here too — a missing name is a "[vitest] No export"
  // error at import time.
  useSelectedLayoutSegment: vi.fn(() => null),
  useSelectedLayoutSegments: vi.fn(() => []),
}));`;
}

function headersMock(): string {
  return `vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  // The real cookie jar is Map-like AND has get/getAll/set/delete: which one a
  // page calls is the page's choice ((await cookies()).has(SLOW) in
  // ProfileFeed), so the stub answers every spelling.
  cookies: vi.fn(async () => ({
    get: vi.fn(() => undefined),
    getAll: vi.fn(() => []),
    has: vi.fn(() => false),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));`;
}

/**
 * The async factory form is required, not stylistic: vi.mock factories are
 * hoisted above every import in the module, so a synchronous factory that closed
 * over a top-level `createElement` binding would throw
 * "Cannot access 'createElement' before initialization".
 */
function linkPassthroughMock(mi: ModuleImportInfo, spec: string): string {
  // Named exports ride along: the real hooks read the same AppRouterContext,
  // and a name the file imports but the factory omits is a "[vitest] No
  // export" error the first time the component calls it (useLinkStatus in
  // nav-link.tsx). Keys are module-side names — aliasing is the importer's.
  const keys = mi.importedNames ?? mi.names;
  const named = keys
    .filter((_, i) => !(mi.hasDefault && i === 0))
    .map((n) =>
      n === "useLinkStatus" ? `useLinkStatus: vi.fn(() => ({ pending: false }))` : `${n}: vi.fn()`,
    );
  return `vi.mock(${JSON.stringify(spec)}, async () => {
  // The real <Link> reads Next's AppRouterContext, which jsdom has no way to
  // provide. A passthrough keeps the anchor, its href and its text queryable.
  const { createElement } = await import("react");
  return {
    default: (props: { href?: string | { pathname?: string }; children?: unknown }) => {
      const { href, children, ...rest } = props;
      const to = typeof href === "string" ? href : (href?.pathname ?? "#");
      return createElement("a", { ...rest, href: to } as never, children as never);
    },${named.length > 0 ? `\n    ${named.join(", ")},` : ""}
  };
});`;
}

/**
 * next/font loaders run at module scope and reach for the filesystem, so the
 * import throws before any test body runs. The stub is keyed on the names the
 * file actually imports rather than a catch-all Proxy — we know them exactly.
 */
function fontMock(mi: ModuleImportInfo, spec: string): string {
  const names = mi.hasDefault ? mi.names.slice(1) : mi.names;
  const loader = `() => ({ className: "", variable: "", style: { fontFamily: "" } })`;
  const entries = names.map((n) => `${n}: ${loader}`);
  if (mi.hasDefault) entries.unshift(`default: ${loader}`);
  if (entries.length === 0) return `vi.mock(${JSON.stringify(spec)}, () => ({}));`;
  return `vi.mock(${JSON.stringify(spec)}, () => ({ ${entries.join(", ")} }));`;
}

/**
 * A "use server" module. An unresolved name's stub resolves to {} rather than
 * undefined because these land in useActionState, whose state is read as
 * `state && "error" in state` — undefined would crash the first render.
 * vi.fn() is a real function, so `action.bind(null, id)` in the JSX still
 * works. A name the analyser resolved (serverActionReturns) gets the action's
 * real literal return instead of the {} stand-in.
 *
 * The factory is keyed by MODULE-side names, never the local aliases: the
 * module exports "createPost" whether the component called it that or
 * "saveIt" (or reached it through `import * as actions`), and a factory
 * keyed by the local binding exports a name the module never had while
 * leaving the real one unmocked.
 */
function serverActionMock(mi: ModuleImportInfo, spec: string, todo?: TodoRecorder): string {
  if (mi.names.length === 0) return `vi.mock(${JSON.stringify(spec)}, () => ({}));`;
  const returns = mi.serverActionReturns ?? {};
  const stub = (moduleName: string): string => {
    const v = returns[moduleName];
    return v === undefined
      ? "vi.fn(async () => ({}))"
      : `vi.fn(async () => (${JSON.stringify(v)}))`;
  };
  // The factory replaces the WHOLE module, so it binds the module's whole
  // export surface: the component's own imports and every sibling a
  // transitive importer might pull. The imported names are only the fallback
  // for when the export list could not be read.
  const namedIndices = mi.names.map((_, i) => i).filter((i) => !(mi.hasDefault && i === 0));
  const surface = mi.serverActionExports?.length
    ? mi.serverActionExports
    : namedIndices.map((i) => membershipName(mi, i));
  const exportNames = [...new Set(surface)].filter((n) => n !== "default");
  const entries = exportNames.map((n) => `${n}: ${stub(n)}`);
  const wantsDefault = mi.hasDefault || (mi.serverActionExports ?? []).includes("default");
  if (wantsDefault) entries.unshift(`default: ${stub("default")}`);
  // The TODO retires only when EVERY export of the module resolved (and the
  // surface is non-empty: exportedNames cannot see `export * from` barrels,
  // and an empty list proves nothing resolved, not that everything did).
  const required = [...exportNames, ...(wantsDefault ? ["default"] : [])];
  if (required.length > 0 && required.every((n) => returns[n] !== undefined)) {
    return `vi.mock(${JSON.stringify(spec)}, () => ({ ${entries.join(", ")} }));`;
  }
  todo?.("server-action-stub");
  return `// TODO(flawless): server action stubbed — give it a realistic return value.
vi.mock(${JSON.stringify(spec)}, () => ({ ${entries.join(", ")} }));`;
}

/**
 * Does any binding of this module have EVIDENCE — a call site the analyser
 * saw (any channel: the unit's awaited deps, the render tree's, or a sync
 * unit's mockDeps) or a return annotation on the declaration? A package
 * module with none is mocked on pure guesswork, which is the state where
 * leaving it real is the honest answer (see the emitMocks loop).
 */
function moduleHasEvidence(group: MergedModule, info: ComponentInfo): boolean {
  const allDeps = [
    ...(info.dataDeps ?? []),
    ...(info.treeDataDeps ?? []),
    ...(info.mockDeps ?? []),
  ];
  return group.bindings.some(
    (b) =>
      allDeps.some((d) => d.calleeRoot === b.local) || group.returns.has(b.moduleName ?? b.local),
  );
}

/**
 * A project-local module a server component reads data from — every import
 * statement of it merged, so the factory covers every binding at once.
 */
function dataModuleMock(
  group: MergedModule,
  info: ComponentInfo,
  spec: string,
  todo?: TodoRecorder,
  apiRoutes?: NextjsApiRoute[],
): string {
  if (group.bindings.length === 0) return `vi.mock(${JSON.stringify(spec)}, () => ({}));`;

  // The descendants' call-site evidence joins the unit's: the mock is shared
  // by the whole render, and it is the CHILD — Drop, not the page — whose
  // `interactions.liked` says what getUserDropInteractions has to return.
  // Analyse already dropped any callee the unit itself deps on. The unit's own
  // mockDeps (sync-unit call sites, defect #4) join here: a sync component's
  // `useToasts()` is exactly the evidence the old async-by-default guess lacked.
  const allDeps = [
    ...(info.dataDeps ?? []),
    ...(info.treeDataDeps ?? []),
    ...(info.mockDeps ?? []),
  ];
  const depsHere = allDeps.filter(
    (d) => d.specifier !== undefined && group.specifiers.has(d.specifier),
  );
  let uncertain = false;
  // Every guess this module's factory makes, stated in the TODO with its
  // reason. "some return shapes could not be inferred" told the reader nothing
  // about WHICH binding or WHY (defect #4, Do #4); each entry below names
  // both, so the TODO is an answerable question, not a shrug.
  const guesses: string[] = [];

  // Resolves an `equalsDep` note — `m.user_id === user.id` — to the literal
  // the referenced dep's own fixture holds, whichever channel that fixture
  // came from. All of the component's deps count, not just this module's:
  // `members` and `user` usually come from different modules. One hop only
  // (fieldValueLiteral's rule); anything unreadable drops the note.
  const depFieldValue: DepFieldResolver = (varName, field) => {
    const dep = allDeps.find((d) => d.varName === varName);
    if (!dep) return undefined;
    if (dep.uncertain || dep.shape.kind === "unknown") {
      const v = inferredDepReturn(dep, apiRoutes)?.value;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        const fv = (v as Record<string, unknown>)[field];
        if (fv !== undefined) return JSON.stringify(fv);
      }
      return undefined;
    }
    if (dep.shape.kind === "object") {
      const f = dep.shape.fields.find((x) => x.name === field);
      if (f) return fieldValueLiteral(f, withRouteParams(info.propsShape));
    }
    return undefined;
  };

  // The stub expression for ONE dep — shared by root-level bindings and the
  // leaves of a dotted tree. Sets the module-level `uncertain` flag exactly
  // where the old inline logic did. `fill` is the dep's own return-annotation
  // value, when one resolved: usage testimony still decides the SHAPE and any
  // compared value, but a field usage could only synthesise a placeholder for
  // takes the declaration's value — `job.status` read into a lookup says
  // nothing about legal statuses, while `Promise<Job>`'s z.enum names one.
  const depStub = (dep: DataDepInfo, seed: string, fill?: unknown): string => {
    // Sync-by-contract: a hook-shaped callee is never mocked async when the
    // async-ness would be a GUESS (see isHookContract). The one exception is
    // the annotation path below: a `Promise<T>` return annotation is the
    // hook's contract STATED in the source, and a stated contract beats the
    // naming heuristic. When the source writes `await useThing()` with no
    // annotation, the disagreement is stated on the stub rather than hidden:
    // the sync mock still satisfies the await.
    const hookSync = isHookContract(dep.calleeRoot);
    const awaited = dep.awaited && !hookSync;
    const hookNote =
      hookSync && dep.awaited
        ? ` /* awaited at the call site, but a use* hook's contract is a value */`
        : "";
    if (dep.uncertain || dep.shape.kind === "unknown") {
      // Usage said nothing, but the dep's own declaration may have: the
      // annotation-derived value, or the OpenAPI example for the fetch the
      // wrapper performs. Only a dep with neither is an admitted gap.
      const inf = inferredDepReturn(dep, apiRoutes);
      if (inf) {
        const provenance =
          inf.provenance === "annotation"
            ? `/* inferred from ${commentSafe(dep.callee)}'s return annotation */`
            : `/* inferred from the OpenAPI example for ${commentSafe(`${dep.wrapsFetch?.method} ${dep.wrapsFetch?.path}`)} */`;
        const lit = JSON.stringify(inf.value);
        return dep.awaited
          ? `vi.fn(async () => (${lit})) ${provenance}`
          : `vi.fn(() => (${lit})) ${provenance}`;
      }
      uncertain = true;
      guesses.push(
        `${dep.callee} guessed {} — neither its call sites nor its declaration said its shape`,
      );
      return awaited ? "vi.fn(async () => ({}))" : `vi.fn(() => ({}))${hookNote}`;
    }
    // Shape inferred from how the awaited value is actually used in the body.
    // The props fixture the spec's own DEFAULTS is built from, so a field
    // compared against a route param gets that param's value.
    const literal = mockLiteral(
      dep.shape,
      seed,
      withRouteParams(info.propsShape),
      depFieldValue,
      fill,
    );
    return awaited ? `vi.fn(async () => (${literal}))` : `vi.fn(() => (${literal}))${hookNote}`;
  };

  const entry = (b: MergedBinding): string => {
    // The factory REPLACES the module's exports: importers read the
    // MODULE-side name. A renamed import ({ Toaster as SonnerToaster }) under
    // the local key would leave the real importer facing a missing export.
    const key = b.isDefault ? "default" : b.moduleName || b.local;
    // The factory replaces the whole module, so a pure class-string helper
    // beside the data exports has to be re-supplied here — synchronously.
    if (b.pure) return `${key}: ${PURE_UTILITY_STUB}`;
    // A default-imported dep is still a dep: its calleeRoot is the local
    // binding name. The old `default: vi.fn()` shortcut resolved undefined —
    // worse than {} — and, once deps could be enriched, dropped the very
    // fixture whose presence had suppressed the RSC skip escape.
    const deps = depsHere.filter((d) => d.calleeRoot === b.local);
    const dep = deps[0];
    if (!dep) {
      if (b.isDefault) return "default: vi.fn()";
      // An UPPER-CASE import never called as a function is a component by
      // the JSX naming convention (lucide icons, and every icon set that
      // reaches a const map: `const Icon = ICONS[kind]; <Icon/>`). The
      // {} fallback made it `vi.fn(async () => ({}))` — mounted as JSX it
      // returns a PROMISE, React 19 awaits components that then, and the
      // whole tree suspends: the spec asserted against an empty container.
      // Pass children through synchronously; the tree stays queryable.
      if (/^[A-Z]/.test(b.local))
        return `${key}: vi.fn((props: { children?: React.ReactNode }) => props.children ?? null)`;
      // No usage evidence — but the DECLARATION may still say. A formatter
      // called inside JSX never becomes a dataDep, and `formatZAR(cents:
      // number): string` was stubbed `async () => ({})`: asynchronous for a
      // synchronous function, and an object where the page renders a string.
      const ann = group.returns.get(b.moduleName ?? b.local);
      if (ann) {
        const lit = JSON.stringify(ann.value);
        const prov = `/* inferred from ${commentSafe(b.local)}'s return annotation */`;
        return ann.sync
          ? `${key}: vi.fn(() => (${lit})) ${prov}`
          : `${key}: vi.fn(async () => (${lit})) ${prov}`;
      }
      // Neither usage nor declaration. {} is a better stand-in than undefined:
      // it survives member access and only fails on .length/.map, which is a
      // legible failure rather than a crash.
      uncertain = true;
      // A graph-only name (some other file imports it; nothing here awaits it —
      // awaiting makes a dep) renders at worst, and a promise child silently
      // suspends the whole tree. SYNC {} fails loudly where it appears, and
      // `await {}` still resolves.
      if (b.graphOnly) {
        guesses.push(`${key} guessed {} — graph-only name, no call site in this render`);
        return `${key}: vi.fn(() => ({}))`;
      }
      // A hook-shaped name is sync by contract even with no evidence at all
      // (isHookContract): the async {} here is what turned `useToasts` into a
      // Promise and the mount into "toasts.map is not a function".
      if (isHookContract(b.moduleName ?? b.local)) {
        guesses.push(`${key} guessed {} — a use* hook is sync by contract; its shape is unknown`);
        return `${key}: vi.fn(() => ({}))`;
      }
      guesses.push(`${key} guessed async {} — no call-site evidence`);
      return `${key}: vi.fn(async () => ({}))`;
    }
    // `db.query.users.findMany()` needs the vi.fn at the LEAF of the dotted
    // path — mocking the root as a function made `.query` undefined and the
    // spec threw on correct code with no escape (FR-014).
    const dotted = deps.filter((d) => d.callee !== d.calleeRoot);
    if (dotted.length > 0) {
      const tree = dottedDepTree(dotted, depStub);
      if (tree !== undefined && deps.length === dotted.length) return `${key}: ${tree}`;
      // Bare + dotted on one binding, or one path prefixing another: a
      // callable object stub would be inventing semantics. The honest {}
      // keeps the TODO and the RSC skip escape alive.
      uncertain = true;
      guesses.push(`${key} guessed {} — bare and dotted call paths on one binding conflict`);
      return `${key}: vi.fn(async () => ({}))`;
    }
    // Call sites may disagree about `await` — one file awaits the callee,
    // another uses it synchronously. Prefer sync and SAY so: a sync mock
    // under `await` still works (`await 5 === 5`), the reverse is a crash.
    const effAwaited = deps.every((d) => d.awaited);
    if (!effAwaited && deps.some((d) => d.awaited)) {
      guesses.push(
        `${key} is awaited at some call sites and used synchronously at others — mocked sync; the await of a sync value still resolves`,
      );
    }
    const eff = effAwaited ? dep : { ...dep, awaited: false };
    return `${key}: ${depStub(eff, b.local, group.returns.get(b.moduleName ?? b.local)?.value)}`;
  };

  const entries = [
    ...group.bindings.filter((b) => b.isDefault).map(entry),
    ...group.bindings.filter((b) => !b.isDefault).map(entry),
  ];

  // One marker (and one tally) per module mock, however many of its bindings
  // were uninferrable — the marker is what the reader answers, not the binding.
  if (uncertain) todo?.("uninferred-return-shape");
  // The TODO states each guess and its reason — which binding, and what the
  // analyser could not see — where the old blanket "some return shapes could
  // not be inferred" told the next person nothing (defect #4, Do #4).
  const note =
    guesses.length > 0
      ? `// TODO(flawless): ${guesses.join("; ")} — give them real fixtures.\n`
      : "";
  // Module-factory completeness, statement half (defect #4, mechanism 2).
  // The factory replaces the WHOLE module. For a package the rest of the
  // surface cannot be enumerated (node_modules is never parsed), so whatever
  // no analysed file imported is undefined in this spec — say which names
  // are covered and what that implies, mirroring the completeness argument
  // serverActionMock makes for its surface, rather than dropping names
  // silently the way `vi.mock("zustand", () => ({ useStore }))` did to
  // `createStore` in the dogfood.
  const surface = group.pkg
    ? `// This factory replaces the whole ${JSON.stringify(spec)} module: the names below are\n` +
      `// every export an analysed file imports, and every other export of the package is\n` +
      `// undefined in this spec. If a render dies on a missing export, delete this vi.mock\n` +
      `// and give the data a real fixture.\n`
    : "";
  return `${surface}${note}vi.mock(${JSON.stringify(spec)}, () => ({ ${entries.join(", ")} }));`;
}
