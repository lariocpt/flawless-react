import ts from "typescript";
import { domOnlyResolver, type HostTagResolver } from "./hostTag.ts";
import { emptyEnv, initialRenderExpression, type RenderEnv } from "./renderPath.ts";

/**
 * The JSX root a component renders on its happy path, as a tag name.
 *
 * Consumers turn this into an assertion about the rendered container, so a
 * wrong answer is a red spec in someone else's repo. Every case where the root
 * is not pinned down by syntax alone — a fragment, a conditional, a qualified
 * tag, a second return with a different root — gives up instead of guessing.
 * The tag is returned as written and may be uppercase (`ButtonPrimitive`); the
 * caller decides whether a component root is useful to it.
 */
export function extractRootTag(
  bodyNode: ts.Node,
  env: RenderEnv = emptyEnv(),
  /**
   * Which tags count as host elements. Defaults to the lowercase-intrinsic rule
   * this function has always used, so every existing caller is unchanged.
   */
  hostTag: HostTagResolver = domOnlyResolver,
): string | undefined {
  // The INITIAL render, not the last return: a component that opens collapsed
  // renders its guard branch, and describing it by the expanded branch below
  // would name a tag the spec never produces.
  const root = initialRenderExpression(bodyNode, env)?.expr;
  if (!root) return undefined;
  // A fragment renders no host element to assert against, and a conditional
  // root depends on props the spec picks independently of this analysis.
  if (!ts.isJsxElement(root) && !ts.isJsxSelfClosingElement(root)) return undefined;

  const tag = plainTagName(root);
  if (tag === undefined) return undefined;
  // Host elements only, as the field's own contract says. A component root is
  // not an answer to "what element does this render" — shadcn's Button returns
  // <ButtonPrimitive>, and reporting that let a caller conclude the render
  // contained an element called "ButtonPrimitive" and no button at all. Every
  // consumer wants a real tag: the spec's querySelector, the content-model
  // wrapper, the ambiguity census.
  //
  // The predicate moved to hostTag.ts, and with it the answer for React Native:
  // <View> is a host element even though it is capitalised, because THIS FILE
  // imports it from "react-native". Under the default resolver the test is the
  // same lowercase one it has always been. Without this, rootTag was undefined
  // for every RN component, which silently took the root-tag contract test, the
  // WRAP_IN table and the ambiguity census down with it.
  const resolved = hostTag(tag);
  if (resolved === undefined) return undefined;

  // The MODULE-SIDE name, so `import { View as Box }` reports "View". Agreement
  // between returns is checked on the tag as written, which is what the source
  // actually repeats.
  return everyReturnAgrees(bodyNode, root, tag) ? resolved.name : undefined;
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function plainTagName(el: ts.JsxElement | ts.JsxSelfClosingElement): string | undefined {
  const tagName = ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName;
  // <UI.Badge /> renders whatever the namespace object holds under that key;
  // "Badge" and "UI.Badge" are both lies about the emitted element.
  return ts.isIdentifier(tagName) ? tagName.text : undefined;
}

/**
 * Every other return in the component must render the same tag or nothing at
 * all. `if (!user) return null` leaves the happy-path root unambiguous, while
 * `if (loading) return <Skeleton />` means the rendered root is decided by
 * props and no single tag describes the component.
 */
function everyReturnAgrees(bodyNode: ts.Node, root: ts.Expression, tag: string): boolean {
  let agrees = true;

  const compatible = (expr: ts.Expression | undefined): boolean => {
    if (expr === undefined || expr === root) return true;
    if (rendersNothing(expr)) return true;
    if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr)) {
      return plainTagName(expr) === tag;
    }
    // `return content` may hold any element; unknowable without a type checker.
    return false;
  };

  const visit = (n: ts.Node): void => {
    if (!agrees) return;
    // Returns inside a nested callback belong to that callback — a `.map` row,
    // a render prop — not to the component.
    if (n !== bodyNode && isFunctionBoundary(n)) return;
    if (ts.isReturnStatement(n)) {
      const expr = n.expression ? unwrapParens(n.expression) : undefined;
      if (!compatible(expr)) {
        agrees = false;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(bodyNode);

  return agrees;
}

function rendersNothing(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.NullKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    return true;
  }
  return ts.isIdentifier(expr) && expr.text === "undefined";
}

function isFunctionBoundary(n: ts.Node): boolean {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
}
