import ts from "typescript";

/**
 * True when the component hands its `children` prop to an element that only
 * accepts ELEMENT children: an `asChild` element (Radix Slot semantics — the
 * element is replaced by its child, and Slot clones an element, never a text
 * node) or a bare `<Slot>` / `<Slottable>`.
 *
 * The app always passes a real element to these, but a unit fixture passes
 * plain text, and every such mount dies at render with
 * "Primitive.button failed to slot onto its children. Expected a single React
 * element child or Slottable" (miro-clone: Hint, Actions, ConfirmModal —
 * each one a Trigger-wrap). The flag makes the unit template pass a
 * <span>{CHILD_TEXT}</span> instead of the bare string — which renders
 * identically through every non-slot children site too.
 */
export function childrenIntoSlot(bodyNode: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n)) {
      const opening = n.openingElement;
      const tag = plainTagName(opening);
      // Qualified tags (<Radix.Slot>) are skipped: the local name is
      // unknowable, and asChild detection does not need the name at all.
      const isSlotEl = tag === "Slot" || tag === "Slottable";
      const asChild = opening.attributes.properties.some(isAsChildAttr);
      if ((isSlotEl || asChild) && n.children.some(isChildrenExpr)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(bodyNode);
  return found;
}

/** The JSX children slot holding exactly the `{children}` identifier expression. */
function isChildrenExpr(n: ts.Node): boolean {
  return (
    ts.isJsxExpression(n) &&
    n.expression !== undefined &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "children"
  );
}

/** `asChild`, `asChild={true}`, `asChild={cond}` — everything except an explicit false. */
function isAsChildAttr(p: ts.JsxAttributeLike): boolean {
  if (!ts.isJsxAttribute(p) || !ts.isIdentifier(p.name) || p.name.text !== "asChild") return false;
  const init = p.initializer;
  if (init === undefined) return true; // bare `asChild`
  if (ts.isStringLiteral(init)) return init.text !== "false";
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
    return true;
  }
  return false;
}

/** The JSX opening tag as a plain identifier, if it is one. */
function plainTagName(opening: ts.JsxOpeningElement): string | undefined {
  return ts.isIdentifier(opening.tagName) ? opening.tagName.text : undefined;
}
