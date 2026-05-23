import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { NextjsApiRoute, NextjsContext, NextjsRouter } from "../types.ts";
import { walkApiRoutes } from "./apiRoutes.ts";

export async function detectNextjs(root: string): Promise<NextjsContext> {
  const abs = path.resolve(root);
  if (!existsSync(abs)) {
    throw new Error(`nextjs: directory not found: ${abs}`);
  }

  if (!looksLikeNext(abs)) {
    throw new Error(
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
    throw new Error(`nextjs: no app/ or pages/ directory under ${abs}`);
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

export async function mergeIntoNextPackageJson(
  nextRoot: string,
  deps: Record<string, string>,
  devDeps: Record<string, string>,
  scripts: Record<string, string>,
): Promise<void> {
  const pkgPath = path.join(nextRoot, "package.json");
  const fs = require("node:fs") as typeof import("node:fs");
  if (!existsSync(pkgPath)) {
    throw new Error(`nextjs: package.json not found at ${pkgPath}`);
  }
  type Pkg = {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Pkg;
  pkg.dependencies = { ...(pkg.dependencies ?? {}), ...deps };
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), ...devDeps };
  pkg.scripts = { ...(pkg.scripts ?? {}), ...scripts };
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  void readdir; // silence unused-import warning when running without explicit re-export
}
