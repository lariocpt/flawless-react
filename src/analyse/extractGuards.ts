import ts from "typescript";
import type { GuardEffect, GuardInfo, GuardOperandTrigger } from "../types.ts";
import type { ImportBinding } from "./parseFile.ts";
import { posOf } from "./pos.ts";
import { bodyStatements, collectRefs, hookCalleeName } from "./refs.ts";

const NAV_SPECIFIER = "next/navigation";
const CONDITION_RAW_MAX = 80;

/** Only these leave the render early in a way a spec can assert on. */
const NAV_EFFECTS = new Set<string>([
  "notFound",
  "redirect",
  "permanentRedirect",
  "unauthorized",
  "forbidden",
]);

/**
 * Early-exit guards at the top of a component body: `if (!building) notFound()`.
 *
 * Purely syntactic and deliberately narrow. Only top-level IfStatements count —
 * a guard nested inside another branch fires under conditions this analyser
 * cannot reconstruct, so the emitted spec would assert a throw that never
 * happens. Everything the classifier cannot name is reported as "complex" with
 * no triggerValue rather than approximated: a wrong trigger produces a failing
 * test in someone's repo, which is worse than emitting no assertion at all.
 */
export function extractGuards(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  imports: Map<string, ImportBinding>,
  depVarNames: Set<string>,
): GuardInfo[] {
  const out: GuardInfo[] = [];

  for (const stmt of bodyStatements(bodyNode)) {
    if (!ts.isIfStatement(stmt)) continue;
    const effect = classifyEffect(stmt.thenStatement, imports);
    if (!effect) continue;

    const condition = classifyCondition(stmt.expression, sourceFile, depVarNames);
    const guard: GuardInfo = {
      effect: effect.effect,
      callee: effect.callee,
      conditionRaw: rawCondition(stmt.expression, sourceFile),
      conditionKind: condition.kind,
      depVars: condition.depVars,
      pos: posOf(stmt, sourceFile),
    };
    if (effect.specifier !== undefined) guard.specifier = effect.specifier;
    if (effect.throwMessage !== undefined) guard.throwMessage = effect.throwMessage;
    if (condition.triggerValue !== undefined) guard.triggerValue = condition.triggerValue;
    if (condition.operandTriggers !== undefined) guard.operandTriggers = condition.operandTriggers;
    out.push(guard);
  }

  return out;
}

/**
 * Whether this if-statement's branch aborts the render the way a guard does —
 * the same classification extractGuards applies, exposed so the fixture side
 * can reason about comparison polarity: inside `if (cond) notFound()`, a
 * fixture that makes `cond` true renders nothing.
 */
export function isGuardExit(stmt: ts.IfStatement, imports: Map<string, ImportBinding>): boolean {
  return classifyEffect(stmt.thenStatement, imports) !== undefined;
}

// ---------------------------------------------------------------------------
// Effect
// ---------------------------------------------------------------------------

interface EffectMatch {
  effect: GuardEffect;
  callee: string;
  specifier?: string;
  throwMessage?: string;
}

function classifyEffect(
  thenStatement: ts.Statement,
  imports: Map<string, ImportBinding>,
): EffectMatch | undefined {
  const stmt = soleStatement(thenStatement);
  if (!stmt) return undefined;

  // A throw needs no provenance check: whatever it constructs, the render aborts.
  if (ts.isThrowStatement(stmt)) {
    const match: EffectMatch = { effect: "throw", callee: throwCallee(stmt) };
    const message = throwMessage(stmt);
    if (message !== undefined) match.throwMessage = message;
    return match;
  }

  const call = exitCall(stmt);
  if (!call) return undefined;
  // A qualified callee (`nav.notFound()`) is not proof of anything — the
  // namespace could be any module — so only a bare identifier is accepted.
  if (!ts.isIdentifier(call.expression)) return undefined;
  const name = call.expression.text;
  if (!NAV_EFFECTS.has(name)) return undefined;

  // The whole point of the check: a project-local `notFound()` that renders a
  // fallback would make an emitted "throws NEXT_NOT_FOUND" assertion a lie.
  const binding = imports.get(name);
  if (!binding || binding.specifier !== NAV_SPECIFIER) return undefined;
  if (binding.isTypeOnly || binding.kind !== "named") return undefined;
  // `import { redirect as notFound }` binds a name that means something else.
  if (binding.importedName !== undefined && binding.importedName !== name) return undefined;

  return { effect: name as GuardEffect, callee: name, specifier: NAV_SPECIFIER };
}

/**
 * The single statement a guard branch may contain. A block holding anything
 * beyond the exit does work the scaffolded spec would not reproduce, so it is
 * not treated as a guard.
 */
function soleStatement(stmt: ts.Statement): ts.Statement | undefined {
  if (!ts.isBlock(stmt)) return stmt;
  return stmt.statements.length === 1 ? stmt.statements[0] : undefined;
}

function exitCall(stmt: ts.Statement): ts.CallExpression | undefined {
  if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
    return stmt.expression;
  }
  if (ts.isReturnStatement(stmt) && stmt.expression && ts.isCallExpression(stmt.expression)) {
    return stmt.expression;
  }
  return undefined;
}

function throwCallee(stmt: ts.ThrowStatement): string {
  const expr = stmt.expression;
  if (ts.isNewExpression(expr) || ts.isCallExpression(expr)) {
    return hookCalleeName(expr.expression) ?? "throw";
  }
  return "throw";
}

/**
 * The message a thrown error carries, only when the source states it with a
 * string literal: `throw new Error("…")` (any error constructor — the
 * matcher checks the message, not the class) and a bare `throw "…"`. An
 * interpolated template or an expression says nothing readable, so undefined
 * — the emitted assertion then stays bare rather than invented.
 */
function throwMessage(stmt: ts.ThrowStatement): string | undefined {
  const expr = stmt.expression;
  if (ts.isNewExpression(expr)) {
    const args = expr.arguments;
    const arg = args === undefined ? undefined : args[0];
    if (arg !== undefined && ts.isStringLiteral(arg)) return arg.text;
    return undefined;
  }
  if (ts.isStringLiteral(expr)) return expr.text;
  return undefined;
}

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

interface ConditionMatch {
  kind: GuardInfo["conditionKind"];
  depVars: string[];
  triggerValue?: GuardInfo["triggerValue"];
  operandTriggers?: GuardOperandTrigger[];
}

function classifyCondition(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  depVarNames: Set<string>,
): ConditionMatch {
  const depVars = referencedDeps(expr, sourceFile, depVarNames);
  const shape = classifyShape(expr, sourceFile, depVarNames);
  const match: ConditionMatch = { kind: shape.kind, depVars, triggerValue: shape.triggerValue };
  if (shape.operandTriggers !== undefined) match.operandTriggers = shape.operandTriggers;
  return match;
}

type ShapeMatch = {
  kind: GuardInfo["conditionKind"];
  triggerValue?: GuardInfo["triggerValue"];
  operandTriggers?: GuardOperandTrigger[];
};

function classifyShape(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  depVarNames: Set<string>,
): ShapeMatch {
  const node = unwrapParens(expr);

  if (ts.isIdentifier(node)) return { kind: "truthy" };

  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = unwrapParens(node.operand);
    if (ts.isIdentifier(operand)) return { kind: "falsy", triggerValue: "undefined" };
    if (isLengthOfIdentifier(operand)) return { kind: "falsy", triggerValue: "empty-array" };
    return { kind: "complex" };
  }

  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken)
      return classifyLogical(node, sourceFile, depVarNames, true);
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return classifyLogical(node, sourceFile, depVarNames, false);
    }
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      return { kind: "comparison", triggerValue: strictEqualityTrigger(node) };
    }
    // `==` is loose equality: the one loose comparison that names a single
    // mock value is `x == null`, which fires on null AND undefined — "null"
    // is the canonical trigger. `x == undefined` is the looseness itself.
    if (op === ts.SyntaxKind.EqualsEqualsToken) {
      return { kind: "comparison", triggerValue: looseNullTrigger(node) };
    }
    // `!==`, `<` … are recognisably comparisons, but none of them names a
    // single mock value that makes the guard fire, so no trigger is invented.
    if (isComparisonOperator(op)) return { kind: "comparison" };
  }

  return { kind: "complex" };
}

/**
 * OR: the guard fires when ANY operand fires. A left-associative chain
 * (`a || b || c`) parses as `(a || b) || c` — it is flattened so the operand
 * list is what a reader sees, and each operand keeps its own match: the
 * consolidated trigger survives only when every operand fires on the same
 * mocked value of the same single dep, which is the stricter bar no single
 * operand needs — that gap is what `operandTriggers` fills (D1 item 5).
 *
 * AND is the other polarity: one value must satisfy EVERY operand, so the
 * old rule stands unchanged and no operand list is recorded — a dep flip
 * that satisfied one AND operand while breaking another would be a lie.
 */
function classifyLogical(
  node: ts.BinaryExpression,
  sourceFile: ts.SourceFile,
  depVarNames: Set<string>,
  isOr: boolean,
): ShapeMatch {
  if (!isOr) {
    const left = classifyCondition(node.left, sourceFile, depVarNames);
    const right = classifyCondition(node.right, sourceFile, depVarNames);
    const sameDep =
      left.depVars.length === 1 &&
      right.depVars.length === 1 &&
      left.depVars[0] === right.depVars[0];
    const sameTrigger = left.triggerValue !== undefined && left.triggerValue === right.triggerValue;
    if (sameDep && sameTrigger) return { kind: "complex", triggerValue: left.triggerValue };
    return { kind: "complex" };
  }

  const operands: ts.Expression[] = [];
  const collect = (expr: ts.Expression): void => {
    const n = unwrapParens(expr);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      collect(n.left);
      collect(n.right);
      return;
    }
    operands.push(n);
  };
  collect(node);

  const operandTriggers: GuardOperandTrigger[] = [];
  for (const operand of operands) {
    const m = classifyCondition(operand, sourceFile, depVarNames);
    const op: GuardOperandTrigger = { depVars: m.depVars };
    if (m.triggerValue !== undefined) op.triggerValue = m.triggerValue;
    op.raw = rawCondition(operand, sourceFile);
    operandTriggers.push(op);
  }

  // An OR binary expression always flattens to >= 2 leaves — the bail is an
  // impossible-shape guard so `first` is total, not a claim.
  const first = operandTriggers[0];
  if (first === undefined) return { kind: "complex" };
  const sameDep =
    first.depVars.length === 1 &&
    operandTriggers.every((op) => op.depVars.length === 1 && op.depVars[0] === first.depVars[0]);
  const sameTrigger =
    first.triggerValue !== undefined &&
    operandTriggers.every((op) => op.triggerValue === first.triggerValue);
  const match: ShapeMatch = { kind: "complex", operandTriggers };
  if (sameDep && sameTrigger) match.triggerValue = first.triggerValue;
  return match;
}

/**
 * The one loose comparison that names a single mock value: `x == null`
 * fires on null AND undefined, and a dep returning null trips it, so "null"
 * is the canonical trigger. `x == undefined` is the looseness itself and
 * names no canonical value.
 */
function looseNullTrigger(node: ts.BinaryExpression): GuardInfo["triggerValue"] | undefined {
  const pairs: Array<[ts.Expression, ts.Expression]> = [
    [node.left, node.right],
    [node.right, node.left],
  ];
  for (const [subject, literal] of pairs) {
    const target = unwrapParens(subject);
    const value = unwrapParens(literal);
    if (ts.isIdentifier(target) && value.kind === ts.SyntaxKind.NullKeyword) return "null";
  }
  return undefined;
}

function strictEqualityTrigger(node: ts.BinaryExpression): GuardInfo["triggerValue"] | undefined {
  const pairs: Array<[ts.Expression, ts.Expression]> = [
    [node.left, node.right],
    [node.right, node.left],
  ];
  for (const [subject, literal] of pairs) {
    const target = unwrapParens(subject);
    const value = unwrapParens(literal);
    if (ts.isIdentifier(target)) {
      if (value.kind === ts.SyntaxKind.NullKeyword) return "null";
      if (ts.isIdentifier(value) && value.text === "undefined") return "undefined";
    }
    if (isLengthOfIdentifier(target) && ts.isNumericLiteral(value) && value.text === "0") {
      return "empty-array";
    }
  }
  return undefined;
}

function isComparisonOperator(op: ts.SyntaxKind): boolean {
  return (
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken ||
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken
  );
}

/** `x.length` on a bare identifier. `a.b.length` stays complex — `a` alone says nothing. */
function isLengthOfIdentifier(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.name.text === "length"
  );
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function referencedDeps(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  depVarNames: Set<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of collectRefs(expr, sourceFile, depVarNames, undefined)) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    out.push(ref.name);
  }
  return out;
}

function rawCondition(expr: ts.Expression, sourceFile: ts.SourceFile): string {
  return expr.getText(sourceFile).replace(/\s+/g, " ").trim().slice(0, CONDITION_RAW_MAX);
}
