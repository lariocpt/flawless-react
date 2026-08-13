import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ModuleResolver } from "../analyse/resolveModule.ts";
import type { NextjsContext } from "../types.ts";

/**
 * Next.js app-router layouts are usually async server components importing
 * next/font, next/headers, or server-only modules — none of which can run
 * under jsdom. When the auto-detected app resolver is such a layout, we
 * derive a client-safe provider wrapper from the JSX chain that encloses
 * `{children}` and emit it once as <outDir>/provider.tsx.
 */

const SERVER_ONLY_SPECIFIERS = /^(next\/font(\/|$)|next\/headers$|server-only$)/;

/** A file is usable as a unit-test provider iff its default export is a sync component and it pulls in no server-only modules. */
export function isUsableUnitProvider(file: string): boolean {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX,
    );
  } catch {
    return false;
  }

  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      SERVER_ONLY_SPECIFIERS.test(stmt.moduleSpecifier.text)
    ) {
      return false;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      const mods = stmt.modifiers ?? [];
      const isDefault =
        mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (isDefault && mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const expr = stmt.expression;
      if (
        (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) &&
        (expr.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        return false;
      }
    }
  }
  return true;
}

export interface ProviderWrapperResult {
  /** Absolute path of the wrapper to use as --provider. */
  path: string;
  /** False when the file already existed and was left untouched. */
  created: boolean;
  /** Local names of the providers included in the wrapper. */
  included: string[];
}

/**
 * Derive `<outDir>/provider.tsx` from the layout's `{children}`-enclosing JSX
 * chain. Only client components ("use client" target files) are kept; literal
 * attributes are copied; everything else is dropped with a TODO comment.
 * Never overwrites an existing provider.tsx.
 */
export function ensureClientProviderWrapper(
  ctx: NextjsContext,
  outDir: string,
  layoutFile?: string,
): ProviderWrapperResult | undefined {
  const layout = layoutFile ?? ctx.appResolver;
  if (!layout || !existsSync(layout)) return undefined;

  const outPath = path.join(outDir, "provider.tsx");
  if (existsSync(outPath)) {
    return { path: outPath, created: false, included: [] };
  }

  const sf = ts.createSourceFile(
    layout,
    readFileSync(layout, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );

  const chain = childrenEnclosingChain(sf);
  const resolver = new ModuleResolver();
  const imports = collectImportLines(sf);

  const included: Array<{
    name: string;
    importLine: string;
    attrs: string;
    dropped: string[];
  }> = [];

  for (const el of chain) {
    const tagName = el.tagText;
    if (!/^[A-Z]/.test(tagName)) continue; // html/body/div — skip intrinsics
    const root = tagName.split(".")[0] as string;
    const imp = imports.get(root);
    if (!imp) continue;
    const target = resolver.resolve(imp.specifier, layout);
    if (!target) continue;
    if (!fileStartsWithUseClient(target)) continue;

    const { attrs, dropped } = literalAttrs(el.attributes, sf);
    included.push({ name: tagName, importLine: imp.line, attrs, dropped });
  }

  const body = renderWrapper(layout, included);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, body);
  return { path: outPath, created: true, included: included.map((i) => i.name) };
}

interface ChainElement {
  tagText: string;
  attributes: ts.JsxAttributes;
}

/** JSX elements enclosing the `{children}` expression, outermost first. */
function childrenEnclosingChain(sf: ts.SourceFile): ChainElement[] {
  let childrenExpr: ts.Node | undefined;
  const find = (n: ts.Node): void => {
    if (childrenExpr) return;
    if (ts.isJsxExpression(n) && n.expression && ts.isIdentifier(n.expression)) {
      if (n.expression.text === "children") {
        childrenExpr = n;
        return;
      }
    }
    ts.forEachChild(n, find);
  };
  find(sf);
  if (!childrenExpr) return [];

  const chain: ChainElement[] = [];
  let cur: ts.Node | undefined = childrenExpr.parent;
  while (cur) {
    if (ts.isJsxElement(cur)) {
      const opening = cur.openingElement;
      chain.unshift({ tagText: opening.tagName.getText(sf), attributes: opening.attributes });
    }
    cur = cur.parent;
  }
  return chain;
}

function collectImportLines(sf: ts.SourceFile): Map<string, { specifier: string; line: string }> {
  const out = new Map<string, { specifier: string; line: string }>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) {
      out.set(clause.name.text, {
        specifier,
        line: `import ${clause.name.text} from "${specifier}";`,
      });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const orig = el.propertyName?.text;
        const spec = orig ? `${orig} as ${el.name.text}` : el.name.text;
        out.set(el.name.text, {
          specifier,
          line: `import { ${spec} } from "${specifier}";`,
        });
      }
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      out.set(clause.namedBindings.name.text, {
        specifier,
        line: `import * as ${clause.namedBindings.name.text} from "${specifier}";`,
      });
    }
  }
  return out;
}

function fileStartsWithUseClient(file: string): boolean {
  try {
    const head = readFileSync(file, "utf8").slice(0, 512);
    return /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(head);
  } catch {
    return false;
  }
}

function literalAttrs(
  attrs: ts.JsxAttributes,
  sf: ts.SourceFile,
): { attrs: string; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const a of attrs.properties) {
    if (ts.isJsxSpreadAttribute(a)) {
      dropped.push(`{...${a.expression.getText(sf)}}`);
      continue;
    }
    if (!ts.isJsxAttribute(a) || !ts.isIdentifier(a.name)) continue;
    const name = a.name.text;
    const init = a.initializer;
    if (!init) {
      kept.push(name);
      continue;
    }
    if (ts.isStringLiteral(init)) {
      kept.push(`${name}=${JSON.stringify(init.text)}`);
      continue;
    }
    if (ts.isJsxExpression(init) && init.expression) {
      const e = init.expression;
      if (ts.isStringLiteral(e)) {
        kept.push(`${name}=${JSON.stringify(e.text)}`);
        continue;
      }
      if (ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword) {
        kept.push(`${name}={${e.getText(sf)}}`);
        continue;
      }
    }
    dropped.push(name);
  }
  return { attrs: kept.length > 0 ? ` ${kept.join(" ")}` : "", dropped };
}

function renderWrapper(
  layoutFile: string,
  included: Array<{ name: string; importLine: string; attrs: string; dropped: string[] }>,
): string {
  const importLines = [...new Set(included.map((i) => i.importLine))].join("\n");
  const layoutRel = path.basename(layoutFile);

  let open = "";
  let close = "";
  const todos: string[] = [];
  for (const [idx, el] of included.entries()) {
    const indent = "      " + "  ".repeat(idx);
    for (const d of el.dropped) {
      todos.push(
        `${indent}{/* TODO(flawless): layout passed ${d} to <${el.name}> (non-literal) — add a fixture here if specs need it */}`,
      );
    }
    open += `${indent}<${el.name}${el.attrs}>\n`;
    close = `${indent}</${el.name}>\n${close}`;
  }
  const inner = "      " + "  ".repeat(included.length) + "{children}";

  const tree =
    included.length > 0
      ? `${todos.length > 0 ? `${todos.join("\n")}\n` : ""}${open}${inner}\n${close}`.replace(
          /\n$/,
          "",
        )
      : "      <>{children}</>";

  return `"use client";
// flawless-react provider wrapper — auto-derived from ${layoutRel} (async server
// layout, unusable under jsdom). Edit freely; flawless-react never overwrites it.
import type { ReactNode } from "react";
${importLines}

export default function FlawlessProvider({ children }: { children: ReactNode }) {
  return (
    <>
${tree}
    </>
  );
}
`;
}
