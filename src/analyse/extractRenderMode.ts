import ts from "typescript";
import type { RenderMode } from "../types.ts";
import { happyPathReturnExpression } from "./extractRootTag.ts";
import type { ImportBinding } from "./parseFile.ts";

/**
 * How a component can be mounted in a test, and why.
 *
 * Some components genuinely cannot be rendered standalone, and generating a
 * render-based assertion for them produces a red suite that says nothing. A
 * design-system "part" (`<Dialog.Content>`, `<Select.Item>`) throws
 * "SelectRootContext is missing" outside its Root; a root layout returns
 * `<html>`, which React cannot mount inside a container div; a hydrator
 * returns null. Naming the situation lets the scaffolder assert what IS true
 * instead of pretending.
 */

/** Headless-UI packages whose parts require a Root ancestor. */
const COMPOUND_PACKAGES = /^@(base-ui|radix-ui|ariakit)(\/|$)/;

/** Members that ARE the provider — these render fine on their own. */
const ROOT_MEMBERS = new Set(["Root", "Provider"]);

export interface RenderModeResult {
  mode: RenderMode;
  /** Human-readable reason, emitted into the spec and the run report. */
  note?: string;
}

export function extractRenderMode(
  bodyNode: ts.Node,
  imports: Map<string, ImportBinding>,
  isAsync: boolean,
): RenderModeResult {
  const expr = happyPathReturnExpression(bodyNode);

  if (expr && isNullLiteral(expr)) {
    return {
      mode: "null",
      note: "returns null — asserted as an empty container rather than visible output",
    };
  }

  // The part is often nested rather than the root: DialogContent returns
  // <DialogPortal><DialogPrimitive.Popup>…, so checking only the root tag
  // misses it. Scan the whole unconditional render subtree instead.
  const part = findUnrootedCompoundPart(expr, imports);
  if (part) {
    return {
      mode: "compound-part",
      note:
        `renders <${part.root}.${part.member}> from ${part.specifier}, which throws outside its ` +
        `Root. Wrap renderTarget() in the matching <Root open> to assert its content.`,
    };
  }

  const intrinsic = intrinsicTagOf(expr);
  if (intrinsic === "html") {
    return {
      mode: "document-root",
      note: "returns a document root (<html>) — React cannot mount that inside a container",
    };
  }

  return { mode: isAsync ? "rsc" : "client" };
}

function isNullLiteral(expr: ts.Expression): boolean {
  return expr.kind === ts.SyntaxKind.NullKeyword;
}

/**
 * A compound-package part rendered without its own Root anywhere in the same
 * subtree. A component that renders `<X.Root>` around its parts supplies its
 * own context and is perfectly renderable, so it must not be flagged.
 */
function findUnrootedCompoundPart(
  expr: ts.Expression | undefined,
  imports: Map<string, ImportBinding>,
): { root: string; member: string; specifier: string } | undefined {
  if (!expr) return undefined;

  const parts: Array<{ root: string; member: string; specifier: string }> = [];
  const rootsProvided = new Set<string>();

  const visit = (n: ts.Node): void => {
    let tagName: ts.JsxTagNameExpression | undefined;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) tagName = n.tagName;
    if (tagName && ts.isPropertyAccessExpression(tagName)) {
      let root: ts.Expression = tagName.expression;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      if (ts.isIdentifier(root)) {
        const binding = imports.get(root.text);
        if (binding && COMPOUND_PACKAGES.test(binding.specifier)) {
          const member = tagName.name.text;
          if (ROOT_MEMBERS.has(member)) rootsProvided.add(root.text);
          else parts.push({ root: root.text, member, specifier: binding.specifier });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);

  return parts.find((p) => !rootsProvided.has(p.root));
}

function intrinsicTagOf(expr: ts.Expression | undefined): string | undefined {
  const tagName = jsxTagName(expr);
  if (!tagName || !ts.isIdentifier(tagName)) return undefined;
  return /^[a-z]/.test(tagName.text) ? tagName.text : undefined;
}

function jsxTagName(expr: ts.Expression | undefined): ts.JsxTagNameExpression | undefined {
  if (!expr) return undefined;
  let node: ts.Expression = expr;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isJsxElement(node)) return node.openingElement.tagName;
  if (ts.isJsxSelfClosingElement(node)) return node.tagName;
  return undefined;
}
