import ts from "typescript";
import type { FetchCallInfo } from "../types.ts";
import { posOf } from "./pos.ts";
import { hookCalleeName } from "./refs.ts";

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect"]);

/**
 * Collect fetch() call sites with their URL shape. Interpolations become
 * :holes named after the interpolated identifier (or the property name of a
 * member access); anything unnameable becomes :param. Non-literal URLs
 * (variables, function results) are skipped — better no spec than a wrong one.
 */
export function extractFetchCalls(bodyNode: ts.Node, sourceFile: ts.SourceFile): FetchCallInfo[] {
  const out: FetchCallInfo[] = [];

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fetch") {
      const urlArg = n.arguments[0];
      const parsed = urlArg ? parseUrlArg(urlArg) : undefined;
      if (parsed) {
        out.push({
          urlTemplate: parsed.template,
          holes: parsed.holes,
          method: readMethod(n.arguments[1]),
          pos: posOf(n, sourceFile),
          inEffect: isInsideEffect(n, bodyNode),
          ...(!isInsideEffect(n, bodyNode) ? classifyHandler(n, bodyNode) : {}),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);
  return out;
}

export function parseUrlArg(arg: ts.Expression): { template: string; holes: string[] } | undefined {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { template: arg.text, holes: [] };
  }
  if (ts.isTemplateExpression(arg)) {
    let template = arg.head.text;
    const holes: string[] = [];
    for (const span of arg.templateSpans) {
      const hole = holeName(span.expression, holes.length);
      holes.push(hole);
      template += `:${hole}${span.literal.text}`;
    }
    return { template, holes };
  }
  return undefined;
}

function holeName(expr: ts.Expression, index: number): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
  return `param${index}`;
}

export function readMethod(init: ts.Expression | undefined): string {
  if (!init || !ts.isObjectLiteralExpression(init)) return "GET";
  for (const p of init.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
    if (name !== "method") continue;
    if (ts.isStringLiteral(p.initializer)) return p.initializer.text.toUpperCase();
  }
  return "GET";
}

function isInsideEffect(call: ts.Node, bodyNode: ts.Node): boolean {
  let cur: ts.Node | undefined = call.parent;
  while (cur && cur !== bodyNode) {
    if (ts.isCallExpression(cur)) {
      const name = hookCalleeName(cur.expression);
      if (name && EFFECT_HOOKS.has(name)) return true;
    }
    cur = cur.parent;
  }
  return false;
}

/**
 * D1 item 3: which handler (if any) a NON-effect fetch sits in, so the emitter
 * can attribute the request to the click bound to that handler. The outermost
 * function boundary strictly below the component body decides — the same
 * ladder extractState's classifyContext walks:
 *
 *   function ask() { fetch(…) }        → handlerName "ask"
 *   const ask = () => fetch(…)        → handlerName "ask"
 *   onClick={() => fetch(…)}          → inlineHandlerEvent "onClick"
 *
 * Anything else (a useCallback, a nested helper, a bare call in render) names
 * no handler: the fetch stays unattributed and unemitted, exactly as before
 * this field existed. An attributed fetch is a CLAIM only when the emitter also
 * finds the click that reaches it.
 */
function classifyHandler(
  call: ts.Node,
  bodyNode: ts.Node,
): { handlerName?: string; inlineHandlerEvent?: string } {
  let outermostFn: ts.Node | undefined;
  for (let p = call.parent; p && p !== bodyNode; p = p.parent) {
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isFunctionDeclaration(p)) {
      outermostFn = p;
    }
  }
  if (!outermostFn) return {};
  if (ts.isFunctionDeclaration(outermostFn) && outermostFn.name) {
    return { handlerName: outermostFn.name.text };
  }
  const parent = outermostFn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return { handlerName: parent.name.text };
  }
  // onClick={() => fetch(…)} — the arrow is the attribute initializer itself.
  if (parent && ts.isJsxAttribute(parent) && ts.isIdentifier(parent.name)) {
    if (/^on[A-Z]/.test(parent.name.text)) return { inlineHandlerEvent: parent.name.text };
    return {};
  }
  // onClick={<expr>} through a JSX expression container (the shape
  // extractState's classifyContext matches for wrapped handlers).
  if (
    parent &&
    ts.isJsxExpression(parent) &&
    parent.parent &&
    ts.isJsxAttribute(parent.parent) &&
    ts.isIdentifier(parent.parent.name) &&
    /^on[A-Z]/.test(parent.parent.name.text)
  ) {
    return { inlineHandlerEvent: parent.parent.name.text };
  }
  return {};
}
