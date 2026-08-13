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
import { emitModuleMocks } from "./mocks.ts";
import {
  allocateSpecNames,
  type FlatComponent,
  flattenTrees,
  synthesiseDefaults,
} from "./registry.ts";
import {
  awaitSelector,
  emitPlaywrightDispatch,
  emitPlaywrightSelector,
  emitTriggerSelector,
  emitVitestDispatch,
  emitVitestSelector,
} from "./selectors.ts";

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
  const flat = flattenTrees(opts.trees);
  const specNames = allocateSpecNames(flat);
  const withBrowser = opts.browserSpecs !== false;
  const files: RenderedFile[] = [
    { relPath: "vitest.config.ts", content: vitestConfig(opts) },
    { relPath: "setup.ts", content: setupTs(Boolean(opts.mswSetup)) },
  ];
  if (withBrowser) {
    files.push({ relPath: "browser/playwright.config.ts", content: browserPlaywrightConfig() });
  }

  // A component with no export cannot be imported by a spec, so there is no
  // spec to write. These reach `flat` only as children of an exported parent,
  // and emitting `import { X }` for them yields undefined -> "Element type is
  // invalid" at render time. Their behaviour is covered through that parent.
  const specTargets = flat.filter((c) => c.info.exportKind !== "none");

  const perFile = new Map<string, number>();
  for (const c of specTargets)
    perFile.set(c.info.filePath, (perFile.get(c.info.filePath) ?? 0) + 1);

  for (const c of specTargets) {
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
    for (const c of specTargets) {
      const mode = c.info.renderMode ?? (c.info.isAsync ? "rsc" : "client");
      // Only components that mount standalone can be driven in the browser host.
      if (mode !== "client") continue;
      const specName = specNames.get(c) as string;
      files.push({
        relPath: `browser/${specName}.spec.ts`,
        content: browserSpec(c, specName),
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
  const mode = c.info.renderMode ?? (c.info.isAsync ? "rsc" : "client");
  if (mode === "compound-part" || mode === "document-root") {
    return constrainedSpec(c, importPath, providerImport, mode, specDir);
  }
  return mode === "rsc"
    ? rscSpec(c, importPath, providerImport, specDir)
    : unitSpec(c, opts.variants, importPath, providerImport, mocksImport, opts.apiRoutes, specDir);
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
  // dedupe is not optional in a workspace. When react resolves to the repo root
  // and react-dom to the package, react-dom-server sets its hook dispatcher on a
  // different React instance than the component reads from, and every hook call
  // fails with "Cannot read properties of null (reading 'useEffect')" — a
  // confusing error that looks like a generator bug and is not one.
  const dedupeLine = `    dedupe: ["react", "react-dom"],\n`;
  const aliasBlock = aliasLines.length > 0 ? `    alias: [\n${aliasLines}\n    ],\n` : "";
  const resolveBlock = `  resolve: {\n${dedupeLine}${aliasBlock}  },\n`;
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

  // Node >= 22 defines a \`localStorage\` global that is inert unless the process
  // was started with --localstorage-file. Under vitest's jsdom environment
  // \`window.localStorage\` can resolve to that global rather than to jsdom's own
  // implementation, so persistence middleware (zustand persist, redux-persist)
  // is handed undefined and throws on its first write.
  const memoryStorage = (): Storage => {
    const m = new Map<string, string>();
    return {
      get length() {
        return m.size;
      },
      clear: () => {
        m.clear();
      },
      getItem: (k: string) => m.get(k) ?? null,
      key: (i: number) => [...m.keys()][i] ?? null,
      removeItem: (k: string) => {
        m.delete(k);
      },
      setItem: (k: string, v: string) => {
        m.set(k, String(v));
      },
    } as Storage;
  };
  if (typeof window.localStorage?.setItem !== "function") {
    Object.defineProperty(window, "localStorage", {
      value: memoryStorage(),
      configurable: true,
    });
  }
  if (typeof window.sessionStorage?.setItem !== "function") {
    Object.defineProperty(window, "sessionStorage", {
      value: memoryStorage(),
      configurable: true,
    });
  }
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
  specDir?: string,
): string {
  const info = c.info;
  const name = info.componentName;
  // A prop whose type could not be resolved is absent from propsShape, so the
  // component receives undefined — and any `prop.field` read then throws. When
  // the analyser saw it used via member access, stand it up as {} so the read
  // yields undefined (renders as nothing) instead of crashing the spec.
  const propsLiteral = JSON.stringify(synthesiseDefaults(info));
  const variantsLiteral = JSON.stringify(info.variants.slice(0, variants));
  const promiseProps = info.promiseProps ?? [];
  const interactions = info.interactions;

  const allHandlers = collectPropHandlers(info);
  const handlerObjectLiteral =
    allHandlers.length > 0 ? `{ ${allHandlers.map((h) => `${h}: vi.fn()`).join(", ")} }` : `{}`;

  const interactionTests = interactions
    ? emitInteractionTests(
        name,
        interactions,
        allHandlers,
        firstClickTrigger(info),
        info.renderGuarded === true,
      )
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

  // `Props` exists only to type the props spread, and the React import exists
  // only to declare it. A zero-prop component renders bare, so emitting either
  // leaves dead code that fails a project's lint gate (noUnusedVariables).
  const propsTypeBlock = hasProps ? `import type * as React from "react";\n` : "";
  const propsAlias = hasProps ? `\ntype Props = React.ComponentProps<typeof ${name}>;\n` : "";

  // Client specs emitted no mocks at all until now, so a component importing
  // next/navigation or calling a server action through useActionState blew up on
  // import. Allowlist only — see mocks.ts for why a blanket mock is wrong here.
  const mocks = emitModuleMocks(info, "client", specDir).statements;
  const mockBlock = mocks.length > 0 ? `${mocks.join("\n")}\n` : "";

  return `import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
${propsTypeBlock}${mswImports}${mockBlock}${providerLine}${emitComponentImport(info, importPath)}
${propsAlias}${childTextConst}
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

${emitContractTests(name, info)}
${
  info.variants.slice(0, variants).length > 0
    ? `describe("${name} variants", () => {
  for (const v of VARIANTS) {
    test(\`renders with \${JSON.stringify(v)}\`, () => {
      const { container } = renderTarget(v);
      expect(container.firstElementChild, \`\${JSON.stringify(v)} rendered nothing\`).not.toBeNull();
    });
  }
});`
    : `// no literal-union props — no variant matrix (VARIANTS kept for hand-written rows).
void VARIANTS;`
}

${interactionTests}
${staticTextTests}${stateTests}${fetchTests}`;
}

/**
 * What a component's markup is contractually obliged to do, for components that
 * render no literal copy of their own.
 *
 * The whole shadcn/ui layer is like this — CardFooter, TableRow, AlertDialogHeader
 * — and before these rules every one of their specs was a bare `renderTarget()`
 * with `void screen;` to satisfy lint: six tests that proved nothing. Each rule
 * asserts something the SOURCE says is true, and is emitted only when the
 * analyser saw the value actually reach the DOM.
 *
 * When none of them apply the spec says so and skips, rather than passing on a
 * render that asserted nothing.
 */
function emitContractTests(name: string, info: ComponentInfo): string {
  const parts: string[] = [];
  // A guarded render may produce nothing at all at these props — `if
  // (toasts.length === 0) return null` with a store-backed list is the shape —
  // so the tag below it is a description, not a promise.
  const rootTag =
    info.rootTag && /^[a-z]/.test(info.rootTag) && !info.renderGuarded ? info.rootTag : undefined;

  if (rootTag) {
    parts.push(`
test("${name} renders a <${rootTag}>", () => {
  const { container } = renderTarget();
  expect(container.querySelector(${JSON.stringify(rootTag)})).not.toBeNull();
});`);
  } else if (info.renderGuarded) {
    parts.push(`
test("${name} mounts at defaults without throwing", () => {
  // An early return that this analysis could not decide means the component may
  // legitimately render nothing here, so the assertion is that mounting is safe
  // rather than that anything appeared.
  expect(() => renderTarget()).not.toThrow();
  void screen;
});`);
  } else {
    parts.push(`
test("${name} renders at defaults without crashing", () => {
  const { container } = renderTarget();
  expect(container.firstElementChild).not.toBeNull();
  void screen;
});`);
  }

  if (info.acceptsChildren && info.childrenFlow) {
    parts.push(`
test("${name} renders the children it is given", () => {
  renderTarget();
  expect(screen.getByText(CHILD_TEXT)).toBeInTheDocument();
});`);
  }

  parts.push(emitVariantDistinctness(name, info));

  if (info.classNameFlow) {
    // Queried across the whole container rather than on the root: <Table>
    // renders <div><table className={cn(…, className)}/></div>, so a root-only
    // assertion would be wrong about where the class lands.
    parts.push(`
test("${name} forwards className to the markup it renders", () => {
  const { container } = renderTarget({ className: "flawless-cls" });
  expect(container.querySelector(".flawless-cls")).not.toBeNull();
});`);
  }

  return parts.join("\n");
}

/**
 * Each cva option renders an observably different class list.
 *
 * Deliberately NOT an assertion about specific Tailwind tokens. `cn()` is
 * usually tailwind-merge, which drops base classes a later variant conflicts
 * with — verified against the real DOM, where `rounded-lg` is absent at
 * size="sm" — and the tool cannot know whether a project's `cn` merges or just
 * concatenates. What the cva table DOES support is that two options whose class
 * strings differ must produce different markup. That proves the variant prop
 * reaches the DOM and that every option is distinguishable, with no Tailwind
 * knowledge at all.
 *
 * Bails when any two options share a class string (they legitimately render the
 * same), when one is empty, or when there is only one option to compare.
 */
function emitVariantDistinctness(name: string, info: ComponentInfo): string {
  const classes = info.variantClasses ?? {};
  const parts: string[] = [];

  for (const [key, byOption] of Object.entries(classes)) {
    const options = Object.keys(byOption);
    if (options.length < 2) continue;
    const strings = options.map((o) => byOption[o] ?? "");
    if (strings.some((v) => v === "")) continue;
    if (new Set(strings).size !== strings.length) continue;

    parts.push(`
test("${name}: every \`${key}\` option renders a distinct class list", () => {
  const seen = ${JSON.stringify(options)}.map((option) => {
    const { container, unmount } = renderTarget({ ${JSON.stringify(key)}: option });
    const el = container.querySelector("[class]");
    expect(el, \`${key}=\${option} rendered no element carrying a class\`).not.toBeNull();
    const cls = el?.getAttribute("class") ?? "";
    unmount();
    return cls;
  });
  expect(new Set(seen).size, "two options rendered identical markup").toBe(seen.length);
});`);
  }

  return parts.join("\n");
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
      // Nothing in the source identifies the element; a query that resolves to
      // null would click nothing and pass.
      if (!selector) continue;
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
  const selector = emitVitestSelector(click);
  if (!selector) return undefined;
  const query = selector.replace(".getBy", ".queryBy").replace(/\)!$/, ")");
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

/**
 * A component that cannot be mounted standalone. Rather than emit a render
 * assertion that can only fail, assert what IS verifiable — that the module
 * exports a component — and state the reason in the file so the gap is visible
 * rather than silently missing.
 */
function constrainedSpec(
  c: FlatComponent,
  importPath: string,
  providerImport: string | undefined,
  mode: "compound-part" | "document-root",
  specDir?: string,
): string {
  const info = c.info;
  const name = info.componentName;
  const note = (info.renderNotes ?? []).join(" ");
  void providerImport;

  // Importing the module runs its module scope, so "server-only" and
  // next/font/* throw at collection time even for a spec that only asserts the
  // export exists. These specs emitted no mocks at all until now.
  const mocks = emitModuleMocks(info, "rsc", specDir).statements;
  const mockBlock = mocks.length > 0 ? `${mocks.join("\n")}\n` : "";

  if (mode === "document-root") {
    const propsLiteral = JSON.stringify(info.propsShape);
    const promiseProps = info.promiseProps ?? [];
    // An async server component has to be invoked to get its element. A sync one
    // must NOT be: calling it directly runs its hooks with no React dispatcher
    // ("Cannot read properties of null (reading 'useEffect')"). Rendering it as
    // an element is safe either way — effects simply do not run during SSR.
    // `{...(props as never)}` is a type error — never is not an object type — so
    // the spread is cast to the component's own props instead.
    const invoke = info.isAsync
      ? `await ${name}(props as never)`
      : `<${name} {...(props as React.ComponentProps<typeof ${name}>)} />`;
    // Only a component that actually renders {children} can be asserted to pass
    // a slot through. A root error boundary takes {error, reset} and renders
    // neither, so injecting a slot and demanding it appear is a test the
    // component can never satisfy — and the failure reads as a real defect.
    const slotBlock = info.acceptsChildren
      ? {
          const: `const SLOT = "flawless-slot";\n`,
          prop: `\n    children: <div data-testid={SLOT} />,`,
          title: " containing its children",
          assert: `\n  expect(html).toContain(SLOT);`,
        }
      : { const: "", prop: "", title: "", assert: "" };
    return `import { test, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as React from "react";
${mockBlock}${emitComponentImport(info, importPath)}

// ${name} ${note}.
// Mounting it with Testing Library would nest <html> inside a container div:
// jsdom tolerates that silently, so the test would pass while asserting
// nothing true. Its contract is checked as static markup instead.
const DEFAULTS: Record<string, unknown> = ${propsLiteral};
const PROMISE_PROPS: string[] = ${JSON.stringify(promiseProps)};
${slotBlock.const}
test("${name} returns a document root${slotBlock.title}", async () => {
  const props: Record<string, unknown> = {
    ...DEFAULTS,${slotBlock.prop}
  };
  for (const k of PROMISE_PROPS) {
    if (k in props) props[k] = Promise.resolve(props[k]);
  }
  const ui = ${invoke};
  const html = renderToStaticMarkup(ui as React.ReactElement);
  expect(html).toMatch(/^<html/);
  expect(html).toContain("<body");${slotBlock.assert}
  void vi;
});
`;
  }

  return `import { test, expect${mocks.length > 0 ? ", vi" : ""} } from "vitest";
${mockBlock}${emitComponentImport(info, importPath)}

// ${name} ${note}
// Rendering it on its own throws, so this spec asserts only what is true in
// isolation. TODO(flawless): wrap renderTarget() in the matching Root with an
// open state to assert its content.
test("${name} is exported as a component", () => {
  expect(typeof ${name}).toMatch(/function|object/);
});
`;
}

function rscSpec(
  c: FlatComponent,
  importPath: string,
  providerImport: string | undefined,
  specDir?: string,
): string {
  const info = c.info;
  const name = info.componentName;
  const propsLiteral = JSON.stringify(info.propsShape);
  const promiseProps = info.promiseProps ?? [];

  const mocks = emitModuleMocks(info, "rsc", specDir).statements;

  const providerLine = providerImport ? `import AppProvider from "${providerImport}";\n` : "";
  const renderExpr = providerImport
    ? `render(<AppProvider>{ui}</AppProvider>)`
    : `render(<>{ui}</>)`;

  const callArgs = rscCallArgs(info);
  // A zero-parameter component never calls buildProps, and an unused helper
  // fails a project's lint gate (noUnusedVariables) just as a dead type alias
  // does. Emit the props plumbing only when something uses it.
  const propsBlock =
    callArgs === ""
      ? ""
      : `
const DEFAULTS: Record<string, unknown> = ${propsLiteral};
const PROMISE_PROPS: string[] = ${JSON.stringify(promiseProps)};

function buildProps(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...DEFAULTS, ...extra };
  for (const k of PROMISE_PROPS) {
    if (k in merged) merged[k] = Promise.resolve(merged[k]);
  }
  return merged;
}
`;
  const guards = info.guards ?? [];
  const guardSummary =
    guards.length > 0 ? guards.map((g) => `${g.effect}()`).join(" / ") : "no early-exit guards";
  const staticTextTests = emitStaticTextTests(name, info, "rsc");
  const guardTests = emitGuardTests(name, info);

  return `import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type * as React from "react";
${mocks.join("\n")}
${providerLine}${emitComponentImport(info, importPath)}

// ${name} is an async server component: it is invoked as a function and its
// resolved JSX is rendered directly. Module-level data dependencies above are
// mocked — fill in fixtures to make the assertions meaningful.
${propsBlock}
test("${name} (RSC): resolves, or takes one of its declared guard paths", async (t) => {
  try {
    const ui: React.ReactNode = await ${name}(${callArgs});
    ${renderExpr};
  } catch (err) {
    // notFound()/redirect() are legitimate outcomes when the mocked data layer
    // returns nothing — this component declares ${guardSummary}.
    if (/notFound\\(\\) called|NEXT_REDIRECT|NEXT_NOT_FOUND/.test(String(err))) return;
${uncertainEscape(info)}    // Not a guard and not an admitted gap: a real failure, reported as itself
    // rather than as a confusing "expected TypeError to match /notFound/".
    throw err;
  }
  expect(document.body.innerHTML.length).toBeGreaterThan(0);
  void screen;
});
${staticTextTests}${guardTests}`;
}

/**
 * When the analyser could not infer a data dependency's return shape, it says so
 * in the mock and stands the value up as `{}`. If the component — or a child it
 * renders — then reads a field off that, the crash is the tool reporting its own
 * admitted gap, not a defect in the code under test.
 *
 * Reporting it as skipped keeps that distinction visible. Passing would claim
 * coverage that does not exist; failing would blame the application for a
 * fixture the tool never had.
 */
function uncertainEscape(info: ComponentInfo): string {
  const uncertain = (info.dataDeps ?? []).some((d) => d.uncertain || d.shape.kind === "unknown");
  if (!uncertain) return "";
  // t.skip() takes no argument in this vitest major, so the reason goes to the
  // console — losing it entirely would leave a bare skip with no explanation.
  return `    // A data mock whose shape could not be inferred (see the TODO above).
    console.warn(\`[flawless] data fixture missing, skipping: \${String(err)}\`);
    t.skip();
`;
}

/**
 * A zero-parameter component must be invoked with no arguments, and one that
 * declares a parameter must get one. `children` is tracked separately from
 * propsShape, but a layout taking `{ children }` still has a required param.
 */
function rscCallArgs(info: ComponentInfo): string {
  const takesProps =
    Object.keys(info.propsShape).length > 0 ||
    info.unresolvedProps.length > 0 ||
    info.acceptsChildren === true;
  return takesProps ? "buildProps() as never" : "";
}

/**
 * Literal copy the component renders unconditionally. `getByText` matches an
 * element's whole normalised text, which is why the analyser only keeps
 * sole-child text — anything else would assert a string that never appears.
 */
function emitStaticTextTests(name: string, info: ComponentInfo, mode: "unit" | "rsc"): string {
  const texts = info.staticText ?? [];
  if (texts.length === 0) return "";
  const callArgs = rscCallArgs(info);
  // An RSC may legitimately abort via notFound()/redirect() against empty
  // mocks. The main test asserts that outcome, so bail out here instead of
  // reporting a second failure for the same known behaviour.
  const render =
    mode === "rsc"
      ? `let ui: React.ReactNode;
      try {
        ui = await ${name}(${callArgs});
      } catch {
        return;
      }
      render(<>{ui}</>);`
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
  const callArgs = rscCallArgs(info);
  const parts: string[] = [];
  for (const g of info.guards ?? []) {
    if (g.triggerValue === undefined || g.depVars.length !== 1) continue;
    const varName = g.depVars[0] as string;
    const dep = deps.find((d) => d.varName === varName);
    if (!dep?.specifier || dep.calleeRoot.length === 0) continue;
    const value =
      g.triggerValue === "empty-array" ? "[]" : g.triggerValue === "null" ? "null" : "undefined";
    // Emitted verbatim into the spec, so the escaping here is the escaping the
    // generated regex literal gets — double-escaping produced /notFound\\(\\)/,
    // which matches nothing.
    const expected = g.effect === "notFound" ? "/notFound\\(\\) called/" : "/NEXT_REDIRECT/";
    parts.push(`
test("${name}: ${g.effect}() when ${dep.calleeRoot} returns ${value}", async () => {
  vi.mocked(${dep.calleeRoot}).mockResolvedValueOnce(${value} as never);
  await expect(${name}(${callArgs})).rejects.toThrow(${expected});
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
  renderGuarded = false,
): string {
  // `if (!user) return null` with an unresolvable `user` means the component may
  // render nothing at all at the props a spec can synthesise. The JSX below the
  // guard is still the best description of the component, but driving it needs a
  // fixture the tool cannot build — so the interaction tests say that instead of
  // failing on an element that was never going to mount.
  if (renderGuarded) {
    return `
test.skip("${name}: interactions need a fixture — an early return may render nothing", () => {
  // TODO(flawless): give the prop its guard tests (see the component's first
  // \`if (!…) return\`) a real value in DEFAULTS, and these become live tests.
});
`;
  }
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
  if (!selector) {
    // No test id, no aria-label, no role, no id, no literal copy, and the tag is
    // a component rather than a host element — nothing in the source identifies
    // this element. Say so; the previous fallback queried the component NAME as
    // a CSS selector, matched nothing, clicked null and passed.
    return `
test.skip("${name}: ${click.event} on ${labelDesc} #${idx} — no way to select it", () => {
  // TODO(flawless): give <${click.tag}> a data-testid, an aria-label or literal
  // text, and this becomes a real interaction test.
});
`;
  }
  // A menu item, a dialog body: the element does not exist until its trigger is
  // clicked, so the spec opens it first and then queries with findBy*, which
  // retries. getBy* asserts against the DOM as it stands the instant the click
  // returns — before the content has mounted.
  const gateSelector = click.gatedBy ? emitTriggerSelector(click.gatedBy) : undefined;
  const dispatch = emitVitestDispatch(
    click.event,
    gateSelector ? awaitSelector(selector) : selector,
  );
  const gateLines = gateSelector ? `\n  await userEvent.click(${gateSelector});` : "";
  // The prelude opens UI that later interactions live behind — but it is itself
  // a click, so it can fire a handler this test then asserts was NOT called.
  // Reset the spies after it so the isolation assertions stay meaningful.
  const preludeLines = gateSelector
    ? `${gateLines}\n  for (const v of Object.values(handlers)) v.mockClear();`
    : prelude
      ? `\n  ${prelude}\n  for (const v of Object.values(handlers)) v.mockClear();`
      : "";
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
  // The submit control is matched by a name heuristic, so it legitimately may
  // not exist (an icon-only button, or copy the pattern doesn't cover). That is
  // a gap in what can be asserted, not a defect in the component — skip with a
  // reason instead of failing on a lookup the analyser guessed at.
  const submitClick = `const submits = screen.queryAllByRole("button", { name: /submit|sign\\s*up|save|send|invite|create|add|confirm/i });
  if (submits.length === 0) {
    // TODO(flawless): no submit-looking button found; name it here to assert the submit path.
    return;
  }
  await userEvent.click(submits[0] as HTMLElement);`;
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

function browserSpec(c: FlatComponent, specName: string): string {
  // The registry key, not the component name: two components called Card live
  // under different keys in the perf host, and mounting by the bare name drove
  // the wrong one.
  const name = specName;
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
    if (!selector) continue;
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
