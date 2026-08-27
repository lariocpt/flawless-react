import ts from "typescript";
import type { DataDepInfo, MockField, MockShape } from "../types.ts";
import type { ImportBinding } from "./parseFile.ts";
import { posOf } from "./pos.ts";
import { bodyStatements, collectRefs } from "./refs.ts";

/**
 * Infers what an async server component awaits and the shape each awaited
 * value has to be mocked with. The caller decides whether the component is an
 * async server component; this extractor never checks.
 *
 * Purely syntactic (no ts.Program, no checker), so every rule below carries an
 * explicit give-up condition. A wrong shape produces a generated spec that
 * fails against correct code — strictly worse than admitting defeat, which is
 * what `uncertain: true` is for.
 */

/**
 * Callee roots that are never a module boundary worth mocking. `Promise` earns
 * its place for a specific reason: `await Promise.all(members.map(...))` is
 * derived from a dep that was already recorded one line above, so recording it
 * again would ask the caller to mock a value that crosses no module edge.
 */
const SKIP_CALLEE_ROOTS = new Set([
  "Promise",
  "JSON",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Math",
  "Date",
]);

/** Members that prove a value is an array without naming a data field. */
const ARRAY_METHODS = new Set(["map", "filter", "forEach", "find", "slice", "some", "every"]);

/** String methods that prove the receiver is a string rather than an object. */
const STRING_METHODS = new Set([
  "toLowerCase",
  "toUpperCase",
  "trim",
  "split",
  "startsWith",
  "endsWith",
  "includes",
  "replace",
  "replaceAll",
  "padStart",
  "padEnd",
  "charAt",
  "substring",
  "toLocaleDateString",
  "toLocaleTimeString",
  "toISOString",
]);

type FieldKind = "string" | "number" | "date-string" | "array" | "object" | "unknown";

interface FieldNote {
  kinds: Set<FieldKind>;
  rendersAsText: boolean;
  /** Fields read off this one, when it turned out to hold an object. */
  nested?: FieldNotes;
  /** A literal the component compares this field against — see MockField. */
  equals?: string | number | boolean;
  /** A prop path the component compares this field against — see MockField. */
  equalsProp?: string[];
}

type FieldNotes = Map<string, FieldNote>;

export function extractDataDeps(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  imports: Map<string, ImportBinding>,
): DataDepInfo[] {
  const out: DataDepInfo[] = [];
  // Top-level statements only. A call nested in a branch or a closure runs
  // conditionally, so a mock for it would have to fire on paths that never
  // reach it — and we cannot tell which paths those are without a checker.
  for (const stmt of bodyStatements(bodyNode)) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      const parallel = buildPromiseAllDeps(decl, bodyNode, sourceFile, imports);
      if (parallel) {
        out.push(...parallel);
        continue;
      }
      const dep = buildDep(decl, bodyNode, sourceFile, imports);
      if (dep) out.push(dep);
    }
  }
  return out;
}

/**
 * `const [a, b] = await Promise.all([f(), g()])` — one dependency per element.
 *
 * buildDep bails on this twice over: "Promise" is a skipped callee root, and the
 * binding is an array pattern rather than an identifier. So both f and g got a
 * bare vi.fn() returning undefined, and the component crashed on `a.length` with
 * an error that named neither call.
 *
 * Position i of the array literal pairs with binding i. Anything that breaks
 * that correspondence — a spread, an omitted slot, a rest element, a non-call
 * element — returns undefined so the caller falls back to the single-dep path.
 */
function buildPromiseAllDeps(
  decl: ts.VariableDeclaration,
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  imports: Map<string, ImportBinding>,
): DataDepInfo[] | undefined {
  if (!ts.isArrayBindingPattern(decl.name)) return undefined;
  const init = decl.initializer;
  if (!init || !ts.isAwaitExpression(init)) return undefined;
  const call = init.expression;
  if (!ts.isCallExpression(call)) return undefined;
  const callee = dottedName(call.expression);
  if (callee?.text !== "Promise.all") return undefined;

  const arg = call.arguments[0];
  if (!arg || !ts.isArrayLiteralExpression(arg)) return undefined;
  const elements = decl.name.elements;
  if (elements.length !== arg.elements.length) return undefined;

  const out: DataDepInfo[] = [];
  for (const [i, binding] of elements.entries()) {
    if (!ts.isBindingElement(binding) || binding.dotDotDotToken) return undefined;
    if (!ts.isIdentifier(binding.name)) return undefined;
    const element = arg.elements[i];
    if (!element || !ts.isCallExpression(element)) return undefined;
    const elementCallee = dottedName(element.expression);
    if (!elementCallee || SKIP_CALLEE_ROOTS.has(elementCallee.root)) return undefined;

    const varName = binding.name.text;
    const inferred = inferShape(varName, bodyNode, sourceFile);
    const specifier = imports.get(elementCallee.root)?.specifier;
    out.push({
      varName,
      callee: elementCallee.text,
      calleeRoot: elementCallee.root,
      ...(specifier !== undefined ? { specifier } : {}),
      awaited: true,
      pos: posOf(decl, sourceFile),
      shape: inferred.shape,
      uncertain: inferred.uncertain,
    });
  }
  return out;
}

function buildDep(
  decl: ts.VariableDeclaration,
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  imports: Map<string, ImportBinding>,
): DataDepInfo | undefined {
  const init = decl.initializer;
  if (!init) return undefined;

  const awaited = ts.isAwaitExpression(init);
  const source = awaited ? init.expression : init;
  // `await x` counts even when x is not a call (a promise-valued prop such as
  // Next.js `params`); a *non*-awaited bare identifier is only an alias and
  // crosses no boundary, so it is not a dependency.
  const calleeExpr = ts.isCallExpression(source) ? source.expression : awaited ? source : undefined;
  if (!calleeExpr) return undefined;

  // Computed callees (`handlers[kind]()`, `(cond ? a : b)()`) have no stable
  // name for a mock to attach to.
  const callee = dottedName(calleeExpr);
  if (!callee) return undefined;
  if (SKIP_CALLEE_ROOTS.has(callee.root)) return undefined;

  // Absent for a helper declared in this same file — still worth recording, as
  // the caller may stub it another way.
  const specifier = imports.get(callee.root)?.specifier;
  const common = {
    callee: callee.text,
    calleeRoot: callee.root,
    ...(specifier !== undefined ? { specifier } : {}),
    awaited,
    pos: posOf(decl, sourceFile),
  };

  if (ts.isObjectBindingPattern(decl.name)) {
    // The destructured keys *are* the shape. Their own value shapes are left
    // unknown: each key is a separate binding, and chasing them would attribute
    // a shadowed reference to the wrong value.
    return {
      varName: undefined,
      ...common,
      shape: { kind: "object", fields: bindingPatternFields(decl.name) },
      uncertain: false,
    };
  }
  // An array binding pattern (`const [a, b] = await ...`) names positions, not
  // keys, and we have nothing to say about element count or order.
  if (!ts.isIdentifier(decl.name)) return undefined;

  const varName = decl.name.text;
  const inferred = inferShape(varName, bodyNode, sourceFile);
  return { varName, ...common, shape: inferred.shape, uncertain: inferred.uncertain };
}

function bindingPatternFields(pattern: ts.ObjectBindingPattern): MockField[] {
  const fields: MockField[] = [];
  for (const el of pattern.elements) {
    // `{ ...rest }` names no key; the keys listed beside it are still real, so
    // the element is skipped rather than the whole dependency dropped.
    if (el.dotDotDotToken) continue;
    const key = el.propertyName ?? el.name;
    const name = ts.isIdentifier(key)
      ? key.text
      : ts.isStringLiteral(key)
        ? key.text
        : ts.isNumericLiteral(key)
          ? key.text
          : undefined;
    if (name === undefined) continue;
    fields.push({ name, shape: { kind: "unknown" }, rendersAsText: false });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Shape inference
// ---------------------------------------------------------------------------

function inferShape(
  varName: string,
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
): { shape: MockShape; uncertain: boolean } {
  const aliases = propAliases(bodyNode);
  let arrayEvidence = false;
  let booleanTest = false;
  let scalar = false;
  const objectFields: FieldNotes = new Map();
  const elementFields: FieldNotes = new Map();

  for (const ref of collectRefs(bodyNode, sourceFile, new Set([varName]), undefined)) {
    const id: ts.Node = ref.node;
    const parent = id.parent;
    if (!parent) continue;

    if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
      if (!ts.isIdentifier(parent.name)) continue;
      const member = parent.name.text;
      if (member === "length") {
        arrayEvidence = true;
        continue;
      }
      if (ARRAY_METHODS.has(member)) {
        arrayEvidence = true;
        collectElementFields(parent, sourceFile, elementFields, aliases);
        continue;
      }
      noteField(
        objectFields,
        member,
        fieldKind(parent),
        isJsxTextChild(parent),
        nestedOf(parent),
        comparedLiteral(parent, aliases),
      );
      continue;
    }

    if (ts.isElementAccessExpression(parent) && parent.expression === id) {
      // Only a numeric index proves an array. `lookup[key]` is a record, and
      // mocking a record as an array is the kind of guess that breaks specs.
      if (ts.isNumericLiteral(parent.argumentExpression)) arrayEvidence = true;
      continue;
    }

    if (isBooleanTest(id)) {
      booleanTest = true;
      continue;
    }
    if (isScalarRender(id)) {
      scalar = true;
    }
    // Anything else — a JSX attribute value, a call argument, a return — hands
    // the value to code we cannot see, so it is no evidence at all.
  }

  const fields = toFields(objectFields);

  if (arrayEvidence && fields.length === 0) {
    const element = toFields(elementFields);
    return {
      shape:
        element.length > 0
          ? { kind: "array", element: { kind: "object", fields: element } }
          : { kind: "array" },
      uncertain: false,
    };
  }
  if (arrayEvidence) {
    // An envelope: `data.length` sitting next to `data.total` cannot both be
    // right. The object wins because it is the shape that survives a member
    // access, and the caller is told the inference is shaky.
    return { shape: { kind: "object", fields }, uncertain: true };
  }
  if (fields.length > 0) return { shape: { kind: "object", fields }, uncertain: false };
  // A truthy object is only safe when nothing renders the value: React throws
  // on an object child, whereas a string passes a truthiness test just as well.
  if (booleanTest && !scalar) return { shape: { kind: "truthy-object" }, uncertain: false };
  if (scalar) return { shape: { kind: "string" }, uncertain: false };
  return { shape: { kind: "unknown" }, uncertain: true };
}

/** Fields of the callback element in `xs.map((item) => …)`. */
function collectElementFields(
  access: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile,
  notes: FieldNotes,
  aliases: Map<string, string[]>,
): void {
  const call = access.parent;
  if (!call || !ts.isCallExpression(call) || call.expression !== access) return;
  const cb = call.arguments[0];
  // Only an inline arrow with a single named parameter describes the element.
  // A callback passed by name, or one that destructures, lives somewhere this
  // walk cannot follow.
  if (!cb || !ts.isArrowFunction(cb) || cb.parameters.length !== 1) return;
  const param = cb.parameters[0];
  if (!param || !ts.isIdentifier(param.name)) return;

  const elementName = param.name.text;
  for (const ref of collectRefs(cb.body, sourceFile, new Set([elementName]), undefined)) {
    const parent = ref.node.parent;
    if (!parent || !ts.isPropertyAccessExpression(parent)) continue;
    if (parent.expression !== ref.node || !ts.isIdentifier(parent.name)) continue;
    const member = parent.name.text;
    // Builtins name no data field, so mocking them would invent a key.
    if (member === "length" || ARRAY_METHODS.has(member)) continue;
    noteField(
      notes,
      member,
      fieldKind(parent),
      isJsxTextChild(parent),
      nestedOf(parent),
      comparedLiteral(parent, aliases),
    );
  }
}

/**
 * Value kind of a single `x.k` access. One level of nesting is the hard limit:
 * anything deeper falls back to unknown, which mocks as `{}` and therefore
 * survives the access instead of inventing a sub-object that specs assert on.
 */
function fieldKind(access: ts.PropertyAccessExpression): FieldKind {
  const parent = access.parent;
  if (!parent) return "string";

  if (ts.isNewExpression(parent) && isNamedCallee(parent.expression, "Date")) {
    if ((parent.arguments ?? []).some((a) => a === access)) return "date-string";
  }
  if (ts.isCallExpression(parent) && isNamedCallee(parent.expression, "Number")) {
    if (parent.arguments.some((a) => a === access)) return "number";
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === access) {
    if (!ts.isIdentifier(parent.name)) return "unknown";
    const inner = parent.name.text;
    if (inner === "toFixed") return "number";
    if (inner === "length" || ARRAY_METHODS.has(inner)) return "array";
    // A string method proves the field is a string, which the default already
    // covers — but saying so explicitly keeps it out of the "object" branch.
    if (STRING_METHODS.has(inner)) return "string";
    // `session.user.email` — a further property read means this field holds an
    // object. Reporting "unknown" mocked it as the string "flawless-user", and
    // then `.email` was undefined and `.toLowerCase()` threw.
    return "object";
  }
  return "string";
}

/**
 * Locals destructured from another local, as a path: `const { id } = await
 * params` gives `id → ["params", "id"]`.
 *
 * Top-level only, and only from a plain identifier — that is the shape a Next
 * page uses to read its route params, and anything deeper is a value this
 * cannot follow. The root is looked up in the props fixture at emit time, so a
 * root that is not a prop simply resolves to nothing.
 */
function propAliases(bodyNode: ts.Node): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const stmt of bodyStatements(bodyNode)) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isObjectBindingPattern(decl.name)) continue;
      const init = ts.isAwaitExpression(decl.initializer)
        ? decl.initializer.expression
        : decl.initializer;
      if (!ts.isIdentifier(init)) continue;
      for (const el of decl.name.elements) {
        if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
        const from =
          el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
        out.set(el.name.text, [init.text, from]);
      }
    }
  }
  return out;
}

/**
 * The literal this access is compared against: `m.status === "active"`.
 *
 * Strict equality only, and only against a literal — `!==` states what the
 * value must NOT be, which does not pick one out, and a comparison against
 * another expression is not a value this can read.
 */
function comparedLiteral(
  access: ts.PropertyAccessExpression,
  aliases: Map<string, string[]>,
): { equals?: string | number | boolean; equalsProp?: string[] } {
  const parent = access.parent;
  if (!parent || !ts.isBinaryExpression(parent)) return {};
  if (parent.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return {};
  const other = parent.left === access ? parent.right : parent.left;
  if (ts.isStringLiteral(other)) return { equals: other.text };
  if (ts.isNumericLiteral(other)) return { equals: Number(other.text) };
  if (other.kind === ts.SyntaxKind.TrueKeyword) return { equals: true };
  if (other.kind === ts.SyntaxKind.FalseKeyword) return { equals: false };
  if (ts.isIdentifier(other)) {
    const path = aliases.get(other.text);
    if (path) return { equalsProp: path };
  }
  return {};
}

function noteField(
  notes: FieldNotes,
  name: string,
  kind: FieldKind,
  rendersAsText: boolean,
  nestedAccess?: ts.PropertyAccessExpression,
  compared?: { equals?: string | number | boolean; equalsProp?: string[] },
): void {
  const note = notes.get(name) ?? { kinds: new Set<FieldKind>(), rendersAsText: false };
  note.kinds.add(kind);
  note.rendersAsText = note.rendersAsText || rendersAsText;
  // First comparison wins. Two different literals for one field is the
  // component testing for two states, and picking the second over the first is
  // arbitrary — so it keeps the first and stays deterministic.
  if (compared?.equals !== undefined && note.equals === undefined) note.equals = compared.equals;
  if (compared?.equalsProp !== undefined && note.equalsProp === undefined) {
    note.equalsProp = compared.equalsProp;
  }
  // One level deeper, and only where the source actually read it. `session.user`
  // followed by `.email` gives user: { email: … } rather than a bare {}, which
  // would still be undefined at the read the component performs.
  if (kind === "object" && nestedAccess && ts.isIdentifier(nestedAccess.name)) {
    note.nested ??= new Map();
    noteField(
      note.nested,
      nestedAccess.name.text,
      fieldKind(nestedAccess),
      isJsxTextChild(nestedAccess),
    );
  }
  notes.set(name, note);
}

function toFields(notes: FieldNotes): MockField[] {
  const out: MockField[] = [];
  for (const [name, note] of notes) {
    const kind = settleKind(note.kinds);
    const shape: MockShape =
      kind === "object" && note.nested && note.nested.size > 0
        ? { kind: "object", fields: toFields(note.nested) }
        : shapeOfFieldKind(kind);
    out.push({
      name,
      shape,
      rendersAsText: note.rendersAsText,
      ...(note.equals !== undefined ? { equals: note.equals } : {}),
      ...(note.equalsProp !== undefined ? { equalsProp: note.equalsProp } : {}),
    });
  }
  return out;
}

/**
 * "string" is the fallback every access without stronger evidence lands on, so
 * a more specific kind outranks it. Two *different* specific kinds contradict
 * each other, and guessing between them is exactly what breaks a real spec.
 */
function settleKind(kinds: Set<FieldKind>): FieldKind {
  const specific = [...kinds].filter((k) => k !== "string");
  const first = specific[0];
  if (first === undefined) return "string";
  return specific.length === 1 ? first : "unknown";
}

/** The `x.y.z` access hanging off `x.y`, when there is one. */
function nestedOf(access: ts.PropertyAccessExpression): ts.PropertyAccessExpression | undefined {
  const parent = access.parent;
  return parent && ts.isPropertyAccessExpression(parent) && parent.expression === access
    ? parent
    : undefined;
}

function shapeOfFieldKind(kind: FieldKind): MockShape {
  switch (kind) {
    case "number":
      return { kind: "number" };
    case "date-string":
      return { kind: "date-string" };
    case "array":
      return { kind: "array" };
    case "unknown":
      return { kind: "unknown" };
    case "object":
      // An object with no observed fields: {} survives a property read, which is
      // the most a bare `x.y` with no further use can honestly support.
      return { kind: "truthy-object" };
    default:
      return { kind: "string" };
  }
}

// ---------------------------------------------------------------------------
// Reference position tests
// ---------------------------------------------------------------------------

function isBooleanTest(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    ts.isPrefixUnaryExpression(parent) &&
    parent.operator === ts.SyntaxKind.ExclamationToken &&
    parent.operand === node
  ) {
    return true;
  }
  if (ts.isConditionalExpression(parent) && parent.condition === node) return true;
  if (ts.isIfStatement(parent) && parent.expression === node) return true;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    const op = parent.operatorToken.kind;
    return (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    );
  }
  return false;
}

function isScalarRender(node: ts.Node): boolean {
  if (isJsxTextChild(node)) return true;
  const parent = node.parent;
  return parent !== undefined && ts.isTemplateSpan(parent) && parent.expression === node;
}

/** `<p>{x}</p>` — the node is the whole expression React renders as text. */
function isJsxTextChild(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isJsxExpression(parent) || parent.expression !== node) return false;
  return (
    parent.parent !== undefined &&
    (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))
  );
}

function isNamedCallee(expr: ts.Expression, name: string): boolean {
  return ts.isIdentifier(expr) && expr.text === name;
}

/** `db.query.foo.findMany` → { text, root: "db" }; anything computed → undefined. */
function dottedName(expr: ts.Expression): { text: string; root: string } | undefined {
  if (ts.isIdentifier(expr)) return { text: expr.text, root: expr.text };
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    const head = dottedName(expr.expression);
    if (!head) return undefined;
    return { text: `${head.text}.${expr.name.text}`, root: head.root };
  }
  return undefined;
}
