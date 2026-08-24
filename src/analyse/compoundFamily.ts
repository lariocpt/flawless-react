import ts from "typescript";
import type { ComponentInfo } from "../types.ts";
import type { ImportBinding, ParsedComponentUnit } from "./parseFile.ts";
import { emptyEnv, initialRenderExpression } from "./renderPath.ts";

/**
 * The compound family a part's OWN file exports, if it does: shadcn-style
 * wrappers put Dialog (rendering DialogPrimitive.Root), DialogContent and
 * every part in one module, so the wrapper a spec needs is a same-file
 * import away. Derivation is same-file only — a cross-file family would
 * need the child tree, and chasing it is exactly the guessing v1 avoids.
 *
 * The caller decides WHEN to derive (only for compound-part units) and the
 * emitters decide whether the family is wrappable at all (open-state Roots
 * only) — this module just reports what the file says.
 */

/** Headless-UI packages whose parts require a Root ancestor (extractRenderMode's list). */
const COMPOUND_PACKAGES = /^@(base-ui|radix-ui|ariakit)(\/|$)/;

const CONTENT_MEMBERS = new Set(["Content", "Popup"]);

export function deriveCompoundFamily(
  unit: ParsedComponentUnit,
  siblings: ParsedComponentUnit[],
  imports: Map<string, ImportBinding>,
): ComponentInfo["compoundFamily"] {
  const own = compoundMembers(unit, imports);
  const specifier = own[0]?.specifier;
  // The part must render the package directly; a local-hop part (a wrapper
  // whose "part-ness" comes from rendering another local part) has no member
  // of its own to place in the family — v2 territory.
  if (!specifier) return undefined;

  let root: string | undefined;
  let content: string | undefined;
  for (const sibling of siblings) {
    if (sibling.exportKind === "none") continue;
    const members = compoundMembers(sibling, imports).filter((m) => m.specifier === specifier);
    if (members.length === 0) continue;
    if (members.some((m) => m.member === "Root" || m.member === "Provider")) {
      root ??= sibling.componentName;
    } else if (
      sibling.componentName !== unit.componentName &&
      members.some((m) => CONTENT_MEMBERS.has(m.member))
    ) {
      content ??= sibling.componentName;
    }
  }
  if (!root) return undefined;

  const part = own.some((m) => m.member === "Trigger")
    ? ("trigger" as const)
    : own.some((m) => CONTENT_MEMBERS.has(m.member))
      ? ("content" as const)
      : ("other" as const);
  return { root, ...(content !== undefined ? { content } : {}), part, specifier };
}

/** Every `<X.Member>` in the unit's initial render where X is a compound package. */
function compoundMembers(
  unit: ParsedComponentUnit,
  imports: Map<string, ImportBinding>,
): Array<{ member: string; specifier: string }> {
  const expr = initialRenderExpression(unit.bodyNode, emptyEnv())?.expr;
  if (!expr) return [];
  const out: Array<{ member: string; specifier: string }> = [];
  const visit = (n: ts.Node): void => {
    let tagName: ts.JsxTagNameExpression | undefined;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) tagName = n.tagName;
    if (tagName && ts.isPropertyAccessExpression(tagName)) {
      let rootExpr: ts.Expression = tagName.expression;
      while (ts.isPropertyAccessExpression(rootExpr)) rootExpr = rootExpr.expression;
      if (ts.isIdentifier(rootExpr)) {
        const binding = imports.get(rootExpr.text);
        if (binding && COMPOUND_PACKAGES.test(binding.specifier)) {
          out.push({ member: tagName.name.text, specifier: binding.specifier });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return out;
}
