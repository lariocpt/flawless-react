import { existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface ChildRef {
  /** Local identifier used in the JSX. */
  localName: string;
  /** Absolute path to the imported module (resolved from a relative specifier). */
  absPath: string;
}

/**
 * Walk JSX in `bodyNode`, collect referenced child component identifiers that resolve
 * to a project-local module (relative import). Skips node_modules / bare specifiers.
 */
export function walkChildren(
  bodyNode: ts.Node,
  imports: Map<string, string>,
  entryFile: string,
): ChildRef[] {
  const seen = new Set<string>();
  const out: ChildRef[] = [];
  const entryDir = path.dirname(path.resolve(entryFile));

  const visit = (n: ts.Node): void => {
    let tagName: string | undefined;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName;
      if (ts.isIdentifier(tag)) tagName = tag.text;
    }
    if (tagName && /^[A-Z]/.test(tagName) && !seen.has(tagName)) {
      const spec = imports.get(tagName);
      if (spec && isRelative(spec)) {
        const abs = resolveRelative(entryDir, spec);
        if (abs) {
          seen.add(tagName);
          out.push({ localName: tagName, absPath: abs });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);
  return out;
}

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
}

function resolveRelative(fromDir: string, spec: string): string | undefined {
  const base = path.resolve(fromDir, spec);
  // 1. As-is (covers explicit `./Foo.tsx` imports).
  if (existsSync(base)) return base;
  // 2. Strip a trailing .js/.jsx extension and try .ts/.tsx (common TS pattern).
  const stripped = base.replace(/\.(jsx?|tsx?)$/, "");
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const candidate = `${stripped}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
