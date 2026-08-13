import ts from "typescript";
import { initialRenderExpression, type RenderEnv, reachability } from "./renderPath.ts";

/**
 * Whether `children` and `className` actually reach the DOM.
 *
 * Both are the basis for assertions on components that render no literal copy of
 * their own — the whole shadcn/ui layer, which was 40% of the generated specs and
 * every one of them assertion-free. Accepting a prop is not the same as
 * rendering it, so each rule below insists on seeing the value flow somewhere it
 * can be observed, and gives up otherwise.
 */

export interface RenderFlows {
  /** A sentinel child passed in will appear in the markup. */
  children: boolean;
  /** A className passed in will land on some element. */
  className: boolean;
}

export function extractFlows(bodyNode: ts.Node, env: RenderEnv): RenderFlows {
  const initial = initialRenderExpression(bodyNode, env);
  if (!initial) return { children: false, className: false };
  const { expr: root, scope } = initial;
  const reached = (n: ts.Node): boolean => reachability(n, root, scope) === "yes";

  return {
    children: childrenFlow(root, reached),
    className: classNameFlow(root, reached),
  };
}

/**
 * `{children}` rendered directly, or a `{...props}` spread onto a host element
 * that can hold children.
 *
 * The spread case is how the entire shadcn layer works — `<div {...props} />`
 * never mentions children by name — so leaving it out would miss most of the
 * components this rule exists for. Void elements are excluded: <input {...props}/>
 * accepts the prop and renders nothing.
 */
function childrenFlow(root: ts.Node, reached: (n: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isJsxExpression(n) &&
      n.expression &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "children" &&
      n.parent &&
      (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent)) &&
      reached(n)
    ) {
      found = true;
      return;
    }
    if (ts.isJsxSpreadAttribute(n) && reached(n)) {
      const owner = n.parent?.parent;
      const tag = hostTagOf(owner);
      if (tag && !VOID_ELEMENTS.has(tag)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

/**
 * The `className` identifier appearing inside a `className=` attribute on a HOST
 * element — directly, as an argument to any call (cn/clsx/twMerge), or inside a
 * template span.
 *
 * Host-only is the load-bearing part. `<SeparatorPrimitive className={cn(…)} />`
 * hands the class to another component, and whether that component puts it on a
 * DOM node is its business, not something this file can see. Asserting on it
 * would be a claim about a third-party implementation.
 *
 * The other way this goes wrong is a `{...props}` spread positioned AFTER the
 * attribute on the same element, which overwrites it. That is checked rather
 * than assumed.
 */
function classNameFlow(root: ts.Node, reached: (n: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isJsxAttribute(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "className" &&
      hostTagOf(n.parent?.parent) !== undefined &&
      reached(n) &&
      mentionsClassName(n) &&
      !overwrittenBySpread(n)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

function mentionsClassName(attr: ts.JsxAttribute): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === "className" && n !== attr.name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (attr.initializer) visit(attr.initializer);
  return found;
}

/** A spread later in the same attribute list wins, so the className is lost. */
function overwrittenBySpread(attr: ts.JsxAttribute): boolean {
  const list = attr.parent;
  if (!list || !ts.isJsxAttributes(list)) return false;
  const index = list.properties.indexOf(attr);
  if (index < 0) return false;
  return list.properties
    .slice(index + 1)
    .some((p) => ts.isJsxSpreadAttribute(p) && !isClassNameSafeSpread(p));
}

/**
 * `{...props}` after className is only harmful when props can carry className.
 * A rest binding that had className destructured out of it cannot.
 */
function isClassNameSafeSpread(spread: ts.JsxSpreadAttribute): boolean {
  if (!ts.isIdentifier(spread.expression)) return false;
  const name = spread.expression.text;
  // `const { className, ...props }` — the rest holds everything BUT className.
  for (let n: ts.Node | undefined = spread; n; n = n.parent) {
    if (!ts.isFunctionDeclaration(n) && !ts.isArrowFunction(n) && !ts.isFunctionExpression(n)) {
      continue;
    }
    const first = n.parameters[0];
    if (!first || !ts.isObjectBindingPattern(first.name)) return false;
    let sawClassName = false;
    let restMatches = false;
    for (const el of first.name.elements) {
      if (!ts.isBindingElement(el)) continue;
      if (el.dotDotDotToken) {
        restMatches = ts.isIdentifier(el.name) && el.name.text === name;
        continue;
      }
      if (ts.isIdentifier(el.name) && el.name.text === "className") sawClassName = true;
    }
    return sawClassName && restMatches;
  }
  return false;
}

function hostTagOf(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  const tagName = ts.isJsxOpeningElement(node)
    ? node.tagName
    : ts.isJsxSelfClosingElement(node)
      ? node.tagName
      : undefined;
  if (!tagName || !ts.isIdentifier(tagName)) return undefined;
  return /^[a-z]/.test(tagName.text) ? tagName.text : undefined;
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
