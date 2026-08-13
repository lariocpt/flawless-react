import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ModuleResolver } from "../analyse/resolveModule.ts";
import { readPrologueDirective } from "../analyse/sourceCache.ts";
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
  force = false,
): ProviderWrapperResult | undefined {
  const layout = layoutFile ?? ctx.appResolver;
  if (!layout || !existsSync(layout)) return undefined;

  const outPath = path.join(outDir, "provider.tsx");
  // provider.tsx is derived from the layout, so --force may refresh it when the
  // layout's provider chain changes. provider.fixtures.ts beside it is not
  // regenerated under any flag — see renderFixtures.
  if (existsSync(outPath) && !force) {
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
    dropped: DroppedAttr[];
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

  const holes = included.flatMap((i) =>
    i.dropped.filter((d) => d.name !== "...spread").map((d) => ({ owner: i.name, ...d })),
  );

  mkdirSync(outDir, { recursive: true });

  // The asymmetry is the whole design. provider.tsx is DERIVED from the layout,
  // so --force may refresh it. provider.fixtures.ts holds values a human typed
  // and nothing can reconstruct, so --force must not touch it.
  const fixturesPath = path.join(outDir, "provider.fixtures.ts");
  if (holes.length > 0 && !existsSync(fixturesPath)) {
    writeFileSync(fixturesPath, renderFixtures(layout, holes, imports));
  }

  writeFileSync(outPath, renderWrapper(layout, included, holes.length > 0));
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
  return readPrologueDirective(file) === "use client";
}

/** A prop the layout passed that is not literal-composable, and its source text. */
export interface DroppedAttr {
  name: string;
  exprText: string;
  line: number;
}

function literalAttrs(
  attrs: ts.JsxAttributes,
  sf: ts.SourceFile,
): { attrs: string; dropped: DroppedAttr[] } {
  const kept: string[] = [];
  const dropped: DroppedAttr[] = [];
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  for (const a of attrs.properties) {
    if (ts.isJsxSpreadAttribute(a)) {
      dropped.push({
        name: "...spread",
        exprText: `{...${a.expression.getText(sf)}}`,
        line: lineOf(a),
      });
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
    dropped.push({ name, exprText: init ? init.getText(sf) : name, line: lineOf(a) });
  }
  return { attrs: kept.length > 0 ? ` ${kept.join(" ")}` : "", dropped };
}

function renderWrapper(
  layoutFile: string,
  included: Array<{ name: string; importLine: string; attrs: string; dropped: DroppedAttr[] }>,
  hasFixtures: boolean,
): string {
  const importLines = [...new Set(included.map((i) => i.importLine))].join("\n");
  const layoutRel = path.basename(layoutFile);

  let open = "";
  let close = "";
  const todos: string[] = [];
  for (const [idx, el] of included.entries()) {
    const indent = "      " + "  ".repeat(idx);
    // A non-literal prop becomes a typed hole in provider.fixtures.ts rather
    // than a comment: an editor red-squiggle naming the exact shape to supply is
    // worth more than a TODO nobody sees.
    const fixtureAttrs = el.dropped
      .filter((d) => d.name !== "...spread")
      .map((d) => ` ${d.name}={providerFixtures.${d.name}}`)
      .join("");
    for (const d of el.dropped.filter((x) => x.name === "...spread")) {
      todos.push(
        `${indent}{/* TODO(flawless): layout spread ${d.exprText} into <${el.name}> — not reconstructable */}`,
      );
    }
    open += `${indent}<${el.name}${el.attrs}${fixtureAttrs}>\n`;
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
// layout, unusable under jsdom). REGENERATED by --force: put values you want to
// keep in provider.fixtures.ts, which is never rewritten.
import type { ReactNode } from "react";
${importLines}${hasFixtures ? '\nimport { providerFixtures } from "./provider.fixtures";' : ""}

export default function FlawlessProvider({ children }: { children: ReactNode }) {
  return (
    <>
${tree}
    </>
  );
}
`;
}

/**
 * Typed holes for the props the layout passed that could not be copied.
 *
 * Typing each against `ComponentProps<typeof Provider>[prop]` costs nothing —
 * the import line was already captured — and turns "fill this in" into a red
 * squiggle naming the exact shape. The alternative considered was synthesising a
 * plausible session object; that is precisely the guessing this project refuses,
 * and a wrong-shaped fixture is worse than an empty one because the specs go
 * green against a fiction.
 */
function renderFixtures(
  layoutFile: string,
  holes: Array<{ owner: string; name: string; exprText: string; line: number }>,
  imports: Map<string, { specifier: string; line: string }>,
): string {
  const layoutRel = path.basename(layoutFile);
  const importLines = [
    ...new Set(
      holes
        .map((h) => imports.get(h.owner.split(".")[0] as string)?.line)
        .filter((l): l is string => l !== undefined),
    ),
  ].join("\n");

  const entries = holes
    .map(
      (h) =>
        `  /** ${layoutRel}:${h.line} passed ${h.name}={${h.exprText.replace(/^\{|\}$/g, "")}} to <${h.owner}>. */\n` +
        `  ${h.name}: {} as ComponentProps<typeof ${h.owner.split(".")[0]}>[${JSON.stringify(h.name)}],`,
    )
    .join("\n\n");

  return `// Fixtures for the props flawless-react could not copy out of ${layoutRel},
// because they are computed rather than literal.
//
// Owned by you: flawless-react writes this file once and never again — not even
// with --force. provider.tsx beside it IS regenerated, so keep values here.
import type { ComponentProps } from "react";
${importLines}

export const providerFixtures = {
${entries}
};
`;
}
