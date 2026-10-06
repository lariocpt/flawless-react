import ts from "typescript";
import type { ModuleResolver } from "./resolveModule.ts";
import type { SourceFileCache } from "./sourceCache.ts";
import { findExportedDecl } from "./sourceCache.ts";

/**
 * Module-side exports whose declarations are DATA constants — the evidence
 * the mock emitter needs to leave a config-style module real in RSC mode.
 *
 * When EVERYTHING a component imports from a module is one of these, the
 * module must not be mocked at all. A mock factory replaces the module for
 * the whole graph, and a wholesale replacement only ever enumerates the one
 * component's import list: stubbing `@/config/site` to satisfy a component's
 * `SOURCE_CODE_GITHUB_REPO` left json-ld.ts's `SITE_INFO` undefined, and the
 * chanhdai dogfood buried 150+ specs at collection under
 * `No "SITE_INFO" export is defined on the "@/config/site" mock`.
 *
 * Conservative on purpose — "declared" STOPS the barrel walk, so a module can
 * never be unmocked on the strength of a name that is not really its data
 * export. Two verdicts per name found:
 *
 *   data     — initializers that cannot compute at module scope: literals,
 *              substitution-free templates, property-access chains
 *              (`USER.bio`, `process.env.X || "https://…"`), object/array
 *              literals built only of those, and logical/binary/ternary
 *              compositions of those.
 *   declared — anything else that declares the name: a function, class or
 *              enum, an initializer containing a call, `new`, `await`, or a
 *              bare identifier whose binding the scan cannot see. An env
 *              module exporting `envSchema.parse(…)` lands here — those
 *              stay mocked, exactly as before.
 *
 * A name never located at all yields nothing: the mock's normal honest {}
 * fallback covers it, and unmocking on an absence would import blind.
 *
 * "default" names the default export (`export default { … }`), same
 * convention as importedReturns/serverActionReturns.
 */
export function dataConstantExports(
  mi: { names: string[]; importedNames?: string[]; isTypeOnly: boolean; hasDefault: boolean },
  resolvedPath: string,
  resolver: ModuleResolver,
  cache: SourceFileCache,
): string[] {
  if (mi.isTypeOnly) return [];
  const out: string[] = [];
  for (const [i, local] of mi.names.entries()) {
    const exported =
      mi.hasDefault && i === 0 ? "default" : (mi.importedNames?.[i] ?? local);
    if (!exported) continue;
    const located = findExportedDecl(
      resolvedPath,
      exported,
      cache,
      resolver,
      selectDeclaration,
      true,
    );
    if (located?.decl === "data") out.push(exported);
  }
  return out;
}

type DeclHit = "data" | "declared";

/**
 * Verdict for one statement list: "data" for an exported data constant,
 * "declared" for any other executable declaration of the name, undefined to
 * keep walking (not here — a barrel arm may hold it; type-only declarations
 * are erased at runtime and never claim a value binding).
 */
function selectDeclaration(
  sf: ts.SourceFile,
  name: string,
  viaReexport: boolean,
): DeclHit | undefined {
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      const exported =
        ts.canHaveModifiers(stmt) &&
        (ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
      // Reached through a re-export chain, only an exported declaration can
      // vouch for the name; a local `export { X as Y }` clause re-queries
      // this file with viaReexport=false and binds the private one.
      if (viaReexport && !exported) continue;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== name) continue;
        return d.initializer !== undefined && isDataExpr(d.initializer) ? "data" : "declared";
      }
      continue;
    }
    if (ts.isExportAssignment(stmt)) {
      if (name === "default" && !stmt.isExportEquals) {
        return isDataExpr(stmt.expression) ? "data" : "declared";
      }
      continue;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return "declared";
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === name) return "declared";
    if (ts.isEnumDeclaration(stmt) && stmt.name.text === name) return "declared";
  }
  return undefined;
}

/** Depth bound on literal nesting — config files stop at 2-3; beyond this, bail. */
const MAX_DATA_DEPTH = 8;

/**
 * Is this initializer shaped as data — read-only composition of literals and
 * property reads, never a call, a construction, or a function value?
 *
 * `export const fn = obj.method` passes: the chain is a read, and on the
 * skip path the module loads REAL, so even a function-valued constant keeps
 * its real shape. The question the answer feeds is only whether the module
 * SCOPE can compute or throw — calls, `new`, `await` and function literals
 * disqualify precisely because they do.
 */
function isDataExpr(e: ts.Expression, depth = 0): boolean {
  if (depth > MAX_DATA_DEPTH) return false;
  for (;;) {
    if (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isNonNullExpression(e)
    ) {
      e = e.expression;
      continue;
    }
    break;
  }
  if (
    ts.isStringLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e)
  ) {
    return true;
  }
  if (
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(e)) {
    // Only `export const X = undefined` — a bare identifier could be bound
    // to a call result two statements up.
    return e.text === "undefined";
  }
  if (ts.isPropertyAccessExpression(e)) {
    // Chain root is an opaque read — an import (USER, process) or a file
    // const. Property access itself cannot compute.
    return ts.isIdentifier(e.expression) || isDataExpr(e.expression, depth + 1);
  }
  if (ts.isElementAccessExpression(e)) {
    return (
      (ts.isIdentifier(e.expression) || isDataExpr(e.expression, depth + 1)) &&
      isDataExpr(e.argumentExpression, depth + 1)
    );
  }
  if (ts.isTemplateExpression(e)) {
    return e.head.text === "" && e.templateSpans.every((s) => s.literal.text === "");
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every((p) => {
      if (ts.isPropertyAssignment(p)) {
        if (p.name !== undefined && ts.isComputedPropertyName(p.name)) return false;
        return isDataExpr(p.initializer, depth + 1);
      }
      if (ts.isSpreadAssignment(p)) return isDataExpr(p.expression, depth + 1);
      // Shorthand binds an unknown local; methods and accessors are functions.
      return false;
    });
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.every(
      (el) => el.kind === ts.SyntaxKind.OmittedExpression || isDataExpr(el, depth + 1),
    );
  }
  // isBinaryExpression covers the logical forms (&&, ||, ??) too.
  if (ts.isBinaryExpression(e)) {
    return isDataExpr(e.left, depth + 1) && isDataExpr(e.right, depth + 1);
  }
  if (ts.isConditionalExpression(e)) {
    return (
      isDataExpr(e.condition, depth + 1) &&
      isDataExpr(e.whenTrue, depth + 1) &&
      isDataExpr(e.whenFalse, depth + 1)
    );
  }
  if (ts.isPrefixUnaryExpression(e)) {
    return (
      (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) &&
      isDataExpr(e.operand, depth + 1)
    );
  }
  return false;
}
