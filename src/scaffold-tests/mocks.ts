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
import { mockLiteral } from "./mockValues.ts";
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
 *                                 gets a synchronous join stub (under its local
 *                                 name) beside the data stubs.
 */
const PURE_UTILITY_BINDINGS = new Set(["cn", "clsx", "cva", "twMerge", "tw"]);

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
}

interface MergedModule {
  /** Original specifier texts (dataDeps records these, not the re-based one). */
  specifiers: Set<string>;
  bindings: MergedBinding[];
  /** Module-side export name → its own return annotation, merged across the
   * declarations that import from this module. See ModuleImportInfo. */
  returns: Map<string, { value: PropValue; sync: boolean }>;
}

/** Default and namespace entries have no module-side name; the local stands in. */
function membershipName(mi: ModuleImportInfo, index: number): string {
  return mi.importedNames?.[index] ?? mi.names[index] ?? "";
}

function mergeInto(groups: Map<string, MergedModule>, mi: ModuleImportInfo, key: string): void {
  let group = groups.get(key);
  if (!group) {
    group = { specifiers: new Set(), bindings: [], returns: new Map() };
    groups.set(key, group);
  }
  group.specifiers.add(mi.specifier);
  for (const [name, r] of Object.entries(mi.importedReturns ?? {})) group.returns.set(name, r);
  mi.names.forEach((local, i) => {
    if (group.bindings.some((b) => b.local === local)) return;
    group.bindings.push({
      local,
      moduleName: membershipName(mi, i),
      isDefault: mi.hasDefault && i === 0,
      pure: PURE_UTILITY_BINDINGS.has(membershipName(mi, i)),
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

  // Merge the data-path statements per module BEFORE deciding anything: the
  // pure-utility exemption and the mock factory must both see every binding the
  // component imports from a module, however many statements deliver them.
  const dataGroups = new Map<string, MergedModule>();
  if (mode === "rsc") {
    for (const mi of info.moduleImports ?? []) {
      if (!reachesDataPath(mi)) continue;
      mergeInto(dataGroups, mi, mockSpecifier(mi, specDir));
    }
  }

  for (const mi of info.moduleImports ?? []) {
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
      push(mi, linkPassthroughMock);
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
    if (!reachesDataPath(mi)) continue;
    const group = dataGroups.get(mockSpecifier(mi, specDir));
    if (!group) continue;
    if (group.bindings.length > 0 && group.bindings.every((b) => b.pure)) continue;
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
function mockSpecifier(mi: ModuleImportInfo, specDir: string | undefined): string {
  if (!mi.specifier.startsWith(".")) return mi.specifier;
  if (!specDir || !mi.resolvedPath) return mi.specifier;
  let rel = path.relative(specDir, mi.resolvedPath).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.replace(/\.(tsx|ts|jsx|js)$/, "");
}

function navigationMock(): string {
  return `vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("notFound() called"); }),
  // These abort rendering in Next; a plain vi.fn() would let a guarded
  // component run straight past its own guard and crash on the data it guards.
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  permanentRedirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  usePathname: vi.fn(() => "/"),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));`;
}

function headersMock(): string {
  return `vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: vi.fn(), getAll: vi.fn(() => []) })),
}));`;
}

/**
 * The async factory form is required, not stylistic: vi.mock factories are
 * hoisted above every import in the module, so a synchronous factory that closed
 * over a top-level `createElement` binding would throw
 * "Cannot access 'createElement' before initialization".
 */
function linkPassthroughMock(): string {
  return `vi.mock("next/link", async () => {
  // The real <Link> reads Next's AppRouterContext, which jsdom has no way to
  // provide. A passthrough keeps the anchor, its href and its text queryable.
  const { createElement } = await import("react");
  return {
    default: (props: { href?: string | { pathname?: string }; children?: unknown }) => {
      const { href, children, ...rest } = props;
      const to = typeof href === "string" ? href : (href?.pathname ?? "#");
      return createElement("a", { ...rest, href: to } as never, children as never);
    },
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

  const depsHere = (info.dataDeps ?? []).filter(
    (d) => d.specifier !== undefined && group.specifiers.has(d.specifier),
  );
  let uncertain = false;

  // The stub expression for ONE dep — shared by root-level bindings and the
  // leaves of a dotted tree. Sets the module-level `uncertain` flag exactly
  // where the old inline logic did.
  const depStub = (dep: DataDepInfo, seed: string): string => {
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
      return dep.awaited ? "vi.fn(async () => ({}))" : "vi.fn(() => ({}))";
    }
    // Shape inferred from how the awaited value is actually used in the body.
    // The props fixture the spec's own DEFAULTS is built from, so a field
    // compared against a route param gets that param's value.
    const literal = mockLiteral(dep.shape, seed, withRouteParams(info.propsShape));
    return dep.awaited ? `vi.fn(async () => (${literal}))` : `vi.fn(() => (${literal}))`;
  };

  const entry = (b: MergedBinding): string => {
    const key = b.isDefault ? "default" : b.local;
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
      return `${key}: vi.fn(async () => ({}))`;
    }
    return `${key}: ${depStub(dep, b.local)}`;
  };

  const entries = [
    ...group.bindings.filter((b) => b.isDefault).map(entry),
    ...group.bindings.filter((b) => !b.isDefault).map(entry),
  ];

  // One marker (and one tally) per module mock, however many of its bindings
  // were uninferrable — the marker is what the reader answers, not the binding.
  if (uncertain) todo?.("uninferred-return-shape");
  const note = uncertain
    ? "// TODO(flawless): some return shapes could not be inferred — give them fixtures.\n"
    : "";
  return `${note}vi.mock(${JSON.stringify(spec)}, () => ({ ${entries.join(", ")} }));`;
}
