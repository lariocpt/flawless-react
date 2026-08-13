import { existsSync } from "node:fs";
import path from "node:path";
import type { NextjsRouter } from "../types.ts";

export interface PageRoute {
  /** URL path with dynamic segments kept in brackets: /dashboard/buildings/[id]. */
  urlPath: string;
  /** Dynamic segment names in order: ["id"]. */
  params: string[];
  /** Safe file stem for a spec: dashboard-buildings-id. */
  specStem: string;
}

/**
 * Map an app-router page file to its route. Returns undefined when the file is
 * not a page.tsx/page.jsx under the router root (or when the router is pages —
 * only the app router is supported for e2e emission in v1).
 */
export function pageFileToRoute(
  file: string,
  router: NextjsRouter,
  routerRoot: string,
): PageRoute | undefined {
  if (router !== "app") return undefined;
  const abs = path.resolve(file);
  const rel = path.relative(path.resolve(routerRoot), abs);
  if (rel.startsWith("..")) return undefined;
  const parts = rel.split(path.sep);
  const last = parts.pop();
  if (!last || !/^page\.(tsx|jsx|ts|js)$/.test(last)) return undefined;

  const segments: string[] = [];
  const params: string[] = [];
  for (const part of parts) {
    if (/^\(.*\)$/.test(part)) continue; // route groups vanish from the URL
    if (part.startsWith("@")) continue; // parallel-route slots vanish too
    const catchAll = part.match(/^\[\[?\.\.\.(.+?)\]?\]$/);
    if (catchAll?.[1]) {
      params.push(catchAll[1]);
      segments.push(`[...${catchAll[1]}]`);
      continue;
    }
    const dynamic = part.match(/^\[(.+)\]$/);
    if (dynamic?.[1]) {
      params.push(dynamic[1]);
      segments.push(`[${dynamic[1]}]`);
      continue;
    }
    segments.push(part);
  }

  const urlPath = `/${segments.join("/")}`;
  const specStem =
    segments.length === 0
      ? "index"
      : segments
          .map((s) => s.replace(/\[\.\.\.(.+)\]/, "$1").replace(/\[(.+)\]/, "$1"))
          .join("-")
          .replace(/[^a-zA-Z0-9-]+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "");
  return { urlPath: urlPath === "/" ? "/" : urlPath, params, specStem };
}

/** Parse the port from a Next.js dev script ("next dev -p 3001" → 3001). */
export function devScriptPort(devScript: string | undefined): number {
  if (!devScript) return 3000;
  const m = devScript.match(/(?:-p|--port)[=\s]+(\d+)/);
  const port = m?.[1] ? Number(m[1]) : Number.NaN;
  return Number.isFinite(port) ? port : 3000;
}

/** The app/ or pages/ directory a Next.js project routes from. */
export function findRouterRoot(nextRoot: string): string {
  for (const rel of ["app", "src/app", "pages", "src/pages"]) {
    const abs = path.join(nextRoot, rel);
    if (existsSync(abs)) return abs;
  }
  return nextRoot;
}
