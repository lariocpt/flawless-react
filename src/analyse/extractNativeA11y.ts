import ts from "typescript";

/**
 * Attribute-level readers for the native a11y census — the peer of
 * nativeProps.ts on the attribute axis. The census WALK lives in
 * extractInteractions.ts, which owns the tag reader, the hint collector and the
 * label harvest; what lives here is everything that reads a single attributes
 * bag, so the readers stay import-cycle-free and testable on a bare parse.
 *
 * One posture throughout, inherited from nativeProps.ts: a miss costs coverage,
 * a guess costs a false finding. Every reader that meets a value it cannot
 * decide says "unknown" (or reports dynamic presence), and every rule downstream
 * stands down on that answer rather than flagging it.
 */

/** The elements whose whole purpose is to be pressed. RN's own <Button> is
 *  absent on purpose: it carries an unconditional accessibilityRole in RN's own
 *  source (NATIVE_TAG_TO_ROLE's one row) and names itself via `title`. */
export const PRESS_FAMILY: ReadonlySet<string> = new Set([
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
]);

const LABEL_ATTRS = new Set(["accessibilityLabel", "aria-label"]);
const ROLE_ATTRS = new Set(["accessibilityRole", "role"]);

function attrName(a: ts.JsxAttributeLike): string | undefined {
  if (!ts.isJsxAttribute(a)) return undefined;
  return ts.isIdentifier(a.name) ? a.name.text : undefined;
}

/** The string a literal initializer holds — `x="v"` or `x={"v"}` — else undefined. */
function literalString(init: ts.JsxAttribute["initializer"]): string | undefined {
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)) {
    return init.expression.text;
  }
  return undefined;
}

/** Literal true: a bare attribute, `{true}`, or the string "true". */
function literalTrue(init: ts.JsxAttribute["initializer"]): boolean {
  if (!init) return true;
  if (ts.isJsxExpression(init) && init.expression) {
    return init.expression.kind === ts.SyntaxKind.TrueKeyword;
  }
  return literalString(init) === "true";
}

/** Literal false: `{false}` or the string "false" — i.e. provably NOT hidden. */
function literalFalse(init: ts.JsxAttribute["initializer"]): boolean {
  if (!init) return false;
  if (ts.isJsxExpression(init) && init.expression) {
    return init.expression.kind === ts.SyntaxKind.FalseKeyword;
  }
  return literalString(init) === "false";
}

/**
 * Whether this element hides itself from the accessibility tree.
 *
 * "yes" needs a literal: `aria-hidden` / `accessibilityElementsHidden` true, or
 * `importantForAccessibility` set to "no-hide-descendants" or "no". The "no"
 * value is Android-only and does not hide descendants — counting it as hidden
 * is deliberate forgiveness: the author plainly addressed the a11y tree here,
 * and a finding against a deliberate (if imperfect) attempt reads as noise.
 *
 * "unknown" means one of the three attributes is present but not decidable
 * (a spread value, a variable). The icon rule stands down on it.
 */
export function readHiddenFromA11y(attrs: ts.JsxAttributes): "yes" | "unknown" | undefined {
  let unknown = false;
  for (const a of attrs.properties) {
    const name = attrName(a);
    if (!name || !ts.isJsxAttribute(a)) continue;
    if (name === "aria-hidden" || name === "accessibilityElementsHidden") {
      if (literalTrue(a.initializer)) return "yes";
      if (!literalFalse(a.initializer)) unknown = true;
    } else if (name === "importantForAccessibility") {
      const value = literalString(a.initializer);
      if (value === "no-hide-descendants" || value === "no") return "yes";
      if (value === undefined) unknown = true;
    }
  }
  return unknown ? "unknown" : undefined;
}

/** An accessibilityLabel / aria-label is present but not a string literal. */
export function hasDynamicLabel(attrs: ts.JsxAttributes): boolean {
  return hasDynamicIn(attrs, LABEL_ATTRS);
}

/** An accessibilityRole / role is present but not a string literal. */
export function hasDynamicRole(attrs: ts.JsxAttributes): boolean {
  return hasDynamicIn(attrs, ROLE_ATTRS);
}

function hasDynamicIn(attrs: ts.JsxAttributes, names: ReadonlySet<string>): boolean {
  for (const a of attrs.properties) {
    const name = attrName(a);
    if (!name || !ts.isJsxAttribute(a)) continue;
    if (names.has(name) && literalString(a.initializer) === undefined) return true;
  }
  return false;
}

/**
 * Every literal role attribute as written, kept per attribute name because the
 * two props validate against DIFFERENT unions — "header" is an
 * accessibilityRole, "heading" is a role, and each is a typo in the other's
 * column.
 */
export function literalRoleAttrs(
  attrs: ts.JsxAttributes,
): Array<{ attr: "accessibilityRole" | "role"; value: string }> {
  const out: Array<{ attr: "accessibilityRole" | "role"; value: string }> = [];
  for (const a of attrs.properties) {
    const name = attrName(a);
    if (!ts.isJsxAttribute(a)) continue;
    if (name !== "accessibilityRole" && name !== "role") continue;
    const value = literalString(a.initializer);
    if (value !== undefined) out.push({ attr: name, value });
  }
  return out;
}

/** A literal accessibilityLabel / aria-label on this attributes bag. */
export function hasLiteralLabel(attrs: ts.JsxAttributes): boolean {
  for (const a of attrs.properties) {
    const name = attrName(a);
    if (!name || !ts.isJsxAttribute(a)) continue;
    if (LABEL_ATTRS.has(name) && literalString(a.initializer) !== undefined) return true;
  }
  return false;
}
