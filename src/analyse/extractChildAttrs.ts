import ts from "typescript";
import type { AttrValueKind, ChildAttrInfo } from "../types.ts";
import { posOf } from "./pos.ts";

interface ClassifiedValue {
  valueKind: AttrValueKind;
  /** Root identifier for identifier / member kinds. */
  identifier?: string;
}

/**
 * Attribute shapes passed to uppercase (component) JSX children under
 * `bodyNode`. Lowercase host elements (div, button…) are skipped entirely.
 */
export function extractChildAttrs(bodyNode: ts.Node, sourceFile: ts.SourceFile): ChildAttrInfo[] {
  const out: ChildAttrInfo[] = [];

  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = componentTagName(n.tagName);
      if (tag !== undefined) {
        for (const attr of n.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attr)) {
            out.push({
              tag,
              attr: "...spread",
              valueKind: "spread",
              pos: posOf(attr, sourceFile),
            });
            continue;
          }
          if (!ts.isJsxAttribute(attr)) continue;
          const name = ts.isIdentifier(attr.name)
            ? attr.name.text
            : `${attr.name.namespace.text}:${attr.name.name.text}`;
          const classified = classifyInitializer(attr.initializer);
          const entry: ChildAttrInfo = {
            tag,
            attr: name,
            valueKind: classified.valueKind,
            pos: posOf(attr, sourceFile),
          };
          if (classified.identifier !== undefined) entry.identifier = classified.identifier;
          out.push(entry);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);

  return out;
}

/** Full dotted tag text ("Card", "Menu.Item") when the root identifier is uppercase. */
function componentTagName(tag: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(tag)) {
    return /^[A-Z]/.test(tag.text) ? tag.text : undefined;
  }
  if (ts.isPropertyAccessExpression(tag)) {
    let root: ts.Expression = tag.expression;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    if (ts.isIdentifier(root) && /^[A-Z]/.test(root.text)) return readPropertyAccess(tag);
  }
  return undefined;
}

function readPropertyAccess(p: ts.PropertyAccessExpression): string {
  const head = ts.isIdentifier(p.expression)
    ? p.expression.text
    : ts.isPropertyAccessExpression(p.expression)
      ? readPropertyAccess(p.expression)
      : "<dynamic>";
  return `${head}.${p.name.text}`;
}

function classifyInitializer(init: ts.JsxAttribute["initializer"]): ClassifiedValue {
  if (!init) return { valueKind: "boolean-true" };
  if (ts.isStringLiteral(init)) return { valueKind: "string" };
  if (ts.isJsxExpression(init)) {
    return init.expression ? classifyExpression(init.expression) : { valueKind: "other" };
  }
  // TS 5.x also allows JsxElement/JsxFragment attribute values directly.
  return { valueKind: "jsx" };
}

function classifyExpression(expr: ts.Expression): ClassifiedValue {
  if (ts.isStringLiteral(expr)) return { valueKind: "string" };
  if (ts.isNumericLiteral(expr)) return { valueKind: "number" };
  if (expr.kind === ts.SyntaxKind.TrueKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    // The approved AttrValueKind union has no "boolean-false"; a literal
    // `false` value is deliberately reported as "boolean-true" too.
    return { valueKind: "boolean-true" };
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { valueKind: "null" };
  if (ts.isIdentifier(expr)) return { valueKind: "identifier", identifier: expr.text };
  if (ts.isPropertyAccessExpression(expr)) {
    let root: ts.Expression = expr.expression;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    if (ts.isIdentifier(root)) return { valueKind: "member", identifier: root.text };
    return { valueKind: "member" };
  }
  if (ts.isObjectLiteralExpression(expr)) return { valueKind: "object-literal" };
  if (ts.isArrayLiteralExpression(expr)) return { valueKind: "array-literal" };
  if (ts.isArrowFunction(expr)) return { valueKind: "arrow" };
  if (ts.isFunctionExpression(expr)) return { valueKind: "function" };
  if (ts.isCallExpression(expr)) return { valueKind: "call" };
  if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) {
    return { valueKind: "jsx" };
  }
  return { valueKind: "other" };
}
