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
import type { ComponentInfo, ModuleImportInfo } from "../types.ts";
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
 * className renders as "[object Promise]". A module is exempt only when EVERY
 * binding the component imports from it is on this list; one data export beside
 * a `cn` re-export and the module is stubbed as usual.
 */
const PURE_UTILITY_BINDINGS = new Set(["cn", "clsx", "cva", "twMerge", "tw"]);

function importsOnlyPureUtilities(mi: ModuleImportInfo): boolean {
  return mi.names.length > 0 && mi.names.every((n) => PURE_UTILITY_BINDINGS.has(n));
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
      push(mi, (spec) => serverActionMock(mi, spec));
      continue;
    }

    // --- everything else: server specs only -----------------------------------
    if (mode === "client") continue;
    if (mi.kind !== "value") continue;
    if (MOCK_SKIP.test(mi.specifier)) continue;
    if (importsOnlyPureUtilities(mi)) continue;
    push(mi, (spec) => dataModuleMock(mi, info, spec));
  }

  return { statements, mocked };
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
 * A "use server" module. The stub resolves to {} rather than undefined because
 * these land in useActionState, whose state is read as `state && "error" in
 * state` — undefined would crash the first render. vi.fn() is a real function,
 * so `action.bind(null, id)` in the JSX still works.
 */
function serverActionMock(mi: ModuleImportInfo, spec: string): string {
  if (mi.names.length === 0) return `vi.mock(${JSON.stringify(spec)}, () => ({}));`;
  const named = mi.hasDefault ? mi.names.slice(1) : mi.names;
  const entries = named.map((n) => `${n}: vi.fn(async () => ({}))`);
  if (mi.hasDefault) entries.unshift("default: vi.fn(async () => ({}))");
  return `// TODO(flawless): server action stubbed — give it a realistic return value.
vi.mock(${JSON.stringify(spec)}, () => ({ ${entries.join(", ")} }));`;
}

/** A project-local module a server component reads data from. */
function dataModuleMock(mi: ModuleImportInfo, info: ComponentInfo, spec: string): string {
  if (mi.names.length === 0) return `vi.mock(${JSON.stringify(spec)}, () => ({}));`;

  const named = mi.hasDefault ? mi.names.slice(1) : mi.names;
  const depsHere = (info.dataDeps ?? []).filter((d) => d.specifier === mi.specifier);
  let uncertain = false;

  const entries = named.map((n) => {
    const dep = depsHere.find((d) => d.calleeRoot === n);
    if (!dep) {
      // Imported and called, but no evidence of how its result is used. {} is a
      // better stand-in than undefined: it survives member access and only
      // fails on .length/.map, which is a legible failure rather than a crash.
      uncertain = true;
      return `${n}: vi.fn(async () => ({}))`;
    }
    if (dep.uncertain || dep.shape.kind === "unknown") {
      uncertain = true;
      return dep.awaited ? `${n}: vi.fn(async () => ({}))` : `${n}: vi.fn(() => ({}))`;
    }
    // Shape inferred from how the awaited value is actually used in the body.
    const literal = mockLiteral(dep.shape, n);
    return dep.awaited
      ? `${n}: vi.fn(async () => (${literal}))`
      : `${n}: vi.fn(() => (${literal}))`;
  });

  if (mi.hasDefault) entries.unshift("default: vi.fn()");
  const note = uncertain
    ? "// TODO(flawless): some return shapes could not be inferred — give them fixtures.\n"
    : "";
  return `${note}vi.mock(${JSON.stringify(spec)}, () => ({ ${entries.join(", ")} }));`;
}
