import path from "node:path";
import type {
  ClickHandler,
  ComponentInfo,
  ComponentTree,
  FetchCallInfo,
  FormInfo,
  NextjsApiRoute,
  PropsShape,
  StateInfo,
} from "../types.ts";
import { mockLiteral } from "./mockValues.ts";
import {
  emitPlaywrightDispatch,
  emitPlaywrightSelector,
  emitVitestDispatch,
  emitVitestSelector,
} from "./selectors.ts";

export interface FlatComponent {
  info: ComponentInfo;
  /** Component name of the nearest parent in the tree (undefined for roots). */
  parentName: string | undefined;
}

export interface RenderedFile {
  relPath: string;
  content: string;
  /** When set, write here instead of <outDir>/<relPath> (colocated specs). */
  absPath?: string;
  /** Never overwrite an existing file at the target (unless --force). */
  skipIfExists?: boolean;
}

export interface AliasEntry {
  /** Import prefix ("@/") or exact specifier ("react"). */
  find: string;
  /** Absolute replacement path (dir for prefixes, module path for exact). */
  replacement: string;
  prefix: boolean;
}

export interface UnitBrowserRenderOptions {
  trees: ComponentTree[];
  outDir: string;
  variants: number;
  mswSetup?: boolean;
  /** Absolute path of a .tsx default-exporting a provider wrapper. */
  provider?: string;
  /** vitest resolve.alias entries (tsconfig paths + react dedupe). */
  resolveAliases?: AliasEntry[];
  /** Emit unit specs beside the analysed sources as <base>.flawless.test.tsx. */
  colocate?: boolean;
  /** API routes with response bodies, for fetch-spec fixtures. */
  apiRoutes?: NextjsApiRoute[];
  /**
   * Emit the Playwright browser specs. They drive the perf-harness host
   * (`host/server.ts`), so without that host in the same outDir they cannot
   * run — the caller passes false when perf-harness isn't part of the run.
   */
  browserSpecs?: boolean;
}

export function renderUnitBrowser(opts: UnitBrowserRenderOptions): RenderedFile[] {
  const flat = flatten(opts.trees);
  const specNames = allocateSpecNames(flat);
  const withBrowser = opts.browserSpecs !== false;
  const files: RenderedFile[] = [
    { relPath: "vitest.config.ts", content: vitestConfig(opts) },
    { relPath: "setup.ts", content: setupTs(Boolean(opts.mswSetup)) },
  ];
  if (withBrowser) {
    files.push({ relPath: "browser/playwright.config.ts", content: browserPlaywrightConfig() });
  }

  const perFile = new Map<string, number>();
  for (const c of flat) perFile.set(c.info.filePath, (perFile.get(c.info.filePath) ?? 0) + 1);

  for (const c of flat) {
    const specName = specNames.get(c) as string;
    if (opts.colocate) {
      const srcDir = path.dirname(c.info.filePath);
      const base = path.basename(c.info.filePath).replace(/\.(tsx|jsx|ts|js)$/, "");
      // Multi-component files get one spec per component (card.CardHeader....)
      // so they don't overwrite each other.
      const stem =
        (perFile.get(c.info.filePath) ?? 1) > 1 ? `${base}.${c.info.componentName}` : base;
      files.push({
        relPath: `unit/${specName}.test.tsx`,
        absPath: path.join(srcDir, `${stem}.flawless.test.tsx`),
        skipIfExists: true,
        content: renderUnitFile(c, opts, srcDir, `./${base}`),
      });
    } else {
      const fromDir = path.resolve(opts.outDir, "unit");
      files.push({
        relPath: `unit/${specName}.test.tsx`,
        content: renderUnitFile(c, opts, fromDir, toRel(fromDir, c.info.filePath)),
      });
    }
  }

  if (withBrowser) {
    for (const c of flat) {
      if (c.info.isAsync) continue; // async server components cannot mount client-side
      const specName = specNames.get(c) as string;
      files.push({
        relPath: `browser/${specName}.spec.ts`,
        content: browserSpec(c),
      });
    }
  }
  return files;
}

function renderUnitFile(
  c: FlatComponent,
  opts: UnitBrowserRenderOptions,
  specDir: string,
  importPath: string,
): string {
  const providerImport = opts.provider ? toImportPath(specDir, opts.provider) : undefined;
  const mocksImport = opts.mswSetup
    ? toImportPath(specDir, path.join(path.resolve(opts.outDir), "mocks", "node.ts"))
    : undefined;
  return c.info.isAsync
    ? rscSpec(c, importPath, providerImport)
    : unitSpec(c, opts.variants, importPath, providerImport, mocksImport, opts.apiRoutes);
}

function flatten(trees: ComponentTree[]): FlatComponent[] {
  const out: FlatComponent[] = [];
  const seen = new Set<string>();
  const walk = (t: ComponentTree, parentName: string | undefined): void => {
    const key = `${t.entry.filePath}::${t.entry.componentName}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ info: t.entry, parentName });
    }
    for (const c of t.children) walk(c, t.entry.componentName);
  };
  for (const t of trees) walk(t, undefined);
  return out;
}

/** First claimant keeps the bare name; same-named later components get Parent__Name, then __2. */
function allocateSpecNames(flat: FlatComponent[]): Map<FlatComponent, string> {
  const taken = new Set<string>();
  const out = new Map<FlatComponent, string>();
  for (const c of flat) {
    let name = c.info.componentName;
    if (taken.has(name) && c.parentName) name = `${c.parentName}__${c.info.componentName}`;
    let i = 2;
    while (taken.has(name)) name = `${c.info.componentName}__${i++}`;
    taken.add(name);
    out.set(c, name);
  }
  return out;
}

function toRel(fromDir: string, absFile: string): string {
  let rel = path.relative(fromDir, absFile);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.split(path.sep).join("/");
}

/**
 * Emitted import paths must not carry a .ts/.tsx extension: the target project
 * type-checks the generated specs, and TS rejects those unless it opts into
 * allowImportingTsExtensions. flawless's own source uses them (Bun), the code
 * it writes into someone else's repo must not.
 */
function toImportPath(fromDir: string, absFile: string): string {
  return stripTsExt(toRel(fromDir, absFile));
}

function stripTsExt(spec: string): string {
  return spec.replace(/\.(tsx|ts|jsx|js)$/, "");
}

/** Named vs default import, from the analyser's exportKind. */
function emitComponentImport(info: ComponentInfo, importPath: string): string {
  const stripped = stripTsExt(importPath);
  if (info.exportKind === "default") {
    return `import ${info.componentName} from "${stripped}";`;
  }
  return `import { ${info.componentName} } from "${stripped}";`;
}

function vitestConfig(opts: UnitBrowserRenderOptions): string {
  const aliasLines = (opts.resolveAliases ?? [])
    .map((a) =>
      a.prefix
        ? `      { find: /^${escapeRegex(a.find)}/, replacement: ${JSON.stringify(`${a.replacement}/`)} },`
        : `      { find: /^${escapeRegex(a.find)}$/, replacement: ${JSON.stringify(a.replacement)} },`,
    )
    .join("\n");
  const resolveBlock =
    aliasLines.length > 0 ? `  resolve: {\n    alias: [\n${aliasLines}\n    ],\n  },\n` : "";
  if (opts.colocate) {
    // Colocate mode runs as `vitest run --config flawless/vitest.config.ts`.
    // Vite roots itself at the CONFIG file's directory, so without an explicit
    // root the include globs resolve under flawless/ and match nothing.
    return `import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  root: projectRoot,
${resolveBlock}  test: {
    environment: "jsdom",
    setupFiles: [path.join(projectRoot, "flawless/setup.ts")],
    include: ["src/**/*.flawless.test.{ts,tsx}", "flawless/unit/**/*.test.{ts,tsx}"],
    globals: true,
  },
});
`;
  }
  return `import { defineConfig } from "vitest/config";

export default defineConfig({
${resolveBlock}  test: {
    environment: "jsdom",
    setupFiles: ["./setup.ts"],
    include: ["unit/**/*.test.{ts,tsx}"],
    globals: true,
  },
});
`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function setupTs(mswSetup: boolean): string {
  const polyfills = `
// jsdom gaps that real-world component stacks hit constantly (next-themes →
// matchMedia, virtualisers → ResizeObserver, lazy mounts → IntersectionObserver).
if (typeof window !== "undefined") {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  window.IntersectionObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
    root = null;
    rootMargin = "";
    thresholds = [];
  } as unknown as typeof IntersectionObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.scrollTo ??= (() => {}) as typeof Element.prototype.scrollTo;
}
`;
  if (!mswSetup) {
    return `import "@testing-library/jest-dom/vitest";
${polyfills}`;
  }
  return `import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./mocks/node";
${polyfills}
// MSW node server intercepts fetch() inside jsdom — same handlers your browser
// suite uses, so unit and browser layers agree on what /api/* returns.
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
`;
}

// ---------------------------------------------------------------------------
// Client-component unit spec
// ---------------------------------------------------------------------------

function unitSpec(
  c: FlatComponent,
  variants: number,
  importPath: string,
  providerImport: string | undefined,
  mocksImport: string | undefined,
  apiRoutes: NextjsApiRoute[] | undefined,
): string {
  const info = c.info;
  const name = info.componentName;
  const propsLiteral = JSON.stringify(info.propsShape);
  const variantsLiteral = JSON.stringify(info.variants.slice(0, variants));
  const promiseProps = info.promiseProps ?? [];
  const interactions = info.interactions;

  const allHandlers = collectPropHandlers(info);
  const handlerObjectLiteral =
    allHandlers.length > 0 ? `{ ${allHandlers.map((h) => `${h}: vi.fn()`).join(", ")} }` : `{}`;

  const interactionTests = interactions
    ? emitInteractionTests(name, interactions, allHandlers, firstClickTrigger(info))
    : emitFallbackHandlerTests(name, info.propsShape, info.unresolvedProps);

  const stateTests = emitStateTests(name, info);
  const staticTextTests = emitStaticTextTests(name, info, "unit");
  const effectFetches = (info.fetchCalls ?? []).filter((f) => f.inEffect);
  const fetchTests =
    mocksImport && effectFetches.length > 0
      ? emitFetchTests(name, info, effectFetches, apiRoutes, firstClickTrigger(info))
      : "";

  const providerLine = providerImport ? `import AppProvider from "${providerImport}";\n` : "";
  const mswImports =
    mocksImport && effectFetches.length > 0
      ? `import { http, HttpResponse, delay } from "msw";\nimport { server } from "${mocksImport}";\n`
      : "";

  // A component with no discoverable props has `ComponentProps<typeof X>` of
  // `unknown`, and spreading that is a type error in the target project.
  const hasProps =
    Object.keys(info.propsShape).length > 0 ||
    info.unresolvedProps.length > 0 ||
    allHandlers.length > 0;
  const spread = hasProps ? ` {...(merged as unknown as Props)}` : "";
  const childTextConst = info.acceptsChildren ? `const CHILD_TEXT = "flawless child";\n` : "";
  const element = info.acceptsChildren
    ? `<${name}${spread}>{CHILD_TEXT}</${name}>`
    : `<${name}${spread} />`;
  const renderExpr = providerImport
    ? `render(<AppProvider>${element}</AppProvider>)`
    : `render(${element})`;

  return `import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
${mswImports}${providerLine}${emitComponentImport(info, importPath)}

type Props = React.ComponentProps<typeof ${name}>;
${childTextConst}
const DEFAULTS: Record<string, unknown> = ${propsLiteral};
const PROMISE_PROPS: string[] = ${JSON.stringify(promiseProps)};
const VARIANTS: Array<Record<string, unknown>> = ${variantsLiteral};
const handlers: Record<string, ReturnType<typeof vi.fn>> = ${handlerObjectLiteral};

beforeEach(() => {
  for (const v of Object.values(handlers)) v.mockClear();
});

function buildProps(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...DEFAULTS, ...handlers, ...extra };
  for (const k of PROMISE_PROPS) {
    if (k in merged) merged[k] = Promise.resolve(merged[k]);
  }
  return merged;
}

function renderTarget(extra: Record<string, unknown> = {}) {
  const merged = buildProps(extra);
  void merged;
  return ${renderExpr};
}

test("${name} renders at defaults without crashing", () => {
  renderTarget();
  void screen;
});

${
  info.variants.slice(0, variants).length > 0
    ? `describe("${name} variants", () => {
  for (const v of VARIANTS) {
    test(\`renders with \${JSON.stringify(v)}\`, () => {
      renderTarget(v);
    });
  }
});`
    : `// no literal-union props — no variant matrix (VARIANTS kept for hand-written rows).
void VARIANTS;`
}

${interactionTests}
${staticTextTests}${stateTests}${fetchTests}`;
}

// ---------------------------------------------------------------------------
// State-derived tests
// ---------------------------------------------------------------------------

function emitStateTests(name: string, info: ComponentInfo): string {
  const states = (info.state ?? []).filter((s) => s.kind !== "useRef");
  if (states.length === 0) return "";

  const parts: string[] = [];
  const summary = states
    .map(
      (s) =>
        `//   ${s.varName}${s.setterName ? ` / ${s.setterName}` : ""} (${s.typeKind}) = ${escapeComment(s.initialRaw ?? "?")}`,
    )
    .join("\n");
  parts.push(`\n// Detected state:\n${summary}`);

  for (const s of states) {
    const witness = initialWitness(s);
    if (witness) {
      parts.push(`
test("${name} initial state: ${s.varName} = ${escapeTestName(s.initialRaw ?? "")} is rendered", () => {
  renderTarget();
  expect(screen.queryAllByText(${JSON.stringify(witness)}).length).toBeGreaterThan(0);
});`);
    }
  }

  // Interaction → state change: a click bound to a local handler that calls a setter.
  const clicks = info.interactions?.clicks ?? [];
  for (const s of states) {
    for (const call of s.setterCalls) {
      if (call.context !== "handler" || !call.enclosingName) continue;
      const click = clicks.find(
        (cl) => cl.binding.kind === "local" && cl.binding.localName === call.enclosingName,
      );
      if (!click) continue;
      const selector = emitVitestSelector(click);
      const dispatch = emitVitestDispatch(click.event, selector);
      parts.push(`
test("${name}: ${click.event} via ${call.enclosingName} → ${s.setterName ?? s.varName} updates", async () => {
  const { container } = renderTarget();
  void container;
  ${dispatch};
  // TODO(flawless): assert the observable change for ${s.setterName ?? s.varName}(...) —
  // the handler fires, but no text witness could be derived statically.
  await waitFor(() => expect(document.body).toBeTruthy());
});`);
      break; // one interaction test per state var is enough scaffolding
    }
  }

  return `${parts.join("\n")}\n`;
}

function initialWitness(s: StateInfo): string | undefined {
  if (typeof s.initialValue !== "string" || s.initialValue.trim().length < 2) return undefined;
  if (!s.flowsToJsx.some((f) => f.via === "child")) return undefined;
  return s.initialValue;
}

/** Safe inside a double-quoted test name: no quotes, no newlines, bounded. */
function escapeTestName(s: string): string {
  return s.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 40);
}

/** Safe inside a `//` comment: single line, bounded. */
function escapeComment(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 80);
}

// ---------------------------------------------------------------------------
// Effect-driven fetch tests (MSW)
// ---------------------------------------------------------------------------

/**
 * Data effects are often gated behind UI state (open a panel → fetch). The
 * fetch specs fire the component's first detected click when it is present,
 * which unlocks the common launcher-gated pattern; a mount-triggered fetch is
 * unaffected (the click is skipped when the element is absent).
 */
function firstClickTrigger(info: ComponentInfo): string | undefined {
  const click = info.interactions?.clicks.find((c) => c.event === "onClick");
  if (!click) return undefined;
  const query = emitVitestSelector(click).replace(".getBy", ".queryBy").replace(/\)!$/, ")");
  return `const trigger = ${query};
    if (trigger) await userEvent.click(trigger as HTMLElement);`;
}

function emitFetchTests(
  name: string,
  info: ComponentInfo,
  fetches: FetchCallInfo[],
  apiRoutes: NextjsApiRoute[] | undefined,
  trigger: string | undefined,
): string {
  const triggerLines = trigger
    ? `\n    // Effects can be gated behind UI state — fire the first detected click.\n    ${trigger}`
    : "";
  const propNames = new Set([...Object.keys(info.propsShape), ...info.unresolvedProps]);
  const parts: string[] = [];
  for (const f of fetches) {
    const mswPath = f.urlTemplate;
    const method = f.method.toLowerCase();
    const fixture = fixtureFor(f, apiRoutes);
    const fixtureLiteral = fixture !== undefined ? JSON.stringify(fixture) : "{}";
    const fixtureComment =
      fixture !== undefined
        ? "// Fixture from the project's OpenAPI spec examples."
        : "// TODO(flawless): no example found in the API spec — replace {} with a realistic fixture.";

    // URL holes that are props default to "" and would collapse a path
    // segment (/api/x//y never matches :param) — render with real values.
    const holeOverrides = Object.fromEntries(
      f.holes.filter((h) => propNames.has(h)).map((h) => [h, `test-${h}`]),
    );
    const renderArg = Object.keys(holeOverrides).length > 0 ? JSON.stringify(holeOverrides) : "";
    parts.push(`
describe("${name} ${f.method} ${mswPath}", () => {
  const URL = ${JSON.stringify(mswPath)};
  ${fixtureComment}
  const FIXTURE: unknown = ${fixtureLiteral};

  test("mount fetches and renders with a successful response", async () => {
    let calls = 0;
    server.use(http.${method}(URL, () => { calls++; return HttpResponse.json(FIXTURE as never); }));
    const { container } = renderTarget(${renderArg});
    void container;${triggerLines}
    await waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });
    // TODO(flawless): assert rendered content derived from FIXTURE.
  });

  test("stays stable while the response is delayed (loading state)", async () => {
    let calls = 0;
    server.use(http.${method}(URL, async () => { calls++; await delay(150); return HttpResponse.json(FIXTURE as never); }));
    const { container } = renderTarget(${renderArg});
    void container;${triggerLines}
    await waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });
    // TODO(flawless): assert the loading indicator while the response is pending.
  });

  test("survives a 500 without crashing (error state)", async () => {
    let calls = 0;
    server.use(http.${method}(URL, () => { calls++; return new HttpResponse(null, { status: 500 }); }));
    const { container } = renderTarget(${renderArg});
    void container;${triggerLines}
    await waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });
    // TODO(flawless): assert the error-state UI.
  });

  test("renders the empty state for an empty payload", async () => {
    let calls = 0;
    server.use(http.${method}(URL, () => { calls++; return HttpResponse.json(${emptyPayloadFor(fixture)}); }));
    const { container } = renderTarget(${renderArg});
    void container;${triggerLines}
    await waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });
    // TODO(flawless): assert the empty-state copy.
  });
});`);
  }
  return `\n${parts.join("\n")}\n`;
}

function fixtureFor(f: FetchCallInfo, apiRoutes: NextjsApiRoute[] | undefined): unknown {
  if (!apiRoutes) return undefined;
  const wanted = normalizeApiPath(f.urlTemplate);
  for (const r of apiRoutes) {
    if (normalizeApiPath(r.path) !== wanted) continue;
    const body = r.responseBodies?.[f.method.toUpperCase()] ?? r.responseBodies?.GET;
    if (body !== undefined) return body;
  }
  return undefined;
}

/** Compare /api/x/{id}/y, /api/x/:id/y and /api/x/:buildingId/y as the same shape. */
function normalizeApiPath(p: string): string {
  return p
    .replace(/\{[^}]+\}/g, ":_")
    .replace(/:[A-Za-z0-9_]+/g, ":_")
    .replace(/\/+$/, "");
}

function emptyPayloadFor(fixture: unknown): string {
  if (Array.isArray(fixture)) return "[]";
  if (fixture && typeof fixture === "object") {
    // Preserve the envelope but empty every array member: { items: [] }.
    const emptied: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fixture as Record<string, unknown>)) {
      emptied[k] = Array.isArray(v) ? [] : v;
    }
    return JSON.stringify(emptied);
  }
  return "{}";
}

// ---------------------------------------------------------------------------
// RSC spec (async server components)
// ---------------------------------------------------------------------------

const MOCK_SKIP =
  /^(react($|\/)|next\/(?!navigation|headers|cache)|.*\.(css|scss|sass|less|svg|png|jpe?g|gif|woff2?)$)/;

function rscSpec(c: FlatComponent, importPath: string, providerImport: string | undefined): string {
  const info = c.info;
  const name = info.componentName;
  const propsLiteral = JSON.stringify(info.propsShape);
  const promiseProps = info.promiseProps ?? [];

  const mocks: string[] = [];
  for (const mi of info.moduleImports ?? []) {
    if (mi.kind !== "value" || mi.isTypeOnly) continue;
    if (MOCK_SKIP.test(mi.specifier)) continue;
    if (mi.specifier === "server-only") {
      mocks.push(`vi.mock("server-only", () => ({}));`);
      continue;
    }
    if (mi.specifier === "next/navigation") {
      mocks.push(`vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("notFound() called"); }),
  // These abort rendering in Next; a plain vi.fn() would let a guarded
  // component run straight past its own guard and crash on the data it guards.
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  permanentRedirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  usePathname: vi.fn(() => "/"),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));`);
      continue;
    }
    if (mi.specifier === "next/headers") {
      mocks.push(`vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: vi.fn(), getAll: vi.fn(() => []) })),
}));`);
      continue;
    }
    if (mi.names.length === 0) {
      mocks.push(`vi.mock(${JSON.stringify(mi.specifier)}, () => ({}));`);
      continue;
    }
    const named = mi.hasDefault ? mi.names.slice(1) : mi.names;
    const depsHere = (info.dataDeps ?? []).filter((d) => d.specifier === mi.specifier);
    let uncertain = false;
    const entries = named.map((n) => {
      const dep = depsHere.find((d) => d.calleeRoot === n);
      if (!dep || dep.uncertain || dep.shape.kind === "unknown") {
        if (dep) uncertain = true;
        return `${n}: vi.fn()`;
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
    mocks.push(
      `${note}vi.mock(${JSON.stringify(mi.specifier)}, () => ({ ${entries.join(", ")} }));`,
    );
  }

  const providerLine = providerImport ? `import AppProvider from "${providerImport}";\n` : "";
  const renderExpr = providerImport
    ? `render(<AppProvider>{ui}</AppProvider>)`
    : `render(<>{ui}</>)`;

  const guards = info.guards ?? [];
  const guardSummary =
    guards.length > 0 ? guards.map((g) => `${g.effect}()`).join(" / ") : "no early-exit guards";
  const staticTextTests = emitStaticTextTests(name, info, "rsc");
  const guardTests = emitGuardTests(name, info);

  return `import { test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type * as React from "react";
${mocks.join("\n")}
${providerLine}${emitComponentImport(info, importPath)}

// ${name} is an async server component: it is invoked as a function and its
// resolved JSX is rendered directly. Module-level data dependencies above are
// mocked — fill in fixtures to make the assertions meaningful.

const DEFAULTS: Record<string, unknown> = ${propsLiteral};
const PROMISE_PROPS: string[] = ${JSON.stringify(promiseProps)};

function buildProps(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...DEFAULTS, ...extra };
  for (const k of PROMISE_PROPS) {
    if (k in merged) merged[k] = Promise.resolve(merged[k]);
  }
  return merged;
}

test("${name} (RSC): resolves, or takes one of its declared guard paths", async () => {
  let ui: React.ReactNode;
  try {
    ui = await ${name}(buildProps() as never);
  } catch (err) {
    // notFound()/redirect() are legitimate outcomes when the mocked data layer
    // returns nothing — this component declares ${guardSummary}. Assert that
    // this is what happened rather than that nothing broke.
    expect(String(err)).toMatch(/notFound\\(\\) called|NEXT_REDIRECT|NEXT_NOT_FOUND/);
    return;
  }
  ${renderExpr};
  expect(document.body.innerHTML.length).toBeGreaterThan(0);
  void screen;
});
${staticTextTests}${guardTests}`;
}

/**
 * Literal copy the component renders unconditionally. `getByText` matches an
 * element's whole normalised text, which is why the analyser only keeps
 * sole-child text — anything else would assert a string that never appears.
 */
function emitStaticTextTests(name: string, info: ComponentInfo, mode: "unit" | "rsc"): string {
  const texts = info.staticText ?? [];
  if (texts.length === 0) return "";
  const render =
    mode === "rsc"
      ? `const ui = await ${name}(buildProps() as never);\n    ${"render(<>{ui}</>)"};`
      : "renderTarget();";
  return `
describe("${name} static content", () => {
  for (const t of ${JSON.stringify(texts)}) {
    test(\`renders \${JSON.stringify(t)}\`, async () => {
      ${render}
      expect(screen.getByText(t)).toBeInTheDocument();
    });
  }
});
`;
}

/**
 * A guard whose trigger value is known can be asserted directly: make the dep
 * it guards return nothing, and the component must abort the way its own
 * source says it will.
 */
function emitGuardTests(name: string, info: ComponentInfo): string {
  const deps = info.dataDeps ?? [];
  const parts: string[] = [];
  for (const g of info.guards ?? []) {
    if (g.triggerValue === undefined || g.depVars.length !== 1) continue;
    const varName = g.depVars[0] as string;
    const dep = deps.find((d) => d.varName === varName);
    if (!dep?.specifier || dep.calleeRoot.length === 0) continue;
    const value =
      g.triggerValue === "empty-array" ? "[]" : g.triggerValue === "null" ? "null" : "undefined";
    const expected = g.effect === "notFound" ? "/notFound\\\\(\\\\) called/" : "/NEXT_REDIRECT/";
    parts.push(`
test("${name}: ${g.effect}() when ${dep.calleeRoot} returns ${value}", async () => {
  vi.mocked(${dep.calleeRoot}).mockResolvedValueOnce(${value} as never);
  await expect(${name}(buildProps() as never)).rejects.toThrow(${expected});
});`);
  }
  if (parts.length === 0) return "";
  const imports = [
    ...new Set(
      (info.guards ?? [])
        .filter((g) => g.triggerValue !== undefined && g.depVars.length === 1)
        .map((g) => deps.find((d) => d.varName === g.depVars[0]))
        .filter((d): d is NonNullable<typeof d> => Boolean(d?.specifier))
        .map((d) => `import { ${d.calleeRoot} } from ${JSON.stringify(d.specifier)};`),
    ),
  ];
  // vi.mock is hoisted, so these resolve to the mocks declared above.
  return `\n${imports.join("\n")}\n${parts.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Interaction tests
// ---------------------------------------------------------------------------

function collectPropHandlers(info: ComponentInfo): string[] {
  const out = new Set<string>();
  // Anything matching /^on[A-Z]/ that flowed through extractProps as "unresolved"
  // (callback type) or appears explicitly in interactions.
  for (const u of info.unresolvedProps) if (/^on[A-Z]/.test(u)) out.add(u);
  for (const k of Object.keys(info.propsShape)) if (/^on[A-Z]/.test(k)) out.add(k);
  const inter = info.interactions;
  if (inter) {
    for (const c of inter.clicks) {
      if (c.binding.kind === "prop") out.add(c.binding.propName);
    }
    for (const f of inter.forms) {
      if (f.submit?.kind === "prop") out.add(f.submit.propName);
    }
  }
  return [...out];
}

function emitInteractionTests(
  name: string,
  info: NonNullable<ComponentInfo["interactions"]>,
  allHandlers: string[],
  trigger: string | undefined,
): string {
  const firstClickIdx = info.clicks.findIndex((c) => c.event === "onClick");
  const parts: string[] = [];
  for (let i = 0; i < info.clicks.length; i++) {
    const click = info.clicks[i];
    if (!click) continue;
    // Later interactions often live behind UI state the first click opens.
    const prelude = i !== firstClickIdx && trigger ? trigger : undefined;
    parts.push(emitClickTest(name, click, allHandlers, i, prelude));
  }
  for (let i = 0; i < info.forms.length; i++) {
    const form = info.forms[i];
    if (!form) continue;
    parts.push(emitFormTest(name, form, allHandlers, i));
  }
  if (parts.length === 0) {
    parts.push(`// no interactions detected — render-only smoke is above.`);
  }
  return parts.join("\n\n");
}

function emitClickTest(
  name: string,
  click: ClickHandler,
  allHandlers: string[],
  idx: number,
  prelude?: string,
): string {
  const labelDesc = describeClickLabel(click);
  const selector = emitVitestSelector(click);
  const dispatch = emitVitestDispatch(click.event, selector);
  const preludeLines = prelude ? `\n  ${prelude}` : "";
  if (click.binding.kind === "prop") {
    const propName = click.binding.propName;
    const others = allHandlers.filter((h) => h !== propName);
    const isolationAsserts = others
      .map((h) => `  expect(handlers.${h}).not.toHaveBeenCalled();`)
      .join("\n");
    return `test("${name} fires ${propName} when ${labelDesc} (${click.event})", async () => {
  const { container } = renderTarget();
  void container;${preludeLines}
  ${dispatch};
  expect(handlers.${propName}).toHaveBeenCalled();
${isolationAsserts || "  // no other handlers to isolate"}
});`;
  }
  // local / inline — smoke: no thrown error, no prop handler accidentally called.
  const isolationAsserts = allHandlers
    .map((h) => `  expect(handlers.${h}).not.toHaveBeenCalled();`)
    .join("\n");
  return `test("${name} ${click.event} on ${labelDesc} #${idx} is a smoke click", async () => {
  const { container } = renderTarget();
  void container;${preludeLines}
  ${dispatch};
${isolationAsserts || "  // no prop handlers declared"}
});`;
}

function describeClickLabel(c: ClickHandler): string {
  // Used inside double-quoted JS test names — escape internal double quotes.
  const safe = (s: string): string => s.replace(/"/g, "'");
  if (c.label.kind === "text") return `'${safe(c.label.value)}'`;
  if (c.label.kind === "prop") return `the {${c.label.propName}} ${c.tag}`;
  if (c.label.kind === "aria") return `[aria-label='${safe(c.label.value)}']`;
  if (c.label.kind === "testid") return `[data-testid='${safe(c.label.value)}']`;
  return `the ${c.tag}`;
}

function emitFormTest(name: string, form: FormInfo, allHandlers: string[], idx: number): string {
  const fillSteps: string[] = [];
  for (const field of form.fields) {
    if (field.tag !== "input" && field.tag !== "textarea") continue;
    const sampleValue =
      field.type === "email"
        ? "user@example.com"
        : field.type === "password"
          ? "pa55word!"
          : field.type === "number"
            ? "42"
            : (field.label ?? field.name ?? "value");
    const lookup = field.label
      ? `screen.getByLabelText(${JSON.stringify(field.label)})`
      : field.placeholder
        ? `screen.getByPlaceholderText(${JSON.stringify(field.placeholder)})`
        : field.id
          ? `container.querySelector(${JSON.stringify(`#${field.id}`)})!`
          : field.name
            ? `container.querySelector(${JSON.stringify(`[name=${field.name}]`)})!`
            : undefined;
    if (!lookup) continue;
    fillSteps.push(
      `  await userEvent.type(${lookup} as HTMLElement, ${JSON.stringify(sampleValue)});`,
    );
  }
  const submitClick = `await userEvent.click(screen.getByRole("button", { name: /submit|sign\\s*up|save|send|invite|create|add|confirm/i }));`;
  if (form.submit?.kind === "prop") {
    const propName = form.submit.propName;
    const others = allHandlers.filter((h) => h !== propName);
    const isolation = others
      .map((h) => `  expect(handlers.${h}).not.toHaveBeenCalled();`)
      .join("\n");
    return `test("${name} submits form #${idx} → ${propName} called once", async () => {
  const { container } = renderTarget();
  void container;
${fillSteps.join("\n")}
  ${submitClick}
  expect(handlers.${propName}).toHaveBeenCalled();
${isolation || "  // no other handlers to isolate"}
});`;
  }
  return `test("${name} form #${idx} fills + submits without error (smoke)", async () => {
  const { container } = renderTarget();
  void container;
${fillSteps.join("\n")}
  ${submitClick}
});`;
}

function emitFallbackHandlerTests(
  name: string,
  propsShape: PropsShape,
  unresolvedProps: string[],
): string {
  const handlers = [
    ...Object.keys(propsShape).filter((k) => /^on[A-Z]/.test(k)),
    ...unresolvedProps.filter((k) => /^on[A-Z]/.test(k)),
  ];
  if (handlers.length === 0) return `// no interactions and no handler props detected.`;
  return handlers
    .map(
      (p) => `
test("${name} invokes ${p} when first button clicked (fallback)", async () => {
  const { container } = renderTarget();
  const button = container.querySelector("button");
  if (button) {
    await userEvent.click(button);
    expect(handlers.${p}).toHaveBeenCalled();
  }
});`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Browser specs
// ---------------------------------------------------------------------------

function browserSpec(c: FlatComponent): string {
  const name = c.info.componentName;
  const propsLiteral = JSON.stringify(c.info.propsShape);
  const interactions = c.info.interactions;

  const interactionTests = interactions
    ? emitBrowserInteractionTests(interactions)
    : `
test(\`\${NAME}: click first button without errors (fallback)\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [NAME, DEFAULTS],
  );
  const btn = page.locator("button").first();
  if (await btn.count() > 0) await btn.click();
  expect(errors).toEqual([]);
});`;

  return `import { test, expect } from "@playwright/test";

const NAME = ${JSON.stringify(name)};
const DEFAULTS = ${propsLiteral} as Record<string, unknown>;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => typeof window.__profile?.mount === "function");
});

test(\`\${NAME}: mounts in the browser without console errors\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [NAME, DEFAULTS],
  );
  await page.waitForTimeout(100);
  expect(errors).toEqual([]);
  const rootHtml = await page.locator("#root").innerHTML();
  expect(rootHtml.length).toBeGreaterThan(0);
});
${interactionTests}
`;
}

function emitBrowserInteractionTests(info: NonNullable<ComponentInfo["interactions"]>): string {
  const parts: string[] = [];
  for (let i = 0; i < info.clicks.length; i++) {
    const click = info.clicks[i];
    if (!click) continue;
    const labelDesc = describeClickLabel(click);
    const selector = emitPlaywrightSelector(click);
    const dispatch = emitPlaywrightDispatch(click.event, selector);
    parts.push(`
test(\`\${NAME}: ${click.event} on ${labelDesc} fires without error\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [NAME, DEFAULTS],
  );
  ${dispatch};
  await page.waitForTimeout(50);
  expect(errors).toEqual([]);
});`);
  }
  for (let i = 0; i < info.forms.length; i++) {
    const form = info.forms[i];
    if (!form) continue;
    const fillSteps: string[] = [];
    for (const field of form.fields) {
      if (field.tag !== "input" && field.tag !== "textarea") continue;
      const sampleValue =
        field.type === "email"
          ? "user@example.com"
          : field.type === "password"
            ? "pa55word!"
            : field.type === "number"
              ? "42"
              : (field.label ?? field.name ?? "value");
      const locator = field.label
        ? `page.getByLabel(${JSON.stringify(field.label)})`
        : field.placeholder
          ? `page.getByPlaceholder(${JSON.stringify(field.placeholder)})`
          : field.id
            ? `page.locator(${JSON.stringify(`#${field.id}`)})`
            : field.name
              ? `page.locator(${JSON.stringify(`[name=${field.name}]`)})`
              : undefined;
      if (!locator) continue;
      fillSteps.push(`  await ${locator}.fill(${JSON.stringify(sampleValue)});`);
    }
    parts.push(`
test(\`\${NAME}: form #${i} fills + submits without error\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [NAME, DEFAULTS],
  );
${fillSteps.join("\n")}
  await page.getByRole("button", { name: /submit|sign\\s*up|save|send|invite|create|add|confirm/i }).click();
  await page.waitForTimeout(50);
  expect(errors).toEqual([]);
});`);
  }
  if (parts.length === 0) {
    parts.push(`
test(\`\${NAME}: no interactions detected — mount-only smoke above is sufficient\`, () => {});`);
  }
  return parts.join("\n");
}

function browserPlaywrightConfig(): string {
  return `import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun ../host/server.ts",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
`;
}
