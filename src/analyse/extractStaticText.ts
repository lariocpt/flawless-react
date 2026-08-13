import ts from "typescript";
import { happyPathReturnExpression } from "./extractRootTag.ts";

const MAX_TEXTS = 8;
const MIN_LENGTH = 2;
/** Separators and icon glyphs — "·", "→", "—" — are decoration, not copy. */
const PUNCTUATION_ONLY = /^[\p{P}\p{S}\s]+$/u;

/**
 * Literal copy a component renders unconditionally, ready to be asserted on
 * with Testing-Library's getByText.
 *
 * Everything here exists to keep a false positive out of a generated spec: text
 * that only sometimes renders (a ternary branch, a `.map` row, a guard path)
 * produces a spec that fails on someone's CI for no reason, which is worse than
 * emitting no assertion at all. Purely syntactic — no type checker.
 */
export function extractStaticText(bodyNode: ts.Node): string[] {
  const root = happyPathReturnExpression(bodyNode);
  if (!root) return [];
  // Only the unconditional tail return renders on the happy path. An early
  // `if (!x) return null` guard is deliberately not a root.
  if (!ts.isJsxElement(root) && !ts.isJsxSelfClosingElement(root) && !ts.isJsxFragment(root)) {
    return [];
  }

  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    const text = literalText(n);
    if (text !== undefined && isUnconditional(n, root) && isSoleRenderedChild(n)) {
      found.push(text);
    }
    ts.forEachChild(n, visit);
  };
  visit(root);

  return normalise(found);
}

/** JSX text, or an expression container holding nothing but a string literal. */
function literalText(n: ts.Node): string | undefined {
  if (ts.isJsxText(n)) return n.text;
  if (ts.isJsxExpression(n) && n.expression) {
    const expr = n.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  }
  return undefined;
}

/** No branch, loop, callback, call argument or attribute stands between root and node. */
function isUnconditional(node: ts.Node, root: ts.Node): boolean {
  for (let p = node.parent; p && p !== root; p = p.parent) {
    if (isBranchingAncestor(p)) return false;
  }
  return true;
}

function isBranchingAncestor(n: ts.Node): boolean {
  if (ts.isConditionalExpression(n)) return true;
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    return (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    );
  }
  if (ts.isIfStatement(n) || ts.isSwitchStatement(n) || ts.isCaseClause(n)) return true;
  if (ts.isIterationStatement(n, false)) return true;
  // A callback body renders per item or not at all: `.map` rows, render props.
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) {
    return true;
  }
  // Any call argument, which covers `.map(...)`, `t("Save")` and `cn("btn")`:
  // the call decides whether and how its argument reaches the DOM.
  if (ts.isCallExpression(n)) return true;
  // aria-label / title / placeholder text is not the element's text content.
  return ts.isJsxAttribute(n);
}

/**
 * getByText matches an element's WHOLE normalised text content, so a text node
 * is only assertable when it is its parent element's only rendered child. In
 * `<p>From <em>Asha</em></p>` the DOM holds no element whose text is "From" —
 * the <p> reads "From Asha" — so asserting on "From" fails at runtime; only
 * "Asha", the sole child of <em>, is safe to emit.
 */
function isSoleRenderedChild(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isJsxElement(parent)) return false;
  const rendered = parent.children.filter((child) => !isLayoutWhitespace(child));
  return rendered.length === 1 && rendered[0] === node;
}

/** Indentation between JSX children; React drops it, so it is not a sibling. */
function isLayoutWhitespace(child: ts.JsxChild): boolean {
  return ts.isJsxText(child) && child.text.trim() === "";
}

function normalise(found: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of found) {
    const text = value.replace(/\s+/g, " ").trim();
    if (text.length < MIN_LENGTH) continue;
    if (PUNCTUATION_ONLY.test(text)) continue;
    // A brace survived into the literal (`{"{count} items"}`), meaning the copy
    // is a template the runtime fills in — the rendered text differs.
    if (text.includes("{") || text.includes("}")) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length === MAX_TEXTS) break;
  }
  return out;
}
