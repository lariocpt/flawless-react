import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { underOutDir } from "../emitPaths.ts";
import { stringifyLike } from "../scaffold/adoptStyle.ts";
import {
  type NextjsApiRoute,
  type NextjsContext,
  type NextjsRouter,
  UsageError,
} from "../types.ts";
import { walkApiRoutes } from "./apiRoutes.ts";

export async function detectNextjs(root: string): Promise<NextjsContext> {
  const abs = path.resolve(root);
  if (!existsSync(abs)) {
    throw new UsageError(`nextjs: directory not found: ${abs}`);
  }

  if (!looksLikeNext(abs)) {
    throw new UsageError(
      `nextjs: ${abs} does not look like a Next.js project (no next.config or "next" in package.json).`,
    );
  }

  const appDir = path.join(abs, "app");
  const srcAppDir = path.join(abs, "src", "app");
  const pagesDir = path.join(abs, "pages");
  const srcPagesDir = path.join(abs, "src", "pages");

  let router: NextjsRouter;
  let routerRoot: string;
  if (isDir(appDir)) {
    router = "app";
    routerRoot = appDir;
  } else if (isDir(srcAppDir)) {
    router = "app";
    routerRoot = srcAppDir;
  } else if (isDir(pagesDir)) {
    router = "pages";
    routerRoot = pagesDir;
  } else if (isDir(srcPagesDir)) {
    router = "pages";
    routerRoot = srcPagesDir;
  } else {
    throw new UsageError(`nextjs: no app/ or pages/ directory under ${abs}`);
  }

  const appResolver = await detectAppResolver(router, routerRoot);
  const apiRoutes: NextjsApiRoute[] = await walkApiRoutes(router, routerRoot);

  return {
    root: abs,
    router,
    appResolver,
    apiRoutes,
  };
}

function looksLikeNext(dir: string): boolean {
  for (const f of ["next.config.ts", "next.config.js", "next.config.mjs", "next.config.cjs"]) {
    if (existsSync(path.join(dir, f))) return true;
  }
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function detectAppResolver(
  router: NextjsRouter,
  routerRoot: string,
): Promise<string | undefined> {
  if (router === "app") {
    for (const f of ["layout.tsx", "layout.jsx", "layout.ts", "layout.js"]) {
      const candidate = path.join(routerRoot, f);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  // Pages router: pages/_app.tsx
  for (const f of ["_app.tsx", "_app.jsx", "_app.ts", "_app.js"]) {
    const candidate = path.join(routerRoot, f);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The entries a run must add, given the out dir as the ignore root sees it.
 *
 * Shared rather than written per call site: the Next and non-Next paths ignoring
 * different sets is the bug this list exists to prevent, one level up.
 *
 * `underOutDir`, not a literal "flawless": under `--out qa` the run writes qa/
 * and an earlier version ignored flawless/, leaving 566MB of heaps, the
 * Playwright output and — worst — qa/e2e/.auth.json untracked and unignored.
 * That file is where global-setup.ts tells you to persist a logged-in
 * storageState, i.e. session cookies staged for commit.
 *
 * `*.flawless.json` stays literal: it is the inline-summary sidecar pattern,
 * written beside the analysed sources rather than under the out dir.
 */
export function ignoreEntries(outRel: string): string[] {
  return [
    underOutDir(outRel, "reports/"),
    underOutDir(outRel, "heaps/"),
    underOutDir(outRel, "playwright-report/"),
    underOutDir(outRel, "node_modules/"),
    underOutDir(outRel, "test-results/"),
    underOutDir(outRel, "browser/test-results/"),
    underOutDir(outRel, "e2e/test-results/"),
    underOutDir(outRel, "e2e/.auth.json"),
    underOutDir(outRel, "load/last-*.json"),
    "*.flawless.json",
  ];
}

/**
 * Where a non-Next run's .gitignore belongs.
 *
 * The git root first: that is where git reads a repo-wide ignore and where the
 * user's existing one already is. Then the nearest package.json, for a package
 * that is not a repository. Then the out dir's parent, so a run always ignores
 * something rather than nothing.
 */
export function ignoreRootFor(outDir: string): string {
  let dir = path.resolve(outDir);
  const start = dir;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dir = start;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(start);
}

export function updateGitignore(nextRoot: string, entries: string[]): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const gipath = path.join(nextRoot, ".gitignore");
  let current = "";
  if (existsSync(gipath)) {
    try {
      current = fs.readFileSync(gipath, "utf8");
    } catch {
      current = "";
    }
  }
  const have = new Set(
    current
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const added: string[] = [];
  for (const e of entries) {
    if (!have.has(e)) added.push(e);
  }
  if (added.length === 0) return [];
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  const block = `${sep}\n# flawless-react — generated reports + sidecars\n${added.join("\n")}\n`;
  fs.writeFileSync(gipath, current + block);
  return added;
}

const PRETTIER_CONFIG_NAMES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  "prettier.config.js",
  "prettier.config.cjs",
];
// The ES-LINT-RC family only. eslint.config.* is the flat config, and a flat
// config does not read .eslintignore at all — writing the file there would be
// dead weight that outlives the migration to make it seem supported.
const ESLINTRC_CONFIG_NAMES = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.json5",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

/**
 * Make the repo's own formatter and linter skip the suite directory.
 *
 * The tool formats its output with the project's prettier before finishing, but
 * "failures are warnings, never task failures" only covers the tool's own run.
 * The project's `prettier --check .` is not so forgiving, and dogfood proved the
 * gap real: prettier 3.0.3 cannot parse `import ... with { type: "json" }` —
 * import-attribute support landed in 3.1 — so the whole profile plane flagged
 * as unparseable in that repo's CI, over files the tool owns and rewrites.
 *
 * Ignore FILES are the append-safe, schema-free surface: prettier reads
 * `.prettierignore`, eslintrc reads `.eslintignore`, and both are inert until a
 * repo actually uses the tool — so the file is written only where the tool is
 * configured. Biome gets no entry: it has no ignore file, and its 2.x
 * `files.includes` marker is version-gated JSONC that belongs in a documented
 * one-line setup step, not rewritten into a user's config.
 */
export function ensureFormatterIgnores(
  root: string,
  outRel: string,
): { file: string; entry: string }[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const pkg = ((): Record<string, unknown> => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    } catch {
      return {};
    }
  })();
  const usesPrettier =
    PRETTIER_CONFIG_NAMES.some((n) => existsSync(path.join(root, n))) || pkg.prettier !== undefined;
  const usesEslintrc =
    ESLINTRC_CONFIG_NAMES.some((n) => existsSync(path.join(root, n))) ||
    pkg.eslintConfig !== undefined;
  const entry = `${outRel}/`;
  const touched: { file: string; entry: string }[] = [];
  for (const [file, inUse] of [
    [".prettierignore", usesPrettier],
    [".eslintignore", usesEslintrc],
  ] as const) {
    if (!inUse) continue;
    const abs = path.join(root, file);
    let current = "";
    try {
      if (existsSync(abs)) current = fs.readFileSync(abs, "utf8");
    } catch {
      current = "";
    }
    const have = new Set(
      current
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    );
    if (have.has(entry) || have.has(outRel)) continue;
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(abs, `${current}${sep}\n# flawless-react — tool-owned suite\n${entry}\n`);
    touched.push({ file, entry });
  }
  return touched;
}

export function detectComponentsGlob(nextRoot: string): string | undefined {
  for (const rel of ["components", "src/components", "app/components"]) {
    if (isDir(path.join(nextRoot, rel))) return path.join(nextRoot, rel, "**/*.tsx");
  }
  return undefined;
}

/**
 * Add the entries the suite needs, without touching a version already pinned.
 *
 * These were spread last, so the tool's own pins overwrote the project's: a repo
 * on `vitest ^3.x` came back on `^2.1.0`, and the next `bun install` acted on it.
 * Nothing said so, and README calls generation "an additive diff". The
 * standalone path has always done it this way (scaffold-tests/index.ts) — this
 * only brings the Next.js path in line.
 */
function addMissing(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string>,
): Record<string, string> {
  const out = { ...(existing ?? {}) };
  for (const [name, range] of Object.entries(incoming)) {
    if (!(name in out)) out[name] = range;
  }
  return out;
}

export async function mergeIntoNextPackageJson(
  nextRoot: string,
  deps: Record<string, string>,
  devDeps: Record<string, string>,
  scripts: Record<string, string>,
  /**
   * Per key: OTHER command spellings this tool itself emits or once emitted
   * (the --root vs --config forms of flawless:unit, say). An existing value
   * on this list is tool-owned and upgrades; only a value the tool does not
   * recognize is someone's work and kept.
   */
  toolSpellings: Record<string, readonly string[]> = {},
): Promise<{ keptScripts: string[] }> {
  const pkgPath = path.join(nextRoot, "package.json");
  const fs = require("node:fs") as typeof import("node:fs");
  if (!existsSync(pkgPath)) {
    throw new UsageError(`nextjs: package.json not found at ${pkgPath}`);
  }
  type Pkg = {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const source = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(source) as Pkg;
  // Only touch sections that receive entries (or already exist) so the merge
  // never invents empty keys, and preserve the file's own indentation — a
  // tabs-indented package.json must not come back 2-space-reindented.
  if (Object.keys(deps).length > 0 || pkg.dependencies) {
    pkg.dependencies = addMissing(pkg.dependencies, deps);
  }
  if (Object.keys(devDeps).length > 0 || pkg.devDependencies) {
    pkg.devDependencies = addMissing(pkg.devDependencies, devDeps);
  }
  // Scripts used to be the one place the tool spread last and "won its own
  // namespace" — so a command improvement reached older projects. Dogfood
  // round 5 showed the cost: an app's hand-customized flawless:load
  // (`--env-file …`) was clobbered by a refresh and the load run failed at
  // setup (FR-034). A differing existing value is the user's work now, kept
  // and REPORTED — the caller logs the kept keys with the same escape every
  // kept file gets: delete the key to take the tool's current command.
  const keptScripts: string[] = [];
  if (Object.keys(scripts).length > 0 || pkg.scripts) {
    const merged = { ...(pkg.scripts ?? {}) };
    for (const [name, cmd] of Object.entries(scripts)) {
      const existing = merged[name];
      if (
        existing !== undefined &&
        existing !== cmd &&
        !(toolSpellings[name] ?? []).includes(existing)
      ) {
        keptScripts.push(name);
        continue;
      }
      merged[name] = cmd;
    }
    pkg.scripts = merged;
  }
  // pnpm ≥10 treats an UNRECORDED build-script decision as an error: with
  // verifyDepsBeforeRun (the default in 11), `pnpm run dev` install-checks
  // first, and ERR_PNPM_IGNORED_BUILDS over msw/@playwright/test — packages
  // THIS merge introduced — killed the app's own dev server before Next
  // could boot. Writing the ignore down IS the decision: msw's postinstall
  // copies a service worker into a public dir and playwright's downloads
  // browsers; neither is needed to run the app, and neither may block it.
  // A dependency the app already approved (onlyBuiltDependencies) stays
  // approved — that is the app's call, not ours.
  if (existsSync(path.join(nextRoot, "pnpm-lock.yaml"))) {
    const BUILD_SCRIPT_DEPS = ["@playwright/test", "msw"];
    const added = Object.keys(devDeps);
    const p = pkg as Pkg & {
      pnpm?: { ignoredBuiltDependencies?: string[]; onlyBuiltDependencies?: string[] };
    };
    const approved = new Set(p.pnpm?.onlyBuiltDependencies ?? []);
    const ignored = [...(p.pnpm?.ignoredBuiltDependencies ?? [])];
    let changed = false;
    for (const d of BUILD_SCRIPT_DEPS) {
      if (added.includes(d) && !approved.has(d) && !ignored.includes(d)) {
        ignored.push(d);
        changed = true;
      }
    }
    if (changed) p.pnpm = { ...p.pnpm, ignoredBuiltDependencies: ignored.sort() };
  }
  fs.writeFileSync(pkgPath, stringifyLike(source, pkg));
  return { keptScripts };
}
