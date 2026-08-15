import path from "node:path";
import { requiredAncestors } from "../analyse/htmlContentModel.ts";
import { relativeToEmitted } from "../emitPaths.ts";
import {
  allocateSpecNames,
  flattenTrees,
  functionProps,
  hostEligibility,
  synthesiseDefaults,
} from "../scaffold-tests/registry.ts";
import { emitPlaywrightClickTarget } from "../scaffold-tests/selectors.ts";
import type { ComponentInfo, ComponentTree, HeapMode, MockRoute, PropsShape } from "../types.ts";

const NL = "\n";

interface FlatComponent {
  info: ComponentInfo;
  importPath: string;
  /** Registry key. Differs from componentName when two components share a name. */
  specName: string;
}

export interface ExcludedComponent {
  name: string;
  file: string;
  reason: string;
}

export interface RenderedFile {
  relPath: string;
  content: string;
  executable?: boolean;
  /**
   * Never overwrite an existing file here, `--force` included.
   *
   * For the files whose contents cannot be recovered from the analysis — the
   * same criterion `provider.fixtures.ts` and `e2e/global-setup.ts` are held to.
   * Everything else in the suite is derived and must stay regenerable, or an
   * existing suite never receives a later version's improvements.
   */
  writeOnce?: boolean;
}

export interface RenderOptions {
  tree: ComponentTree;
  /** How much of the V8 heap the emitted profile suite keeps. */
  heaps?: HeapMode;
  extraTrees?: ComponentTree[];
  outDir: string;
  variants: number;
  report: boolean;
  providerImportPath?: string;
  mockRoutes?: MockRoute[];
  suiteName?: string;
  nextjsHost?: boolean;
  mswSetup?: boolean;
}

export function renderSuite(opts: RenderOptions): RenderedFile[] {
  const trees: ComponentTree[] = [opts.tree, ...(opts.extraTrees ?? [])];
  const { hosted: flat, excluded, serverActionStubs } = selectHostComponents(trees, opts.outDir);
  const hasMock = Array.isArray(opts.mockRoutes);
  const useMsw = Boolean(opts.mswSetup);
  const suiteName = opts.suiteName ?? trees[0]?.entry.componentName ?? "suite";
  const files: RenderedFile[] = [
    { relPath: "playwright.config.ts", content: playwrightConfig(hasMock) },
    {
      relPath: "host/server.ts",
      content: hostServer(hasMock, serverActionStubs, path.join(opts.outDir, "host")),
    },
    { relPath: "host/index.html", content: hostHtml() },
    { relPath: "host/_polyfill.ts", content: hostPolyfill() },
    // writeOnce: docs/extending.md tells you to edit this to add providers and
    // MSW, and nothing can rebuild that wiring from the analysis.
    {
      relPath: "host/main.tsx",
      content: hostMain(flat, opts.providerImportPath, useMsw),
      writeOnce: true,
    },
    { relPath: "profile/_helpers.ts", content: helpers() },
    { relPath: "profile/_heap.ts", content: heapHelper(opts.heaps ?? "stress") },
    // writeOnce: docs/generated-suite.md tells you to tighten these to your
    // observed p95. A regenerated default silently un-tightens the gate.
    { relPath: "budgets.json", content: budgets(flat, opts.variants), writeOnce: true },
    {
      relPath: "README.md",
      content: readme(
        suiteName,
        flat.map((c) => c.specName),
        excluded,
      ),
    },
  ];
  if (!opts.nextjsHost) {
    files.unshift({ relPath: "tsconfig.json", content: tsConfig() });
    files.unshift({ relPath: "package.json", content: pkgJson(suiteName, opts.report) });
  }
  for (const c of flat) {
    files.push({
      relPath: `profile/${c.specName}.profile.spec.ts`,
      content: spec(c, opts.variants),
    });
  }
  if (hasMock) {
    files.push({ relPath: "mock/server.ts", content: mockServer() });
    files.push({ relPath: "mock/routes.ts", content: mockRoutesFile(opts.mockRoutes ?? []) });
  }
  if (opts.report) {
    files.push({ relPath: "scripts/report.mjs", content: reportScript(), executable: true });
  }
  return files;
}

export function toHostRelImport(outDir: string, absFile: string): string {
  const hostDir = path.resolve(outDir, "host");
  return toRel(hostDir, path.resolve(absFile));
}

/**
 * The components the host can actually mount, plus what was left out and why.
 *
 * The old implementation deduped on filePath alone, so a file exporting seven
 * components contributed one — 84 of the dogfood app's 181 vanished without a
 * word. It also keyed imports and the REGISTRY on the bare component name, which
 * does not compile when two files both export a CommentForm, and it emitted
 * `import { X }` for default exports and for components that are not exported at
 * all.
 *
 * Names are allocated over the FULL list before filtering, so they match the
 * unit scaffolder's — the browser specs look components up by these keys.
 */
function selectHostComponents(
  trees: ComponentTree[],
  outDir: string,
): {
  hosted: FlatComponent[];
  excluded: ExcludedComponent[];
  /** Absolute path → the export names a hosted component imports from it. */
  serverActionStubs: Map<string, string[]>;
} {
  const hostDir = path.resolve(outDir, "host");
  const flat = flattenTrees(trees);
  const specNames = allocateSpecNames(flat);

  const hosted: FlatComponent[] = [];
  const excluded: ExcludedComponent[] = [];
  const serverActionStubs = new Map<string, string[]>();
  for (const c of flat) {
    const verdict = hostEligibility(c.info);
    if (!verdict.eligible) {
      excluded.push({
        name: c.info.componentName,
        file: c.info.filePath,
        reason: verdict.reason ?? "not eligible",
      });
      continue;
    }
    for (const mi of c.info.moduleImports ?? []) {
      if (!mi.isServerAction || !mi.resolvedPath || mi.isTypeOnly) continue;
      const names = new Set(serverActionStubs.get(mi.resolvedPath) ?? []);
      for (const n of mi.serverActionExports ?? mi.names) names.add(n);
      // Sorted, not Set order: the emitted file has to be byte-identical across
      // runs or the idempotence gate churns.
      serverActionStubs.set(mi.resolvedPath, [...names].sort());
    }
    hosted.push({
      info: c.info,
      // No .tsx: the host is type-checked by the target project, which does not
      // enable allowImportingTsExtensions.
      importPath: stripTsExt(toRel(hostDir, c.info.filePath)),
      specName: specNames.get(c) as string,
    });
  }
  return { hosted, excluded, serverActionStubs };
}

function stripTsExt(spec: string): string {
  return spec.replace(/\.(tsx|ts|jsx|js)$/, "");
}

/**
 * Safe inside the emitted `test.skip(\`...\`)` template literal.
 *
 * A skip reason quotes the source — a tag name, a prop name — so it can carry a
 * backtick or a `${`, either of which would end the literal early and emit a
 * spec that does not parse.
 */
function titleSafe(reason: string): string {
  return reason.replace(/`/g, "'").replace(/\$\{/g, "$ {");
}

/** Named vs default import, aliased when the registry key differs from the name. */
function hostComponentImport(c: FlatComponent): string {
  const { componentName, exportKind } = c.info;
  if (exportKind === "default") return `import ${c.specName} from "${c.importPath}";`;
  if (c.specName === componentName) {
    return `import { ${componentName} } from "${c.importPath}";`;
  }
  return `import { ${componentName} as ${c.specName} } from "${c.importPath}";`;
}

function toRel(fromDir: string, absFile: string): string {
  let rel = path.relative(fromDir, absFile);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.split(path.sep).join("/");
}

function pkgJson(name: string, report: boolean): string {
  const dashed = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return `${JSON.stringify(
    {
      name: `${dashed}-profile`,
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        test: "playwright test",
        // Same command under the name --run-tests looks for. Without it, a
        // standalone perf-harness run with --run-tests reported "failed suites:
        // perf" on a suite that was fine, because `bun run test:perf` did not
        // exist — the key is only added when unit-browser also ran.
        "test:perf": "playwright test",
        "test:headed": "playwright test --project=interactive",
        // Only when scripts/report.mjs is emitted beside it. Declared
        // unconditionally, `bun run report` on a suite generated without
        // --report failed with a module-not-found naming a file the user never
        // asked for and cannot restore without regenerating.
        ...(report ? { report: "node ./scripts/report.mjs" } : {}),
      },
      dependencies: {
        react: "^18.3.0",
        "react-dom": "^18.3.0",
        "react-scan": "^0.4.3",
      },
      devDependencies: {
        "@playwright/test": "^1.49.0",
        "@types/node": "^22.0.0",
        "@types/react": "^18.3.0",
        "@types/react-dom": "^18.3.0",
        typescript: "^5.6.0",
      },
    },
    null,
    2,
  )}\n`;
}

function tsConfig(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        lib: ["ESNext", "DOM"],
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        skipLibCheck: true,
        esModuleInterop: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        resolveJsonModule: true,
      },
      // mock/ is emitted TypeScript like the rest and was outside this list, so
      // `bunx tsc --noEmit` inside a generated suite type-checked everything
      // except the server it tells you to run. scripts/ is deliberately still
      // out: it holds one .mjs, and tsc ignores JS without allowJs/checkJs, so
      // the glob would look like coverage and give none — that file is covered
      // by running it under node in tests/emittedExecution.test.ts instead.
      include: ["host/**/*", "profile/**/*", "mock/**/*", "playwright.config.ts"],
    },
    null,
    2,
  )}\n`;
}

function playwrightConfig(hasMock: boolean): string {
  const hostServerBlock = `{
    command: "bun host/server.ts",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  }`;
  const mockServerBlock = `{
    command: "bun mock/server.ts",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  }`;
  const webServerField = hasMock
    ? `webServer: [\n    ${hostServerBlock},\n    ${mockServerBlock},\n  ]`
    : `webServer: ${hostServerBlock}`;

  return `import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./profile",
  // Anchored to this file, not to the directory the command was typed in.
  // Playwright's default put traces in <app>/test-results/ while the .gitignore
  // the tool writes covers flawless/test-results/ — 347MB of untracked output.
  outputDir: path.join(__dirname, "test-results"),
  // One worker gives the cleanest timings; more give a fast verification run.
  // Budgets only warn, so parallel measurement never fails a run — but it does
  // make the numbers noisier, so CI (where a recorded number usually matters)
  // keeps one, and FLAWLESS_WORKERS=1 forces it anywhere else.
  fullyParallel: true,
  workers: process.env.FLAWLESS_WORKERS
    ? Number(process.env.FLAWLESS_WORKERS)
    : process.env.CI
      ? 1
      : undefined,
  // The JSON entry is what scripts/report.mjs reads. It goes under outputDir,
  // which is already gitignored and which Playwright clears at the START of a
  // run — the reporter writes at the end, so the file survives the run that
  // produced it. The HTML report cannot serve this purpose: it stores stdout
  // inside a base64 zip blob.
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(__dirname, "test-results", "results.json") }],
    ["html", { open: "never", outputFolder: path.join(__dirname, "playwright-report") }],
  ],
  preserveOutput: "always",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  ${webServerField},
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "interactive", use: { ...devices["Desktop Chrome"], headless: false } },
  ],
});
`;
}

function hostServer(
  hasMock: boolean,
  serverActionStubs = new Map<string, string[]>(),
  hostDir = "",
): string {
  const mockProxyBlock = hasMock
    ? `
    // Proxy any other request to the mock server so the component's relative
    // fetch calls (\`/api/...\`) reach the OpenAPI-derived mock without code
    // changes. Headers and body pass through unchanged.
    if (url.pathname !== "/" && url.pathname !== "/index.html" && url.pathname !== "/bundle.js") {
      const target = "http://127.0.0.1:" + MOCK_PORT + url.pathname + url.search;
      return fetch(target, {
        method: req.method,
        headers: req.headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      });
    }`
    : "";
  const mockPortConst = hasMock ? `const MOCK_PORT = Number(process.env.MOCK_PORT ?? 5174);\n` : "";

  // "use server" modules a hosted component imports. Bundling them for the
  // browser pulls in the database driver, the mailer and Node builtins — the
  // build fails outright, and since the host is ONE bundle that takes every
  // profile test with it. They are intercepted by absolute path so no resolution
  // guessing is involved, and each stub carries the real export names: ESM named
  // imports have to bind, which a catch-all default export cannot satisfy.
  const stubEntries = [...serverActionStubs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const stubSources = stubEntries
    .map(([abs, names]) => {
      const body = names
        .map((n) =>
          n === "default"
            ? `export default async () => ({});`
            : `export const ${n} = async () => ({});`,
        )
        .join("\n");
      // Relative to this file, resolved back to absolute when the map is built.
      // Bun's onLoad hands us an absolute `args.path`, so the KEYS must be
      // absolute at runtime — but an absolute key in the committed source names
      // the machine that generated it, and every stub would miss on any other
      // checkout, putting pg and nodemailer back into the browser bundle.
      const key = hostDir ? relativeToEmitted(hostDir, abs) : abs;
      return `  ${JSON.stringify(key)}: ${JSON.stringify(body || "export {};")},`;
    })
    .join("\n");
  const stubPlugin = `
// Path relative to this file -> replacement source, resolved to the absolute
// paths Bun's onLoad reports. See the comment where this was generated.
const SERVER_STUB_SOURCES: Record<string, string> = {
${stubSources}
};
const SERVER_STUBS: Record<string, string> = Object.fromEntries(
  Object.entries(SERVER_STUB_SOURCES).map(([rel, src]) => [path.resolve(HOST_DIR, rel), src]),
);

const stubServerModules: BunPlugin = {
  name: "flawless-server-stubs",
  setup(build) {
    build.onLoad({ filter: /\\.(ts|tsx)$/ }, (args) => {
      const src = SERVER_STUBS[args.path];
      return src ? { contents: src, loader: "ts" } : undefined;
    });
  },
};
if (Object.keys(SERVER_STUBS).length > 0) {
  console.log(
    "[flawless] stubbed " + Object.keys(SERVER_STUBS).length + " server-action module(s) for the browser bundle",
  );
}
`;

  return `import path from "node:path";
import type { BunPlugin } from "bun";

const HOST_DIR = import.meta.dir;
const SUITE_DIR = path.dirname(HOST_DIR);
const PORT = Number(process.env.PORT ?? 5173);
${mockPortConst}

// Resolve bare specifiers ("react", "react-dom/client", etc.) against the
// suite's node_modules instead of the importing file's directory. Component
// files often live outside the suite (e.g. in the user's repo, or in a
// fixtures directory with no React installed); without this plugin those
// imports fail to resolve.
const resolveFromSuite: BunPlugin = {
  name: "resolve-from-suite",
  setup(build) {
    build.onResolve({ filter: /^[a-zA-Z@][^:]*$/ }, (args) => {
      try {
        return { path: Bun.resolveSync(args.path, SUITE_DIR) };
      } catch {
        return; // fall through to Bun's default resolver
      }
    });
  },
};

${stubPlugin}
const built = await Bun.build({
  entrypoints: [path.join(HOST_DIR, "main.tsx")],
  target: "browser",
  format: "esm",
  splitting: false,
  sourcemap: "inline",
  minify: false,
  plugins: [stubServerModules, resolveFromSuite],
  // Replace bare \`global\` references at build time. The runtime polyfill
  // (host/_polyfill.ts, imported first from main.tsx) handles \`process\`.
  define: {
    global: "globalThis",
  },
});

if (!built.success) {
  for (const log of built.logs) console.error(log);
  throw new Error("host bundle failed");
}

const bundle = await built.outputs[0]?.text();
if (!bundle) throw new Error("host bundle produced no output");

const indexHtml = await Bun.file(path.join(HOST_DIR, "index.html")).text();

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml, { headers: { "content-type": "text/html" } });
    }
    // MSW registers its worker from the page origin, so the host has to serve
    // it. Without this the registration 404s on every boot.
    if (url.pathname === "/mockServiceWorker.js") {
      try {
        const swPath = Bun.resolveSync("msw/mockServiceWorker.js", SUITE_DIR);
        return new Response(Bun.file(swPath), {
          headers: { "content-type": "text/javascript", "service-worker-allowed": "/" },
        });
      } catch {
        return new Response("// msw not installed", {
          status: 404,
          headers: { "content-type": "text/javascript" },
        });
      }
    }
    if (url.pathname === "/bundle.js") {
      return new Response(bundle, { headers: { "content-type": "application/javascript" } });
    }${mockProxyBlock}
    return new Response("not found", { status: 404 });
  },
});

console.log("host listening on http://127.0.0.1:" + PORT);
`;
}

function hostHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>flawless-react host</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/bundle.js"></script>
  </body>
</html>
`;
}

function hostPolyfill(): string {
  return `// Browser polyfill for Node-only globals referenced at module init by some
// runtime deps (e.g. react-performance-testing's CJS build reads
// process.env.RPT_SKIP_AUTO_CLEANUP before any user code runs).
//
// Imported first from main.tsx — ESM evaluates imports in source order, so
// globalThis is patched before any other module is initialised.
const g = globalThis as unknown as {
  process?: { env: Record<string, string | undefined>; platform: string; versions: Record<string, string>; argv: string[] };
  global?: typeof globalThis;
  setImmediate?: (fn: (...args: unknown[]) => void, ...args: unknown[]) => number;
};

if (typeof g.process === "undefined") {
  g.process = { env: { NODE_ENV: "development" }, platform: "browser", versions: {}, argv: [] };
}
if (typeof g.global === "undefined") {
  g.global = globalThis;
}
if (typeof g.setImmediate === "undefined") {
  // react-performance-testing schedules its task queue via setImmediate; falling
  // back to a microtask is good enough for our profiling needs.
  g.setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) =>
    setTimeout(fn, 0, ...args)) as unknown as typeof g.setImmediate;
}

export {};
`;
}

function hostMain(flat: FlatComponent[], providerImportPath?: string, mswSetup = false): string {
  const imports = flat.map(hostComponentImport).join(NL);

  // Cast per entry: a component declaring required props is not assignable to
  // the host's loose (props: Record<string, unknown>) => unknown signature, and
  // supplying those props is exactly what the profile spec does at runtime.
  const registry = flat
    .map((c) => `  ${JSON.stringify(c.specName)}: ${c.specName} as unknown as Component,`)
    .join(NL);

  // Function props cannot cross page.evaluate's structured clone, so a spec's
  // DEFAULTS can never carry one. The component then calls undefined: AuthError
  // renders <Button onClick={reset}> and threw the moment the click landed. The
  // host holds the names and supplies no-ops on this side of the boundary.
  const fnProps = flat
    .map((c) => ({ name: c.specName, props: functionProps(c.info) }))
    .filter((e) => e.props.length > 0)
    .map((e) => `  ${JSON.stringify(e.name)}: ${JSON.stringify(e.props)},`)
    .join(NL);

  // Components whose root tag HTML only permits inside a particular parent.
  // Rendering <tbody> into the host's #root div made React log "In HTML, <tbody>
  // cannot be a child of <div>", which failed seven table primitives for a
  // warning the harness itself caused.
  const wrapIn = flat
    .map((c) => ({ name: c.specName, chain: requiredAncestors(c.info.rootTag) }))
    .filter((e) => e.chain.length > 0)
    .map((e) => `  ${JSON.stringify(e.name)}: ${JSON.stringify(e.chain)},`)
    .join(NL);

  const providerImport = providerImportPath
    ? `import AppProvider from ${JSON.stringify(stripTsExt(providerImportPath))};\n`
    : "";
  const wrapBody = providerImportPath ? "createElement(AppProvider as never, null, tree)" : "tree";
  const mswImport = mswSetup ? `import { startMockWorker } from "../mocks/browser";\n` : "";
  const mswBoot = mswSetup
    ? `
// Boot MSW before any component mounts so fetch() in render-time effects is
// intercepted. Failure is NOT fatal: this await sits at module top level, so a
// rejection would abort the module and leave window.__profile undefined —
// every profile test then times out waiting for a harness that never loaded,
// which is a very confusing way to learn that a service worker 404'd.
try {
  await startMockWorker();
} catch (err) {
  console.warn("[flawless] MSW did not start; fetches will hit the network:", err);
}
`
    : "";

  return `import "./_polyfill";
import { createElement, Profiler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { scan } from "react-scan";
${mswImport}${providerImport}${imports}
${mswBoot}

// We measure renders with React's built-in Profiler rather than
// react-performance-testing's patching: the latter only instruments the
// classic JSX runtime (\`React.createElement\`), and Bun.build emits JSX via
// the automatic \`react/jsx-runtime\`. Profiler works with either runtime and
// across React versions, so the host stays portable.
type Component = (props: Record<string, unknown>) => unknown;

const REGISTRY: Record<string, Component> = {
${registry}
};

/** Props the component calls, which a serialised props object cannot carry. */
const FN_PROPS: Record<string, string[]> = {
${fnProps}
};

/** Ancestors HTML requires around a component's root tag, outermost first. */
const WRAP_IN: Record<string, string[]> = {
${wrapIn}
};

function withFnProps(name: string, props: Record<string, unknown>): Record<string, unknown> {
  const names = FN_PROPS[name];
  if (!names) return props;
  const out = { ...props };
  for (const p of names) if (out[p] === undefined) out[p] = () => {};
  return out;
}

function nest(name: string, tree: ReactNode): ReactNode {
  const chain = WRAP_IN[name];
  if (!chain) return tree;
  let out = tree;
  for (let i = chain.length - 1; i >= 0; i--) out = createElement(chain[i] as string, null, out);
  return out;
}

interface RenderCountField { value: number }
interface RenderTimeField { mount?: number; updates?: number[] }

const renderCount: Record<string, RenderCountField | undefined> = {};
const renderTime: Record<string, RenderTimeField | undefined> = {};

let activeRoot: Root | undefined;
let activeName: string | undefined;

const scanEvents: Array<{ name: string; reason: string; ts: number }> = [];

scan({
  enabled: true,
  log: false,
  onRender: (fiber: { type?: { displayName?: string; name?: string } }, renders: unknown[]) => {
    const name = fiber.type?.displayName ?? fiber.type?.name ?? "anonymous";
    for (const r of renders as Array<{ changes?: unknown[]; unnecessary?: boolean; reason?: string }>) {
      if (r.unnecessary) {
        scanEvents.push({
          name,
          reason: r.reason ?? "unnecessary rerender",
          ts: performance.now(),
        });
      }
    }
  },
});

// The last exception React swallowed on our behalf. Without it every render
// failure looked identical — "did not render within 5000ms" — no matter whether
// the component threw on a missing prop, a missing provider or a bad import.
let lastRenderError: unknown;

function ensureRoot(): Root {
  if (activeRoot) return activeRoot;
  const el = document.getElementById("root");
  if (!el) throw new Error("#root not found");
  activeRoot = createRoot(el, {
    onUncaughtError: (err: unknown) => {
      lastRenderError = err;
    },
  });
  return activeRoot;
}

// Wrap the profiled component tree in the user's Provider (if --provider was
// passed at scaffold time). Without a provider this is the identity function,
// so call sites stay uniform.
function wrap(tree: ReactNode): ReactNode {
  return ${wrapBody};
}

function onProfile(id: string, phase: string, actualDuration: number): void {
  const c = renderCount[id] ?? (renderCount[id] = { value: 0 });
  c.value += 1;
  const t = renderTime[id] ?? (renderTime[id] = {});
  if (phase === "mount") {
    t.mount = actualDuration;
  } else {
    (t.updates ??= []).push(actualDuration);
  }
}

declare global {
  interface Window {
    __profile: {
      mount(name: string, props: Record<string, unknown>): Promise<void>;
      rerender(name: string, props: Record<string, unknown>): Promise<void>;
      unmount(): Promise<void>;
      getRenderInfo(): { renderCount: unknown; renderTime: unknown };
      getScanEvents(): typeof scanEvents;
      clearScanEvents(): void;
      list(): string[];
    };
  }
}

window.__profile = {
  list: () => Object.keys(REGISTRY),
  async mount(name, props) {
    const Comp = REGISTRY[name];
    if (!Comp) throw new Error("unknown component: " + name);
    activeName = name;
    lastRenderError = undefined;
    ensureRoot().render(
      wrap(
        createElement(
          Profiler,
          { id: name, onRender: onProfile },
          nest(name, createElement(Comp as never, withFnProps(name, props))),
        ),
      ),
    );
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      if ((renderCount[name]?.value ?? 0) >= 1) return;
      if (lastRenderError) break;
      await new Promise<void>((res) => requestAnimationFrame(() => res()));
    }
    const cause = lastRenderError
      ? ": " + (lastRenderError instanceof Error ? lastRenderError.message : String(lastRenderError))
      : " within 5000ms";
    throw new Error("mount: " + name + " did not render" + cause);
  },
  async rerender(name, props) {
    if (!activeRoot) throw new Error("mount first");
    const Comp = REGISTRY[name];
    if (!Comp) throw new Error("unknown component: " + name);
    activeRoot.render(
      wrap(
        createElement(
          Profiler,
          { id: name, onRender: onProfile },
          nest(name, createElement(Comp as never, withFnProps(name, props))),
        ),
      ),
    );
    activeName = name;
    await new Promise<void>((res) => requestAnimationFrame(() => res()));
  },
  async unmount() {
    if (activeRoot) {
      activeRoot.unmount();
      activeRoot = undefined;
      activeName = undefined;
      for (const k of Object.keys(renderCount)) delete renderCount[k];
      for (const k of Object.keys(renderTime)) delete renderTime[k];
    }
  },
  getRenderInfo() {
    return { renderCount, renderTime };
  },
  getScanEvents() {
    return [...scanEvents];
  },
  clearScanEvents() {
    scanEvents.length = 0;
  },
};

// Suppress unused-name warning during isolated builds.
void activeName;
`;
}

function helpers(): string {
  return `import type { Page } from "@playwright/test";

export interface RenderInfoSnapshot {
  renderCount: Record<string, { value: number } | undefined>;
  renderTime: Record<
    string,
    | {
        mount?: number;
        updates?: number[];
      }
    | undefined
  >;
}

export interface ScanEvent {
  name: string;
  reason: string;
  ts: number;
}

export async function mountComponent(page: Page, name: string, props: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [name, props],
  );
}

export async function rerenderComponent(
  page: Page,
  name: string,
  props: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ([n, p]) => window.__profile.rerender(n as string, p as Record<string, unknown>),
    [name, props],
  );
}

/**
 * N rerenders in one round trip.
 *
 * Driving the loop from Node cost a CDP round trip per iteration — 50 per
 * component, 4,700 across a whole-app sweep, and about 150s of a 13.5-minute
 * run spent in IPC rather than in React. The loop runs in the page instead, and
 * rerender still awaits a frame between commits, so the Profiler records
 * exactly the same renders.
 */
export async function rerenderMany(
  page: Page,
  name: string,
  pool: Array<Record<string, unknown>>,
  iterations: number,
): Promise<void> {
  await page.evaluate(
    async ([n, p, count]) => {
      const props = p as Array<Record<string, unknown>>;
      for (let i = 0; i < (count as number); i++) {
        await window.__profile.rerender(n as string, props[i % props.length] as Record<string, unknown>);
      }
    },
    [name, pool, iterations] as [string, Array<Record<string, unknown>>, number],
  );
}

export async function unmount(page: Page): Promise<void> {
  await page.evaluate(() => window.__profile.unmount());
}

export async function getRenderInfo(page: Page): Promise<RenderInfoSnapshot> {
  return page.evaluate(() => window.__profile.getRenderInfo() as RenderInfoSnapshot);
}

export async function getScanEvents(page: Page): Promise<ScanEvent[]> {
  return page.evaluate(() => window.__profile.getScanEvents());
}

export async function clearScanEvents(page: Page): Promise<void> {
  await page.evaluate(() => window.__profile.clearScanEvents());
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  if (lo === hi) return a;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export function summarize(samples: number[]): {
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
  n: number;
} {
  if (samples.length === 0) return { min: 0, avg: 0, p50: 0, p95: 0, max: 0, n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    min: sorted[0] as number,
    avg: sum / sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1] as number,
    n: sorted.length,
  };
}
`;
}

function heapHelper(mode: HeapMode): string {
  return `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Page, TestInfo } from "@playwright/test";

// Drives the browser's V8 heap profiler via CDP. Snapshots land in
// <suite-root>/heaps/<spec>__<test>__<label>.heapsnapshot with predictable
// names so you can grab them from the filesystem directly (no need to dig
// through playwright-report/data/<sha1>). They're also attached to the
// Playwright HTML report so you can navigate from a failed test to its
// snapshot. Format is the standard V8 .heapsnapshot, viewable in Chrome
// DevTools' Memory tab.

const HEAPS_DIR = "heaps";

/**
 * How much of the heap this suite keeps, from --heaps at scaffold time.
 *
 * "off" skips the CDP capture entirely. That is not only about disk: a heap
 * snapshot of a real app is tens of megabytes and takes real time, and one is
 * taken either side of every scenario — an observer that costs more than the
 * thing it observes, inside the measurement it is bracketing.
 */
const HEAP_MODE: "off" | "stress" | "all" = ${JSON.stringify(mode)};

/**
 * A heap snapshot, or an empty buffer.
 *
 * Snapshots are diagnostics, not the measurement. Opening a CDP session can fail
 * for reasons that have nothing to do with the component under test — a page
 * that has already navigated, a Playwright/Chromium pairing that disagrees about
 * a target guid — and letting that throw means the profiling extra breaks the
 * very tests it was added to observe. It warns and returns nothing instead.
 */
async function captureSnapshot(page: Page): Promise<Buffer> {
  if (HEAP_MODE === "off") return Buffer.alloc(0);
  let session: CDPSession;
  try {
    session = await page.context().newCDPSession(page);
  } catch (err) {
    console.warn("[flawless] heap snapshot skipped:", (err as Error).message);
    return Buffer.alloc(0);
  }
  const chunks: string[] = [];
  const onChunk = (e: { chunk: string }): void => {
    chunks.push(e.chunk);
  };
  session.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    // Force GC so the snapshot reflects retained-by-reachability, not
    // not-yet-collected garbage.
    await session.send("HeapProfiler.collectGarbage");
    await session.send("HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
      captureNumericValue: true,
    });
  } catch (err) {
    console.warn("[flawless] heap snapshot failed:", (err as Error).message);
    return Buffer.alloc(0);
  } finally {
    session.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    await session.detach().catch(() => undefined);
  }
  return Buffer.from(chunks.join(""), "utf8");
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function persistSnapshot(buf: Buffer, label: string, testInfo: TestInfo): Promise<string> {
  // Resolve from THIS FILE, not from CWD. Resolving from cwd was meant to keep
  // the path independent of Playwright's rootDir resolution; what it actually
  // did was make it depend on the directory the command was typed in. Run via
  // the generated \`flawless:perf\` script that is the app root, so snapshots
  // landed in <app>/heaps/ while the .gitignore the tool writes covers
  // flawless/heaps/ — 566MB of untracked binaries in someone's repo.
  const dir = path.resolve(__dirname, "..", HEAPS_DIR);
  await mkdir(dir, { recursive: true });
  const specBase = slug(path.basename(testInfo.file).replace(/\\.spec\\.ts$/, ""));
  const title = slug(testInfo.title);
  const filename = \`\${specBase}__\${title}__\${slug(label)}.heapsnapshot\`;
  const out = path.join(dir, filename);
  await writeFile(out, buf);
  await testInfo.attach(filename, { path: out, contentType: "application/octet-stream" });
  return out;
}

export interface HeapSnapshotResult {
  byteSize: number;
  path: string;
}

export async function takeHeapSnapshot(
  page: Page,
  label: string,
  testInfo: TestInfo,
): Promise<HeapSnapshotResult> {
  const buf = await captureSnapshot(page);
  const outPath = await persistSnapshot(buf, label, testInfo);
  return { byteSize: buf.byteLength, path: outPath };
}

// Brackets a scenario with before/after heap snapshots. Snapshots are only
// persisted on failure (cheap signal when something breaks) or when the
// scenario name starts with "stress-" (always kept so leak diffs are
// available). On a clean non-stress pass, the buffers are dropped to keep
// CI artifacts small.
export async function bracketScenario(
  page: Page,
  name: string,
  testInfo: TestInfo,
  fn: () => Promise<void>,
): Promise<void> {
  const before = await captureSnapshot(page);
  let threw: unknown;
  try {
    await fn();
  } catch (err) {
    threw = err;
  }
  const after = await captureSnapshot(page);
  const failed = threw !== undefined;
  const isStress = name.startsWith("stress-");
  const keep =
    HEAP_MODE !== "off" && (HEAP_MODE === "all" || failed || isStress) && after.byteLength > 0;
  if (keep) {
    const bp = await persistSnapshot(before, \`\${name}-before\`, testInfo);
    const ap = await persistSnapshot(after, \`\${name}-after\`, testInfo);
    const delta = after.byteLength - before.byteLength;
    const sign = delta >= 0 ? "+" : "";
    console.log(
      \`[heap] \${name}: \${before.byteLength} -> \${after.byteLength} bytes (delta \${sign}\${delta}) -> \${path.relative(process.cwd(), ap)}\`,
    );
    void bp;
  }
  if (threw) throw threw;
}

export async function repeatClick(page: Page, selector: string, n: number): Promise<void> {
  const locator = page.locator(selector).first();
  for (let i = 0; i < n; i++) {
    await locator.click();
  }
}
`;
}

function budgets(flat: FlatComponent[], _variants: number): string {
  const obj: Record<string, { mountMs: number; updateMs: number }> = {};
  for (const c of flat) obj[c.specName] = { mountMs: 50, updateMs: 16 };
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function spec(c: FlatComponent, variants: number): string {
  // The registry key, so the mount call finds the right component when two share
  // a name.
  const name = c.specName;
  const propsLiteral = JSON.stringify(synthesiseDefaults(c.info));
  const variantsLiteral = JSON.stringify(c.info.variants.slice(0, variants));
  const hooksLiteral = JSON.stringify(c.info.hooks);
  const forcedIterations = Math.max(10, variants * 10);
  const targetedClick = emitPlaywrightClickTarget(c.info.interactions);
  // Clicking a purely presentational component re-renders nothing, so waiting
  // for the render count to rise times out after 30s and reports a stateless
  // Button as broken. Only assert a rerender when the analyser saw something
  // that could cause one: local state, or a handler the parent supplies.
  const hasAnalysedClick = (c.info.interactions?.clicks ?? []).some((cl) => cl.event === "onClick");
  const hasForm = (c.info.interactions?.forms ?? []).length > 0;
  const canRerender =
    ((c.info.state ?? []).some((st) => st.kind !== "useRef") ||
      (c.info.interactions?.clicks ?? []).some((cl) => cl.binding.kind === "prop") ||
      (c.info.hooks ?? []).some((h) => /^use(State|Reducer|SyncExternalStore|Context)$/.test(h))) &&
    // With no analysed click handler the scenario falls back to "the first
    // button on the page". In a form component that button is the SUBMIT
    // control, and clicking it runs an action — against a stubbed server action
    // in a host with no backend, which is not a render measurement.
    !(hasForm && !hasAnalysedClick);
  // No blind fallback. `page.locator("button").first()` claims the first button
  // is the one the analysis found a handler on — true only when there is one
  // button, and in VoteCard it resolved to a disabled "Cast vote" while the
  // handler belonged to a vote option. When nothing names the target, the
  // scenario skips with the reason instead of clicking whatever is first.
  const clickButtonExpr = targetedClick.locator || `page.locator("button").first()`;
  const openDisclosure = targetedClick.prelude ? `\n  ${targetedClick.prelude}` : "";

  // Whether a click scenario can run at all is decided HERE, not at run time.
  // `test.skip(cond, reason)` inside a body runs every beforeEach first and then
  // throws, so 259 of the dogfood app's 470 profile tests were paying a full
  // page load to discover they had nothing to do — 38% of a 13.5-minute run.
  // `test.skip(title, fn)` is declarative: Playwright never runs the hooks.
  //
  // The reason moves into the title, which is a reporting gain: the list
  // reporter prints titles and does not print runtime skip reasons at all.
  const clickSkipReason = !targetedClick.locator
    ? (targetedClick.reason ?? "no clickable target could be derived")
    : !canRerender
      ? hasForm && !hasAnalysedClick
        ? "the only clickable target is a form submit, not a render measurement"
        : "no state or handler prop, so a click cannot re-render this component"
      : undefined;

  const clickScenario = !clickSkipReason
    ? `test(\`\${NAME}: click rerender\`, async ({ page }, testInfo) => {
  await mountComponent(page, NAME, DEFAULTS);${openDisclosure}
  const button = ${clickButtonExpr};
  const hasButton = (await button.count()) > 0;
  test.skip(!hasButton, "component does not render a clickable target");
  // A control that is disabled or covered is not a profiling failure; clicking
  // it would just wait out the 30s actionability timeout and report the
  // component as broken.
  const clickable = hasButton && (await button.isEnabled()) && (await button.isVisible());
  test.skip(!clickable, "the clickable target is disabled or not visible at defaults");
  await bracketScenario(page, "click-rerender", testInfo, async () => {
    await clearScanEvents(page);
    const before = (await getRenderInfo(page)).renderCount[NAME]?.value ?? 0;
    await button.click();
    await page.waitForFunction(
      ([n, b]) => {
        const v = window.__profile.getRenderInfo().renderCount as Record<string, { value: number } | undefined>;
        return (v[n as string]?.value ?? 0) > (b as number);
      },
      [NAME, before],
    );
    const events = await getScanEvents(page);
    if (events.length > 0) {
      console.warn(\`[react-scan] \${NAME} click triggered \${events.length} unnecessary rerender(s)\`);
    }
  });
});`
    : `test.skip(\`\${NAME}: click rerender — ${titleSafe(clickSkipReason)}\`, () => {});`;
  const stressScenario = !clickSkipReason
    ? `test(\`\${NAME}: stress-click-rerender x 50\`, async ({ page }, testInfo) => {
  await mountComponent(page, NAME, DEFAULTS);${openDisclosure}
  const button = ${clickButtonExpr};
  const hasButton = (await button.count()) > 0;
  test.skip(!hasButton, "component does not render a clickable target");
  // A control that is disabled or covered is not a profiling failure; clicking
  // it would just wait out the 30s actionability timeout and report the
  // component as broken.
  const clickable = hasButton && (await button.isEnabled()) && (await button.isVisible());
  test.skip(!clickable, "the clickable target is disabled or not visible at defaults");
  await bracketScenario(page, "stress-click-rerender", testInfo, async () => {
    const startCount = (await getRenderInfo(page)).renderCount[NAME]?.value ?? 0;
    // Stop when the control goes away. A "Remove" button in a list removes its
    // own row, so it survives as many clicks as there are rows — and clicking a
    // locator that no longer resolves waits out the whole timeout, reporting a
    // working component as broken.
    let __clicks = 0;
    for (let __i = 0; __i < 50; __i++) {
      if ((await button.count()) === 0 || !(await button.isEnabled())) break;
      await button.click();
      __clicks++;
    }
    test.skip(__clicks === 0, "the clickable target vanished before the first click");
    await page.waitForFunction(
      ([n, b]) => {
        const v = window.__profile.getRenderInfo().renderCount as Record<string, { value: number } | undefined>;
        return (v[n as string]?.value ?? 0) > (b as number);
      },
      [NAME, startCount],
      { timeout: 30_000 },
    );
    console.log(\`[\${NAME} stress] \${__clicks} click(s) landed before the target went away\`);
  });
});`
    : `test.skip(\`\${NAME}: stress-click-rerender x 50 — ${titleSafe(clickSkipReason)}\`, () => {});`;

  // Same reasoning as the click scenarios: VARIANTS is emitted as a literal, so
  // "are there any" is answerable here rather than after a page load.
  const variantScenario =
    variantsLiteral === "[]"
      ? `test.skip(\`\${NAME}: variant matrix — no union-of-literal props to vary\`, () => {});`
      : `test(\`\${NAME}: variant matrix\`, async ({ page }, testInfo) => {
  await bracketScenario(page, "variant-matrix", testInfo, async () => {
    await mountComponent(page, NAME, DEFAULTS);
    const samples: number[] = [];
    for (const v of VARIANTS) {
      await rerenderComponent(page, NAME, v);
      const info = await getRenderInfo(page);
      const updates = info.renderTime[NAME]?.updates ?? [];
      const last = updates[updates.length - 1];
      if (typeof last === "number") samples.push(last);
    }
    const stats = summarize(samples);
    console.log(\`[\${NAME} variants] \${JSON.stringify(stats)}\`);
    const budget = (budgets as Record<string, { updateMs: number } | undefined>)[NAME]?.updateMs ?? 16;
    if (stats.p95 > budget) {
      console.warn(\`[budget] \${NAME} p95 \${stats.p95.toFixed(2)}ms > \${budget}ms\`);
    }
  });
});`;

  return `import { test, expect } from "@playwright/test";
import budgets from "../budgets.json" with { type: "json" };
import {
  mountComponent,
  rerenderComponent,
  rerenderMany,
  unmount,
  getRenderInfo,
  getScanEvents,
  clearScanEvents,
  summarize,
} from "./_helpers";
import { bracketScenario, repeatClick, takeHeapSnapshot } from "./_heap";

const NAME = ${JSON.stringify(name)};
const DEFAULTS = ${propsLiteral} as Record<string, unknown>;
const VARIANTS = ${variantsLiteral} as Array<Record<string, unknown>>;
const HOOKS = ${hooksLiteral} as string[];

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => typeof window.__profile?.mount === "function");
  await clearScanEvents(page);
});

test.afterEach(async ({ page }) => {
  await unmount(page);
});

test(\`\${NAME}: mounts at defaults\`, async ({ page }) => {
  await mountComponent(page, NAME, DEFAULTS);
  const info = await getRenderInfo(page);
  const count = info.renderCount[NAME]?.value ?? 0;
  expect(count).toBeGreaterThanOrEqual(1);
  const mountMs = info.renderTime[NAME]?.mount ?? 0;
  const budget = (budgets as Record<string, { mountMs: number } | undefined>)[NAME]?.mountMs ?? 50;
  if (mountMs > budget) {
    console.warn(\`[budget] \${NAME} mount \${mountMs.toFixed(2)}ms > \${budget}ms\`);
  }
});

${variantScenario}

${clickScenario}

test(\`\${NAME}: forced rerender x \${${forcedIterations}}\`, async ({ page }, testInfo) => {
  await mountComponent(page, NAME, DEFAULTS);
  await bracketScenario(page, "forced-rerender", testInfo, async () => {
    const pool: Array<Record<string, unknown>> =
      VARIANTS.length > 0 ? VARIANTS : [DEFAULTS];
    await rerenderMany(page, NAME, pool, ${forcedIterations});
    const info = await getRenderInfo(page);
    const updates = info.renderTime[NAME]?.updates ?? [];
    const stats = summarize(updates as number[]);
    console.log(\`[\${NAME} forced] \${JSON.stringify(stats)}\`);
    // Smoke: at least one update was timed.
    expect(stats.n).toBeGreaterThan(0);
    // HOOKS list is informational — surface it in the test output for context.
    if (HOOKS.length > 0) console.log(\`[\${NAME} hooks] \${HOOKS.join(", ")}\`);
  });
});

// Repeat-N click stress: baseline snapshot, 50 clicks, final snapshot. Both
// snapshots are always attached so a leak diff can be opened in Chrome DevTools
// (Memory tab → load → Comparison view).
${stressScenario}

// takeHeapSnapshot is exported so future analyses (e.g. byte-delta asserts) can
// call it directly without bracketScenario.
void takeHeapSnapshot;
`;
}

function readme(
  suiteName: string,
  componentNames: string[],
  excluded: ExcludedComponent[] = [],
): string {
  const componentList =
    componentNames.length > 1
      ? `\n\nComponents in this suite: ${componentNames.map((n) => `\`${n}\``).join(", ")}.\n`
      : "";
  // Silence here would read as "everything is covered". Each line says what was
  // left out of the browser host and why.
  const excludedList =
    excluded.length > 0
      ? `\n## Not in this host (${excluded.length})\n\n${excluded
          .map((e) => `- \`${e.name}\` — ${e.reason}`)
          .join("\n")}\n`
      : "";
  return `# ${suiteName}.profile${componentList}${excludedList}

Auto-generated by [flawless-react](https://github.com/larioborges-timbuk2/flawless-react). Edit freely — there is no regeneration step that overwrites you.

## Run

\`\`\`bash
bun install
bun run test           # headless
bun run test:headed    # open Chromium
\`\`\`

## What's measured

- **Mount time** and **update times** per component, via \`react-performance-testing\`.
- **Unnecessary rerenders** flagged by \`react-scan\`.
- Wall-clock distribution (min / avg / p50 / p95 / max) over a forced-rerender loop.

## Customise

- \`budgets.json\` — tighten per-component mount/update budgets. Tests warn (not fail) on breach by default; switch the \`console.warn\` to \`expect(...).toBeLessThan(...)\` to make them hard.
- \`profile/_helpers.ts\` — add scenarios; e.g. mock data sources before \`mountComponent\`.
- \`host/main.tsx\` — register additional components by hand in \`REGISTRY\`.

## Notes

- Components import their own React from the parent project's \`node_modules\`. The suite's own React must match the major version; \`bun install\` here pins \`^18.3.0\`.
- The Playwright \`webServer\` boots \`bun host/server.ts\` automatically; no manual server step.
`;
}

/**
 * A .mjs file, so it is plain JavaScript — no type annotations.
 *
 * It carried `const sections: string[] = […]` for as long as it existed, which
 * node refuses outright ("Missing initializer in const declaration"), so
 * `bun run report` had never once worked. Nothing noticed because
 * tests/emittedSyntax.test.ts filters on /\.tsx?$/ and this file is neither.
 * tests/emittedExecution.test.ts now runs it under node.
 */
function reportScript(): string {
  return `#!/usr/bin/env node
// Aggregates the latest Playwright run's stdout into a markdown summary at ./report.md.
// Re-run with: bun run report
import { readFileSync, writeFileSync } from "node:fs";

// The JSON reporter's output, not playwright-report/index.html. The HTML report
// keeps every stdout line inside a base64 zip blob under
// window.playwrightReportBase64, so the regex below matched nothing there and
// this script wrote a report with no sections in it.
const RESULTS = "test-results/results.json";

let report;
try {
  report = JSON.parse(readFileSync(RESULTS, "utf8"));
} catch {
  console.error("no " + RESULTS + " — run \`bun run test\` first");
  process.exit(1);
}

// Suites nest arbitrarily deep (file, describe, project), and the lines we want
// are on the individual test results.
function collectStdout(suites) {
  let text = "";
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        for (const r of t.results ?? []) {
          for (const chunk of r.stdout ?? []) {
            if (typeof chunk === "string") text += chunk;
            else if (chunk.text !== undefined) text += chunk.text;
            else if (chunk.buffer !== undefined) {
              text += Buffer.from(chunk.buffer, "base64").toString("utf8");
            }
          }
        }
      }
    }
    text += collectStdout(suite.suites);
  }
  return text;
}

const sections = ["# Profile report", ""];
const stats = [...collectStdout(report.suites).matchAll(/\\[(.+?) (variants|forced)\\] (\\{.+?\\})/g)];
for (const m of stats) {
  sections.push(\`## \${m[1]} (\${m[2]})\`);
  sections.push("\\n\`\`\`json");
  sections.push(m[3] ?? "{}");
  sections.push("\`\`\`\\n");
}
writeFileSync("report.md", sections.join("\\n"));
console.log("wrote report.md");
`;
}

function mockServer(): string {
  return `import { routes } from "./routes";

const PORT = Number(process.env.MOCK_PORT ?? 5174);

// Convert an OpenAPI path template ("/users/{id}") into a RegExp matcher.
// Captures the parameter names so handlers can read them via the second arg
// even though we don't currently expose them (the response body is static).
function compile(pattern: string): { re: RegExp; params: string[] } {
  const params: string[] = [];
  const reSrc =
    "^" +
    pattern.replace(/{([^}]+)}/g, (_, name) => {
      params.push(name);
      return "([^/]+)";
    }) +
    "$";
  return { re: new RegExp(reSrc), params };
}

const compiled = routes.map((r) => ({ ...r, ...compile(r.path) }));

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    // Root health endpoint — Playwright's webServer rejects 404s when probing
    // readiness, so we return a 200 with a route count for "/".
    if (url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true, routes: compiled.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    for (const r of compiled) {
      if (r.method !== method) continue;
      if (!r.re.test(url.pathname)) continue;
      return new Response(r.body === null ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: r.body === null ? {} : { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "not mocked", method, path: url.pathname }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
});

console.log("mock listening on http://127.0.0.1:" + PORT);
`;
}

function mockRoutesFile(routes: MockRoute[]): string {
  const literal = JSON.stringify(routes, null, 2);
  return `// Routes derived at scaffold time from the OpenAPI spec passed to --api.
// Each entry pairs a path template + method with a pre-computed response body
// (either the spec's first example, or a schema-synthesised default).
//
// Edit freely — there is no regeneration step that will overwrite this file.

export interface MockRoute {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export const routes: MockRoute[] = ${literal};
`;
}

export function _exportedPropsLiteral(p: PropsShape): string {
  return JSON.stringify(p);
}
