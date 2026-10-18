import { readFileSync } from "node:fs";
import path from "node:path";
import { type AuthStub, authShimEsm, collectAuthStubs } from "../analyse/authShims.ts";
import { requiredAncestors } from "../analyse/htmlContentModel.ts";
import { libraryShimSource, referencedLibraryShims } from "../analyse/providerWraps.ts";
import { relativeToEmitted } from "../emitPaths.ts";
import { appReactMajor, detectAppReact } from "../packageJson.ts";
import {
  allocateSpecNames,
  compoundWrappable,
  defaultsJson,
  flattenTrees,
  functionProps,
  hostEligibility,
  synthesiseDefaults,
} from "../scaffold-tests/registry.ts";
import { emitPlaywrightClickTarget } from "../scaffold-tests/selectors.ts";
import { stamp } from "../scaffold-tests/stamp.ts";
import { NEXT_SCRIPT, SUITE_COMMAND, SUITE_SCRIPT } from "../suiteScripts.ts";
import type {
  ComponentInfo,
  ComponentTree,
  HeapMode,
  MockRoute,
  PropsShape,
  PropValue,
  ProviderRef,
} from "../types.ts";
import { VERSION } from "../version.ts";

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
  /** When set, write here instead of <outDir>/<relPath> (library shim files). */
  absPath?: string;
  executable?: boolean;
  /**
   * Never overwrite an existing file here, `--force` included.
   *
   * For the files whose contents cannot be recovered from the analysis — the
   * same criterion `provider.fixtures.ts` and `e2e/global-setup.ts` are held to.
   * Everything else in the suite is derived and must stay regenerable, or an
   * existing suite never receives a later version's improvements.
   *
   * **The set is smaller than it looks: in renderSuite only `host/main.tsx` and
   * `budgets.json` carry this.** `profile/_helpers.ts` reads like somewhere to
   * keep your own scenarios and is rebuilt on every `--force`. Check this flag
   * before telling a user, in emitted prose or in docs, that their edits to a
   * file will survive — the emitted README claimed exactly that about
   * `_helpers.ts` in a draft of the commit that fixed the README for claiming
   * it about itself. Rendering the file and reading it caught that; no test did.
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
  /**
   * Absolute path of the same provider, for reading its import table: the host
   * mounts it around every component, so its provider-bound auth imports need
   * stubbing too (analyse/authShims.ts).
   */
  providerFile?: string;
  mockRoutes?: MockRoute[];
  suiteName?: string;
  nextjsHost?: boolean;
  mswSetup?: boolean;
  /** Context providers to mount around each component; see ScaffoldOptions. */
  providerWraps?: Map<string, ProviderRef[]>;
}

export function renderSuite(opts: RenderOptions): RenderedFile[] {
  const trees: ComponentTree[] = [opts.tree, ...(opts.extraTrees ?? [])];
  const {
    hosted: flat,
    excluded,
    serverActionStubs,
    authStubs,
  } = selectHostComponents(trees, opts.outDir, opts.providerFile);
  const hasMock = Array.isArray(opts.mockRoutes);
  const useMsw = Boolean(opts.mswSetup);
  const suiteName = opts.suiteName ?? trees[0]?.entry.componentName ?? "suite";
  const files: RenderedFile[] = [
    { relPath: "playwright.config.ts", content: playwrightConfig(hasMock) },
    {
      relPath: "host/server.ts",
      content: hostServer(hasMock, serverActionStubs, path.join(opts.outDir, "host"), authStubs),
    },
    { relPath: "host/index.html", content: hostHtml() },
    { relPath: "host/_polyfill.ts", content: hostPolyfill() },
    // Regenerated (FR-016): a re-run must be able to register newly analysed
    // components over a kept wrapper.
    {
      relPath: "host/registry.ts",
      content: hostRegistry(flat, opts.providerWraps, path.resolve(opts.outDir, "host")),
    },
    // writeOnce: docs/extending.md tells you to edit this to add providers,
    // MSW and hand registrations in the ALL spread, and nothing can rebuild
    // that wiring from the analysis. The tables it reads live in ./registry.
    {
      relPath: "host/main.tsx",
      // legacyMount: a React 17 host renders through ReactDOM.render — there
      // is no react-dom/client to import, so this cannot be runtime-detected.
      content: hostMain(opts.providerImportPath, useMsw, (appReactMajor(opts.outDir) ?? 18) <= 17),
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
        { nextjsHost: opts.nextjsHost, report: opts.report },
      ),
    },
  ];
  // Generated library-provider shims the wrap map mounts: the file lives at
  // the IMPORTING PACKAGE's root, not the outDir — a bare library import only
  // resolves through that package's node_modules (bun workspaces hoist
  // nothing). Tool-owned content, rewritten per run.
  for (const shim of referencedLibraryShims(
    opts.providerWraps,
    flat.map((c) => c.info.filePath),
  )) {
    files.push({
      relPath: path.relative(opts.outDir, shim.filePath),
      absPath: shim.filePath,
      content: libraryShimSource(shim.module, shim.componentName),
    });
  }
  if (!opts.nextjsHost) {
    files.unshift({ relPath: "tsconfig.json", content: tsConfig() });
    files.unshift({
      relPath: "package.json",
      content: pkgJson(suiteName, opts.report, opts.outDir),
    });
    files.push({ relPath: "pnpm-workspace.yaml", content: PNPM_SUITE_SETTINGS, writeOnce: true });
  }
  for (const c of flat) {
    files.push({
      relPath: `profile/${c.specName}.profile.spec.ts`,
      // Stamped like the colocated and browser specs: this file is only
      // rewritten while the component STAYS host-mountable, so the stamp is
      // what lets a later sweep tell "our own stale output" (safe to remove)
      // from "someone worked on this" (kept). Restamped after the host
      // formatter runs, same as the colocated specs (core.ts restampGenerated).
      content: stamp(spec(c, opts.variants)),
    });
  }
  if (hasMock) {
    files.push({ relPath: "mock/server.ts", content: mockServer() });
    // writeOnce: its emitted header says no regeneration step overwrites it —
    // hand-tuned fixture bodies cannot be rebuilt from the OpenAPI spec.
    files.push({
      relPath: "mock/routes.ts",
      content: mockRoutesFile(opts.mockRoutes ?? []),
      writeOnce: true,
    });
  }
  if (opts.report) {
    files.push({
      relPath: "scripts/report.mjs",
      content: reportScript(
        opts.nextjsHost ? NEXT_SCRIPT.report : SUITE_SCRIPT.report,
        opts.nextjsHost ? NEXT_SCRIPT.perf : SUITE_SCRIPT.test,
      ),
      executable: true,
    });
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
/** One "use server" module to stub for the browser bundle. */
interface ServerActionStub {
  /** Every export name the stub must bind. */
  names: string[];
  /** Module-side name → the literal that action returns, where resolved. */
  returns: Record<string, PropValue>;
  /**
   * Bare (non-relative) specifiers that import this module. The analyser
   * resolves a workspace package to its SOURCE tree — that is where the
   * annotations live — but the bundler resolves the same bare specifier
   * through package.json `main`/`exports` to `dist/`, so a path-keyed stub
   * never fires for it (B-11). These specifiers are intercepted BEFORE
   * resolution instead, the way the unit plane's vi.mock always has.
   */
  specifiers: string[];
}

function selectHostComponents(
  trees: ComponentTree[],
  outDir: string,
  providerFile?: string,
): {
  hosted: FlatComponent[];
  excluded: ExcludedComponent[];
  /** Absolute path → the stub for the module at that path. */
  serverActionStubs: Map<string, ServerActionStub>;
  /** Bare specifier → the signed-out auth-library stub (analyse/authShims.ts). */
  authStubs: Map<string, AuthStub>;
} {
  const hostDir = path.resolve(outDir, "host");
  const flat = flattenTrees(trees);
  const specNames = allocateSpecNames(flat);
  // EVERY analysed component contributes imports here, hosted or not: an
  // excluded component still sits in a hosted neighbour's import chain, and
  // one library that throws at module init takes the whole bundle down. The
  // provider wrapper joins them for the same reason — the host renders it around
  // every component, so its auth imports are in that bundle whether the
  // analysis visited the file or not.
  const authStubs = collectAuthStubs(
    flat.map((c) => c.info),
    providerFile ? [providerFile] : [],
  );

  const hosted: FlatComponent[] = [];
  const excluded: ExcludedComponent[] = [];
  const serverActionStubs = new Map<string, ServerActionStub>();
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
      const entry = serverActionStubs.get(mi.resolvedPath) ?? {
        names: [],
        returns: {},
        specifiers: [],
      };
      const names = new Set(entry.names);
      for (const n of mi.serverActionExports ?? mi.names) names.add(n);
      const specifiers = new Set(entry.specifiers);
      if (!mi.specifier.startsWith(".")) specifiers.add(mi.specifier);
      // Sorted, not Set order: the emitted file has to be byte-identical across
      // runs or the idempotence gate churns. Returns merge trivially — every
      // importer's record was extracted from the same file.
      serverActionStubs.set(mi.resolvedPath, {
        names: [...names].sort(),
        returns: { ...entry.returns, ...(mi.serverActionReturns ?? {}) },
        specifiers: [...specifiers].sort(),
      });
    }
    hosted.push({
      info: c.info,
      // No .tsx: the host is type-checked by the target project, which does not
      // enable allowImportingTsExtensions.
      importPath: stripTsExt(toRel(hostDir, c.info.filePath)),
      specName: specNames.get(c) as string,
    });
  }
  return { hosted, excluded, serverActionStubs, authStubs };
}

function stripTsExt(spec: string): string {
  return spec.replace(/\.(tsx|ts|jsx|js)$/, "");
}

/**
 * Safe inside an emitted `test(\`...\`)` / `test.skip(\`...\`)` template literal.
 *
 * A title quotes the source — a tag name, a prop name, a clickable label — so
 * it can carry a backtick or a `${`: the backtick would end the literal early
 * and emit a spec that does not parse, the `${` would become a live
 * substitution. Exported for the unit/browser emitter, whose titles quote the
 * same source text.
 */
export function titleSafe(reason: string): string {
  return reason.replace(/`/g, "'").replace(/\$\{/g, "$ {");
}

/** Named vs default import, aliased when the registry key differs from the name. */
function hostComponentImport(c: FlatComponent): string {
  const { componentName, exportKind } = c.info;
  if (exportKind === "default") return `import ${c.specName} from "${c.importPath}";`;
  // `export { Internal as Public }` — only the alias is a module binding.
  const boundary = c.info.exportedAs ?? componentName;
  if (c.specName === boundary) {
    return `import { ${boundary} } from "${c.importPath}";`;
  }
  return `import { ${boundary} as ${c.specName} } from "${c.importPath}";`;
}

function toRel(fromDir: string, absFile: string): string {
  let rel = path.relative(fromDir, absFile);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.split(path.sep).join("/");
}

// pnpm >=10 refuses to run a dependency's build scripts unless the manager
// declares them, and esbuild's postinstall IS its binary: a suite installed
// with plain `pnpm install` died at vitest startup with a confusing
// "esbuild binary missing" from inside vite. pnpm >=10 reads the allow-list
// from pnpm-workspace.yaml (onlyBuiltDependencies) and pnpm >=12 renamed it
// (allowBuilds); the file spells both, and each manager ignores the key it
// does not know. The suite-local file also keeps `pnpm install` run inside
// the suite from being captured by the application's workspace.
export const PNPM_SUITE_SETTINGS = `# Generated by flawless-react (write-once: add your own keys freely).
# esbuild's postinstall IS its binary — without this allowance pnpm refuses
# it and vitest dies at startup; msw's copies its service worker. Both
# spellings: pnpm >=10 and >=12 renamed.
onlyBuiltDependencies:
  - esbuild
  - msw
allowBuilds:
  esbuild: true
  msw: true
`;

function pkgJson(name: string, report: boolean, outDir: string): string {
  // The suite's react IS the copy the perf host bundles and renders with
  // (resolveFromSuite resolves from the suite directory), so it must be the
  // version the app's component code was written against. See detectAppReact.
  const pin = detectAppReact(outDir);
  const typesPin = pin ? `^${pin.react.split(".")[0]}.0.0` : "^18.3.0";
  const dashed = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return `${JSON.stringify(
    {
      name: `${dashed}-profile`,
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        [SUITE_SCRIPT.test]: SUITE_COMMAND.perf,
        // Same command under the name --run-tests looks for. Without it, a
        // standalone perf-harness run with --run-tests reported "failed suites:
        // perf" on a suite that was fine, because `bun run test:perf` did not
        // exist — the key is only added when unit-browser also ran.
        [SUITE_SCRIPT.perf]: SUITE_COMMAND.perf,
        [SUITE_SCRIPT.headed]: SUITE_COMMAND.headed,
        // Only when scripts/report.mjs is emitted beside it. Declared
        // unconditionally, `bun run report` on a suite generated without
        // --report failed with a module-not-found naming a file the user never
        // asked for and cannot restore without regenerating.
        ...(report ? { [SUITE_SCRIPT.report]: SUITE_COMMAND.report } : {}),
      },
      dependencies: {
        react: pin?.react ?? "^18.3.0",
        "react-dom": pin?.reactDom ?? "^18.3.0",
        "react-scan": "^0.4.3",
      },
      devDependencies: {
        "@playwright/test": "^1.49.0",
        "@types/node": "^22.0.0",
        "@types/react": typesPin,
        "@types/react-dom": typesPin,
        typescript: "^5.6.0",
      },
    },
    null,
    2,
  )}\n`;
}

export function tsConfig(): string {
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

  // The first line is this suite's provenance record: it is the marker file a
  // re-run checks for, and a changed-mode run reads the version back out of
  // this banner (scaffold/index.ts parseExistingVersion) to report which tool
  // generated the suite it is keeping. The literal phrase is load-bearing:
  // BANNER_RE in scaffold/index.ts matches these exact words, so rewording
  // it degrades every future suite to "unknown version". Change both or
  // neither.
  return `// Generated by flawless-react ${VERSION}
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./profile",
  // Relative, which playwright resolves against THIS FILE. The unset default
  // resolves elsewhere (the package.json directory) and once put 347MB of
  // traces in <app>/test-results/ outside the emitted .gitignore.
  // Never the CJS dirname global: a "type":"module" suite loads this config
  // as ESM, where it does not exist and the whole config dies at import.
  outputDir: "test-results",
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
    ["json", { outputFile: "test-results/results.json" }],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  preserveOutput: "always",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  ${webServerField},
  projects: [
    // Exactly ONE project. A second, headed "interactive" project used to
    // live here for manual debugging — and a bare \`playwright test\` then
    // ran every spec twice, the second pass in a real browser window, per
    // spec (a 2,590-spec dogfood run turned into a window storm). Headed
    // probing is what Playwright's own --headed flag is for; \`bun run
    // test:headed\` carries it.
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
`;
}

// The app's module scope runs BEFORE any spec: a top-level
// `new URL(process.env.DATABASE_URL)` throws and takes the whole host bundle
// down (one registry imports every component). The runtime polyfill gives
// `process` an empty env, so the values must be inlined as build defines.
// Repo-root .env files, Next's precedence order (later wins). The host binds
// 127.0.0.1 and the bundle never leaves the suite's disk.
function collectEnvDefines(): string {
  const files = [".env", ".env.local", ".env.development", ".env.development.local"];
  const merged = new Map<string, string>();
  for (const f of files) {
    let txt: string;
    try {
      txt = readFileSync(path.resolve(process.cwd(), f), "utf8");
    } catch {
      continue;
    }
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const name = m[1];
      if (name === undefined) continue;
      let v = (m[2] ?? "").trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v) merged.set(name, v);
    }
  }
  return [...merged].map(([k, v]) => `"process.env.${k}": ${JSON.stringify(v)},`).join("\n    ");
}

function hostServer(
  hasMock: boolean,
  serverActionStubs = new Map<string, ServerActionStub>(),
  hostDir = "",
  authStubs = new Map<string, AuthStub>(),
): string {
  const envDefineLines = collectEnvDefines();
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
  const specifierSources = new Map<string, string>();
  const stubSources = stubEntries
    .map(([abs, stub]) => {
      // A name the analyser resolved returns the action's real literal; the
      // rest keep the {} stand-in the comment above justifies.
      const stubValue = (n: string): string =>
        stub.returns[n] === undefined ? "{}" : JSON.stringify(stub.returns[n]);
      const body = stub.names
        .map((n) =>
          n === "default"
            ? `export default async () => (${stubValue(n)});`
            : `export const ${n} = async () => (${stubValue(n)});`,
        )
        .join("\n");
      // A module imported by a BARE specifier (a workspace package) is also
      // stubbed at the specifier itself: the analyser resolved it to src, the
      // bundler would resolve it to package.json's dist — two paths, neither
      // of which the path key below can cover (B-11).
      for (const spec of stub.specifiers) specifierSources.set(spec, body || "export {};");
      // Relative to this file, resolved back to absolute when the map is built.
      // Bun's onLoad hands us an absolute `args.path`, so the KEYS must be
      // absolute at runtime — but an absolute key in the committed source names
      // the machine that generated it, and every stub would miss on any other
      // checkout, putting pg and nodemailer back into the browser bundle.
      const key = hostDir ? relativeToEmitted(hostDir, abs) : abs;
      return `  ${JSON.stringify(key)}: ${JSON.stringify(body || "export {};")},`;
    })
    .join("\n");
  // Provider-bound auth libraries ride the same bare-specifier interception:
  // they resolve fine in the suite's node_modules — that's the problem. The
  // real module lands in the bundle and throws at import or first hook call
  // without ClerkProvider/SessionProvider keys nobody hands a perf host.
  for (const [spec, stub] of authStubs) specifierSources.set(spec, authShimEsm(spec, stub));
  const specifierEntries = [...specifierSources.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const specifierSourceLines = specifierEntries
    .map(([spec, body]) => `  ${JSON.stringify(spec)}: ${JSON.stringify(body)},`)
    .join("\n");
  // Escaped at GENERATION time so the emitted file carries a plain literal;
  // /$^/ when empty, so the (never-entered) registration still parses.
  const specifierFilter = specifierEntries
    .map(([spec]) => spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const specifierFilterLiteral =
    specifierEntries.length > 0
      ? `new RegExp(${JSON.stringify(`^(?:${specifierFilter})$`)})`
      : "/$^/";
  // next/navigation's client hooks throw "invariant expected app router to be
  // mounted" outside a Next runtime, and the host IS a bare browser. Same
  // stand-ins the unit plane's setup.ts installs (redirect/notFound throw on
  // purpose: a component that wants to leave should fail the mount, not
  // profile a page that never rendered). Fixed export list — the Next API
  // surface is stable, so this needs no analysis pass, unlike authShims.
  const navStubSource = [
    "const __noopRouter = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} };",
    'export const notFound = () => { throw new Error("notFound() called"); };',
    'export const redirect = () => { throw new Error("NEXT_REDIRECT"); };',
    'export const permanentRedirect = () => { throw new Error("NEXT_REDIRECT"); };',
    'export const usePathname = () => "/";',
    "export const useRouter = () => __noopRouter;",
    "export const useSearchParams = () => new URLSearchParams();",
    "export const useParams = () => ({});",
    "export const useSelectedLayoutSegment = () => null;",
    "export const useSelectedLayoutSegments = () => [];",
    'export const useLinkStatus = () => "idle";',
  ].join("\n");
  // next/router — the PAGES-router twin of the stub above. Its useRouter
  // throws "NextRouter was not mounted" outside Next's App container, so a
  // pages app's component dies at render in the host exactly as it does under
  // jsdom (talkformai: NavBar, DashboardMode, SignInForm — every mount). Navigate
  // nowhere, but define every field the router API documents: `router.query.id`
  // and `router.pathname.split("/")` are what a render actually touches, and an
  // undefined one is a different crash, not a quieter one.
  const pagesRouterStubSource = [
    "import * as React from 'react';",
    "const __router = { pathname: '/', route: '/', query: {}, asPath: '/', basePath: '', locale: undefined, locales: [], isLocaleDomain: false, isReady: true, isPreview: false, push: () => Promise.resolve(true), replace: () => Promise.resolve(true), prefetch: () => Promise.resolve(), pushScope: () => [], popScope: () => false, beforePopState: () => {}, reload: () => {}, back: () => {}, forward: () => {}, events: { on: () => {}, off: () => {}, emit: () => {} } };",
    "export const router = __router;",
    "export const useRouter = () => __router;",
    "export const withRouter = (Component) => (props) => React.createElement(Component, Object.assign({}, props, { router: __router }));",
  ].join("\n");
  // next/script renders NOTHING into the tree: it injects its tag through
  // Next's client router context, which a bare host does not have. A component
  // whose whole output is <Script> therefore mounted as an empty container and
  // failed the browser smoke on its markup floor — talkformai's GoogleAnalytics
  // and PostHogScript, both expect(rootHtml.length).toBeGreaterThan(0) on an
  // otherwise clean, error-free mount. Answer with a script element rendered IN
  // PLACE so the component's own render is what gets measured, marked
  // type="text/plain" so the browser neither fetches src nor executes inline
  // code: third-party analytics has no business running inside a render
  // benchmark. An inert stand-in is this host's answer everywhere else (DB
  // drivers, fonts, both routers) — a silent blank was the outlier.
  const nextScriptStubSource = [
    "import * as React from 'react';",
    "function FlawlessScript(props) { return React.createElement('script', { type: 'text/plain', src: typeof props.src === 'string' ? props.src : undefined, id: props.id, 'data-flawless-stub': 'next/script' }); }",
    "export default FlawlessScript;",
  ].join("\n");
  const stubPlugin = `
// Path relative to this file -> replacement source, resolved to the absolute
// paths Bun's onLoad reports. See the comment where this was generated.
const SERVER_STUB_SOURCES: Record<string, string> = {
${stubSources}
};
const SERVER_STUBS: Record<string, string> = Object.fromEntries(
  Object.entries(SERVER_STUB_SOURCES).map(([rel, src]) => [path.resolve(HOST_DIR, rel), src]),
);

// Bare specifiers (workspace packages) -> replacement source. Intercepted at
// RESOLUTION, before package.json main/exports can route them to a dist build
// the path-keyed map has never heard of.
const SERVER_STUB_SPECIFIERS: Record<string, string> = {
${specifierSourceLines}
};

const stubServerModules: BunPlugin = {
  name: "flawless-server-stubs",
  setup(build) {
    // Node/bun built-ins are not available in the browser target. Stub them
    // so component deps that conditionally import fs/stream/zlib don't crash
    // the build.
    build.onResolve({ filter: /^(node:|bun:)/ }, (args) => ({
      path: args.path,
      namespace: "flawless-node-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "flawless-node-stub" }, () => ({
      contents:
        "const make = () => { const f = function () {}; return new Proxy(f, { get: (t, p) => (p === '__esModule' ? false : p === 'then' ? undefined : (t[p] ??= make())), apply: () => make(), construct: () => new Proxy({}, { get: () => () => undefined }) }); }; const KNOWN = ['default', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'performance', 'platform', 'arch', 'env', 'version', 'cwd', 'dirname', 'join', 'resolve', 'sep', 'delimiter', 'normalize', 'extname', 'basename', 'relative', 'isAbsolute', 'tmpdir', 'homedir', 'readFileSync', 'writeFileSync', 'existsSync', 'statSync', 'readdirSync', 'mkdirSync', 'rmSync', 'promisify', 'createReadStream', 'createWriteStream', 'createGzip', 'createDeflate', 'pipeline', 'fileURLToPath', 'pathToFileURL', 'randomUUID', 'execSync', 'spawnSync', 'execFileSync', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'AbortController', 'AbortSignal', 'EventEmitter', 'once', 'Stream', 'inspect', 'format', 'types', 'isDeepStrictEqual', 'createInterface', 'question', 'getLogger', 'Drizzle', 'drizzle', 'Kysely', 'Pool', 'Client', 'sql', 'PrismaPg', 'PrismaBetterSqlite3', 'PrismaBunSql', 'PrismaLibSql', 'PrismaD1', 'PrismaSqlite', 'SupabaseClient', 'createClient', 'globalThis']; const root = new Proxy({}, { get: (t, p) => (p === '__esModule' ? false : p === 'then' ? undefined : (t[p] ??= make())), ownKeys: () => KNOWN, getOwnPropertyDescriptor: (t, p) => ({ value: t[p] ??= make(), enumerable: true, configurable: true, writable: true }) }); module.exports = root;",
      loader: "js",
    }));
    // Native .node addons cannot build for a browser target at all, and
    // ?module wasm (next's vendored resvg) is not loadable here either. A
    // component that actually CALLS into one throws at render and fails its
    // own spec — acceptable; a hard BUILD error takes the whole host down.
    build.onResolve({ filter: /\\.(node|wasm|so|dylib|dll)(\\?.*)?$/ }, (args) => ({
      path: args.path,
      namespace: "flawless-node-stub",
    }));
    // Database clients: even their "pure JS" entries load native query
    // engines at module init. A relative import of a generated client (e.g.
    // generated/prisma/client.ts) still drags in these BARE runtime
    // specifiers, which is where the bundle is cut. Perf then measures the
    // component's render with inert data — the suite's mocking philosophy.
    //
    // Yield the ones with a generated stub of their own. The Supabase family
    // is matched here by PACKAGE PATTERN and in SERVER_STUB_SPECIFIERS by
    // EXACT NAME, and esbuild asks hooks in registration order — this one is
    // registered first, so it used to win: the signed-out auth-helpers stub
    // sat in the map unused while the component got the inert CJS Proxy, and
    // talkformai's NavBar / SignInForm / DashboardMode all timed out on
    // "useSessionContext is not a function". A named stub is a decision about
    // that module's surface; a pattern stub is only a fallback.
    build.onResolve(
      {
        filter:
          /^(@supabase\\/[a-z0-9._-]+|@prisma\\/adapter[a-z0-9._-]*|mongodb|mongoose|pg|kysely|drizzle-orm)([\\/:].*)?$/,
      },
      (args) =>
        SERVER_STUB_SPECIFIERS[args.path]
          ? undefined
          : { path: args.path, namespace: "flawless-node-stub" },
    );
    // Prisma's generated client destructures the runtime namespace AT MODULE
    // SCOPE — a Proxy'd CJS namespace loses its keys through bun's __toESM
    // key-copy and kills the whole host bundle. A real ESM module with the
    // runtime's export names declared survives the copy; each value is a
    // recursive inert proxy (any call shape resolves, nothing connects).
    build.onResolve({ filter: /^(prisma|@prisma\\/[a-z0-9._-]+)([\\/:].*)?$/ }, (args) => ({
      path: args.path,
      namespace: "flawless-prisma-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "flawless-prisma-stub" }, () => ({
      contents:
        "const make = () => { const f = function () {}; return new Proxy(f, { get: (t, p) => (p === '__esModule' ? true : p === 'then' ? undefined : (t[p] ??= make())), apply: () => make(), construct: () => new Proxy({}, { get: () => () => undefined }) }); };\\n" +
        [
          "AnyNull",
          "Bytes",
          "DbNull",
          "Decimal",
          "DecimalJsLike",
          "DMMF",
          "empty",
          "Extensions",
          "FieldRef",
          "getPrismaClient",
          "GetPrismaClientConfig",
          "InputJsonArray",
          "InputJsonObject",
          "InputJsonValue",
          "ITXClientDenyList",
          "join",
          "JsonArray",
          "JsonNull",
          "JsonObject",
          "JsonValue",
          "makeStrictEnum",
          "NullTypes",
          "Operation",
          "PrismaClientInitializationError",
          "PrismaClientKnownRequestError",
          "PrismaClientRustPanicError",
          "PrismaClientUnknownRequestError",
          "PrismaClientValidationError",
          "raw",
          "Sql",
          "SqlCommenterPlugin",
          "SqlDriverAdapterFactory",
          "sqltag",
          "Types",
        ]
          .map((n) => "export const " + n + " = make();")
          .join("\\n") +
        "\\nexport default make();",
      loader: "js",
    }));
    // The \\.js variant is real: nuqs (and other tsm-compiled libs) ship
    // pre-compiled JS importing "next/navigation.js" to satisfy TS module
    // resolution — an exact-specifier filter lets the genuine module
    // through, and its useRouter throws "expected app router to be
    // mounted" on every mount.
    build.onResolve({ filter: /^next\\/navigation(\\.js)?$/ }, (args) => ({
      path: args.path,
      namespace: "flawless-next-nav-stub",
    }));
    // next/link and next/image are REAL components that resolve from the
    // app's node_modules — and the link's router hook needs the app-router
    // context no host provides ("invariant expected app router to be
    // mounted", every chanhdai mount including icons, because the layout
    // tree in main.tsx renders SiteHeader). Answer with the DOM elements
    // they compile down to; anchors keep hrefs clickable for e2e habits.
    build.onResolve({ filter: /^next[\\/](link|image)(\\.js)?$/ }, (args) => ({
      path: args.path.indexOf("image") >= 0 ? "flawless:next/image" : "flawless:next/link",
      namespace: "flawless-next-component-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "flawless-next-component-stub" }, (args) => ({
      contents: args.path.endsWith(":image")
        ? "import * as React from 'react'; function FlawlessImage(props) { var src = typeof props.src === 'string' ? props.src : (props.src && props.src.src) || ''; return React.createElement('img', { src: src, alt: props.alt ?? '', className: props.className, width: props.width, height: props.height }); } const Image = FlawlessImage; Image.loader = (s) => (typeof s === 'string' ? s : (s && s.src) || ''); export default Image;"
        : "import * as React from 'react'; function FlawlessLink({ children, href, prefetch, scroll, replace, shallow, scrollBehavior, legacyBehavior, passHref, className, ...rest }) { return React.createElement('a', Object.assign({ href: href == null ? '#' : String(href) }, rest), children); } export default FlawlessLink;",
      loader: "jsx",
    }));
    // next/font (google/local) factories RUN at module scope in every repo
    // that imports a font package (geist et al.) — and the real loader is a
    // compiler hook with no runtime. Answer with a callable that returns the
    // same shape: className + CSS variable are all any consumer reads.
    build.onResolve({ filter: /^next[\\/]font([\\/:].*)?$/ }, (args) => ({
      path: args.path,
      namespace: "flawless-font-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "flawless-font-stub" }, () => ({
      contents:
        "function makeFont(o) { return { className: 'flawless-stub-font', variable: '--flawless-stub-font', style: { fontFamily: (o && o.fallback && o.fallback.join(', ')) || '' } }; } const ns = new Proxy(makeFont, { get: (t, p) => (p === '__esModule' ? false : p === 'then' ? undefined : (t[p] ??= makeFont)), }); module.exports = ns;",
      loader: "js",
    }));
    build.onLoad({ filter: /.*/, namespace: "flawless-next-nav-stub" }, () => ({
      contents: ${JSON.stringify(navStubSource)},
      loader: "js",
    }));
    // Pages-router twin of the nav stub, same \\.js reasoning.
    build.onResolve({ filter: /^next[\\/]router(\\.js)?$/ }, (args) => ({
      path: args.path,
      namespace: "flawless-next-router-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "flawless-next-router-stub" }, () => ({
      contents: ${JSON.stringify(pagesRouterStubSource)},
      loader: "js",
    }));
    // next/script: renders nothing without Next's router context, so a component
    // made only of <Script> would mount as an empty container. See the source.
    build.onResolve({ filter: /^next[\\/]script(\\.js)?$/ }, (args) => ({
      path: args.path,
      namespace: "flawless-next-script-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "flawless-next-script-stub" }, () => ({
      contents: ${JSON.stringify(nextScriptStubSource)},
      loader: "js",
    }));
    // The server-component marker: absent in many repos (Bun's resolver
    // fails outright) and throw-on-import where installed. Transitively
    // importing modules still have to BUILD, so the specifier resolves to
    // an empty module — same call the vitest config's alias makes.
    build.onResolve({ filter: /^server-only$/ }, () => ({
      path: "server-only",
      namespace: "flawless-empty-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "flawless-empty-stub" }, () => ({
      contents: "export {};",
      loader: "ts",
    }));
    if (Object.keys(SERVER_STUB_SPECIFIERS).length > 0) {
      build.onResolve({ filter: ${specifierFilterLiteral} }, (args) => ({
        path: args.path,
        namespace: "flawless-server-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "flawless-server-stub" }, (args) =>
        SERVER_STUB_SPECIFIERS[args.path]
          ? { contents: SERVER_STUB_SPECIFIERS[args.path], loader: "ts" }
          : // No generated surface for this specifier: a CJS Proxy answers ANY
            // named import at runtime instead of failing the ESM build.
            {
              contents:
                "const make = () => { const f = function () {}; return new Proxy(f, { get: (t, p) => (p === '__esModule' ? false : p === 'then' ? undefined : (t[p] ??= make())), apply: () => make(), construct: () => new Proxy({}, { get: () => () => undefined }) }); }; const KNOWN = ['default', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'performance', 'platform', 'arch', 'env', 'version', 'cwd', 'dirname', 'join', 'resolve', 'sep', 'delimiter', 'normalize', 'extname', 'basename', 'relative', 'isAbsolute', 'tmpdir', 'homedir', 'readFileSync', 'writeFileSync', 'existsSync', 'statSync', 'readdirSync', 'mkdirSync', 'rmSync', 'promisify', 'createReadStream', 'createWriteStream', 'createGzip', 'createDeflate', 'pipeline', 'fileURLToPath', 'pathToFileURL', 'randomUUID', 'execSync', 'spawnSync', 'execFileSync', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'AbortController', 'AbortSignal', 'EventEmitter', 'once', 'Stream', 'inspect', 'format', 'types', 'isDeepStrictEqual', 'createInterface', 'question', 'getLogger', 'Drizzle', 'drizzle', 'Kysely', 'Pool', 'Client', 'sql', 'PrismaPg', 'PrismaBetterSqlite3', 'PrismaBunSql', 'PrismaLibSql', 'PrismaD1', 'PrismaSqlite', 'SupabaseClient', 'createClient', 'globalThis']; const root = new Proxy({}, { get: (t, p) => (p === '__esModule' ? false : p === 'then' ? undefined : (t[p] ??= make())), ownKeys: () => KNOWN, getOwnPropertyDescriptor: (t, p) => ({ value: t[p] ??= make(), enumerable: true, configurable: true, writable: true }) }); module.exports = root;",
              loader: "js",
            },
      );
    }
    build.onLoad({ filter: /\\.(ts|tsx|js|jsx|mjs)$/, namespace: "file" }, (args) => {
      const src = SERVER_STUBS[args.path];
      if (src) return { contents: src, loader: "ts" };
      // next/font's NAMED exports are a compiler fiction — no real module
      // backs them at runtime, so the stub above answers the specifier with
      // a CJS Proxy. But CJS->ESM interop copies the export object's OWN
      // keys before reading any of them, and a Proxy without an ownKeys
      // trap reports none: every named font import arrives as undefined
      // and the host dies at boot with "IBM_Plex_Serif is not a function"
      // (chanhdai's first perf run, 341 specs, one error). Rewrite the
      // forms that break — named and namespace imports — onto the default
      // import, which interop preserves verbatim, and which the stub's
      // callable Proxy answers for every name.
      let code;
      try {
        code = readFileSync(args.path, "utf8");
      } catch {
        return;
      }
      if (!/next\\/font/.test(code)) return;
      let flFontSeq = 0;
      const rewritten = code
        .replace(
          /import\\s+(?:(\\w+)\\s*,\\s*)?\\{([^}]*)\\}\\s+from\\s+(["'])(next\\/font[^"']*)\\3/g,
          (m, def, clause, quote, spec) => {
            const text = String(clause).trim();
            if (text.startsWith("type")) return m;
            const parts = text
              .split(",")
              .map((s) => /^\\s*(\\w+)(?:\\s+as\\s+(\\w+))?\\s*$/.exec(s.trim()));
            const named = parts.filter((p): p is RegExpExecArray => p !== null);
            if (named.length !== parts.length) return m;
            const alias = def || "__flFont" + flFontSeq++;
            return (
              "import " + alias + " from " + quote + spec + quote + "; const " +
              named.map((p) => (p[2] || p[1]) + " = " + alias).join(", ") + ";"
            );
          },
        )
        .replace(
          /import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+(["'])(next\\/font[^"']*)\\2/g,
          (m, name, quote, spec) => {
            const alias = "__flFont" + flFontSeq++;
            return "import " + alias + " from " + quote + spec + quote + "; const " + name + " = " + alias + ";";
          },
        );
      if (rewritten === code) return;
      const ext = args.path.slice(args.path.lastIndexOf(".") + 1);
      const loader = ext === "tsx" || ext === "jsx" ? ext : ext === "js" || ext === "mjs" ? "js" : "ts";
      return { contents: rewritten, loader };
    });
  },
};
const stubCount = Object.keys(SERVER_STUBS).length;
if (stubCount > 0) {
  console.log(
    "[flawless] stubbed " + stubCount + " server-action module(s) for the browser bundle" +
      (Object.keys(SERVER_STUB_SPECIFIERS).length > 0
        ? " (" + Object.keys(SERVER_STUB_SPECIFIERS).length + " by bare specifier)"
        : ""),
  );
}
`;

  return `import path from "node:path";
import { readFileSync } from "node:fs";
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
      // msw ships its BROWSER WORKER entry behind a "browser" export
      // CONDITION, and Bun.resolveSync resolves server-side conditions —
      // answering this plugin for msw/browser would pin the node variant
      // onto a browser bundle ("setupWorker failed in a non-browser
      // environment", with global.process now faithfully present for
      // scandir to split). Subpaths therefore fall through: the bundler's
      // own resolver applies the target's conditions. The BARE specifier
      // does NOT — with a catch-all plugin on bare specifiers attached, a
      // fallen-through "msw" came back as a module shell whose named
      // imports were silently dropped: miro-clone's host booted with
      // "http is not defined" exactly where handlers.ts had written
      // import { http } from "msw". Core msw is environment-neutral
      // (its checkGlobals only checks URL), so resolving it like any other
      // package is both correct and the only shape the bundler wires.
      if (args.path.startsWith("msw/")) return;
      try {
        let resolved: string;
        try {
          resolved = Bun.resolveSync(args.path, SUITE_DIR);
        } catch {
          // A pnpm-style strict layout keeps transitive deps out of the
          // suite's reach, but they ARE visible from the importer's own
          // directory — resolve from there, the way node would. Letting the
          // specifier fall through instead can silently drop the import:
          // a transitive bare import that no plugin resolves never reaches
          // the default resolver here, and the bundler emits the use site
          // with the binding undefined ("toHtml is not defined" at boot).
          if (!args.importer) return;
          resolved = Bun.resolveSync(args.path, path.dirname(args.importer));
        }
        // A built-in comes back as its specifier ("node:fs"), not a file
        // path. In the browser target there is no such file, and
        // path.resolve("node:fs") would mangle it into "<suite>/node:fs"
        // and crash the build with a bogus "File not found". Route it to the
        // shared stub namespace (loaded below by stubServerModules) instead.
        // This fires for bare imports like \`fs\`/\`stream\` — no \`node:\`
        // prefix, so the /^(node:|bun:)/ filter above never sees them.
        if (resolved.startsWith("node:") || resolved.startsWith("bun:")) {
          return { path: args.path, namespace: "flawless-node-stub" };
        }
        return { path: resolved };
      } catch {
        return; // fall through to Bun's default resolver
      }
    });
  },
};

${stubPlugin}
// Stylesheets are deliberately invisible to the perf host. Bun's CSS loader
// cannot run the app's real pipeline — tailwind v4's \`@import "tailwindcss"\`
// resolves to the package's JS entry ("Cannot import a .js file into a CSS
// file") and @theme/@apply are custom at-rules it never compiles anyway.
// Perf measures the JS render cost; style fidelity is e2e/load's business.
const stubCss: BunPlugin = {
  name: "flawless-css-stub",
  setup(build) {
    build.onResolve({ filter: /\\.(css|scss|sass|less)(\\?.*)?$/ }, (args) => ({
      path: args.path,
      namespace: "flawless-css-stub",
    }));
    build.onResolve({ filter: /^(@?tailwindcss)([\\/:].*)?$/ }, () => ({
      path: "tailwind-import",
      namespace: "flawless-css-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "flawless-css-stub" }, () => ({
      contents: "/* flawless perf: css intentionally stubbed */",
      loader: "css",
    }));
  },
};
const built = await Bun.build({
  entrypoints: [path.join(HOST_DIR, "main.tsx")],
  target: "browser",
  format: "esm",
  splitting: false,
  sourcemap: "inline",
  minify: false,
  plugins: [stubCss, stubServerModules, resolveFromSuite],
  // Replace bare \`global\` references at build time. The runtime polyfill
  // (host/_polyfill.ts, imported first from main.tsx) handles \`process\`.
  define: {
    global: "globalThis",
${envDefineLines}
    "process.env.NODE_ENV": '"development"',
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
    <script>
      // Node-shim fill-in BEFORE any bundle code evaluates. The _polyfill
      // module cannot own this: the bundler decides module execution order,
      // and a CJS require chain reached through an app dependency (fast-glob
      // via @nodelib/fs.scandir splitting process.versions.node) ran before
      // it. An inline classic script is the only position that provably
      // precedes the bundle's module script.
      (function () {
        var g = globalThis;
        var p = (g.process = g.process || {});
        try {
          p.env = p.env || {};
          p.versions = p.versions || {};
          if (typeof p.versions.node !== "string") p.versions.node = "22.0.0";
          if (typeof p.platform !== "string") p.platform = "browser";
          if (!Array.isArray(p.argv)) p.argv = [];
          // versions.node is also msw's isNodeProcess fingerprint. The
          // renderer type is the Electron hatch msw and @mswjs/interceptors
          // built for exactly this: process-shaped-but-in-a-browser.
          if (typeof p.type !== "string") p.type = "renderer";
          if (typeof p.cwd !== "function") p.cwd = function () { return "/"; };
          if (typeof g.global === "undefined") g.global = g;
          if (typeof g.setImmediate === "undefined")
            g.setImmediate = function (fn) { return setTimeout(fn, 0); };
        } catch (e) {}
      })();
    </script>
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
  process?: {
    env: Record<string, string | undefined>;
    platform: string;
    versions: Record<string, string>;
    argv: string[];
    type?: string;
    cwd?: () => string;
  };
  global?: typeof globalThis;
  setImmediate?: (fn: (...args: unknown[]) => void, ...args: unknown[]) => number;
};

if (typeof g.process === "undefined") {
  g.process = {
    env: { NODE_ENV: "development" },
    platform: "browser",
    versions: {},
    argv: [],
    type: "renderer",
    cwd: () => "/",
  };
} else {
  // The bundler's own browser shim usually wins the race to define process,
  // and it is partial: no versions.node, which @nodelib/fs.scandir (and
  // every other fast-glob caller) splits at module scope. Fill the holes
  // rather than assume an all-or-nothing assignment.
  const p = g.process as Record<string, unknown>;
  try {
    p.env ??= {};
    p.versions ??= {};
    const v = p.versions as Record<string, string>;
    if (typeof v.node !== "string") v.node = "22.0.0";
    if (typeof p.platform !== "string") p.platform = "browser";
    if (!Array.isArray(p.argv)) p.argv = [];
    if (typeof p.type !== "string") p.type = "renderer";
    if (typeof p.cwd !== "function") p.cwd = () => "/";
  } catch {
    // A frozen shim is not this file's problem to solve.
  }
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

/**
 * host/registry.ts — the mechanical mount tables, split out of the write-once
 * wrapper (FR-016: a kept main.tsx froze the registry with it, so a newly
 * analysed component's specs could never mount, and no flag could fix it).
 * Regenerated on every run; hand registrations belong in main.tsx's ALL
 * spread, which survives.
 */
function hostRegistry(
  flat: FlatComponent[],
  providerWraps: Map<string, ProviderRef[]> | undefined,
  hostDir: string,
): string {
  // Sorted by registry key: emission is byte-identical for a given set of
  // specNames. (Byte-identity across PERMUTED entry order holds only until a
  // componentName collision — allocateSpecNames is delivery-order-dependent
  // in who keeps the bare name; that predates the split and lives upstream.)
  // Code-unit order (not localeCompare): locale rules interleave cases and
  // would reorder — churning — every adopted suite's registry on refresh.
  const sorted = [...flat].sort((a, b) =>
    a.specName < b.specName ? -1 : a.specName > b.specName ? 1 : 0,
  );
  // A wrappable compound part mounts through a composed entry: the family
  // Root (open, unless the part is the Trigger — a trigger's visible state
  // is a CLOSED root) and the Content sibling around the part itself. The
  // composition lives HERE, regenerated-side, so a kept main.tsx benefits
  // from a plain refresh — its ALL spread sees a Component like any other.
  // Wrapper imports are aliased per entry: the Root is often a registry
  // component itself, already imported under its own name from this module.
  const wrappedOf = (c: FlatComponent): NonNullable<ComponentInfo["compoundFamily"]> | undefined =>
    compoundWrappable(c.info) ? c.info.compoundFamily : undefined;
  const wrapImports = sorted
    .map((c) => {
      const fam = wrappedOf(c);
      if (!fam) return "";
      const content =
        fam.part === "other" && fam.content ? `, ${fam.content} as ${c.specName}__Content` : "";
      return `import { ${fam.root} as ${c.specName}__Root${content} } from "${c.importPath}";`;
    })
    .filter((l) => l !== "")
    .join(NL);
  const anyWrapped = wrapImports !== "";
  // Context providers to mount around each component, derived upstream in
  // analyse/providerWraps.ts from useX CALL evidence — the provider is often
  // exported by a file NO analysed component imports (route layouts import
  // SidebarProvider, and route files are not entries), so it is imported here
  // directly under a __Prov alias allocateSpecNames never produces. A
  // provider that cannot mount bare breaks the wraps it guards, and the
  // dogfood failure then names it.
  const hostedKey = new Map<string, string>();
  for (const c of sorted) {
    hostedKey.set(`${c.info.filePath}::${c.info.componentName}`, c.specName);
  }
  const provAlias = new Map<string, string>();
  const bindingLabel = new Map<string, string>();
  const provImportLines: string[] = [];
  const providersFor = (c: FlatComponent): string[] => {
    const out: string[] = [];
    const self = `${c.info.filePath}::${c.info.componentName}`;
    for (const ref of providerWraps?.get(self) ?? []) {
      const key = `${ref.filePath}::${ref.componentName}`;
      if (key === self) continue; // never wraps itself
      const hosted = hostedKey.get(key);
      if (hosted) {
        bindingLabel.set(hosted, ref.componentName);
        out.push(hosted);
        continue;
      }
      let binding = provAlias.get(key);
      if (!binding) {
        binding = `__Prov${ref.componentName}`;
        for (let n = 2; bindingLabel.has(binding); n++) binding = `__Prov${ref.componentName}${n}`;
        provAlias.set(key, binding);
        bindingLabel.set(binding, ref.componentName);
        const rel = stripTsExt(toRel(hostDir, ref.filePath));
        provImportLines.push(
          ref.exportKind === "default"
            ? `import ${binding} from "${rel}";`
            : `import { ${ref.exportedAs ?? ref.componentName} as ${binding} } from "${rel}";`,
        );
      }
      out.push(binding);
    }
    return out;
  };
  const providersByEntry = new Map<string, { bindings: string[]; labels: string[] }>();
  for (const c of sorted) {
    const bindings = providersFor(c);
    if (bindings.length > 0) {
      providersByEntry.set(
        c.specName,
        bindings.reduce(
          (acc, b) => {
            acc.bindings.push(b);
            acc.labels.push(bindingLabel.get(b) ?? b);
            return acc;
          },
          { bindings: [], labels: [] } as { bindings: string[]; labels: string[] },
        ),
      );
    }
  }
  const anyProvider = providersByEntry.size > 0;
  const imports = [
    ...(anyWrapped || anyProvider ? ['import { createElement } from "react";'] : []),
    sorted.map(hostComponentImport).join(NL),
    ...(anyWrapped ? [wrapImports] : []),
    ...(anyProvider ? [provImportLines.join(NL)] : []),
  ].join(NL);

  // Cast per entry: a component declaring required props is not assignable to
  // the host's loose (props: Record<string, unknown>) => unknown signature, and
  // supplying those props is exactly what the profile spec does at runtime.
  const withProvidersCall = (value: string, c: FlatComponent): string => {
    const entry = providersByEntry.get(c.specName);
    return entry === undefined ? value : `withProviders(${value}, [${entry.bindings.join(", ")}])`;
  };
  const registry = sorted
    .map((c) => {
      const fam = wrappedOf(c);
      const entry = fam
        ? (() => {
            const inner = `createElement(${c.specName} as never, props as never)`;
            const chained =
              fam.part === "other" && fam.content
                ? `createElement(${c.specName}__Content as never, null, ${inner})`
                : inner;
            const rootProps = fam.part === "trigger" ? "null" : "{ open: true } as never";
            return `((props: Record<string, unknown>) => createElement(${c.specName}__Root as never, ${rootProps}, ${chained})) as Component`;
          })()
        : `${c.specName} as unknown as Component`;
      return `  ${JSON.stringify(c.specName)}: ${withProvidersCall(entry, c)},`;
    })
    .join(NL);
  const providerHelper = anyProvider
    ? `
/** Nest the derived context providers around a component (outermost first). */
const withProviders = (Component: Component, providers: Component[]): Component =>
  providers.length === 0
    ? Component
    : (props) =>
        providers.reduceRight(
          (children, Provider) => createElement(Provider as never, null, children),
          createElement(Component as never, props as never),
        );
`
    : "";
  const autoTable = sorted
    .map((c) => {
      const entry = providersByEntry.get(c.specName);
      return entry ? `  ${JSON.stringify(c.specName)}: ${JSON.stringify(entry.labels)},` : "";
    })
    .filter(Boolean)
    .join(NL);

  // Function props cannot cross page.evaluate's structured clone, so a spec's
  // DEFAULTS can never carry one. The component then calls undefined: AuthError
  // renders <Button onClick={reset}> and threw the moment the click landed. The
  // host holds the names and supplies no-ops on this side of the boundary.
  const fnProps = sorted
    .map((c) => ({ name: c.specName, props: functionProps(c.info) }))
    .filter((e) => e.props.length > 0)
    .map((e) => `  ${JSON.stringify(e.name)}: ${JSON.stringify(e.props)},`)
    .join(NL);

  // Components whose root tag HTML only permits inside a particular parent.
  // Rendering <tbody> into the host's #root div made React log "In HTML, <tbody>
  // cannot be a child of <div>", which failed seven table primitives for a
  // warning the harness itself caused.
  const wrapIn = sorted
    .map((c) => ({ name: c.specName, chain: requiredAncestors(c.info.rootTag) }))
    .filter((e) => e.chain.length > 0)
    .map((e) => `  ${JSON.stringify(e.name)}: ${JSON.stringify(e.chain)},`)
    .join(NL);

  return `// Regenerated on every flawless-react run — derived tables only, so edits
// here are lost. Hand-registered components belong in main.tsx's ALL spread,
// which is never overwritten.
${imports}

/** The loose signature the host mounts through; props arrive at runtime. */
export type Component = (props: Record<string, unknown>) => unknown;
${providerHelper}
export const REGISTRY: Record<string, Component> = {
${registry}
};

/** Component → context providers the host mounts around it (useX call evidence). */
export const AUTO_PROVIDERS: Record<string, string[]> = {
${autoTable}
};

/** Props the component calls, which a serialised props object cannot carry. */
export const FN_PROPS: Record<string, string[]> = {
${fnProps}
};

/** Ancestors HTML requires around a component's root tag, outermost first. */
export const WRAP_IN: Record<string, string[]> = {
${wrapIn}
};
`;
}

function hostMain(providerImportPath?: string, mswSetup = false, legacyMount = false): string {
  const providerImport = providerImportPath
    ? `import AppProvider from ${JSON.stringify(stripTsExt(providerImportPath))};\n`
    : "";
  const wrapBody = providerImportPath ? "createElement(AppProvider as never, null, tree)" : "tree";
  // React 17 has no react-dom/client. The host speaks the legacy renderer
  // through the same small Root interface the 18+ path uses, so every
  // mount/rerender/unmount call site stays version-blind.
  const mountImport = legacyMount
    ? `import * as ReactDOM from "react-dom";

interface Root {
  render(node: ReactNode): void;
  unmount(): void;
}
`
    : `import { createRoot, type Root } from "react-dom/client";
`;
  const rootInit = legacyMount
    ? `  // React 17 has no onUncaughtError: the legacy render throws synchronously.
  // Record and rethrow — the mount wait-loop reads the same variable the
  // concurrent renderer's callback fills, so failure reporting stays identical.
  activeRoot = {
    render: (node) => {
      try {
        ReactDOM.render(node as never, el);
      } catch (err) {
        lastRenderError = err;
        throw err;
      }
    },
    unmount: () => {
      ReactDOM.unmountComponentAtNode(el);
    },
  };
`
    : `  activeRoot = createRoot(el, {
    onUncaughtError: (err: unknown) => {
      lastRenderError = err;
    },
  });
`;
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
${mountImport}import { scan } from "react-scan";
${mswImport}${providerImport}// ./registry last among the app imports: it pulls every component module,
// and the monolithic host evaluated msw/provider modules FIRST — a component
// with module-scope code leaning on a provider module's side effects (i18n
// init, interceptor install) must keep that order across the split.
import { type Component, FN_PROPS, REGISTRY, WRAP_IN } from "./registry";
${mswBoot}

// We measure renders with React's built-in Profiler rather than
// react-performance-testing's patching: the latter only instruments the
// classic JSX runtime (\`React.createElement\`), and Bun.build emits JSX via
// the automatic \`react/jsx-runtime\`. Profiler works with either runtime and
// across React versions, so the host stays portable.

// Every lookup below goes through the ALL_* spreads, never the registry
// tables directly: ./registry is regenerated on every run, so these spreads
// are the one place hand-registered entries survive. All three exist for the
// same reason — a hand-registered component may also need function-prop
// stubs (functions cannot cross page.evaluate's structured clone) or a
// wrapper chain, and without its own spread each table would silently drop
// hand entries on the next regeneration.
const ALL: Record<string, Component> = {
  ...REGISTRY /* hand-registered components ride here and survive regeneration */,
};
const ALL_FN_PROPS: Record<string, readonly string[]> = {
  ...FN_PROPS /* hand-registered components' function-prop names ride here */,
};
const ALL_WRAP_IN: Record<string, readonly string[]> = {
  ...WRAP_IN /* hand-registered components' wrapper chains ride here */,
};

function withFnProps(name: string, props: Record<string, unknown>): Record<string, unknown> {
  const names = ALL_FN_PROPS[name];
  if (!names) return props;
  const out = { ...props };
  for (const p of names) if (out[p] === undefined) out[p] = () => {};
  return out;
}

function nest(name: string, tree: ReactNode): ReactNode {
  const chain = ALL_WRAP_IN[name];
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

// react-scan is measurement sugar: on a React it cannot instrument (17 is
// supported but its internals differ) it must never take the host down —
// render counts come from the Profiler, not from scan.
try {
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
} catch (err) {
  console.warn("[flawless] react-scan disabled:", err);
}

// The last exception React swallowed on our behalf. Without it every render
// failure looked identical — "did not render within 5000ms" — no matter whether
// the component threw on a missing prop, a missing provider or a bad import.
let lastRenderError: unknown;

function ensureRoot(): Root {
  if (activeRoot) return activeRoot;
  const el = document.getElementById("root");
  if (!el) throw new Error("#root not found");
${rootInit}  return activeRoot;
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
  list: () => Object.keys(ALL),
  async mount(name, props) {
    const Comp = ALL[name];
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
    const Comp = ALL[name];
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
  // Anchored to the CONFIG FILE via the runtime FullConfig — the one anchor
  // that exists under both loaders. NOT rootDir: playwright resolves rootDir
  // to the testDir ("./profile" here), which would put snapshots in
  // profile/heaps/ outside the emitted .gitignore's <out>/heaps/ entry — the
  // 566MB-of-untracked-binaries class this path has already been through
  // twice (cwd first, the CJS dirname global second).
  const configFile = testInfo.config.configFile;
  const suiteRoot = configFile ? path.dirname(configFile) : testInfo.config.rootDir;
  const dir = path.join(suiteRoot, HEAPS_DIR);
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
  const propsLiteral = defaultsJson(synthesiseDefaults(c.info));
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
  // scenario skips with the reason instead of clicking whatever is first:
  // an empty locator forces clickSkipReason below, so this expression is only
  // ever emitted with a derived target in it.
  const clickButtonExpr = targetedClick.locator;
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

/**
 * The profile suite's README, in the vocabulary of the mode that generated it.
 *
 * Standalone, the suite is its own package and `bun run test` is its script.
 * In Next.js mode there is no suite package.json — it is skipped in renderSuite
 * — so the same block told the user to run `bun run test`, which walks up to the
 * APPLICATION's package.json and runs its real test suite. That reads as
 * success, which is why it lasted.
 *
 * Only the perf scripts are named. This file IS the perf-harness output, so
 * those are the only ones guaranteed to have been declared by the run that
 * wrote it; naming flawless:e2e or flawless:load here would reintroduce the
 * defect one task over.
 */
function readme(
  suiteName: string,
  componentNames: string[],
  excluded: ExcludedComponent[] = [],
  opts: { nextjsHost?: boolean; report?: boolean } = {},
): string {
  const nextjs = Boolean(opts.nextjsHost);
  const perfScript = nextjs ? NEXT_SCRIPT.perf : SUITE_SCRIPT.test;
  // Commented lines aligned on the longest command in THIS block, rather than a
  // fixed width — `bun run flawless:report` is wider than the standalone names
  // the constant was picked for, and overflowed it.
  const runLines: Array<[string, string]> = nextjs
    ? [[`bun run ${perfScript}`, "headless"]]
    : [
        [`bun run ${perfScript}`, "headless"],
        [`bun run ${SUITE_SCRIPT.headed}`, "open Chromium"],
      ];
  if (opts.report) {
    runLines.push([
      `bun run ${nextjs ? NEXT_SCRIPT.report : SUITE_SCRIPT.report}`,
      "aggregate the last run into report.md",
    ]);
  }
  const width = Math.max(...runLines.map(([cmd]) => cmd.length));
  const commented = runLines.map(([cmd, note]) => `${cmd.padEnd(width)}  # ${note}`).join("\n");
  // No `bun install` in Next.js mode: the host project owns node_modules, and
  // there is no suite package.json here to install from.
  const runBlock = nextjs ? commented : `bun install\n${commented}`;
  // The React-version note is about the suite's OWN package.json, which only
  // exists standalone. In Next.js mode the host project owns node_modules and
  // there is no `bun install` here to pin anything.
  const reactNote = nextjs
    ? "- Components import their own React from the host project's `node_modules`, which is the only copy in play."
    : "- Components import their own React from the parent project's `node_modules`. The suite's own React must match the major version; `bun install` here pins the version your app declares (detected at generation; `^18.3.0` when nothing is detectable).";
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

Auto-generated by [flawless-react](https://github.com/lariocpt/flawless-react).

This README is not yours — it is regenerated by \`--force\`, so that a later
version of flawless-react can tell you something it worked out after your suite
was generated. Put your own notes in \`host/main.tsx\` or \`budgets.json\`: those
two are written once and never overwritten, and everything else here is derived
and will be rebuilt.

## Run

\`\`\`bash
${runBlock}
\`\`\`

## What's measured

- **Mount time** and **update times** per component, via React's built-in \`<Profiler>\`.
- **Unnecessary rerenders** flagged by \`react-scan\`.
- Wall-clock distribution (min / avg / p50 / p95 / max) over a forced-rerender loop.

## Customise

- \`budgets.json\` — tighten per-component mount/update budgets. Tests warn (not fail) on breach by default; switch the \`console.warn\` to \`expect(...).toBeLessThan(...)\` to make them hard.
- \`profile/_helpers.ts\` — add scenarios; e.g. mock data sources before \`mountComponent\`.
- \`host/main.tsx\` — hand-register extra components in the \`ALL\` spread. The tables in \`host/registry.ts\` are regenerated on every run, so entries added there are lost.

## Notes

${reactNote}
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
function reportScript(reportScriptName: string, perfScriptName: string): string {
  return `#!/usr/bin/env node
// Aggregates the latest Playwright run's stdout into a markdown summary at report.md.
// Re-run with: bun run ${reportScriptName}
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Anchored to this file, not to the working directory. Standalone the script is
// run from the suite root and a relative path happened to work; in Next.js mode
// the script is declared in the APP's package.json and runs from the app root,
// where "test-results/..." resolves somewhere that does not exist.
const SUITE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The JSON reporter's output, not playwright-report/index.html. The HTML report
// keeps every stdout line inside a base64 zip blob under
// window.playwrightReportBase64, so the regex below matched nothing there and
// this script wrote a report with no sections in it.
const RESULTS = path.join(SUITE_DIR, "test-results", "results.json");

let report;
try {
  report = JSON.parse(readFileSync(RESULTS, "utf8"));
} catch {
  console.error("no " + RESULTS + " — run \`bun run ${perfScriptName}\` first");
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
writeFileSync(path.join(SUITE_DIR, "report.md"), sections.join("\\n"));
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
