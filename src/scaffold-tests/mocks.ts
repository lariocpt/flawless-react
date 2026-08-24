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
import type { ComponentInfo, ModuleImportInfo, TodoRecorder } from "../types.ts";
import { mockLiteral } from "./mockValues.ts";

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
  local: string;
  isDefault: boolean;
  pure: boolean;
}

interface MergedModule {
  /** Original specifier texts (dataDeps records these, not the re-based one). */
  specifiers: Set<string>;
  bindings: MergedBinding[];
}

/** Default and namespace entries have no module-side name; the local stands in. */
function membershipName(mi: ModuleImportInfo, index: number): string {
  return mi.importedNames?.[index] ?? mi.names[index] ?? "";
}

function mergeInto(groups: Map<string, MergedModule>, mi: ModuleImportInfo, key: string): void {
  let group = groups.get(key);
  if (!group) {
    group = { specifiers: new Set(), bindings: [] };
    groups.set(key, group);
  }
  group.specifiers.add(mi.specifier);
  mi.names.forEach((local, i) => {
    if (group.bindings.some((b) => b.local === local)) return;
    group.bindings.push({
      local,
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
export function emitModuleMocks(
  info: ComponentInfo,
  mode: MockMode,
  specDir?: string,
  todo?: TodoRecorder,
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
    push(mi, (spec) => dataModuleMock(group, info, spec, todo));
  }

  return { statements, mocked };
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
): string {
  if (group.bindings.length === 0) return `vi.mock(${JSON.stringify(spec)}, () => ({}));`;

  const depsHere = (info.dataDeps ?? []).filter(
    (d) => d.specifier !== undefined && group.specifiers.has(d.specifier),
  );
  let uncertain = false;

  const entry = (b: MergedBinding): string => {
    const key = b.isDefault ? "default" : b.local;
    // The factory replaces the whole module, so a pure class-string helper
    // beside the data exports has to be re-supplied here — synchronously.
    if (b.pure) return `${key}: ${PURE_UTILITY_STUB}`;
    if (b.isDefault) return "default: vi.fn()";
    const dep = depsHere.find((d) => d.calleeRoot === b.local);
    if (!dep) {
      // Imported and called, but no evidence of how its result is used. {} is a
      // better stand-in than undefined: it survives member access and only
      // fails on .length/.map, which is a legible failure rather than a crash.
      uncertain = true;
      return `${key}: vi.fn(async () => ({}))`;
    }
    if (dep.uncertain || dep.shape.kind === "unknown") {
      uncertain = true;
      return dep.awaited ? `${key}: vi.fn(async () => ({}))` : `${key}: vi.fn(() => ({}))`;
    }
    // Shape inferred from how the awaited value is actually used in the body.
    const literal = mockLiteral(dep.shape, b.local);
    return dep.awaited
      ? `${key}: vi.fn(async () => (${literal}))`
      : `${key}: vi.fn(() => (${literal}))`;
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
