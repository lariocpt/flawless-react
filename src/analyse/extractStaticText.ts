import ts from "typescript";
import { emptyEnv, initialRenderExpression, type RenderEnv, reachability } from "./renderPath.ts";

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
export function extractStaticText(bodyNode: ts.Node, env: RenderEnv = emptyEnv()): string[] {
  // The JSX this component renders FIRST, which is not always the tail return —
  // a guard we can decide points somewhere else entirely.
  const initial = initialRenderExpression(bodyNode, env);
  if (!initial) return [];
  const root = initial.expr;
  if (!ts.isJsxElement(root) && !ts.isJsxSelfClosingElement(root) && !ts.isJsxFragment(root)) {
    return [];
  }

  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    const text = literalText(n);
    if (
      text !== undefined &&
      reachability(n, root, initial.scope) === "yes" &&
      !underJsxAttribute(n, root) &&
      isSoleRenderedChild(n)
    ) {
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

/**
 * aria-label / title / placeholder text is not the element's text content, so
 * getByText will never find it. reachability has nothing to say about this —
 * the attribute IS rendered, just not as copy.
 */
function underJsxAttribute(node: ts.Node, root: ts.Node): boolean {
  for (let p = node.parent; p && p !== root; p = p.parent) {
    if (ts.isJsxAttribute(p)) return true;
  }
  return false;
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

/**
 * Literal copy in the branch an error boundary renders once it has caught.
 *
 * extractStaticText walks the INITIAL render, and an error boundary has none —
 * its render branches on `this.state`, which is exactly why the whole component
 * refuses. But this branch is not undecidable in the way the others are: React's
 * own contract says getDerivedStateFromError puts the component into that state,
 * so a spec reaches it by rendering a child that throws.
 *
 * The branch is the consequent of the first `if` whose condition reads
 * `this.state`. Anything else — a guard on props, a loading flag — is not the
 * error branch and is left alone.
 */
export function errorFallbackText(renderBody: ts.Node): string[] {
  let branch: ts.Node | undefined;
  const find = (n: ts.Node): void => {
    if (branch) return;
    if (ts.isIfStatement(n) && readsThisState(n.expression)) {
      branch = n.thenStatement;
      return;
    }
    ts.forEachChild(n, find);
  };
  find(renderBody);
  if (!branch) return [];
  const out: string[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      const t = n.text.trim();
      if (t) out.push(t);
    }
    ts.forEachChild(n, collect);
  };
  collect(branch);
  return [...new Set(out)];
}

/** `this.state` / `this.state.x` anywhere in an expression. */
function readsThisState(expr: ts.Expression): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ThisKeyword &&
      n.name.text === "state"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(expr);
  return found;
}
