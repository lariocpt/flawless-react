import ts from "typescript";
import type { PropValue, StateInfo } from "../types.ts";

/**
 * Which JSX a component actually renders at the props and state a generated spec
 * gives it, and whether a given node inside that JSX is reached.
 *
 * The problem this solves: extractRootTag, extractStaticText and
 * extractRenderMode all described a component by the LAST return in its body. A
 * component that opens with `const [open] = useState(false)` and
 * `if (!open) return <Trigger/>` renders the trigger — but every assertion was
 * derived from the expanded branch below it, describing markup the spec never
 * produces. In the dogfood app that was twelve red tests in two files.
 *
 * The rule is asymmetric on purpose:
 *
 *   - A guard we CAN decide is followed exactly. That is new evidence, and it
 *     makes the analysis strictly more accurate.
 *   - A guard we CANNOT decide falls through to the tail return, which is what
 *     every consumer did before this module existed. Bailing there would delete
 *     working assertions from components that pass today, trading real coverage
 *     for no correctness gain — so the result is flagged `guarded` instead and
 *     the caller decides.
 *
 * Purely syntactic. `evaluate` handles a deliberately closed set of expressions
 * and returns undefined — meaning "unknown", which propagates — for everything
 * else. There is no type checker here and no attempt to model JavaScript.
 */

export interface RenderEnv {
  /** Prop name → the value the spec will pass. */
  props: Map<string, PropValue>;
  /** useState variable / local const → its initial value. */
  state: Map<string, PropValue>;
  /** Names that exist but whose value is not knowable. */
  opaque: Set<string>;
}

export type Verdict = "yes" | "no" | "unknown";

export interface InitialRender {
  expr: ts.Expression;
  /**
   * True when an undecidable early return stands between the component's entry
   * and this expression, so it is the best guess rather than a certainty.
   */
  guarded: boolean;
  /**
   * The env as it stood at the render, with every local const folded in. Pass
   * THIS to reachability, not the env you started with — otherwise a condition
   * like `boosted` (declared two lines above the JSX) reads as unknown and every
   * node behind it becomes undecidable.
   */
  scope: RenderEnv;
}

export function emptyEnv(): RenderEnv {
  return { props: new Map(), state: new Map(), opaque: new Set() };
}

export function makeEnv(
  props: Record<string, PropValue>,
  unresolvedProps: string[],
  state: StateInfo[],
): RenderEnv {
  const env = emptyEnv();
  for (const [k, v] of Object.entries(props)) env.props.set(k, v);
  // A prop whose type could not be resolved is passed as undefined, so it exists
  // but decides nothing.
  for (const name of unresolvedProps) env.opaque.add(name);
  for (const s of state) {
    if (s.initialValue !== undefined) env.state.set(s.varName, s.initialValue);
    else env.opaque.add(s.varName);
  }
  return env;
}

// ---------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------

/**
 * A literal-composable expression's value, or undefined for "unknown".
 *
 * Unknown propagates: any operand we cannot value makes the whole expression
 * unknown, except where a short-circuit operator has already been decided by the
 * operand we do know.
 */
export function evaluate(expr: ts.Expression, env: RenderEnv): PropValue | undefined {
  const node = unwrap(expr);

  const literal = literalToValue(node);
  if (literal !== undefined) return literal;

  if (ts.isIdentifier(node)) {
    if (node.text === "undefined") return undefined;
    if (env.opaque.has(node.text)) return undefined;
    // has(), not ??: a stored null must not fall through to the props map.
    if (env.state.has(node.text)) return env.state.get(node.text);
    if (env.props.has(node.text)) return env.props.get(node.text);
    return undefined;
  }

  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = evaluate(node.operand, env);
    return inner === undefined ? undefined : !truthy(inner);
  }

  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const target = evaluate(node.expression, env);
    if (target === undefined) return undefined;
    if (node.name.text === "length") {
      if (Array.isArray(target)) return target.length;
      if (typeof target === "string") return target.length;
      return undefined;
    }
    if (target !== null && typeof target === "object" && !Array.isArray(target)) {
      return (target as { [k: string]: PropValue })[node.name.text];
    }
    return undefined;
  }

  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    if (node.expression.text === "Boolean" && node.arguments.length === 1) {
      const arg = evaluate(node.arguments[0] as ts.Expression, env);
      return arg === undefined ? undefined : truthy(arg);
    }
    return undefined;
  }

  if (ts.isBinaryExpression(node)) return evaluateBinary(node, env);

  return undefined;
}

function evaluateBinary(node: ts.BinaryExpression, env: RenderEnv): PropValue | undefined {
  const op = node.operatorToken.kind;

  // Short-circuit operators can resolve from the left operand alone.
  // An unknown operand does not always make the result unknown: `x || true` is
  // true whatever x is, and `x && false` is false. Bailing on the left operand
  // alone left `disabled={pending || picked.length === 0}` undecidable — with
  // `picked` starting as [] the control is disabled at mount, and clicking it
  // cost a full 30-second Playwright timeout.
  if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
    const left = evaluate(node.left, env);
    if (left !== undefined && !truthy(left)) return left;
    const right = evaluate(node.right, env);
    if (left !== undefined) return right;
    // Left unknown: only a falsy right settles it, and && yields that operand.
    return right !== undefined && !truthy(right) ? right : undefined;
  }
  if (op === ts.SyntaxKind.BarBarToken) {
    const left = evaluate(node.left, env);
    if (left !== undefined && truthy(left)) return left;
    const right = evaluate(node.right, env);
    if (left !== undefined) return right;
    return right !== undefined && truthy(right) ? right : undefined;
  }
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    const left = evaluate(node.left, env);
    if (left === undefined) return undefined;
    return left === null ? evaluate(node.right, env) : left;
  }

  const left = evaluate(node.left, env);
  const right = evaluate(node.right, env);
  if (left === undefined || right === undefined) return undefined;

  if (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    const same = sameValue(left, right);
    // Guard the negation: `!undefined` is true, which would turn "cannot tell"
    // into a confident "not equal".
    if (same === undefined) return undefined;
    return op === ts.SyntaxKind.EqualsEqualsEqualsToken ? same : !same;
  }

  // Ordering comparisons are only meaningful between numbers; anything else
  // (string collation, date coercion) is not worth modelling.
  if (typeof left !== "number" || typeof right !== "number") return undefined;
  switch (op) {
    case ts.SyntaxKind.LessThanToken:
      return left < right;
    case ts.SyntaxKind.LessThanEqualsToken:
      return left <= right;
    case ts.SyntaxKind.GreaterThanToken:
      return left > right;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      return left >= right;
    default:
      return undefined;
  }
}

/** Reference equality for objects and arrays is never decidable from syntax. */
function sameValue(a: PropValue, b: PropValue): boolean | undefined {
  if (a !== null && typeof a === "object") return undefined;
  if (b !== null && typeof b === "object") return undefined;
  return a === b;
}

export function truthy(v: PropValue): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  // Arrays and objects are always truthy in JS, empty or not.
  return true;
}

/** Literal-composable expression → PropValue; anything dynamic → undefined. */
export function literalToValue(expr: ts.Expression): PropValue | undefined {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (isNegativeNumber(expr)) return -Number((expr.operand as ts.NumericLiteral).text);
  if (ts.isArrayLiteralExpression(expr)) {
    const items: PropValue[] = [];
    for (const el of expr.elements) {
      const v = literalToValue(el);
      if (v === undefined) return undefined;
      items.push(v);
    }
    return items;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const obj: { [k: string]: PropValue } = {};
    for (const prop of expr.properties) {
      if (!ts.isPropertyAssignment(prop)) return undefined;
      const key =
        ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
      if (key === undefined) return undefined;
      const v = literalToValue(prop.initializer);
      if (v === undefined) return undefined;
      obj[key] = v;
    }
    return obj;
  }
  return undefined;
}

function isNegativeNumber(expr: ts.Expression): expr is ts.PrefixUnaryExpression {
  return (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  );
}

// ---------------------------------------------------------------------------
// initialRenderExpression
// ---------------------------------------------------------------------------

/**
 * The JSX the component yields on its first render with `env`'s values.
 *
 * Walks the body in statement order so an early return that we can prove is
 * taken wins over the tail return. Local `const`s are folded into the env as we
 * pass them, which is what lets `const show = weight > 1` decide a guard below
 * it without any special-casing.
 */
export function initialRenderExpression(
  bodyNode: ts.Node,
  env: RenderEnv,
): InitialRender | undefined {
  const fn = bodyNode as ts.FunctionLikeDeclaration;
  const body = fn.body;
  if (!body) return undefined;
  if (!ts.isBlock(body)) return { expr: unwrap(body), guarded: false, scope: env };

  // Cloned so folding locals never leaks back into the caller's env.
  const scope: RenderEnv = {
    props: env.props,
    state: new Map(env.state),
    opaque: new Set(env.opaque),
  };
  let guarded = false;

  for (const stmt of body.statements) {
    if (ts.isVariableStatement(stmt)) {
      foldLocals(stmt, scope);
      continue;
    }

    if (ts.isReturnStatement(stmt)) {
      return stmt.expression ? { expr: unwrap(stmt.expression), guarded, scope } : undefined;
    }

    if (ts.isIfStatement(stmt)) {
      const taken = evaluate(stmt.expression, scope);
      if (taken === undefined) {
        // Undecidable. If the guard renders nothing we can still describe the
        // tail; if it renders content, no single answer describes the component.
        const bail = returnedExpression(stmt.thenStatement);
        if (bail && !rendersNothing(bail)) return undefined;
        guarded = true;
        continue;
      }
      const branch = truthy(taken) ? stmt.thenStatement : stmt.elseStatement;
      if (!branch) continue;
      const returned = returnedExpression(branch);
      if (returned) return { expr: unwrap(returned), guarded, scope };
      // A taken branch that does not return (a side effect, a throw) leaves the
      // walk to continue; a throw is not a render we can describe.
      if (containsThrow(branch)) return undefined;
    }

    // Anything else — an expression statement, a hook call — does not change
    // which JSX comes back.
  }

  return undefined;
}

/** `const x = <literal>` folded into scope; anything dynamic becomes opaque. */
function foldLocals(stmt: ts.VariableStatement, scope: RenderEnv): void {
  for (const decl of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name)) continue;
    const value = decl.initializer ? evaluate(decl.initializer, scope) : undefined;
    if (value === undefined) {
      scope.opaque.add(decl.name.text);
      scope.state.delete(decl.name.text);
    } else {
      scope.opaque.delete(decl.name.text);
      scope.state.set(decl.name.text, value);
    }
  }
}

/** The expression of a `return` that is the whole branch, if there is one. */
function returnedExpression(branch: ts.Statement): ts.Expression | undefined {
  if (ts.isReturnStatement(branch)) return branch.expression;
  if (ts.isBlock(branch)) {
    for (const s of branch.statements) {
      if (ts.isReturnStatement(s)) return s.expression;
    }
  }
  return undefined;
}

function containsThrow(branch: ts.Statement): boolean {
  if (ts.isThrowStatement(branch)) return true;
  if (ts.isBlock(branch)) return branch.statements.some((s) => ts.isThrowStatement(s));
  return false;
}

function rendersNothing(expr: ts.Expression): boolean {
  const node = unwrap(expr);
  if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return true;
  }
  return ts.isIdentifier(node) && node.text === "undefined";
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

/**
 * Whether `node` is rendered when the component renders `root`.
 *
 * "no" beats "unknown": one ancestor proving the node is on an untaken branch
 * settles it regardless of what the others say.
 */
export function reachability(node: ts.Node, root: ts.Node, env: RenderEnv): Verdict {
  let sawUnknown = false;

  for (let child = node, p = node.parent; p && child !== root; child = p, p = p.parent) {
    const verdict = stepVerdict(child, p, env);
    if (verdict === "no") return "no";
    if (verdict === "unknown") sawUnknown = true;
  }

  return sawUnknown ? "unknown" : "yes";
}

function stepVerdict(child: ts.Node, parent: ts.Node, env: RenderEnv): Verdict {
  if (ts.isConditionalExpression(parent)) {
    if (child === parent.condition) return "yes";
    const cond = evaluate(parent.condition, env);
    if (cond === undefined) return "unknown";
    const takenBranch = truthy(cond) ? parent.whenTrue : parent.whenFalse;
    return child === takenBranch ? "yes" : "no";
  }

  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    const shortCircuit =
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken;
    if (!shortCircuit) return "yes";
    if (child === parent.left) return "yes";
    const left = evaluate(parent.left, env);
    if (left === undefined) return "unknown";
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return truthy(left) ? "yes" : "no";
    if (op === ts.SyntaxKind.BarBarToken) return truthy(left) ? "no" : "yes";
    return left === null ? "yes" : "no";
  }

  if (ts.isIfStatement(parent)) {
    if (child === parent.expression) return "yes";
    const cond = evaluate(parent.expression, env);
    if (cond === undefined) return "unknown";
    const takenBranch = truthy(cond) ? parent.thenStatement : parent.elseStatement;
    return child === takenBranch ? "yes" : "no";
  }

  // A row count is never knowable from syntax, and a callback body may not run
  // at all — a render prop, an event handler, a `.map` over an empty array.
  if (ts.isIterationStatement(parent, false)) return "unknown";
  if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) return "unknown";
  if (ts.isFunctionDeclaration(parent)) return "unknown";
  // The call decides whether and how its argument reaches the DOM.
  if (ts.isCallExpression(parent) && child !== parent.expression) return "unknown";
  if (ts.isSwitchStatement(parent) || ts.isCaseClause(parent)) return "unknown";

  return "yes";
}

export function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}
