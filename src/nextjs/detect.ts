import { existsSync, statSync } from "node:fs";
import path from "node:path";
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
): Promise<void> {
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
  // Scripts go the other way on purpose: the tool spreads last and wins its own
  // `flawless:*` namespace, so an improvement to a generated command reaches a
  // project that was scaffolded by an older version. A version range is the
  // project's decision; the command that runs the generated suite is not.
  if (Object.keys(scripts).length > 0 || pkg.scripts) {
    pkg.scripts = { ...(pkg.scripts ?? {}), ...scripts };
  }
  fs.writeFileSync(pkgPath, stringifyLike(source, pkg));
}
