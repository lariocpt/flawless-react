import ts from "typescript";
import type { EffectFeatures, HookDetail } from "../types.ts";
import { posOf } from "./pos.ts";
import { type ComponentScope, collectRefs, hookCalleeName } from "./refs.ts";

const HOOK_RE = /^use[A-Z]/;

export function extractHooks(bodyNode: ts.Node): string[] {
  const found = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const fn = n.expression;
      if (ts.isIdentifier(fn) && HOOK_RE.test(fn.text)) {
        found.add(fn.text);
      } else if (
        ts.isPropertyAccessExpression(fn) &&
        ts.isIdentifier(fn.name) &&
        HOOK_RE.test(fn.name.text)
      ) {
        found.add(fn.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);
  return [...found].sort();
}

const DEP_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useMemo",
  "useCallback",
  "useImperativeHandle",
]);

/** One HookDetail per hook call site (not deduped), in source order. */
export function extractHookDetails(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  scope: ComponentScope,
): HookDetail[] {
  const out: HookDetail[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeHookName(n.expression);
      if (name !== undefined) out.push(detailFor(n, name, sourceFile, scope));
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);
  return out;
}

function calleeHookName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr) && HOOK_RE.test(expr.text)) return expr.text;
  if (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.name) &&
    HOOK_RE.test(expr.name.text)
  ) {
    return expr.name.text;
  }
  return undefined;
}

function detailFor(
  call: ts.CallExpression,
  name: string,
  sf: ts.SourceFile,
  scope: ComponentScope,
): HookDetail {
  const args = call.arguments;

  const last = args[args.length - 1];
  const depsArray = last !== undefined && ts.isArrayLiteralExpression(last) ? last : undefined;
  const deps = depsArray?.elements.map((el) => el.getText(sf));
  const depsHasComplex = depsArray?.elements.some((el) => !ts.isIdentifier(el)) ?? false;

  const arg0 = args[0];
  const callback =
    arg0 !== undefined && (ts.isArrowFunction(arg0) || ts.isFunctionExpression(arg0))
      ? arg0
      : undefined;
  const isEffect = name === "useEffect" || name === "useLayoutEffect";

  return {
    name,
    pos: posOf(call, sf),
    argCount: args.length,
    argsSummary: args.map((a) => summarizeArg(a, sf)),
    deps,
    depsHasComplex,
    missingDepsArray: DEP_HOOKS.has(name) && deps === undefined,
    callbackReads: callback ? readsInCallback(callback, sf, scope) : [],
    callbackIsInline: callback !== undefined,
    readsBareParamsObject:
      callback !== undefined &&
      scope.paramName !== undefined &&
      paramsObjectEscapes(callback.body, scope.paramName),
    effectFeatures: isEffect && callback ? effectFeaturesOf(callback) : undefined,
    resultName: resultNameOf(call),
  };
}

function summarizeArg(arg: ts.Expression, sf: ts.SourceFile): string {
  if (ts.isArrowFunction(arg)) return "arrow";
  if (ts.isFunctionExpression(arg)) return "function";
  if (ts.isIdentifier(arg)) return `identifier:${arg.text}`;
  if (
    ts.isStringLiteral(arg) ||
    ts.isNumericLiteral(arg) ||
    arg.kind === ts.SyntaxKind.TrueKeyword ||
    arg.kind === ts.SyntaxKind.FalseKeyword ||
    arg.kind === ts.SyntaxKind.NullKeyword
  ) {
    return `literal:${arg.getText(sf)}`;
  }
  if (ts.isObjectLiteralExpression(arg)) return "object";
  if (ts.isArrayLiteralExpression(arg)) return "array";
  if (ts.isCallExpression(arg)) return "call";
  return "other";
}

/**
 * Component-scope names read inside the callback body, canonicalised through
 * propAliases, minus names shadowed by the callback's own parameters.
 */
function readsInCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  sf: ts.SourceFile,
  scope: ComponentScope,
): string[] {
  const names = new Set<string>([
    ...scope.propNames,
    ...scope.propAliases.keys(),
    ...scope.stateVars,
    ...scope.setterNames,
    ...scope.refNames,
    ...scope.memoResultNames,
    ...scope.derivedNames.keys(),
  ]);
  const shadowed = ownParamNames(callback);
  const reads = new Set<string>();
  for (const ref of collectRefs(callback.body, sf, names, scope.paramName)) {
    if (shadowed.has(ref.node.text)) continue;
    reads.add(scope.propAliases.get(ref.name) ?? ref.name);
  }
  return [...reads].sort();
}

function ownParamNames(fn: ts.ArrowFunction | ts.FunctionExpression): Set<string> {
  const out = new Set<string>();
  for (const p of fn.parameters) collectBindingNames(p.name, out);
  return out;
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) collectBindingNames(el.name, out);
  }
}

/** The whole props object escapes: a bare `props` reference that is not a `props.x` receiver. */
function paramsObjectEscapes(body: ts.Node, paramName: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isIdentifier(n) &&
      n.text === paramName &&
      !(
        ts.isPropertyAccessExpression(n.parent) &&
        (n.parent.expression === n || n.parent.name === n)
      )
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

function effectFeaturesOf(callback: ts.ArrowFunction | ts.FunctionExpression): EffectFeatures {
  const features: EffectFeatures = {
    fetch: false,
    setInterval: false,
    setTimeout: false,
    addEventListener: false,
    hasCleanup: false,
  };
  const body = callback.body;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = hookCalleeName(n.expression);
      if (callee === "fetch") features.fetch = true;
      else if (callee === "setInterval") features.setInterval = true;
      else if (callee === "setTimeout") features.setTimeout = true;
      else if (callee === "addEventListener") features.addEventListener = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);

  if (ts.isBlock(body)) {
    features.hasCleanup = body.statements.some(
      (s) =>
        ts.isReturnStatement(s) &&
        s.expression !== undefined &&
        (ts.isArrowFunction(s.expression) ||
          ts.isFunctionExpression(s.expression) ||
          ts.isIdentifier(s.expression)),
    );
  } else {
    features.hasCleanup = ts.isArrowFunction(body) || ts.isFunctionExpression(body);
  }
  return features;
}

function resultNameOf(call: ts.CallExpression): string | undefined {
  const parent = call.parent;
  if (
    parent !== undefined &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === call &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return undefined;
}
