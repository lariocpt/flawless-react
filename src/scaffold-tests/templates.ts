import path from "node:path";
import { type AuthStub, authShimVitestBlock, collectAuthStubs } from "../analyse/authShims.ts";
import {
  libraryShimSource,
  providerKey,
  referencedLibraryShims,
} from "../analyse/providerWraps.ts";
import { relativeToEmitted } from "../emitPaths.ts";
import { titleSafe } from "../scaffold/templates.ts";
import { VITEST_CONFIG } from "../suiteScripts.ts";
import type {
  ClickHandler,
  ComponentInfo,
  ComponentTree,
  FetchCallInfo,
  FormInfo,
  LabelSource,
  NextjsApiRoute,
  PredicateSiteInfo,
  PropsShape,
  ProviderRef,
  StateInfo,
  TodoCounter,
  TodoRecorder,
} from "../types.ts";
import {
  apiRouteFixture,
  dottedMockConflicts,
  emitModuleMocks,
  inferredDepReturn,
  mockSpecifier,
} from "./mocks.ts";
import { decidePostDispatch, describeNoClaim, type PostDispatchContext } from "./postDispatch.ts";
import {
  allocateSpecNames,
  compoundWrappable,
  type FlatComponent,
  flattenTrees,
  hostEligibility,
  synthesiseDefaults,
  withRouteParams,
} from "./registry.ts";
import {
  awaitSelector,
  describeUnlocatable,
  emitPlaywrightClickTarget,
  emitPlaywrightDispatch,
  emitPlaywrightFill,
  emitPlaywrightSelector,
  emitPlaywrightSubmit,
  emitTriggerSelector,
  emitVitestDispatch,
  emitVitestFill,
  emitVitestFillAssertion,
  emitVitestSelector,
  emitVitestSubmit,
  firstOf,
} from "./selectors.ts";
import { stamp } from "./stamp.ts";

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
  /**
   * `find` is a RAW regex source (anchors included), emitted verbatim rather
   * than escaped-and-wrapped. Used for the pnpm-realpath pins: vite resolves
   * an internalized package to its realpath under <nm>/.pnpm/<name>@<ver>/,
   * and the package's own require("react") is a request-level rewrite no
   * request alias can intercept — only a pattern against the resolved path.
   */
  raw?: boolean;
}

/**
 * A tsconfig prefix (usually `@/`) claimed by TWO packages whose tsconfigs
 * point it at different directories — a workspace with an app and a docs site.
 * One global vite alias cannot honour both, so these resolve per importer
 * through the emitted plugin instead of resolve.alias.
 */
export interface MultiRootAlias {
  /** Import prefix as tsconfig writes it, wildcard stripped ("@/"). */
  prefix: string;
  /** Candidate target directories in root-discovery order. */
  dirs: string[];
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
  /** tsconfig prefixes claimed by several roots with different targets: the
   *  emitted config resolves those per importer instead of aliasing them. */
  multiRootAliases?: MultiRootAlias[];
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
  /**
   * Collector for the TODO(flawless) markers these templates plant, mutated as
   * each marker is emitted (TodoCounter in types.ts says why never by grep).
   * It rides the options object through scaffoldUnitBrowser unchanged, so the
   * unit-browser task can hand the tallies to the run report.
   */
  todos?: TodoCounter;
  /**
   * Derived context providers to mount around each unit render, keyed by
   * providerKey (analyse/providerWraps.ts). The same map the perf host
   * consumes: a component that throws "must be used within X" on the host
   * throws the same in its unit spec, and one derivation fixes both planes.
   */
  providerWraps?: Map<string, ProviderRef[]>;
  /**
   * The APP package's root — where its .env files live. Emitted into the
   * vitest config as a config-load reader: modules under test execute their
   * import-time side effects (a prisma client doing `new URL(process.env
   * .DATABASE_URL)` at module scope crashes every importing spec at
   * collection when the variable is unset, while the app itself reads that
   * file from this very directory).
   */
  appEnvRoot?: string;
}

export function renderUnitBrowser(opts: UnitBrowserRenderOptions): RenderedFile[] {
  const flat = flattenTrees(opts.trees);
  const specNames = allocateSpecNames(flat);
  const withBrowser = opts.browserSpecs !== false;
  const authStubs = collectAuthStubs(flat.map((c) => c.info));
  const files: RenderedFile[] = [
    { relPath: "setup.ts", content: setupTs(Boolean(opts.mswSetup), authStubs) },
    // The inert target of the /^server-only$/ alias in the vitest config: the
    // marker package is missing or throw-on-import, and a transitive importer
    // (MDX -> a server table -> "server-only") cannot be saved by a per-spec
    // vi.mock. This file is the whole alias target.
    {
      relPath: "server-only-stub.ts",
      content: "// Inert replacement for the server-component marker package.\nexport {};\n",
    },
    // Generated library-provider shims the wrap map mounts: the file lives at
    // the IMPORTING PACKAGE's root, not the outDir, because that is the only
    // place the bare library import inside it resolves (package hoisting is
    // not a thing in bun workspaces). Tool-owned content — rewritten per run.
    ...referencedLibraryShims(
      opts.providerWraps,
      flat.map((c) => c.info.filePath),
    ).map((shim) => ({
      relPath: path.relative(opts.outDir, shim.filePath),
      absPath: shim.filePath,
      content: libraryShimSource(shim.module, shim.componentName),
    })),
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

  // The emitted vitest config roots at the outDir's parent; a component
  // whose source lives OUTSIDE that root (a workspace-resolved child in a
  // sibling package) cannot colocate — the config could never run the spec,
  // while the sibling's own test glob WOULD, under the wrong setup. Those
  // fall back to in-outDir placement.
  const configRoot = path.dirname(path.resolve(opts.outDir));

  for (const c of specTargets) {
    const specName = specNames.get(c) as string;
    const colocatable =
      opts.colocate && !path.relative(configRoot, path.resolve(c.info.filePath)).startsWith("..");
    if (colocatable) {
      const srcDir = path.dirname(c.info.filePath);
      const base = path.basename(c.info.filePath).replace(/\.(tsx|jsx|ts|js)$/, "");
      // Multi-component files get one spec per component (card.CardHeader....)
      // so they don't overwrite each other.
      const stem =
        (perFile.get(c.info.filePath) ?? 1) > 1 ? `${base}.${c.info.componentName}` : base;
      const absPath = path.join(srcDir, `${stem}.flawless.test.tsx`);
      files.push({
        relPath: `unit/${specName}.test.tsx`,
        absPath,
        skipIfExists: true,
        content: renderUnitFile(c, opts, srcDir, `./${base}`, opts.todos?.for(absPath)),
      });
    } else {
      const fromDir = path.resolve(opts.outDir, "unit");
      // The recorder is bound to the path the writer will use, so a tally's
      // exemplar names the spec that actually carries the marker.
      const target = path.join(fromDir, `${specName}.test.tsx`);
      files.push({
        relPath: `unit/${specName}.test.tsx`,
        content: renderUnitFile(
          c,
          opts,
          fromDir,
          toRel(fromDir, c.info.filePath),
          opts.todos?.for(target),
        ),
      });
    }
  }

  if (withBrowser) {
    for (const c of specTargets) {
      // The browser spec mounts through the perf host's REGISTRY by name, so
      // the emit predicate must be the host's OWN — hostEligibility — not a
      // re-derivation of it. This loop used to check `renderMode === "client"`,
      // which is broader than the host: a client component whose render()
      // branches on an undecidable condition is refused by the host ("no
      // render to profile") yet still drew a browser spec that threw
      // "unknown component" on every run (FR-061). And it is narrower: a
      // wrappable compound part the host DOES carry drew no browser spec at
      // all. One predicate, four call sites — the unit spec emitter, the host
      // registry, the report, and here.
      if (!hostEligibility(c.info).eligible) continue;
      const specName = specNames.get(c) as string;
      const target = path.join(path.resolve(opts.outDir), "browser", `${specName}.spec.ts`);
      files.push({
        relPath: `browser/${specName}.spec.ts`,
        // Stamped like the colocated specs, for the same reason: this file is
        // only rewritten while the component STAYS mountable. Once it leaves
        // the host the file is simply no longer rendered, and the stamp is
        // what lets the writer tell "our own stale output" (safe to remove)
        // from "a human worked in here" (never touch).
        content: stamp(browserSpec(c, specName, opts.todos?.for(target))),
      });
    }
  }
  // The config's include has to cover wherever the colocated specs actually
  // landed — derived from the emitted files, so filtering rules stay in one
  // place. Rendered last for that reason, prepended so it is written first.
  files.unshift({ relPath: VITEST_CONFIG, content: vitestConfig(opts) });
  return files;
}

function renderUnitFile(
  c: FlatComponent,
  opts: UnitBrowserRenderOptions,
  specDir: string,
  importPath: string,
  todo?: TodoRecorder,
): string {
  const providerImport = opts.provider ? toImportPath(specDir, opts.provider) : undefined;
  const mocksImport = opts.mswSetup
    ? toImportPath(specDir, path.join(path.resolve(opts.outDir), "mocks", "node.ts"))
    : undefined;
  const mode = c.info.renderMode ?? (c.info.isAsync ? "rsc" : "client");
  // Derived wraps ride along only where the spec actually mounts the
  // component. constrainedSpec voids providerImport for the same reason:
  // these specs never render interactively, so nothing to wrap.
  const autoProv = autoProviderBits(c.info, opts.providerWraps, specDir);
  if (mode === "compound-part" || mode === "document-root") {
    return constrainedSpec(c, importPath, providerImport, mode, specDir, todo, opts.apiRoutes);
  }
  return mode === "rsc"
    ? rscSpec(c, importPath, providerImport, specDir, todo, opts.apiRoutes, autoProv)
    : unitSpec(
        c,
        opts.variants,
        importPath,
        providerImport,
        mocksImport,
        opts.apiRoutes,
        specDir,
        todo,
        autoProv,
      );
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

/** Spec-side rendering of one component's derived provider wraps. */
interface AutoProvBits {
  imports: string;
  open: string;
  close: string;
}

/**
 * Turn the derived provider map into spec imports and a JSX nest. Bindings
 * carry a `__Prov` prefix so they can never collide with anything the spec
 * imports itself (the same convention the host registry uses).
 */
function autoProviderBits(
  info: ComponentInfo,
  wraps: Map<string, ProviderRef[]> | undefined,
  specDir: string,
): AutoProvBits {
  const refs = wraps?.get(providerKey(info)) ?? [];
  if (refs.length === 0) return { imports: "", open: "", close: "" };
  const imports: string[] = [];
  let open = "";
  let close = "";
  for (const ref of refs) {
    const binding = `__Prov${ref.componentName}`;
    const rel = toImportPath(specDir, ref.filePath);
    imports.push(
      ref.exportKind === "default"
        ? `import ${binding} from "${rel}";`
        : `import { ${ref.exportedAs ?? ref.componentName} as ${binding} } from "${rel}";`,
    );
    open = `${open}<${binding}>`;
    close = `</${binding}>${close}`;
  }
  return { imports: `${imports.join("\n")}\n`, open, close };
}

/** Named vs default import, from the analyser's exportKind. */
function emitComponentImport(info: ComponentInfo, importPath: string): string {
  const stripped = stripTsExt(importPath);
  if (info.exportKind === "default") {
    return `import ${info.componentName} from "${stripped}";`;
  }
  // A re-export alias is the module's real binding; the internal name is not
  // importable. Alias it back so every spec body can keep naming the component.
  if (info.exportedAs && info.exportedAs !== info.componentName) {
    return `import { ${info.exportedAs} as ${info.componentName} } from "${stripped}";`;
  }
  return `import { ${info.componentName} } from "${stripped}";`;
}

function vitestConfig(opts: UnitBrowserRenderOptions): string {
  // Every replacement is resolved against the config's own directory rather
  // than baked in absolute. This file is committed, and the react/react-dom
  // pins in particular pointed into a node_modules path that exists only on the
  // machine that generated them — on a checkout rooted elsewhere the suite
  // could not resolve React at all.
  const aliasLines = (opts.resolveAliases ?? [])
    .map((a) => {
      const rel = JSON.stringify(relativeToEmitted(opts.outDir, a.replacement));
      const target = a.prefix
        ? `path.resolve(configDir, ${rel}) + "/"`
        : `path.resolve(configDir, ${rel})`;
      // Raw patterns are emitted as regex LITERALS, so every "/" in the
      // source must carry a backslash — an unescaped one would terminate the
      // literal mid-pattern and leave the config unparseable.
      const find = a.raw
        ? `/${a.find.replace(/\//g, "\\/")}/`
        : a.prefix
          ? `/^${escapeRegex(a.find)}/`
          : `/^${escapeRegex(a.find)}$/`;
      return `      { find: ${find}, replacement: ${target} },`;
    })
    .concat(
      // The server-component MARKER package: not installed in many repos (vite
      // fails to resolve the import outright — chanhdai's MDX crashed at
      // collection on a transitive one), and where installed its module THROWS
      // on import. Both lands want the same thing: resolve the specifier to
      // nothing so the surrounding module loads and jsdom mounts what is
      // really ordinary code. Per-spec vi.mock cannot reach transitive
      // importers, the alias can.
      [
        (() => {
          const rel = JSON.stringify(
            relativeToEmitted(opts.outDir, path.resolve(opts.outDir, "server-only-stub.ts")),
          );
          return `      { find: /^server-only$/, replacement: path.resolve(configDir, ${rel}) },`;
        })(),
      ],
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
  // Several roots claiming one tsconfig prefix. The alias map is a pure string
  // rewrite, so with two packages both writing `@/` to different targets half
  // the repo's imports land in the wrong tree (nakama: docs/website's
  // `@/lib/source` resolved into apps/web). Resolve per importer instead:
  // prefer the candidate the importer itself lives under, then whichever
  // candidate actually has the file. Dirs are emitted configDir-relative so
  // the config survives a moved checkout.
  const multi = opts.multiRootAliases ?? [];
  const multiBlock =
    multi.length === 0
      ? ""
      : `const multiRootPaths = [
${multi
  .map(
    (m) =>
      `  { prefix: ${JSON.stringify(m.prefix)}, dirs: [${m.dirs
        .map((d) => `path.resolve(configDir, ${JSON.stringify(relativeToEmitted(opts.outDir, d))})`)
        .join(", ")}] },`,
  )
  .join("\n")}
];
const probeFile = (base: string): string | null => {
  for (const cand of [
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((e) => base + e),
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map((e) =>
      path.join(base, "index" + e),
    ),
  ]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
};
const multiRootPlugin = {
  name: "flawless-multiroot-tsconfig-paths",
  enforce: "pre",
  resolveId(spec: string, importer?: string) {
    for (const m of multiRootPaths) {
      if (!spec.startsWith(m.prefix)) continue;
      const rest = spec.slice(m.prefix.length);
      const dirs = [...m.dirs].sort(
        (a, b) => (importer?.startsWith(b) ? 1 : 0) - (importer?.startsWith(a) ? 1 : 0),
      );
      for (const dir of dirs) {
        const hit = probeFile(path.join(dir, rest));
        if (hit) return hit;
      }
    }
    return null;
  },
};
`;
  const pluginsBlock = multi.length === 0 ? "" : `  plugins: [multiRootPlugin],\n`;
  // The app's .env files, read at config load — see UnitBrowserRenderOptions
  // .appEnvRoot for why the suite must see them. Nothing is copied into this
  // file, and keys already in the environment win: exporting an override
  // still redirects the suite.
  const envBlock = opts.appEnvRoot
    ? `{
  const appRoot = path.resolve(
    configDir,
    ${JSON.stringify(relativeToEmitted(opts.outDir, opts.appEnvRoot))},
  );
  for (const file of [".env.test.local", ".env.test", ".env.local", ".env"]) {
    try {
      const text = readFileSync(path.join(appRoot, file), "utf8");
      for (const line of text.split("\\n")) {
        const kv = line.match(/^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (kv && !(kv[1] in process.env))
          process.env[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      /* that file does not exist */
    }
  }
}

`
    : "";
  const fsNames = [
    ...(multi.length > 0 ? ["existsSync", "statSync"] : []),
    ...(envBlock ? ["readFileSync"] : []),
  ];
  const fsImport = fsNames.length === 0 ? "" : `import { ${fsNames.join(", ")} } from "node:fs";\n`;
  if (opts.colocate) {
    // Colocate mode runs as `vitest run --config <out>/vitest.config.mts`.
    // Vite roots itself at the CONFIG file's directory, so without an explicit
    // root the include globs resolve under <out>/ and match nothing.
    //
    // The out dir's own name, not the literal "flawless": setupFiles and the
    // unit include were hardcoded to it, so --colocate with the standalone
    // default (.flawless) or any --out pointed vitest at a setup file that does
    // not exist, and it died at startup.
    const outName = path.basename(opts.outDir);
    // Root-wide, NOT derived from this run's emitted files: the config is
    // always rewritten, so a per-run derivation (run 1 over src/**, run 2 over
    // app/**) left only the latest run's dirs and silently deselected every
    // previously colocated spec. The same two globs, whatever this run
    // touched — run-order independent and byte-identical across runs by
    // construction. Known limit: with --out OUTSIDE the project tree the
    // config root is the out dir's parent and cannot reach colocated specs in
    // the source tree — same as before this change, and out of scope here.
    const include = [`**/*.flawless.test.{ts,tsx}`, `${outName}/unit/**/*.test.{ts,tsx}`];
    return `${fsImport}import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(configDir, "..");
${multiBlock}${envBlock}export default defineConfig({
  root: projectRoot,
${pluginsBlock}  // The automatic JSX runtime, pinned HERE: a Next.js host's tsconfig says
  // jsx "preserve", which gives vitest's esbuild nothing usable, and every
  // spec died at render with "React is not defined". The suite pins react
  // >=18, where the automatic runtime always exists (FR-018 — found the
  // first time an emitted spec was actually executed in this repo).
  esbuild: { jsx: "automatic" },
  // Kill the PostCSS config FILE search: vite walks up from the suite and
  // picks up the repo's own postcss config (a tailwind v4 plugin vite cannot
  // even load here — "Invalid PostCSS Plugin found at: plugins[0]"). Specs
  // never need the app's styles (test.css is false below).
  css: { postcss: { plugins: [] } },
${resolveBlock}  test: {
    environment: "jsdom",
    setupFiles: [path.join(configDir, "setup.ts")],
    include: [${include.map((g) => JSON.stringify(g)).join(", ")}],
    // Setting exclude REPLACES vitest's defaults, so the standard set rides
    // along explicitly: without dist/ here, a build step that copies raw
    // .flawless.test sources into dist/ would run every spec twice. The
    // root-wide include reaches all of them; this committed config must be
    // safe on its own terms.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.{idea,git,cache,output,temp}/**"],
    globals: true,
    css: false,
    // Run the harness's own closure (testing-library, react, react-dom)
    // through vite instead of node's require: that is what lets the resolve
    // ALIASES above apply to it. Externalized, @testing-library/react's
    // require("react") bypasses vite entirely and lands on a second React —
    // React-19 components then render under React-18 ("Objects are not valid
    // as a React child", "useOptimistic is not a function").
    server: {
      deps: {
        inline: [/@testing-library/, /^react$/, /^react\\//, /^react-dom$/, /^react-dom\\//],
      },
    },
  },
});
`;
  }
  const anchor =
    aliasLines.length > 0 || multi.length > 0 || envBlock !== ""
      ? `${fsImport}import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const configDir = path.dirname(fileURLToPath(import.meta.url));
${multiBlock}${envBlock}`
      : `import { defineConfig } from "vitest/config";

`;
  return `${anchor}export default defineConfig({
${pluginsBlock}  // See the colocate branch: a host tsconfig with jsx "preserve" (the
  // Next.js default) left esbuild on the classic runtime and every render
  // threw "React is not defined" (FR-018).
  esbuild: { jsx: "automatic" },
  // Kill the PostCSS config FILE search: vite walks up from the suite and
  // picks up the repo's own postcss config (a tailwind v4 plugin vite cannot
  // even load here — "Invalid PostCSS Plugin found at: plugins[0]"). Specs
  // never need the app's styles (test.css is false below).
  css: { postcss: { plugins: [] } },
${resolveBlock}  test: {
    environment: "jsdom",
    setupFiles: ["./setup.ts"],
    include: ["unit/**/*.test.{ts,tsx}"],
    globals: true,
    css: false,
    // Run the harness's own closure (testing-library, react, react-dom)
    // through vite instead of node's require: that is what lets the resolve
    // ALIASES above apply to it. Externalized, @testing-library/react's
    // require("react") bypasses vite entirely and lands on a second React —
    // React-19 components then render under React-18 ("Objects are not valid
    // as a React child", "useOptimistic is not a function").
    server: {
      deps: {
        inline: [/@testing-library/, /^react$/, /^react\\//, /^react-dom$/, /^react-dom\\//],
      },
    },
  },
});
`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function setupTs(mswSetup: boolean, authStubs = new Map<string, AuthStub>()): string {
  // Global signed-out stubs for provider-bound auth libs (analyse/authShims.ts
  // says why): a bare unit mount has no SessionProvider/ClerkProvider, and the
  // real modules throw before the component under test renders.
  const authMocks = [...authStubs.entries()]
    .map(([spec, stub]) => authShimVitestBlock(spec, stub))
    .join("");
  const polyfills = `
// Native-import interception: the runner loads node_modules packages through
// plain import(), where vi.mock cannot reach them. The resolve hook below
// answers two classes that die at collection: font-loader wrappers executing
// at module scope (geist), and router-wrapper libraries mounting the REAL
// next/navigation — "invariant expected app router to be mounted".
// registerHooks (synchronous, runs IN this thread) is preferred over
// register() (spawns a separate hooks thread Node deprecates); the stubs ride
// as data: URLs so no file-path juggling is needed — import.meta.url is an
// http: URL under vite-node, which the native loader rejects. The capability
// guard keeps older Node (no registerHooks) compiling and running unchanged.
import * as __flNodeModule from "node:module";
{
  const fontStub =
    "const font={className:'',variable:'',style:{fontFamily:''}};" +
    "export default function fontLoader(){return font}";
  const navigationStub =
    "const noop=()=>{};" +
    "export function notFound(){throw new Error('notFound() called')}" +
    "export function redirect(){throw new Error('NEXT_REDIRECT')}" +
    "export function permanentRedirect(){throw new Error('NEXT_REDIRECT')}" +
    "export function usePathname(){return '/'}" +
    "export function useRouter(){return{push:noop,replace:noop,refresh:noop,back:noop,forward:noop,prefetch:noop}}" +
    "export function useSearchParams(){return new URLSearchParams()}" +
    "export function useParams(){return {}}" +
    "export function useRoute(){return '/'}";
  const registerHooks = (__flNodeModule as unknown as {
    registerHooks?: (hooks: {
      resolve?: (
        specifier: string,
        context: unknown,
        nextResolve: (specifier: string) => { url: string; format: string; shortCircuit: boolean },
      ) => { url: string; format: string; shortCircuit: boolean };
    }) => void;
  }).registerHooks;
  if (registerHooks) {
    registerHooks({
      resolve: (specifier, _context, nextResolve) => {
        // Bundled library output imports "next/navigation.js" with the
        // extension, so the bare name and the .js spelling both match.
        if (/^next\\/font(\\/.*)?$/.test(specifier)) {
          return {
            url: \`data:text/javascript,\${encodeURIComponent(fontStub)}\`,
            format: "module",
            shortCircuit: true,
          };
        }
        if (/^next\\/navigation(\\.js)?$/.test(specifier)) {
          return {
            url: \`data:text/javascript,\${encodeURIComponent(navigationStub)}\`,
            format: "module",
            shortCircuit: true,
          };
        }
        return nextResolve(specifier);
      },
    });
  }
}

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
  Element.prototype.getAnimations ??= (() => [] as Animation[]) as typeof Element.prototype.getAnimations;

  // jsdom ships no Web Audio: the "play a sound on click" hook crashes at
  // mount on \`new AudioContext()\` — an unhandled rejection that exits the
  // run rc=1 even when every test passed. The graph below is inert but
  // complete: every node answers, params chain, and \`decodeAudioData\`
  // resolves so awaiting loaders complete instead of rejecting.
  class FlawlessAudioParam {
    value = 0;
    defaultValue = 0;
    minValue = -3.4028234663852886e38;
    maxValue = 3.4028234663852886e38;
    setValueAtTime(): FlawlessAudioParam { return this; }
    linearRampToValueAtTime(): FlawlessAudioParam { return this; }
    exponentialRampToValueAtTime(): FlawlessAudioParam { return this; }
    setTargetAtTime(): FlawlessAudioParam { return this; }
    setValueCurveAtTime(): FlawlessAudioParam { return this; }
    cancelScheduledValues(): FlawlessAudioParam { return this; }
    cancelAndHoldAtTime(): FlawlessAudioParam { return this; }
  }
  class FlawlessAudioNode {
    channelCount = 2;
    numberOfInputs = 1;
    numberOfOutputs = 1;
    connect<T>(node: T): T { return node; }
    disconnect(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean { return true; }
  }
  class FlawlessAudioBuffer {
    numberOfChannels: number;
    length: number;
    sampleRate: number;
    constructor(channels: number, length: number, sampleRate: number) {
      this.numberOfChannels = Math.max(1, channels | 0);
      this.length = Math.max(1, length | 0);
      this.sampleRate = sampleRate > 0 ? sampleRate : 44100;
    }
    get duration(): number { return this.length / this.sampleRate; }
    getChannelData(): Float32Array { return new Float32Array(this.length); }
    copyToChannel(): void {}
    copyFromChannel(): void {}
  }
  class FlawlessSourceNode extends FlawlessAudioNode {
    buffer: unknown = null;
    loop = false;
    loopStart = 0;
    loopEnd = 0;
    playbackRate = new FlawlessAudioParam();
    detune = new FlawlessAudioParam();
    onended: ((event?: unknown) => void) | null = null;
    start(): void {}
    stop(): void {}
  }
  class FlawlessAudioContext extends FlawlessAudioNode {
    readonly sampleRate = 44100;
    readonly state = "suspended";
    readonly baseLatency = 0;
    readonly destination = new FlawlessAudioNode();
    readonly listener: Record<string, unknown> = {};
    readonly audioWorklet = { addModule: async () => {} };
    onstatechange: ((event?: unknown) => void) | null = null;
    get currentTime(): number { return 0; }
    createBuffer(channels: number, length: number, sampleRate: number) {
      return new FlawlessAudioBuffer(channels, length, sampleRate);
    }
    createBufferSource() { return new FlawlessSourceNode(); }
    createGain() {
      const n = new FlawlessAudioNode();
      return Object.assign(n, { gain: new FlawlessAudioParam() });
    }
    createBiquadFilter() {
      const n = new FlawlessAudioNode();
      return Object.assign(n, {
        frequency: new FlawlessAudioParam(),
        Q: new FlawlessAudioParam(),
        gain: new FlawlessAudioParam(),
        detune: new FlawlessAudioParam(),
        getFrequencyResponse: () => {},
      });
    }
    createDynamicsCompressor() {
      const n = new FlawlessAudioNode();
      return Object.assign(n, {
        threshold: new FlawlessAudioParam(),
        knee: new FlawlessAudioParam(),
        ratio: new FlawlessAudioParam(),
        attack: new FlawlessAudioParam(),
        release: new FlawlessAudioParam(),
        reduction: 0,
      });
    }
    createStereoPanner() {
      const n = new FlawlessAudioNode();
      return Object.assign(n, { pan: new FlawlessAudioParam() });
    }
    createPanner() {
      return new FlawlessAudioNode();
    }
    createOscillator() {
      const n = new FlawlessAudioNode();
      return Object.assign(n, {
        frequency: new FlawlessAudioParam(),
        detune: new FlawlessAudioParam(),
        onended: null,
        start: () => {},
        stop: () => {},
      });
    }
    createDelay() {
      const n = new FlawlessAudioNode();
      return Object.assign(n, { delayTime: new FlawlessAudioParam() });
    }
    createWaveShaper() {
      const n = new FlawlessAudioNode();
      return Object.assign(n, { curve: null, oversample: "none" });
    }
    createConvolver() {
      const n = new FlawlessAudioNode();
      return Object.assign(n, { buffer: null, normalize: true });
    }
    createAnalyser() {
      const n = new FlawlessAudioNode();
      return Object.assign(n, {
        fftSize: 2048,
        frequencyBinCount: 1024,
        minDecibels: -100,
        maxDecibels: -30,
        smoothingTimeConstant: 0.8,
        getByteFrequencyData: () => {},
        getByteTimeDomainData: () => {},
        getFloatFrequencyData: () => {},
        getFloatTimeDomainData: () => {},
      });
    }
    createChannelMerger() { return new FlawlessAudioNode(); }
    createChannelSplitter() { return new FlawlessAudioNode(); }
    decodeAudioData(
      _data: ArrayBuffer,
      onSuccess?: (buffer: unknown) => void,
      onError?: (e: unknown) => void,
    ): Promise<unknown> {
      const buffer = this.createBuffer(2, 1, this.sampleRate);
      onSuccess?.(buffer);
      void onError;
      return Promise.resolve(buffer);
    }
    resume(): Promise<void> { return Promise.resolve(); }
    suspend(): Promise<void> { return Promise.resolve(); }
    close(): Promise<void> { return Promise.resolve(); }
  }
  const webAudio = FlawlessAudioContext as unknown as typeof AudioContext;
  window.AudioContext ??= webAudio;
  (window as unknown as Record<string, unknown>).webkitAudioContext ??= webAudio;
  (window as unknown as Record<string, unknown>).OfflineAudioContext ??= FlawlessAudioContext;

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
 // Global next/navigation mock: covers provider wrappers and third-party
 // libs (Clerk, TanStack Router, etc.) that import next/navigation
 // internally. Per-test mocks still override for specific components.
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => { throw new Error("notFound() called"); }),
  redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  permanentRedirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); }),
  usePathname: vi.fn(() => "/"),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
  useRoute: vi.fn(() => "/"),
  useSelectedLayoutSegment: vi.fn(() => null),
  useSelectedLayoutSegments: vi.fn(() => []),
}));
// Global next/cache mock: revalidate & co. are no-ops without a server, and
// cacheLife()/cacheTag() THROW at execution time ("... is only available
// with the cacheComponents config") in a plain vitest process — an app whose
// cached server actions call them fails every spec that executes one.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
// Global next/font mocks: the loaders are compile-time shims in the Next
// pipeline; their runtime modules have NO exports to enumerate. A factory
// listing only \`default\` starves named loaders (\`import { Caveat } from
// "next/font/google"\`), so hand every requested name the same callable stub
// through a Proxy. Native imports (node_modules wrappers like geist that run
// the loader at module scope) bypass vi.mock entirely — the resolve hook
// registered above answers those.
vi.mock("next/font", () => {
  const loader = () => ({ className: "", variable: "", style: { fontFamily: "" } });
  return new Proxy({}, {
    get: (_t, p) => (p === "__esModule" ? true : typeof p === "string" && p !== "then" ? loader : undefined),
    has: () => true,
  });
});
vi.mock("next/font/local", () => {
  const loader = () => ({ className: "", variable: "", style: { fontFamily: "" } });
  return new Proxy({}, {
    get: (_t, p) => (p === "__esModule" ? true : typeof p === "string" && p !== "then" ? loader : undefined),
    has: () => true,
  });
});
vi.mock("next/font/google", () => {
  const loader = () => ({ className: "", variable: "", style: { fontFamily: "" } });
  return new Proxy({}, {
    get: (_t, p) => (p === "__esModule" ? true : typeof p === "string" && p !== "then" ? loader : undefined),
    has: () => true,
  });
});
${authMocks}`;
  // The explicit vi import: setup files run with vitest's globals at runtime,
  // but the emitted suite must also TYPE-check standalone, and the nav/auth
  // mocks below are bare vi.mock calls.
  if (!mswSetup) {
    return `import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
${polyfills}`;
  }
  return `import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
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
// Native-import stub modules (Node ESM resolve hook + stubs, see setupTs)
// ---------------------------------------------------------------------------

function fontStubMjs(): string {
  return `// Runtime stub for the Next.js font loaders. Next replaces these imports at
// BUILD time; under a bare test runner the loaders either cannot resolve
// (next/font/local is a directory import Node ESM rejects) or are empty
// shims whose default export is not callable. Any module that runs the
// loader at module scope — geist and friends — needs this to stand in. The
// default export must be a FUNCTION: wrapper packages CALL it at module
// scope and use the result's className/variable/style.
const font = {
  className: "",
  variable: "",
  style: { fontFamily: "" },
};

export function createDefault() {
  return font;
}

export default function fontLoader() {
  return font;
}
`;
}

function navigationStubMjs(): string {
  return `// Runtime stub for next/navigation under NATIVE imports. The test runner
// loads node_modules packages through plain import(), where vi.mock cannot
// reach; libraries that wrap the router (@bprogress and friends) then hit
// the real module and die on "invariant expected app router to be mounted".
// Same semantics as the setup-file vi.mock: redirects throw (Next aborts
// rendering at those calls), router methods are no-ops.
const noop = () => {};

export function notFound() {
  throw new Error("notFound() called");
}

export function redirect() {
  throw new Error("NEXT_REDIRECT");
}

export function permanentRedirect() {
  throw new Error("NEXT_REDIRECT");
}

export function usePathname() {
  return "/";
}

export function useRouter() {
  return {
    push: noop,
    replace: noop,
    refresh: noop,
    back: noop,
    forward: noop,
    prefetch: noop,
  };
}

export function useSearchParams() {
  return new URLSearchParams();
}

export function useParams() {
  return {};
}

export function useRoute() {
  return "/";
}
`;
}

function nativeImportHooksMjs(): string {
  return `// Node ESM resolve hook: the test runner loads node_modules packages through
// native import(), where vi.mock cannot reach. Two classes of Next module
// break that way. The font loaders: geist and friends run them at module
// scope, and next/font/local's directory import has no ESM answer (next
// ships no exports map). next/navigation: router-wrapper libraries hit the
// real module and throw "invariant expected app router to be mounted".
// Point each class at its stub; everything else resolves normally. Bundled
// library output imports "next/navigation.js" with the extension, so the
// bare name and the .js spelling both match.
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = pathToFileURL(fileURLToPath(new URL(".", import.meta.url))).href;
const FONT_STUB = \`\${dir}font-stub.mjs\`;
const NAVIGATION_STUB = \`\${dir}navigation-stub.mjs\`;

export async function resolve(specifier, context, nextResolve) {
  if (/^next\\/font(\\/.*)?$/.test(specifier)) {
    return { url: FONT_STUB, format: "module", shortCircuit: true };
  }
  if (/^next\\/navigation(\\.js)?$/.test(specifier)) {
    return { url: NAVIGATION_STUB, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
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
  todo?: TodoRecorder,
  autoProv?: AutoProvBits,
): string {
  const info = c.info;
  const name = info.componentName;
  // No render could be described at all: renderPath could not decide which
  // branch runs and every branch returns content. README has said since it was
  // written that such a component "produces no description at all", and until
  // renderUndecidable existed nothing recorded it — so the walk fell back to the
  // whole body and the spec drove a control inside a branch the defaults never
  // take. Executed: "Unable to find an accessible element with the role
  // 'button' and name 'Try again'" on a component that is entirely correct.
  //
  // A skip that names the cause, and nothing else. Not a mount test either: the
  // mount is the same claim in a weaker voice, and for a class whose props are
  // required it does not even compile.
  if (info.renderUndecidable === true) {
    // An error boundary is the one undecidable render whose BOTH branches a spec
    // can reach — React's contract for getDerivedStateFromError says a throwing
    // child puts it into the caught state — so it gets a real two-path spec
    // rather than the refusal.
    const fallback = info.errorBoundary?.fallbackText ?? [];
    if (info.errorBoundary && fallback.length > 0) {
      return errorBoundarySpec(name, importPath, info, fallback);
    }
    todo?.("other");
    return undecidableRenderSpec(name, importPath, info);
  }
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

  // What THIS spec mocks, which is what it can assert on. Derived from
  // moduleImports rather than from emitModuleMocks' result, because that runs
  // later in this function and the ladder is needed here — the two agree because
  // client mode mocks the allowlist plus "use server" modules, and both read the
  // same field.
  const claimCtx = {
    info,
    ctx: {
      mockedBindings: new Set(
        (info.moduleImports ?? []).filter((mi) => mi.isServerAction).flatMap((mi) => mi.names),
      ),
      routerMocked: (info.moduleImports ?? []).some((mi) => mi.specifier === "next/navigation"),
    },
  };

  // Bindings a rung-2 claim will assert on. They have to be IMPORTED into the
  // spec: vi.mock replaces the module, so importing the name yields the mock —
  // but without the import the assertion is a ReferenceError. Computed by
  // running the same ladder the emitter will, so the two cannot disagree.
  const assertedBindings = new Set<string>();
  for (const click of interactions?.clicks ?? []) {
    const claim = decidePostDispatch(info, click, claimCtx.ctx);
    if (claim.kind === "module-spy") assertedBindings.add(claim.binding);
  }
  for (const form of interactions?.forms ?? []) {
    const a = form.actionBinding;
    if (a !== undefined && claimCtx.ctx.mockedBindings.has(a)) assertedBindings.add(a);
  }
  // Only when something actually uses it: an unused import fails a project's own
  // lint gate, which is where these files have to live.
  const fireEventImport = (interactions?.forms ?? []).some(
    (f) => f.actionBinding !== undefined && claimCtx.ctx.mockedBindings.has(f.actionBinding),
  )
    ? ", fireEvent"
    : "";
  const assertedImports = (info.moduleImports ?? [])
    .map((mi) => {
      const wanted = mi.names.filter((n) => assertedBindings.has(n));
      if (wanted.length === 0) return undefined;
      return `import { ${wanted.join(", ")} } from "${mockSpecifier(mi, specDir)}";`;
    })
    .filter((l): l is string => l !== undefined);

  const interactionTests = interactions
    ? emitInteractionTests(
        name,
        interactions,
        allHandlers,
        firstClickTrigger(info),
        claimCtx,
        info.renderGuarded === true,
        todo,
      )
    : emitFallbackHandlerTests(name, info.propsShape, info.unresolvedProps);

  const stateTests = emitStateTests(name, info, todo);
  const staticTextTests = emitStaticTextTests(name, info, "unit");
  const effectFetches = (info.fetchCalls ?? []).filter((f) => f.inEffect);
  const fetchTests =
    mocksImport && effectFetches.length > 0
      ? emitFetchTests(name, info, effectFetches, apiRoutes, firstClickTrigger(info), todo)
      : "";

  const providerLine =
    (providerImport ? `import AppProvider from "${providerImport}";\n` : "") +
    (autoProv?.imports ?? "");
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
  const wrappedElement = autoProv?.open ? `${autoProv.open}${element}${autoProv.close}` : element;
  const renderExpr = providerImport
    ? `render(<AppProvider>${wrappedElement}</AppProvider>)`
    : `render(${wrappedElement})`;
  // The variant matrix asserts the component's OWN root where one is known.
  // `container.firstElementChild` used to stand here and cannot fail — see the
  // mount branch for why.
  const variantRootTag =
    info.rootTag && /^[a-z]/.test(info.rootTag) && !info.renderGuarded ? info.rootTag : undefined;
  const variantAssert = variantRootTag
    ? `const { container } = renderTarget(v);\n      expect(container.querySelector(${JSON.stringify(variantRootTag)}), \`\${JSON.stringify(v)} rendered no <${variantRootTag}>\`).not.toBeNull();`
    : "expect(() => renderTarget(v), `${JSON.stringify(v)} threw on mount`).not.toThrow();";

  // `Props` exists only to type the props spread, and the React import exists
  // only to declare it. A zero-prop component renders bare, so emitting either
  // leaves dead code that fails a project's lint gate (noUnusedVariables).
  const propsTypeBlock = hasProps ? `import type * as React from "react";\n` : "";
  const propsAlias = hasProps ? `\ntype Props = React.ComponentProps<typeof ${name}>;\n` : "";

  // Client specs emitted no mocks at all until now, so a component importing
  // next/navigation or calling a server action through useActionState blew up on
  // import. Allowlist only — see mocks.ts for why a blanket mock is wrong here.
  const mocks = emitModuleMocks(info, "client", specDir, todo).statements;
  const mockBlock = mocks.length > 0 ? `${mocks.join("\n")}\n` : "";

  return `import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor${fireEventImport} } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
${propsTypeBlock}${mswImports}${mockBlock}${providerLine}${emitComponentImport(info, importPath)}
${assertedImports.join("\n")}
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
      ${variantAssert}
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
test("${name} mounts at defaults without throwing", () => {
  // No host root tag resolved for this component, so nothing here claims it
  // rendered one. \`expect(container.firstElementChild).not.toBeNull()\` stood
  // here and is not that claim either: any wrapper in the render tree — a
  // provider injecting a <script>, say — answers it whether or not the component
  // rendered anything at all.
  expect(() => renderTarget()).not.toThrow();
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
 * Each cva option renders an observably different DOM.
 *
 * Deliberately NOT an assertion about specific Tailwind tokens. `cn()` is
 * usually tailwind-merge, which drops base classes a later variant conflicts
 * with — verified against the real DOM, where `rounded-lg` is absent at
 * size="sm" — and the tool cannot know whether a project's `cn` merges or just
 * concatenates. What the cva table DOES support is that two options whose class
 * strings differ must produce different output. Comparing the whole outerHTML,
 * not the class attribute, is what makes that hold for the shadcn pattern of
 * expressing the variant as `data-variant`/`data-size` (the group root carries
 * the data attributes; the per-variant classes live in the CSS through them)
 * while still catching a variant that reaches no DOM at all.
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
test("${name}: every \`${key}\` option renders distinct markup", () => {
  const seen = ${JSON.stringify(options)}.map((option) => {
    const { container, unmount } = renderTarget({ ${JSON.stringify(key)}: option });
    const el = container.querySelector("[class]");
    expect(el, \`${key}=\${option} rendered no element carrying a class\`).not.toBeNull();
    const dom = el?.outerHTML ?? "";
    unmount();
    return dom;
  });
  expect(new Set(seen).size, "two options rendered identical markup").toBe(seen.length);
});`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// State-derived tests
// ---------------------------------------------------------------------------

function emitStateTests(name: string, info: ComponentInfo, todo?: TodoRecorder): string {
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
      const dispatch = emitVitestDispatch(click.event, selector, { tag: click.tag });
      if (!dispatch) continue;
      todo?.("other");
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
 *
 * Skipping is only honest if the query is non-throwing, so the selector is
 * rewritten to its query twin for EVERY shape it can take: getBy* → queryBy*,
 * getAllBy* → queryAllBy* (an empty result's [0] is undefined), and the
 * querySelector assertion dropped. The old bare getBy→queryBy rewrite left the
 * getAllBy* forms throwing on absence, and the throw failed all four fetch
 * scenarios on a correct component.
 */
function firstClickTrigger(info: ComponentInfo): string | undefined {
  const click = info.interactions?.clicks.find((c) => c.event === "onClick");
  if (!click) return undefined;
  const selector = emitVitestSelector(click);
  if (!selector) return undefined;
  const query = selector
    .replace(".getAllBy", ".queryAllBy")
    .replace(".getBy", ".queryBy")
    .replace(/\)!$/, ")");
  return `const trigger = ${query};
    if (trigger) await userEvent.click(trigger as HTMLElement);`;
}

function emitFetchTests(
  name: string,
  info: ComponentInfo,
  fetches: FetchCallInfo[],
  apiRoutes: NextjsApiRoute[] | undefined,
  trigger: string | undefined,
  todo?: TodoRecorder,
): string {
  const triggerLines = trigger
    ? `\n    // Effects can be gated behind UI state — fire the first detected click.\n    ${trigger}`
    : "";
  // Every marker below goes through this helper so the tally and the emitted
  // text cannot drift apart when a scenario is added or removed.
  const todoLine = (text: string): string => {
    todo?.("other");
    return `// TODO(flawless): ${text}`;
  };
  const propNames = new Set([...Object.keys(info.propsShape), ...info.unresolvedProps]);
  const parts: string[] = [];
  for (const f of fetches) {
    const mswPath = f.urlTemplate;
    const method = f.method.toLowerCase();
    const fixture = apiRouteFixture(f.urlTemplate, f.method, apiRoutes);
    const fixtureLiteral = fixture !== undefined ? JSON.stringify(fixture) : "{}";
    const fixtureComment =
      fixture !== undefined
        ? "// Fixture from the project's OpenAPI spec examples."
        : todoLine("no example found in the API spec — replace {} with a realistic fixture.");

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
    ${todoLine("assert rendered content derived from FIXTURE.")}
  });

  test("stays stable while the response is delayed (loading state)", async () => {
    let calls = 0;
    server.use(http.${method}(URL, async () => { calls++; await delay(150); return HttpResponse.json(FIXTURE as never); }));
    const { container } = renderTarget(${renderArg});
    void container;${triggerLines}
    await waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });
    ${todoLine("assert the loading indicator while the response is pending.")}
  });

  test("survives a 500 without crashing (error state)", async () => {
    let calls = 0;
    server.use(http.${method}(URL, () => { calls++; return new HttpResponse(null, { status: 500 }); }));
    const { container } = renderTarget(${renderArg});
    void container;${triggerLines}
    await waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });
    ${todoLine("assert the error-state UI.")}
  });

  test("renders the empty state for an empty payload", async () => {
    let calls = 0;
    server.use(http.${method}(URL, () => { calls++; return HttpResponse.json(${emptyPayloadFor(fixture)}); }));
    const { container } = renderTarget(${renderArg});
    void container;${triggerLines}
    await waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });
    ${todoLine("assert the empty-state copy.")}
  });
});`);
  }
  return `\n${parts.join("\n")}\n`;
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
  todo?: TodoRecorder,
  apiRoutes?: NextjsApiRoute[],
): string {
  const info = c.info;
  const name = info.componentName;
  const note = (info.renderNotes ?? []).join(" ");
  void providerImport;

  // Importing the module runs its module scope, so "server-only" and
  // next/font/* throw at collection time even for a spec that only asserts the
  // export exists. These specs emitted no mocks at all until now.
  const mocks = emitModuleMocks(info, "rsc", specDir, todo, apiRoutes).statements;
  const mockBlock = mocks.length > 0 ? `${mocks.join("\n")}\n` : "";

  if (mode === "document-root") {
    const propsLiteral = JSON.stringify(withRouteParams(info.propsShape));
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

  if (compoundWrappable(info) && info.compoundFamily) {
    return compoundPartSpec(info, name, note, importPath, mocks, mockBlock);
  }

  todo?.("compound-root-wrap");
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

/**
 * A compound part whose OWN file exports its family mounts the way call
 * sites do: the Trigger inside a closed Root (the state where a trigger is
 * visible), everything else inside <Root open> — with the Content sibling
 * in between for parts that live inside the popup. Portal content lands
 * outside the render container, so assertions read the whole document rather
 * than the container: through screen and baseElement both where the part takes
 * children and there is slot text to look for, and by counting what the mount
 * put in the document where it does not.
 */
function compoundPartSpec(
  info: ComponentInfo,
  name: string,
  note: string,
  importPath: string,
  mocks: string[],
  mockBlock: string,
): string {
  const family = info.compoundFamily as NonNullable<ComponentInfo["compoundFamily"]>;
  const wrapNames = [
    family.root,
    ...(family.part === "other" && family.content ? [family.content] : []),
  ].filter((n) => n !== name);
  const wrapImport =
    wrapNames.length > 0
      ? `import { ${wrapNames.join(", ")} } from "${stripTsExt(importPath)}";\n`
      : "";

  const propsSpread = `{...(DEFAULTS as React.ComponentProps<typeof ${name}>)}`;
  const child = info.acceptsChildren ? `<span>flawless-slot</span>` : undefined;
  const partJsx = child
    ? `<${name} ${propsSpread}>${child}</${name}>`
    : `<${name} ${propsSpread} />`;
  const open = family.part === "trigger" ? "" : " open";
  const wrapped =
    family.part === "other" && family.content
      ? `<${family.root}${open}><${family.content}>${partJsx}</${family.content}></${family.root}>`
      : `<${family.root}${open}>${partJsx}</${family.root}>`;

  // Both portal surfaces. screen is bound to document.body, so it sees a part
  // that rendered through a portal and a part that rendered inline alike;
  // baseElement is the same document from the render result's side. A part
  // that rendered nowhere satisfies neither.
  //
  // getAllByText, not getByText: getByText additionally demands the child appear
  // EXACTLY once, which is not a property of the part under test. Real
  // primitives duplicate it — a radix Select mounted without its Trigger renders
  // a mirror <option> for the bubble select, so getByText made the emitted
  // SelectItem spec red against a perfectly healthy component. getAllByText
  // still throws "Unable to find an element with the text" on zero matches, so
  // a part that renders nothing is still caught.
  //
  // With no child to witness, count elements instead: render() always appends
  // its own container div to baseElement, so >1 means the composed mount put
  // something in the document. A bare not.toThrow() did not even ask that.
  //
  // Honest about its reach: a Root is a context provider and renders no DOM of
  // its own, so for a trigger or the content part this fails when the part
  // renders nothing. An "other" part is wrapped in the Content sibling too,
  // and that sibling's own DOM satisfies the count on its own — there the
  // assertion witnesses the mount, not the part.
  const body = child
    ? `  const { baseElement } = render(${wrapped});
  expect(screen.getAllByText("flawless-slot").length).toBeGreaterThan(0);
  expect(baseElement.textContent).toContain("flawless-slot");`
    : `  const { baseElement } = render(${wrapped});
  expect(baseElement.querySelectorAll("*").length).toBeGreaterThan(1);`;

  return `import { test, expect${mocks.length > 0 ? ", vi" : ""} } from "vitest";
import { render${child ? ", screen" : ""} } from "@testing-library/react";
import type * as React from "react";
${mockBlock}${emitComponentImport(info, importPath)}
${wrapImport}
// ${name} ${note}
// Its own file exports the family, so the spec mounts the part the way call
// sites do instead of skipping. Portal content lands outside the container, so
${
  child
    ? "// the assertions read the whole document — via screen and baseElement."
    : `// the assertion reads the whole document. This part takes no children, so
// there is no slot text to look for: it asserts the mount put elements in the
// document at all.`
}
const DEFAULTS: Record<string, unknown> = ${JSON.stringify(synthesiseDefaults(info))};

test("${name} mounts inside its family wrapper", () => {
${body}
});
`;
}

function rscSpec(
  c: FlatComponent,
  importPath: string,
  providerImport: string | undefined,
  specDir?: string,
  todo?: TodoRecorder,
  apiRoutes?: NextjsApiRoute[],
  autoProv?: AutoProvBits,
): string {
  const info = c.info;
  const name = info.componentName;
  const propsLiteral = JSON.stringify(withRouteParams(info.propsShape));
  const promiseProps = info.promiseProps ?? [];

  const mocks = emitModuleMocks(info, "rsc", specDir, todo, apiRoutes).statements;

  const providerLine =
    (providerImport ? `import AppProvider from "${providerImport}";\n` : "") +
    (autoProv?.imports ?? "");
  // Captured: @testing-library appends its container to document.body on
  // every render, so asserting on document.body could not fail even when the
  // component rendered nothing. The container is what this component produced.
  const renderExpr = providerImport
    ? autoProv?.open
      ? `rendered = render(<AppProvider>${autoProv.open}{ui}${autoProv.close}</AppProvider>)`
      : `rendered = render(<AppProvider>{ui}</AppProvider>)`
    : autoProv?.open
      ? `rendered = render(${autoProv.open}{ui}${autoProv.close})`
      : `rendered = render(<>{ui}</>)`;

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
  const inversionTests = emitPredicateInversionTests(name, info, providerImport, specDir, autoProv);

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
  // Hoisted so the assertion below stays OUTSIDE the try: an assertion
  // failure must be reported as itself, never swallowed by the guard catch.
  let rendered: ReturnType<typeof render> | undefined;
  try {
    const ui: React.ReactNode = await ${name}(${callArgs});
    ${renderExpr};
  } catch (err) {
    // notFound()/redirect() are legitimate outcomes when the mocked data layer
    // returns nothing — this component declares ${guardSummary}.
    if (/notFound\\(\\) called|NEXT_REDIRECT|NEXT_NOT_FOUND/.test(String(err))) return;
${uncertainEscape(info, apiRoutes)}    // Not a guard and not an admitted gap: a real failure, reported as itself
    // rather than as a confusing "expected TypeError to match /notFound/".
    throw err;
  }
  expect(rendered?.container.innerHTML.length ?? 0).toBeGreaterThan(0);
  void screen;
});
${staticTextTests}${guardTests}${inversionTests}`;
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
function uncertainEscape(info: ComponentInfo, apiRoutes?: NextjsApiRoute[]): string {
  // A dep with an inferred return (annotation, or the emit-time OpenAPI
  // join) is coverage, not an admitted gap — its crash must report as a real
  // failure, or the inferred fixture could be wrong forever without anyone
  // seeing red.
  const uncertain =
    (info.dataDeps ?? []).some(
      (d) => (d.uncertain || d.shape.kind === "unknown") && !inferredDepReturn(d, apiRoutes),
    ) ||
    // A dotted-mock conflict falls back to {} even when every dep's shape is
    // certain — the crash on the missing member is the tool's admitted gap,
    // not the application's failure.
    dottedMockConflicts(info.dataDeps ?? []);
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
      // getAllByText, not getByText: the claim is "this text renders", and a
      // page legitimately rendering the same literal twice (an eyebrow above
      // a card title) must not fail it on multiplicity.
      expect(screen.getAllByText(t).length).toBeGreaterThan(0);
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

/** The import names emitGuardTests already emitted, so nothing binds twice. */
function guardTestImportNames(info: ComponentInfo): Set<string> {
  const deps = info.dataDeps ?? [];
  return new Set(
    (info.guards ?? [])
      .filter((g) => g.triggerValue !== undefined && g.depVars.length === 1)
      .map((g) => deps.find((d) => d.varName === g.depVars[0]))
      .filter((d): d is NonNullable<typeof d> => Boolean(d?.specifier))
      .map((d) => d.calleeRoot),
  );
}

/**
 * B-19: the OTHER side of every certified predicate. One test per control,
 * two legs in it: the defaults leg proves each witness the inverted leg will
 * assert against actually renders (B-26's lesson — an absence over text that
 * never rendered passes vacuously), then a single Once-override flips the
 * predicate and the second mount asserts the sides that changed. No guard
 * catch on the inverted mount: the analyser certified the flip stays on the
 * render path, so an exit there is the certification being wrong — a tool
 * gap that must fail red, never pass.
 */
function emitPredicateInversionTests(
  name: string,
  info: ComponentInfo,
  providerImport: string | undefined,
  specDir?: string,
  autoProv?: AutoProvBits,
): string {
  const controls = info.predicateInversions ?? [];
  const refusals = info.predicateRefusals ?? [];
  if (controls.length === 0 && refusals.length === 0) return "";

  const callArgs = rscCallArgs(info);
  const renderOf = (uiVar: string): string => {
    if (autoProv?.open) {
      const uiExpr = `${autoProv.open}{${uiVar}}${autoProv.close}`;
      return providerImport ? `render(<AppProvider>${uiExpr}</AppProvider>)` : `render(${uiExpr})`;
    }
    return providerImport
      ? `render(<AppProvider>{${uiVar}}</AppProvider>)`
      : `render(<>{${uiVar}}</>)`;
  };
  const staticText = info.staticText ?? [];
  const mountProof = staticText[0];
  const parts: string[] = [];
  const importNames = new Map<string, string>(); // callee → import specifier
  const already = guardTestImportNames(info);

  // The import must spell the module the way the vi.mock above did — a
  // relative specifier re-based onto the spec's own directory — or an
  // out-dir spec imports a path that does not exist there.
  const needImport = (callee: string | undefined): boolean => {
    if (!callee) return false;
    const mi = (info.moduleImports ?? []).find((m) => !m.isTypeOnly && m.names.includes(callee));
    if (!mi) return false;
    if (!already.has(callee)) importNames.set(callee, mockSpecifier(mi, specDir));
    return true;
  };

  for (const c of controls) {
    const flippedWitnessOf = (s: PredicateSiteInfo): string | undefined =>
      s.baselineSide ? s.falseWitness : s.trueWitness;
    const baselineWitnessOf = (s: PredicateSiteInfo): string | undefined =>
      s.baselineSide ? s.trueWitness : s.falseWitness;
    // An absence claim over text the page also renders unconditionally would
    // red on correct code; those witnesses assert presence only.
    const absenceSafe = (w: string): boolean => !staticText.some((t) => t.includes(w));

    if (c.kind === "dep-null") {
      if (!c.calleeRoot || !needImport(c.calleeRoot) || !mountProof) continue;
      const texts = staticText.slice(0, 3);
      parts.push(`
test("${name}: ${c.varName} = null — the guard's other side renders", async () => {
  // null is a legal return of ${c.calleeRoot}'s own annotation, so the page
  // below the guard is reachable by contract — and only this flip reaches it.
  vi.mocked(${c.calleeRoot}).mockResolvedValueOnce(null as never);
  const ui: React.ReactNode = await ${name}(${callArgs});
  const view = ${renderOf("ui")};
  const text = (view.container.textContent ?? "").replace(/\\s+/g, " ");
${texts.map((t) => `  expect(text).toContain(${JSON.stringify(t)});`).join("\n")}
});`);
      continue;
    }

    // The single override that flips this predicate.
    let override = "";
    let mountExpr = `${name}(${callArgs})`;
    if (c.kind === "prop") {
      const path = c.propPath ?? [];
      const lit = c.flip === undefined ? "undefined" : JSON.stringify(c.flip);
      if (path.length === 1) {
        mountExpr = `${name}(buildProps({ ${path[0]}: ${lit} }) as never)`;
      } else if (path.length === 2) {
        const root = JSON.stringify(path[0]);
        mountExpr = `${name}(buildProps({ ${path[0]}: { ...(DEFAULTS[${root}] as Record<string, unknown>), ${path[1]}: ${lit} } }) as never)`;
      } else {
        continue;
      }
    } else {
      if (!c.calleeRoot || !needImport(c.calleeRoot)) continue;
      const lit = c.kind === "dep-empty" ? "[]" : "false";
      override = c.awaited
        ? `vi.mocked(${c.calleeRoot}).mockResolvedValueOnce(${lit} as never);`
        : `vi.mocked(${c.calleeRoot}).mockReturnValueOnce(${lit} as never);`;
    }

    const leg1: string[] = [];
    const leg2: string[] = [];
    const counters: string[] = [];
    for (const [i, s] of c.sites.entries()) {
      const bw = baselineWitnessOf(s);
      const fw = flippedWitnessOf(s);
      if (s.reachableAtDefaults && bw !== undefined) {
        leg1.push(`  expect(t0).toContain(${JSON.stringify(bw)});`);
        if (s.reachableWhenFlipped && absenceSafe(bw)) {
          leg2.push(`  expect(t1).not.toContain(${JSON.stringify(bw)});`);
        }
      }
      if (s.reachableWhenFlipped && fw !== undefined) {
        leg2.push(`  expect(t1).toContain(${JSON.stringify(fw)});`);
      }
      const bc = s.baselineSide ? s.trueCallee : s.falseCallee;
      const fc = s.baselineSide ? s.falseCallee : s.trueCallee;
      if (bc && needImport(bc)) {
        counters.push(`  const n${i}b = vi.mocked(${bc}).mock.calls.length;`);
        leg2.push(`  expect(vi.mocked(${bc}).mock.calls.length).toBe(n${i}b);`);
      }
      if (fc && needImport(fc)) {
        counters.push(`  const n${i}f = vi.mocked(${fc}).mock.calls.length;`);
        leg2.push(`  expect(vi.mocked(${fc}).mock.calls.length).toBeGreaterThan(n${i}f);`);
      }
    }
    if (leg2.length === 0) continue;
    if (mountProof) leg2.unshift(`  expect(t1).toContain(${JSON.stringify(mountProof)});`);

    const what =
      c.kind === "dep-empty" ? `${c.varName} = [] — the empty side` : `${c.varName} flipped`;
    const textLine =
      leg1.length > 0
        ? `  const t0 = (first.container.textContent ?? "").replace(/\\s+/g, " ");\n`
        : "";
    const legOne =
      leg1.length + counters.length === 0
        ? ""
        : `  // Leg 1 — defaults. Asserting the witnesses HERE is what keeps the
  // inverted leg's absences honest: text that never rendered cannot
  // meaningfully "go absent".
  const ui0: React.ReactNode = await ${name}(${callArgs});
  const first = ${renderOf("ui0")};
${textLine}${[...leg1, ...counters].join("\n")}
  first.unmount();
`;
    parts.push(`
test("${name}: ${what} — ${c.sites.length} branch site(s) change side", async () => {
${legOne}  // ${legOne ? "Leg 2 — one" : "One"} override, the other side. No guard catch: the flip was
  // certified to stay on the render path, so an exit here is a tool gap
  // and must be red.
  ${override}
  const ui1: React.ReactNode = await ${mountExpr};
  const second = ${renderOf("ui1")};
  const t1 = (second.container.textContent ?? "").replace(/\\s+/g, " ");
${leg2.join("\n")}
});`);
  }

  for (const r of refusals) {
    const reason: Record<typeof r.reason, string> = {
      "multi-call": "its callee is called more than once, and a Once-override flips only the first",
      "guard-entangled": "its value decides an exit guard — that false side exits, not renders",
      invisible: "flipping it provably changes no rendered branch",
      unwitnessed: "no branch it moves carries an assertable witness",
      capped: "certified, but over this spec's inversion cap",
    };
    parts.push(`
test.skip("${name}: ${r.varName} inversion refused — ${reason[r.reason]}", () => {});`);
  }

  if (parts.length === 0) return "";
  const importLines = [...importNames].map(
    ([callee, spec]) => `import { ${callee} } from ${JSON.stringify(spec)};`,
  );
  // vi.mock is hoisted, so these resolve to the mocks declared above.
  return `\n${importLines.join("\n")}\n${parts.join("\n")}\n`;
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
  claimCtx: { info: ComponentInfo; ctx: PostDispatchContext },
  renderGuarded = false,
  todo?: TodoRecorder,
): string {
  // `if (!user) return null` with an unresolvable `user` means the component may
  // render nothing at all at the props a spec can synthesise. The JSX below the
  // guard is still the best description of the component, but driving it needs a
  // fixture the tool cannot build — so the interaction tests say that instead of
  // failing on an element that was never going to mount.
  if (renderGuarded) {
    todo?.("other");
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
    parts.push(emitClickTest(name, click, allHandlers, i, claimCtx, prelude, todo));
  }
  for (let i = 0; i < info.forms.length; i++) {
    const form = info.forms[i];
    if (!form) continue;
    parts.push(emitFormTest(name, form, allHandlers, i, claimCtx.ctx.mockedBindings, todo));
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
  /** The component and the spec's mocking surface, for decidePostDispatch. */
  claimCtx: { info: ComponentInfo; ctx: PostDispatchContext },
  prelude?: string,
  todo?: TodoRecorder,
): string {
  const labelDesc = describeClickLabel(click);
  const selector = emitVitestSelector(click);
  if (!selector) {
    // No test id, no aria-label, no role, no id, no literal copy, and either a
    // component tag or a host tag with siblings of its kind — nothing in the
    // source identifies this element. Say which; the previous fallback queried
    // the component NAME as a CSS selector, matched nothing, clicked null and
    // passed.
    todo?.("unaddressable-target");
    return `
test.skip("${name}: ${click.event} on ${labelDesc} #${idx} — ${describeUnlocatable(click)}", () => {
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
    { tag: click.tag },
  );
  if (!dispatch) {
    // A change/input handler on something that holds no text — React's onChange
    // bubbles, so `<form onChange>` is idiomatic delegation. Typing into the form
    // element itself is not a thing; its fields are covered by the form test.
    return `
test.skip("${name}: ${click.event} on ${labelDesc} #${idx} — <${click.tag}> holds no value to change", () => {
  // The handler is delegation from a field inside it; the form test drives those.
});
`;
  }
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
  // What this click provably does — a module the spec mocks, or the router — or
  // an admission that it does nothing observable. The old floor here was
  // `expect(container.firstElementChild).not.toBeNull()`, which under a provider
  // is answered by the PROVIDER's node and so cannot fail, and without one goes
  // red on a component that legitimately unmounts. See postDispatch.ts.
  const claim = decidePostDispatch(claimCtx.info, click, claimCtx.ctx);
  if (claim.kind === "skip") {
    todo?.("other");
    return `test.skip("${name} ${click.event} on ${labelDesc} #${idx} — ${titleSafe(describeNoClaim(claim.reason))}", () => {
  // TODO(flawless): ${describeNoClaim(claim.reason)}, so any assertion after the
  // dispatch would be about something this spec never caused. Supply props that
  // make it reachable and this becomes a real interaction test.
});`;
  }
  // The isolation asserts are a real claim and are APPENDED to whichever rung
  // fires — they never replace one.
  const isolation = isolationAsserts ? `\n${isolationAsserts}` : "";
  if (claim.kind === "module-spy") {
    return `test("${name} ${click.event} on ${labelDesc} #${idx} → ${claim.binding} called", async () => {
  const { container } = renderTarget();
  void container;${preludeLines}
  // The mount path may already have called this module and nothing clears module
  // mocks between tests, so without this the assertion is about the file rather
  // than about this click.
  vi.mocked(${claim.binding}).mockClear();
  ${dispatch};
  await waitFor(() => expect(vi.mocked(${claim.binding})).toHaveBeenCalled());${isolation}
});`;
  }
  if (claim.kind === "router") {
    // toHaveBeenCalledWith(target) when the source names a literal, and a bare
    // toHaveBeenCalled() when it does not — asserting an argument the source
    // never states would be inventing one.
    const matcher =
      claim.target === undefined
        ? "toHaveBeenCalled()"
        : `toHaveBeenCalledWith(${JSON.stringify(claim.target)})`;
    // Single quotes in the TITLE: it is interpolated into a double-quoted test
    // name, and a JSON.stringify'd path ends it.
    const shown = claim.target === undefined ? "" : `'${titleSafe(claim.target)}'`;
    return `test("${name} ${click.event} on ${labelDesc} #${idx} → router.${claim.method}(${shown})", async () => {
  const { container } = renderTarget();
  void container;${preludeLines}
  routerMock.${claim.method}.mockClear();
  ${dispatch};
  await waitFor(() => expect(routerMock.${claim.method}).${matcher});${isolation}
});`;
  }
  // Canary: drive it, and assert only that nothing escaped — which the old floor
  // did NOT do. Executed: a throwing handler leaves today's vitest test green and
  // fails only the run, so this is strictly more than the floor it replaces.
  // prop-spy is handled by the branch above, which runs before decide is called.
  const reason = claim.kind === "canary" ? claim.reason : "opaque-callback";
  todo?.("other");
  return `test("${name} ${click.event} on ${labelDesc} #${idx} — drives the ${click.event}; asserts only that nothing escaped it", async () => {
  // TODO(flawless): ${describeNoClaim(reason)}. Nothing in the source says
  // what this ${click.event} should DO, and "the component still rendered" would
  // pass whatever the handler did. It becomes a real test as soon as the callback
  // is a prop (the spec passes a spy), or the work goes through a module this
  // spec mocks.
  const escaped: string[] = [];
  // Bubble phase only: a failed <img> load also fires \`error\` on the element and
  // must not be read as the handler throwing.
  const onError = (e: ErrorEvent) => { escaped.push(e.message); e.preventDefault(); };
  window.addEventListener("error", onError);
  try {
    const { container } = renderTarget();
    void container;${preludeLines}
    ${dispatch};
  } finally {
    window.removeEventListener("error", onError);
  }
  expect(escaped, "the ${click.event} threw out of its handler").toEqual([]);${isolation}
});`;
}

function describeClickLabel(c: ClickHandler): string {
  // Used inside double-quoted test names AND template-literal titles: a double
  // quote would end the former, a backtick or ${ the latter — titleSafe defuses
  // both (locators are untouched; they JSON.stringify the raw label).
  const safe = (s: string): string => titleSafe(s.replace(/"/g, "'"));
  if (c.label.kind === "text") return `'${safe(c.label.value)}'`;
  if (c.label.kind === "prop") return `the {${c.label.propName}} ${c.tag}`;
  if (c.label.kind === "aria") return `[aria-label='${safe(c.label.value)}']`;
  if (c.label.kind === "testid") return `[data-testid='${safe(c.label.value)}']`;
  return `the ${c.tag}`;
}

function emitFormTest(
  name: string,
  form: FormInfo,
  allHandlers: string[],
  idx: number,
  /** Bindings this spec mocks, so an action claim is only made when observable. */
  mockedBindings: Set<string>,
  todo?: TodoRecorder,
): string {
  const fillSteps: string[] = [];
  const valueAsserts: string[] = [];
  for (const field of form.fields) {
    const step = emitVitestFill(field);
    if (!step) continue;
    fillSteps.push(`  ${step}`);
    const assertion = emitVitestFillAssertion(field);
    if (assertion) valueAsserts.push(`  ${assertion}`);
  }
  // The submit control is read out of the markup — a <button> whose type says it
  // submits. When the source has none, there is no submit path to drive; say so
  // rather than hunting for a button whose wording matches a list of verbs.
  const submitTarget = emitVitestSubmit(form);
  if (!submitTarget) {
    todo?.("other");
    return `test.skip("${name} form #${idx} — no submit control in the markup", () => {
  // TODO(flawless): the form declares no <button type="submit">, so nothing here
  // identifies how it is submitted. Add one (or an onSubmit handler on a named
  // control) and this becomes a real submit test.
});`;
  }
  if (form.submitControl?.disabled) {
    todo?.("other");
    return `test.skip("${name} form #${idx} — its submit control is disabled at these props", () => {
  // TODO(flawless): the button's \`disabled\` expression is true at DEFAULTS.
  // Supply props that enable it and this becomes a real submit test.
});`;
  }
  const submitClick = `await userEvent.click(${submitTarget});`;
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
${valueAsserts.join("\n") || "  // no text field whose value could be read back"}
  ${submitClick}
  expect(handlers.${propName}).toHaveBeenCalled();
${isolation || "  // no other handlers to isolate"}
});`;
  }
  // No prop handler on the form. The floor here was
  // `expect(container.firstElementChild).not.toBeNull()` — and unlike the smoke
  // click it had no isolation fallback at all, so it fired even when prop spies
  // existed and something precise WAS available. Under a provider it cannot
  // fail; without one it reddens a form that navigates away on submit.
  //
  // The isolation asserts are a real claim and are used where there are any. The
  // value assertions above already carry the test on their own, which is how 13
  // of the dogfood app's 23 forms keep a meaningful test with no floor at all.
  // The one post-dispatch claim this app's own shapes support. `<form
  // action={action}>` where `const [state, action] = useActionState(loginAction,
  // …)` — React invokes loginAction on submit with NO guard in between, unlike
  // every click handler here, which puts its action behind a guard and inside a
  // startTransition callback. Verified end to end before it was emitted: green on
  // the real component, red once the form's action is disconnected.
  const action = form.actionBinding;
  if (action !== undefined && mockedBindings.has(action)) {
    return `test("${name} submits form #${idx} → ${action} called", async () => {
  const { container } = renderTarget();
  void container;
${fillSteps.join("\n")}
${valueAsserts.join("\n") || "  // no text field whose value could be read back"}
  // Nothing clears module mocks between tests and a mount effect may already have
  // called this one, so without the clear the assertion is about the file.
  vi.mocked(${action}).mockClear();
  // fireEvent.submit, NOT a click on the submit button.
  //
  // \`action={…}\` means "this runs when the form submits", and that is the claim.
  // Clicking the button additionally requires every REQUIRED field to be filled —
  // and this app's fields are <Input> component tags, which collectFields cannot
  // see, so the emitter fills nothing and the browser's constraint validation
  // silently blocks the submit. Executed: the click form of this test failed on a
  // completely correct LoginForm.
  //
  // Whether the BUTTON submits is a separate claim, and the submit-control
  // detection above is what covers it.
  fireEvent.submit(container.querySelectorAll("form")[${idx}] as HTMLFormElement);
  await waitFor(() => expect(vi.mocked(${action})).toHaveBeenCalled());
${allHandlers.map((h) => `  expect(handlers.${h}).not.toHaveBeenCalled();`).join("\n") || "  // no other handlers to isolate"}
});`;
  }
  const submitAfter =
    allHandlers.length > 0
      ? allHandlers.map((h) => `  expect(handlers.${h}).not.toHaveBeenCalled();`).join("\n")
      : valueAsserts.length > 0
        ? "  // the value assertions above are the claim; the submit itself asserts nothing\n  // this spec can observe — see postDispatch.ts for the ladder that decides."
        : "  // TODO(flawless): nothing observable follows this submit — no prop handler,\n  // no field whose value can be read back, and no module this spec mocks. Give\n  // the form an onSubmit prop or route it through a mocked action to make it real.";
  return `test("${name} form #${idx} accepts input and submits", async () => {
  const { container } = renderTarget();
  void container;
${fillSteps.join("\n")}
${valueAsserts.join("\n") || "  // no text field whose value could be read back"}
  ${submitClick}
${submitAfter}
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

function browserSpec(c: FlatComponent, specName: string, todo?: TodoRecorder): string {
  // The registry key, not the component name: two components called Card live
  // under different keys in the perf host, and mounting by the bare name drove
  // the wrong one.
  const name = specName;
  // synthesiseDefaults, not the raw propsShape. The perf scaffolder has always
  // called it; the browser one passed `{}` for a component whose props are only
  // known through their member reads, and ProfileForm — green in its profile
  // spec — died in its browser spec with "did not render within 5000ms".
  const propsLiteral = JSON.stringify(synthesiseDefaults(c.info));
  const interactions = c.info.interactions;

  // An undecidable guard — `if (!user) return null` where `user` comes from a
  // store hook — means the component may legitimately render nothing here. Its
  // interactions were harvested from the tail return, so every one of them has
  // to check that it is on screen before driving it. UserMenu is this shape:
  // the host has no session, the component returns null, and the spec waited
  // 30 seconds for a trigger that was never going to exist.
  const guarded = c.info.renderGuarded === true;
  // No blind fallback. `button:not([disabled])` names whichever enabled button
  // comes first, not one the analysis found a handler on — in a form component
  // that is the submit control, and clicking it runs an action. The reason
  // wording comes from the same helper the profile suite skips with, and it
  // goes in the title because the skip is decided here, at scaffold time.
  let interactionTests: string;
  if (interactions) {
    interactionTests = emitBrowserInteractionTests(interactions, guarded, todo);
  } else {
    todo?.("other");
    interactionTests = `
test.skip(\`\${NAME}: click — ${titleSafe(emitPlaywrightClickTarget(interactions).reason ?? "no clickable target could be derived")}\`, () => {
  // TODO(flawless): the mount smoke above is the only claim the source
  // supports. If this component is interactive, name the control — a
  // data-testid, an aria-label or literal text — and regenerate.
});`;
  }

  // An error boundary logs what it caught, by design. Failing it for that is the
  // harness marking a component wrong for meeting its contract — so the console
  // assertion goes and the reason is written into the spec. The uncaught-error
  // and rendered-output assertions stay: those are still real claims.
  const consoleAssertion = c.info.logsErrors
    ? `  // ${name} calls ${c.info.logsErrors} itself, so "no console errors" is not a
  // claim its source supports. Uncaught exceptions are still asserted below.
  expect(errors.filter((e) => !e.startsWith("[console]"))).toEqual([]);`
    : `  expect(errors).toEqual([]);`;

  return `import { test, expect, type Page } from "@playwright/test";

const NAME = ${JSON.stringify(name)};
const DEFAULTS = ${propsLiteral} as Record<string, unknown>;

async function mount(page: Page): Promise<void> {
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [NAME, DEFAULTS],
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => typeof window.__profile?.mount === "function");
});

test(\`\${NAME}: mounts in the browser without console errors\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push("[console] " + msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await mount(page);
  await page.waitForTimeout(100);
${consoleAssertion}
${guardedMountAssertion(guarded, c.info)}
});
${interactionTests}
`;
}

function emitBrowserInteractionTests(
  info: NonNullable<ComponentInfo["interactions"]>,
  guarded = false,
  todo?: TodoRecorder,
): string {
  const parts: string[] = [];
  /** For a guarded component, nothing on screen is a legitimate outcome. */
  const presenceCheck = (locator: string): string =>
    guarded
      ? `
  if ((await ${locator}.count()) === 0) {
    test.skip(true, "an early return the analyser could not decide left nothing to drive");
  }`
      : "";
  for (let i = 0; i < info.clicks.length; i++) {
    const click = info.clicks[i];
    if (!click) continue;
    const labelDesc = describeClickLabel(click);
    const rawSelector = emitPlaywrightSelector(click);
    if (!rawSelector) {
      // Saying "no interactions detected" here would be false — one was
      // detected and could not be addressed, which is a different fact and the
      // one worth reporting.
      const why = titleSafe(describeUnlocatable(click));
      todo?.("unaddressable-target");
      parts.push(`
test.skip(\`\${NAME}: ${click.event} on ${labelDesc} #${i} — ${why}\`, () => {
  // TODO(flawless): give it a data-testid, an aria-label or literal text.
});`);
      continue;
    }
    // .first() on every target. A control inside .map() resolves to one locator
    // per row, and Playwright's strict mode makes that an error rather than a
    // choice — "getByText('Remove') resolved to 2 elements" is the list working.
    const selector = firstOf(rawSelector);

    // Disabled at the props this spec mounts with. Clicking it would wait for it
    // to become enabled until the test times out; that it is disabled is the
    // thing the source actually says, so assert that instead.
    if (click.hints.disabled === "always") {
      parts.push(`
test(\`\${NAME}: ${labelDesc} #${i} is disabled at these props\`, async ({ page }) => {
  await mount(page);${presenceCheck(selector)}
  await expect(${selector}).toBeDisabled();
});`);
      continue;
    }

    const dispatch = emitPlaywrightDispatch(click.event, selector, { tag: click.tag });
    if (!dispatch) {
      parts.push(`
test.skip(\`\${NAME}: ${click.event} on ${labelDesc} #${i} — <${click.tag}> holds no value to change\`, () => {
  // React's change events bubble, so this is delegation from a field inside it.
  // The form test drives those fields directly.
});`);
      continue;
    }

    // A menu item inside a portal does not exist until its trigger opens it.
    // The unit emitter learned to click the trigger first; this one did not, and
    // waited 30s for a menu that was never going to appear.
    const trigger = click.gatedBy ? emitPlaywrightTrigger(click.gatedBy) : undefined;
    const openLines = trigger
      ? `${presenceCheck(firstOf(trigger))}\n  await ${firstOf(trigger)}.click();`
      : presenceCheck(selector);
    // The source guards this control with an expression that did not reduce —
    // `disabled={pending || !picked}` where `picked` starts from an unresolved
    // prop. Playwright's actionability wait runs to the test timeout before
    // reporting it, so ask first and skip with the reason instead.
    const disabledGuard =
      click.hints.disabled === "conditional"
        ? `
  if (await ${selector}.isDisabled()) {
    test.skip(true, "disabled at these props; the source's guard could not be decided statically");
  }`
        : "";
    parts.push(`
test(\`\${NAME}: ${click.event} on ${labelDesc} #${i} fires without error\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await mount(page);${openLines}${disabledGuard}
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
      const step = emitPlaywrightFill(field);
      if (step) fillSteps.push(`  ${step}`);
    }
    const submitTarget = emitPlaywrightSubmit(form);
    if (!submitTarget) {
      todo?.("other");
      parts.push(`
test.skip(\`\${NAME}: form #${i} — no submit control in the markup\`, () => {
  // TODO(flawless): nothing in the form's JSX declares how it submits. The old
  // emitter guessed at button copy (/submit|save|send|.../) and waited out the
  // 30s timeout whenever the wording differed.
});`);
      continue;
    }
    // There IS a submit control and it is disabled at these props — every one of
    // them, or findSubmitControl would have preferred an enabled one. Saying
    // "no submit control" here would send someone looking for a button that is
    // plainly in the file.
    if (form.submitControl?.disabled) {
      todo?.("other");
      parts.push(`
test.skip(\`\${NAME}: form #${i} — its submit control is disabled at these props\`, () => {
  // TODO(flawless): the button's \`disabled\` expression is true at the props
  // DEFAULTS passes. Supply props (or drive the UI) that enable it, and this
  // becomes a real submit test.
});`);
      continue;
    }
    // The same guard the click tests carry. A submit button is very often
    // `disabled={pending || nothingChosen}`, and when the expression does not
    // reduce the only way to find out is to look.
    parts.push(`
test(\`\${NAME}: form #${i} fills + submits without error\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await mount(page);${presenceCheck(`page.locator("form").first()`)}
${fillSteps.join("\n") || "  // no field carried a type a blind fill could supply"}
  const submit = ${submitTarget};
  if (await submit.isDisabled()) {
    test.skip(true, "the submit control is disabled at these props — nothing here can enable it");
  }
  await submit.click();
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

/**
 * What a mount test may claim about the markup.
 *
 * An unguarded component must render something. A guarded one may legitimately
 * render nothing — `if (!user) return null` behind a store hook — so "it
 * produced markup" is not a claim its source supports. Dropping the assertion
 * entirely was too much, though: when the guard DOES pass, the component's
 * literal copy has to be there, and that is still checkable. The conditional is
 * the honest shape.
 */
function guardedMountAssertion(guarded: boolean, info: ComponentInfo): string {
  if (!guarded) {
    return `  const rootHtml = await page.locator("#root").innerHTML();
  expect(rootHtml.length).toBeGreaterThan(0);`;
  }
  // The longest literal is the most identifying thing the source offers.
  const witness = [...(info.staticText ?? [])]
    .filter((t) => t.trim().length >= 3)
    .sort((a, b) => b.length - a.length)[0];
  if (!witness) {
    return `  // No markup assertion: this component's first statement is a guard the
  // analyser could not decide, and it renders no literal copy that a passing
  // guard would put on the page. That the mount produced no errors is the only
  // claim the source supports.`;
  }
  return `  // An undecidable guard may legitimately render nothing here. When it does
  // render, this copy is unconditional in that branch — so the claim is
  // conditional, not absent.
  const rootHtml = await page.locator("#root").innerHTML();
  if (rootHtml.trim().length > 0) {
    expect(await page.getByText(${JSON.stringify(witness)}).count()).toBeGreaterThan(0);
  }`;
}

/** The Playwright form of a disclosure trigger, so a browser spec can open it. */
function emitPlaywrightTrigger(label: LabelSource): string | undefined {
  switch (label.kind) {
    case "testid":
      return `page.getByTestId(${JSON.stringify(label.value)})`;
    case "aria":
      return `page.getByLabel(${JSON.stringify(label.value)})`;
    case "text":
      return `page.getByText(${JSON.stringify(label.value)}, { exact: true })`;
    default:
      return undefined;
  }
}

function browserPlaywrightConfig(): string {
  return `import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // Relative, which playwright resolves against THIS FILE (only the unset
  // default resolves against the invocation directory). Never the CJS
  // dirname global: a "type":"module" suite is loaded as ESM, where it
  // does not exist — the whole config died at import (FR-022).
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

/**
 * The whole spec for a component whose initial render could not be decided.
 *
 * Deliberately not "a mount test plus skips": the mount test asserts the same
 * unknowable thing — that SOMETHING renders at defaults — and for a class with
 * required props it does not compile, because DEFAULTS is `{}` and the props
 * type demands children.
 *
 * Everything the analyser DID learn is still reported through REPORT.md and the
 * --ci blob; this file's job is to say why there is nothing to run.
 */
function undecidableRenderSpec(name: string, importPath: string, info: ComponentInfo): string {
  return `${emitComponentImport(info, importPath)}
import { test } from "vitest";

void ${name};

// render() branches on a condition the analyser could not decide, and every
// branch returns content — so there is no single render to describe, and any
// assertion here would be about a branch the defaults may never take.
//
// To make it assertable, give the deciding value a knowable initial state (a
// useState with a literal, or a class \`state = { … }\` field this can read), or
// pass it as a prop the spec controls.
test.skip("${name} — render() branches on a condition this analysis could not decide (class state, or a value from a hook it does not follow); no render can be described", () => {});
`;
}

/**
 * The spec for a React error boundary.
 *
 * Every other undecidable render is refused, because a spec cannot know which
 * branch the defaults take. This one it can: `getDerivedStateFromError` is
 * React's contract for "a child threw", so rendering a child that throws reaches
 * the fallback and not doing so reaches the children. Both paths are asserted.
 *
 * console.error is silenced for the caught case only. React logs every error a
 * boundary catches, and a spec whose own output is drowned in an expected stack
 * is a spec people stop reading — but silencing it around the HAPPY path would
 * hide a real one.
 */
function errorBoundarySpec(
  name: string,
  importPath: string,
  info: ComponentInfo,
  fallbackText: string[],
): string {
  // The first line of the caught branch. Matched as a substring, since the
  // surrounding copy may interpolate.
  const witness = fallbackText[0] as string;
  return `${emitComponentImport(info, importPath)}
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const CHILD_TEXT = "flawless child";

/** A child that throws on render — the only way into a boundary's caught state. */
function Boom(): never {
  throw new Error("flawless: thrown by a child");
}

describe(${JSON.stringify(name)}, () => {
  test("renders its children when nothing throws", () => {
    render(<${name}><span>{CHILD_TEXT}</span></${name}>);
    expect(screen.getByText(CHILD_TEXT)).toBeInTheDocument();
  });

  test("renders its fallback when a child throws", () => {
    // React logs every error a boundary catches. Silenced HERE only — around the
    // happy path it would hide a real one.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<${name}><Boom /></${name}>);
      expect(screen.getByText(${JSON.stringify(witness)}, { exact: false })).toBeInTheDocument();
    } finally {
      logged.mockRestore();
    }
  });
});
`;
}
