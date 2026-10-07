import ts from "typescript";
import type { PropUsage } from "../types.ts";
import type { ParsedComponentUnit } from "./parseFile.ts";
import { posOf } from "./pos.ts";

/**
 * Props spread into a same-file sibling are READ there. NavLink's
 * `Props<T> = Omit<...> & {...}` defeats the syntactic type layer — nothing
 * resolves, nothing destructures — and NavLink's own body only forwards
 * `props` to NavLinkInner, where `props.href.toString()` dies on
 * `undefined.toString` in the default-mount spec. When a component hands its
 * props param to components defined in the same file, those siblings' prop
 * names and member reads become evidence for the {} floor in
 * synthesiseDefaults. Transitively: NavLink → NavLinkInner → NavLinkShell.
 */
export function inheritSpreadSiblingProps(
  unit: ParsedComponentUnit,
  siblings: readonly ParsedComponentUnit[],
  known: ReadonlySet<string>,
  unresolvedProps: string[],
  propUsage: PropUsage[],
  sourceFile: ts.SourceFile,
): void {
  const byName = new Map<string, ParsedComponentUnit>();
  for (const c of siblings) if (!byName.has(c.componentName)) byName.set(c.componentName, c);

  const claim = (name: string, member: string | undefined, node: ts.Node): void => {
    // These two never get a value floor: `{}` renders "[object Object]" as a
    // className and is an invalid child as children. Left undefined, they
    // render as nothing — which is what a defaults-only mount expects.
    if (name === "children" || name === "className") return;
    if (known.has(name)) return;
    if (!unresolvedProps.includes(name)) unresolvedProps.push(name);
    if (member !== undefined) {
      propUsage.push({
        propName: name,
        kind: "member-access",
        member,
        pos: posOf(node, sourceFile),
      });
    }
  };

  const queue: ParsedComponentUnit[] = [unit];
  const seen = new Set<ParsedComponentUnit>([unit]);

  const scan = (c: ParsedComponentUnit): void => {
    const visit = (n: ts.Node): void => {
      if (c.paramName !== undefined) {
        if (
          ts.isJsxSpreadAttribute(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === c.paramName
        ) {
          const owner = n.parent?.parent;
          const tag =
            owner && (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner))
              ? owner.tagName
              : undefined;
          if (tag !== undefined && ts.isIdentifier(tag)) {
            const target = byName.get(tag.text);
            if (target !== undefined && !seen.has(target)) {
              seen.add(target);
              queue.push(target);
            }
          }
          return;
        }
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
          if (n.expression.text === c.paramName) {
            // props.href — and props.href.toString() reads a member off it.
            const member =
              n.parent !== undefined &&
              ts.isPropertyAccessExpression(n.parent) &&
              n.parent.expression === n
                ? n.parent.name.text
                : undefined;
            claim(n.name.text, member, n);
          }
          return;
        }
      }
      // href.toString() on the component's OWN destructured binding — the
      // sibling that destructures (NavLinkShell) carries the same evidence.
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        if (c.destructuredProps.includes(n.expression.text)) {
          claim(c.destructuredAliases.get(n.expression.text) ?? n.expression.text, n.name.text, n);
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(c.bodyNode, visit);
  };

  while (queue.length > 0) {
    scan(queue.shift() as ParsedComponentUnit);
  }
}
