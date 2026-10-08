import ts from "typescript";
import type { SetterCallSite, StateInfo, StateJsxFlow, StateKind } from "../types.ts";
import { posOf } from "./pos.ts";
import { collectRefs, hookCalleeName } from "./refs.ts";
import { literalToValue } from "./renderPath.ts";

const INITIAL_RAW_MAX = 120;

/**
 * Extracts useState/useReducer/useRef declarations from a component body,
 * with setter call sites (context + guard classification) and JSX flows.
 * Purely syntactic — companion to extractInteractions/extractProps.
 */
export function extractState(bodyNode: ts.Node, sourceFile: ts.SourceFile): StateInfo[] {
  const out: StateInfo[] = [];

  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)) {
      const hook = hookCalleeName(n.initializer.expression);
      // useActionState(action, initialState) has useReducer's shape exactly, and
      // its initial state is a literal in the source. Without it, `state` was
      // opaque, every guard on it was undecidable, and — once an undecidable
      // render started refusing rather than guessing — two correct React 19 form
      // components lost their whole spec to a refusal that was simply wrong.
      if (
        hook === "useState" ||
        hook === "useReducer" ||
        hook === "useRef" ||
        hook === "useActionState"
      ) {
        const info = buildStateInfo(n, n.initializer, hook, bodyNode, sourceFile);
        if (info) out.push(info);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);

  return out;
}

function buildStateInfo(
  decl: ts.VariableDeclaration,
  call: ts.CallExpression,
  kind: StateKind,
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
): StateInfo | undefined {
  let varName: string | undefined;
  let setterName: string | undefined;
  if (kind !== "useRef" && ts.isArrayBindingPattern(decl.name)) {
    const el0 = decl.name.elements[0];
    const el1 = decl.name.elements[1];
    if (el0 && ts.isBindingElement(el0) && ts.isIdentifier(el0.name)) varName = el0.name.text;
    if (el1 && ts.isBindingElement(el1) && ts.isIdentifier(el1.name)) setterName = el1.name.text;
  } else if (ts.isIdentifier(decl.name)) {
    varName = decl.name.text;
  }
  if (varName === undefined) return undefined;

  // useReducer(reducer, initialState) and useActionState(action, initialState) —
  // the init value is the second argument in both.
  const initExpr =
    kind === "useReducer" || kind === "useActionState" ? call.arguments[1] : call.arguments[0];
  const initialValue = initExpr ? literalToValue(initExpr) : undefined;
  const initialRaw = initExpr ? initExpr.getText(sourceFile).slice(0, INITIAL_RAW_MAX) : "";
  const typeKind = classifyTypeKind(call.typeArguments?.[0], initExpr);

  const setterCalls: SetterCallSite[] = [];
  if (kind === "useRef") {
    collectRefAssignments(bodyNode, sourceFile, varName, setterCalls);
  } else if (setterName !== undefined) {
    collectSetterCalls(bodyNode, sourceFile, setterName, setterCalls);
  }

  return {
    kind,
    varName,
    setterName,
    initialValue,
    initialRaw,
    typeKind,
    pos: posOf(decl, sourceFile),
    setterCalls,
    flowsToJsx: collectJsxFlows(bodyNode, sourceFile, varName),
    setterCalledInEffect: setterCalls.some((c) => c.context === "effect"),
  };
}

// ---------------------------------------------------------------------------
// Initial value / type classification
// ---------------------------------------------------------------------------

function classifyTypeKind(
  typeArg: ts.TypeNode | undefined,
  initExpr: ts.Expression | undefined,
): StateInfo["typeKind"] {
  if (typeArg) return typeKindFromTypeNode(typeArg);
  if (initExpr) return typeKindFromExpression(initExpr);
  return "unknown";
}

function typeKindFromTypeNode(t: ts.TypeNode): StateInfo["typeKind"] {
  switch (t.kind) {
    case ts.SyntaxKind.StringKeyword:
      return "string";
    case ts.SyntaxKind.NumberKeyword:
      return "number";
    case ts.SyntaxKind.BooleanKeyword:
      return "boolean";
    default:
      break;
  }
  if (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isArrayTypeNode(t)) return "array";
  if (ts.isTypeLiteralNode(t)) return "object";
  return "unknown";
}

function typeKindFromExpression(e: ts.Expression): StateInfo["typeKind"] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return "string";
  if (ts.isNumericLiteral(e)) return "number";
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) {
    return "boolean";
  }
  if (e.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isArrayLiteralExpression(e)) return "array";
  if (ts.isObjectLiteralExpression(e)) return "object";
  if (isNegativeNumber(e)) return "number";
  return "unknown";
}

function isNegativeNumber(e: ts.Expression): e is ts.PrefixUnaryExpression {
  return (
    ts.isPrefixUnaryExpression(e) &&
    e.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(e.operand)
  );
}

// ---------------------------------------------------------------------------
// Setter call sites
// ---------------------------------------------------------------------------

function collectSetterCalls(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  setterName: string,
  out: SetterCallSite[],
): void {
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === setterName
    ) {
      out.push({
        pos: posOf(n, sourceFile),
        ...classifyContext(n, bodyNode),
        argKind: classifyArgKind(n),
      });
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);
}

/** `ref.current = ...` assignments are the useRef equivalent of setter calls. */
function collectRefAssignments(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  varName: string,
  out: SetterCallSite[],
): void {
  const visit = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(n.left) &&
      ts.isIdentifier(n.left.expression) &&
      n.left.expression.text === varName &&
      n.left.name.text === "current"
    ) {
      out.push({
        pos: posOf(n, sourceFile),
        ...classifyContext(n, bodyNode),
        argKind: "expression",
      });
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);
}

function classifyArgKind(call: ts.CallExpression): SetterCallSite["argKind"] {
  const arg = call.arguments[0];
  if (!arg) return "none";
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return "updater";
  if (literalToValue(arg) !== undefined) return "literal";
  return "expression";
}

function classifyContext(
  node: ts.Node,
  bodyNode: ts.Node,
): Pick<SetterCallSite, "context" | "enclosingName" | "guarded"> {
  // Outermost function-like strictly below the component body node.
  let outermostFn: ts.Node | undefined;
  for (let p = node.parent; p && p !== bodyNode; p = p.parent) {
    if (isFunctionBoundary(p)) outermostFn = p;
  }
  const guarded = hasConditionalBetween(node, outermostFn ?? bodyNode);
  if (!outermostFn) return { context: "render", guarded };

  const parent = outermostFn.parent;

  if (parent && ts.isCallExpression(parent) && parent.arguments.some((a) => a === outermostFn)) {
    const hook = hookCalleeName(parent.expression);
    if (hook === "useEffect" || hook === "useLayoutEffect") {
      return { context: "effect", enclosingName: hook, guarded };
    }
    if (hook === "useCallback" || hook === "useMemo") {
      return { context: "callback", enclosingName: hook, guarded };
    }
  }

  // const handleAdd = () => ... — variable-initializer handlers.
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const name = parent.name.text;
    const context = /^(handle|on)[A-Z]/.test(name) ? ("handler" as const) : ("unknown" as const);
    return { context, enclosingName: name, guarded };
  }

  // onClick={() => ...} — inline JSX attribute handlers.
  if (parent && ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) {
    const attrName = parent.parent.name.getText();
    const context = /^on[A-Z]/.test(attrName) ? ("handler" as const) : ("unknown" as const);
    return { context, enclosingName: attrName, guarded };
  }

  return { context: "unknown", enclosingName: nearestName(outermostFn), guarded };
}

function nearestName(fn: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  const parent = fn.parent;
  if (parent && ts.isCallExpression(parent)) return hookCalleeName(parent.expression);
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}

function hasConditionalBetween(node: ts.Node, stop: ts.Node): boolean {
  for (let p = node.parent; p && p !== stop; p = p.parent) {
    if (ts.isIfStatement(p) || ts.isConditionalExpression(p)) return true;
    if (
      ts.isBinaryExpression(p) &&
      (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        p.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return true;
    }
  }
  return false;
}

function isFunctionBoundary(n: ts.Node): boolean {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}

// ---------------------------------------------------------------------------
// JSX flows
// ---------------------------------------------------------------------------

function collectJsxFlows(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  varName: string,
): StateJsxFlow[] {
  const flows: StateJsxFlow[] = [];
  // collectRefs also covers useRef `x.current` reads: the receiver `x` of the
  // property access is a reference position, so no separate walk is needed.
  const refs = collectRefs(bodyNode, sourceFile, new Set([varName]), undefined);
  for (const ref of refs) {
    const flow = classifyJsxFlow(ref.node, bodyNode, sourceFile);
    if (flow) flows.push(flow);
  }
  return flows;
}

function classifyJsxFlow(
  refNode: ts.Node,
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
): StateJsxFlow | undefined {
  let crossedFunction = false;
  // The value SELECTS the child here rather than rendering:
  // `{mode === 'write' ? <A/> : <B/>}` and `{mode && <X/>}` never put
  // 'write' on screen. Only the raw value in text position is a witness.
  let selectsOnly = false;
  let prev: ts.Node = refNode;
  for (let p = refNode.parent; p && p !== bodyNode; prev = p, p = p.parent) {
    if (!selectsOnly) {
      if (ts.isConditionalExpression(p) && p.condition === prev) selectsOnly = true;
      if (
        ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        p.left === prev
      )
        selectsOnly = true;
    }
    if (
      ts.isJsxExpression(p) &&
      p.parent &&
      (ts.isJsxElement(p.parent) || ts.isJsxFragment(p.parent))
    ) {
      const tag = ts.isJsxElement(p.parent)
        ? p.parent.openingElement.tagName.getText(sourceFile)
        : "<fragment>";
      return {
        via: selectsOnly ? "condition" : "child",
        tag,
        pos: posOf(refNode, sourceFile),
      };
    }
    if (ts.isJsxAttribute(p) && !crossedFunction) {
      const owner = p.parent.parent;
      const tag =
        owner && (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner))
          ? owner.tagName.getText(sourceFile)
          : "<dynamic>";
      return {
        via: "attr",
        tag,
        attr: p.name.getText(sourceFile),
        pos: posOf(refNode, sourceFile),
      };
    }
    if (isFunctionBoundary(p)) crossedFunction = true;
  }
  return undefined;
}
