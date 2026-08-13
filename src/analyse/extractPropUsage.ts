import ts from "typescript";
import type { PropUsage } from "../types.ts";
import { posOf } from "./pos.ts";
import { type ComponentScope, collectRefs, hookCalleeName } from "./refs.ts";

/**
 * Classifies every prop reference in the component body by where it flows
 * (JSX, hook deps/args, calls, conditions). Rules run in fixed precedence;
 * the first match wins. Purely syntactic — see refs.ts for the shared limits.
 */

const DEPS_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useMemo",
  "useCallback",
  "useImperativeHandle",
]);

type Classified = Pick<PropUsage, "kind" | "tag" | "attr" | "hook">;

export function extractPropUsage(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  scope: ComponentScope,
): PropUsage[] {
  const names = new Set<string>([...scope.propNames, ...scope.propAliases.keys()]);
  const out: PropUsage[] = [];

  for (const ref of collectRefs(bodyNode, sourceFile, names, scope.paramName)) {
    // For `props.x` references classification anchors on the whole access node.
    const refExpr: ts.Node = ref.viaParam ? ref.node.parent : ref.node;
    const usage: PropUsage = {
      propName: scope.propAliases.get(ref.name) ?? ref.name,
      ...classify(refExpr, bodyNode),
      pos: posOf(ref.node, sourceFile),
    };
    const member = memberName(refExpr);
    if (member !== undefined) usage.member = member;
    out.push(usage);
  }
  return out;
}

function classify(refExpr: ts.Node, bodyNode: ts.Node): Classified {
  // 1 — element of the deps array of a deps-taking hook.
  for (let n = refExpr; n !== bodyNode && n.parent; n = n.parent) {
    if (!ts.isArrayLiteralExpression(n)) continue;
    const call = n.parent;
    if (!ts.isCallExpression(call) || call.arguments[call.arguments.length - 1] !== n) continue;
    const hook = hookCalleeName(call.expression);
    if (hook !== undefined && DEPS_HOOKS.has(hook)) return { kind: "hook-dep", hook };
  }

  // 2 — value of a JSX attribute, unless a function boundary intervenes.
  for (let n = refExpr.parent; n && n !== bodyNode; n = n.parent) {
    if (isFunctionBoundary(n)) break;
    if (!ts.isJsxAttribute(n)) continue;
    const tag = owningTag(n);
    return {
      kind: /^[A-Z]/.test(tag) ? "passed-to-child" : "jsx-attr",
      tag,
      attr: attrNameText(n.name),
    };
  }

  // 3 — expression child of an element or fragment (nearest JsxExpression only).
  for (let n = refExpr.parent; n && n !== bodyNode; n = n.parent) {
    if (!ts.isJsxExpression(n)) continue;
    if (ts.isJsxElement(n.parent)) {
      return { kind: "jsx-child", tag: tagText(n.parent.openingElement.tagName) };
    }
    if (ts.isJsxFragment(n.parent)) return { kind: "jsx-child", tag: "<fragment>" };
    break;
  }

  // 4 — the reference itself is called.
  const parent = refExpr.parent;
  if (parent && ts.isCallExpression(parent) && parent.expression === refExpr) {
    return { kind: "call" };
  }

  // 5 — inside any argument of a custom-hook call.
  for (let n = refExpr; n !== bodyNode && n.parent; n = n.parent) {
    const p = n.parent;
    if (!ts.isCallExpression(p) || !p.arguments.some((a) => a === n)) continue;
    const hook = hookCalleeName(p.expression);
    if (hook !== undefined && /^use[A-Z]/.test(hook)) return { kind: "hook-arg", hook };
  }

  // 6 — receiver of a property access (`prop.member`).
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === refExpr) {
    return { kind: "member-access" };
  }

  // 7 — flows into a branching condition before any function boundary.
  for (let n = refExpr; n !== bodyNode && n.parent; n = n.parent) {
    const p = n.parent;
    if (isFunctionBoundary(p)) break;
    if (ts.isIfStatement(p) && p.expression === n) return { kind: "conditional" };
    if (ts.isConditionalExpression(p) && p.condition === n) return { kind: "conditional" };
    if (
      ts.isBinaryExpression(p) &&
      p.left === n &&
      (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        p.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return { kind: "conditional" };
    }
    if (ts.isSwitchStatement(p) && p.expression === n) return { kind: "conditional" };
  }

  return { kind: "other" };
}

/** `prop.member` → "member"; applies to the `props.x` access node for viaParam refs. */
function memberName(refExpr: ts.Node): string | undefined {
  const p = refExpr.parent;
  if (p && ts.isPropertyAccessExpression(p) && p.expression === refExpr) return p.name.text;
  return undefined;
}

function isFunctionBoundary(n: ts.Node): boolean {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}

function owningTag(attr: ts.JsxAttribute): string {
  const owner = attr.parent.parent;
  return ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)
    ? tagText(owner.tagName)
    : "<dynamic>";
}

function attrNameText(name: ts.JsxAttributeName): string {
  return ts.isIdentifier(name) ? name.text : `${name.namespace.text}:${name.name.text}`;
}

function tagText(tag: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) return propertyAccessText(tag);
  return "<dynamic>";
}

function propertyAccessText(p: ts.PropertyAccessExpression): string {
  const head = ts.isIdentifier(p.expression)
    ? p.expression.text
    : ts.isPropertyAccessExpression(p.expression)
      ? propertyAccessText(p.expression)
      : "<dynamic>";
  return `${head}.${p.name.text}`;
}
