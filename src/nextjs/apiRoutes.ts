import { existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { NextjsApiRoute, NextjsRouter } from "../types.ts";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

export async function walkApiRoutes(
  router: NextjsRouter,
  routerRoot: string,
): Promise<NextjsApiRoute[]> {
  if (router === "app") return walkAppRouterApi(path.join(routerRoot, "api"));
  return walkPagesRouterApi(path.join(routerRoot, "api"));
}

async function walkAppRouterApi(apiDir: string): Promise<NextjsApiRoute[]> {
  if (!existsSync(apiDir)) return [];
  const out: NextjsApiRoute[] = [];
  const glob = new Bun.Glob("**/route.{ts,tsx,js,jsx,mjs}");
  for await (const rel of glob.scan({ cwd: apiDir })) {
    const abs = path.join(apiDir, rel);
    const segments = path
      .dirname(rel)
      .split(path.sep)
      .filter((s) => s !== ".");
    // Route groups map to an empty segment — drop them or the path grows a `//`.
    const urlPath = `/api/${segments.map(appRouterSegment).filter(Boolean).join("/")}`;
    const methods = extractAppRouterMethods(abs);
    if (methods.length === 0) continue;
    out.push({
      path: stripTrailingSlash(urlPath),
      methods,
      file: abs,
      ...(segments.some(isCatchAllSegment) ? { catchAll: true } : {}),
    });
  }
  return out;
}

async function walkPagesRouterApi(apiDir: string): Promise<NextjsApiRoute[]> {
  if (!existsSync(apiDir)) return [];
  const out: NextjsApiRoute[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs}");
  for await (const rel of glob.scan({ cwd: apiDir })) {
    const abs = path.join(apiDir, rel);
    const noExt = rel.replace(/\.(ts|tsx|js|jsx|mjs)$/, "");
    let segments = noExt.split(path.sep);
    if (segments[segments.length - 1] === "index") segments = segments.slice(0, -1);
    const urlPath = `/api/${segments.map(pagesRouterSegment).filter(Boolean).join("/")}`;
    out.push({
      path: stripTrailingSlash(urlPath),
      methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      file: abs,
      ...(segments.some(isCatchAllSegment) ? { catchAll: true } : {}),
    });
  }
  return out;
}

/** `[[...x]]` / `[...x]` — a catch-all segment; the same shape nextjs/routes.ts matches. */
function isCatchAllSegment(seg: string): boolean {
  return /^\[\[?\.\.\.(.+?)\]?\]$/.test(seg);
}

function appRouterSegment(seg: string): string {
  // [id] -> {id}, [...slug] -> {slug} (catch-all collapses to one path-param in swagger).
  if (seg.startsWith("[[...") && seg.endsWith("]]")) {
    return `{${seg.slice(5, -2)}}`;
  }
  if (seg.startsWith("[...") && seg.endsWith("]")) {
    return `{${seg.slice(4, -1)}}`;
  }
  if (seg.startsWith("[") && seg.endsWith("]")) {
    return `{${seg.slice(1, -1)}}`;
  }
  // Route groups (parenthesised) don't appear in the URL.
  if (seg.startsWith("(") && seg.endsWith(")")) return "";
  return seg;
}

function pagesRouterSegment(seg: string): string {
  return appRouterSegment(seg);
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function extractAppRouterMethods(file: string): string[] {
  let source = "";
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    source = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    // export const GET = ...
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && HTTP_METHODS.has(d.name.text)) {
          found.add(d.name.text);
        }
      }
    }
    // export function GET() { ... }
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node) && node.name) {
      if (HTTP_METHODS.has(node.name.text)) found.add(node.name.text);
    }
    // export async function GET() { ... }
    // (same node shape; handled above)
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found].sort();
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}
