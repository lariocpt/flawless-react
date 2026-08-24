import ts from "typescript";
import type { PropValue } from "../types.ts";
import { ownReturns } from "./ownReturns.ts";
import { literalToValue } from "./renderPath.ts";

/**
 * What each exported action of a "use server" module actually returns, when
 * that can be read off the source without evaluating anything.
 *
 * The bail policy is literalToValue's, deliberately: a mock built from a wrong
 * guess is worse than the honest {} stub, because the spec goes green against
 * data the action can never produce. So a name is recorded only when every
 * non-exit return collapses to ONE literal-derivable value:
 *
 * - `redirect(...)` / `permanentRedirect(...)` / `notFound()` returns are
 *   exits, not values — Next aborts rendering there, so they say nothing
 *   about what a caller receives. Only when the callee is provably
 *   next/navigation's (extractGuards learned this first): a project-local
 *   redirect() that RETURNS something would otherwise have its value
 *   silently discounted and the recorded literal would disagree with what
 *   the action really returns.
 * - Two distinct literal values bail (which one would the mock pick?);
 *   byte-identical duplicates from two branches collapse fine.
 * - Any non-literal return bails the whole name, even beside a literal one:
 *   a literal happy path next to a computed error path is two shapes, and
 *   mocking just the literal hides the one the component crashes on.
 * - A bare `return;` is a value ({} ≠ undefined) the mock cannot express,
 *   so it bails too.
 *
 * Keyed by MODULE-side export name ("default" for the default export) —
 * that is the name a vi.mock factory or a host stub has to provide.
 */
export function extractServerActionReturns(sf: ts.SourceFile): Record<string, PropValue> {
  const exits = exitBindings(sf);
  const out: Record<string, PropValue> = {};
  for (const [name, fn] of exportedFunctions(sf)) {
    const value = singleReturnValue(fn, exits);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

const EXIT_CALLEES = new Set(["redirect", "permanentRedirect", "notFound"]);

interface ExitBindings {
  /** Local names bound to a next/navigation exit, aliases resolved. */
  locals: Set<string>;
  /** Namespace locals of next/navigation, for `nav.redirect(...)`. */
  namespaces: Set<string>;
}

function exitBindings(sf: ts.SourceFile): ExitBindings {
  const locals = new Set<string>();
  const namespaces = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (stmt.moduleSpecifier.text !== "next/navigation") continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (EXIT_CALLEES.has((el.propertyName ?? el.name).text)) locals.add(el.name.text);
      }
    } else if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
    }
  }
  return { locals, namespaces };
}

function isExitCall(expr: ts.Expression, exits: ExitBindings): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (ts.isIdentifier(callee)) return exits.locals.has(callee.text);
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    exits.namespaces.has(callee.expression.text) &&
    EXIT_CALLEES.has(callee.name.text)
  );
}

export type ActionFn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** Exported name → its function node, local declarations resolved in-file. */
export function exportedFunctions(sf: ts.SourceFile): Array<[string, ActionFn]> {
  // Every top-level function-ish declaration, exported or not: an export
  // clause (`export { doSave as save }`) points at a local one.
  const locals = new Map<string, ActionFn>();
  const out: Array<[string, ActionFn]> = [];
  for (const stmt of sf.statements) {
    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const exported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const isDefault = modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.name) locals.set(stmt.name.text, stmt);
      if (exported && isDefault) out.push(["default", stmt]);
      else if (exported && stmt.name) out.push([stmt.name.text, stmt]);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
        const init = d.initializer;
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
        locals.set(d.name.text, init);
        if (exported) out.push([d.name.text, init]);
      }
      continue;
    }
    // `export { doSave as save }` — the exported name is what importers bind
    // to. A re-export from another file has no local to resolve; skipped
    // HERE — sourceCache's findExportedDecl is the cross-file chase, and
    // callers that want it (resolveDepReturns) walk barrels through that.
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier === undefined &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        const local = locals.get((el.propertyName ?? el.name).text);
        if (local) out.push([el.name.text, local]);
      }
    }
  }
  return out;
}

/** The one literal value every non-exit return yields, else undefined. */
function singleReturnValue(fn: ActionFn, exits: ExitBindings): PropValue | undefined {
  // A generator's `return` sets the iterator's final result — calling the
  // action yields an AsyncGenerator object, never a promise of that literal.
  if (!ts.isArrowFunction(fn) && fn.asteriskToken) return undefined;
  // A concise arrow body IS the single return expression.
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    const expr = unparenthesize(fn.body);
    return isExitCall(expr, exits) ? undefined : literalToValue(expr);
  }
  if (!fn.body || !ts.isBlock(fn.body)) return undefined;

  let value: PropValue | undefined;
  let seen = false;
  for (const ret of ownReturns(fn.body)) {
    const expr = ret.expression === undefined ? undefined : unparenthesize(ret.expression);
    if (expr !== undefined && isExitCall(expr, exits)) continue;
    // Bare `return;` or a non-literal expression: a value we cannot express.
    const v = expr === undefined ? undefined : literalToValue(expr);
    if (v === undefined) return undefined;
    if (seen && JSON.stringify(v) !== JSON.stringify(value)) return undefined;
    value = v;
    seen = true;
  }
  return seen ? value : undefined;
}

function unparenthesize(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}
