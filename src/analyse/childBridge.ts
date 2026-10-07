import ts from "typescript";
import { DATE_PROP_SENTINEL, type DataDepInfo, type MockField, type MockShape } from "../types.ts";

/**
 * The bridge: what a rendered CHILD needs on a prop flows BACK into what
 * the parent's fixtures carry.
 *
 * A spec renders its children for real, and the child reads fields nobody
 * upstream thought to fill. Drop passes `date={drop.createdAt}` to a
 * RelativeTime that calls date.getTime() — the chain read on drop stops at
 * `.createdAt`, the dep fixture has no idea the value is a Date, and the
 * mount dies inside the child with `undefined is not an object`, or worse a
 * plausible ISO STRING where `toLocaleTimeString` was expected. The child
 * knew — its own typed prop resolved to a Date stand-in — but that knowledge
 * never crossed the JSX boundary. It does now, two ways:
 *
 *   bridgePropValues — attr sites rooted at a PROP of the unit, applied by
 *                       synthesiseDefaults: the unit's DEFAULTS gain nested
 *                       values (drop.createdAt becomes a live Date).
 *   bridgeDataShapes  — attr sites rooted at a data dep or the element of
 *                       `dep.map(item => …)`: the mock fixture grows the
 *                       fields the child will read off what it is handed.
 */

/** tag → attr → the value that child's own defaults put on that prop. */
export type ChildExpected = Record<string, Record<string, unknown>>;

/**
 * Propagate a child's expected prop value into an unresolved prop's
 * stand-in. `member` marks a `date={drop.createdAt}` site (the value is one
 * hop INTO the prop); without it the whole prop flows in (`drop={item}`).
 * Returns a fresh value when anything changed, undefined when not.
 */
export function bridgePropValues(
  current: unknown,
  member: string | undefined,
  expected: unknown,
): unknown {
  if (expected === undefined) return undefined;
  if (member === undefined) return richer(expected, current) ? expected : undefined;
  const base =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  if (!richer(expected, base[member])) return undefined;
  return { ...base, [member]: expected };
}

/** Would `want` survive more reads than `have`? The sentinel Date ranks as Date. */
function richer(want: unknown, have: unknown): boolean {
  return rank(want) > rank(have);
}

function rank(v: unknown): number {
  if (v === DATE_PROP_SENTINEL) return 3;
  if (v === null || typeof v !== "object") return typeof v === "string" ? 1 : 0;
  if (Array.isArray(v)) return 2;
  return 4;
}

/**
 * A child's expected VALUE as a fixture SHAPE. Booleans are skipped: no
 * boolean kind exists, and injecting a truthy stand-in could flip a branch
 * every later assertion reads.
 */
function valueToShape(v: unknown): MockShape | undefined {
  if (v === DATE_PROP_SENTINEL) return { kind: "date" };
  if (typeof v === "number") return { kind: "number" };
  if (typeof v === "string") return { kind: "string" };
  // A MISSING element means "no evidence" and mockValues renders []; an
  // UNKNOWN element means "render {}" — Replies learned the difference the
  // hard way when [] became [{}] and started mounting a crashing child.
  if (Array.isArray(v)) return { kind: "array" };
  if (v !== null && typeof v === "object") {
    const fields: MockField[] = [];
    for (const [name, fv] of Object.entries(v as Record<string, unknown>)) {
      const shape = valueToShape(fv);
      if (shape) fields.push({ name, shape, rendersAsText: false });
    }
    return { kind: "object", fields };
  }
  return undefined;
}

/** Fold `wanted` into `existing`; existing evidence wins unless it is vaguer. */
function mergeShape(existing: MockShape | undefined, wanted: MockShape): MockShape {
  // Unknown carries no evidence; it may never overwrite (or replace) a shape
  // that knows more.
  if (wanted.kind === "unknown") return existing ?? wanted;
  if (!existing) return wanted;
  if (existing.kind === "unknown" || existing.kind === "truthy-object") return wanted;
  if (existing.kind === "array") {
    if (wanted.kind === "array" && wanted.element && !existing.element)
      return { kind: "array", element: wanted.element };
    return existing;
  }
  if (existing.kind === "object" && wanted.kind === "object") {
    const fields = [...existing.fields];
    for (const w of wanted.fields) {
      const i = fields.findIndex((f) => f.name === w.name);
      if (i === -1) fields.push(w);
      else fields[i] = { ...fields[i], shape: mergeShape(fields[i].shape, w.shape) };
    }
    return { kind: "object", fields };
  }
  // A child that calls Date methods outranks a rendered ISO string.
  if (wanted.kind === "date" && (existing.kind === "string" || existing.kind === "date-string"))
    return wanted;
  return existing;
}

const ELEM_METHODS = new Set(["map", "filter", "find", "some", "every", "forEach", "flatMap"]);

interface Site {
  tag: string;
  attr: string;
  root: string;
  path: string[];
}

/**
 * Fill a data dep's fixture with what the rendered children read off the
 * values handed to them. `items` reaches `<Drop drop={item.drop}>` through
 * `items.map(item => …)`: the Drop child's own defaults say drop carries a
 * body and a Date createdAt, so the array element's `drop` field grows them.
 */
export function bridgeDataShapes(
  bodyNode: ts.Node,
  dataDeps: DataDepInfo[],
  childExpected: ChildExpected,
): void {
  const depVars = new Set(
    dataDeps.map((d) => d.varName).filter((v): v is string => v !== undefined),
  );
  if (depVars.size === 0) return;

  // `items.map(item => …)` binds item to the ELEMENT of items.
  const elemAliases = new Map<string, string>();
  const collectAliases = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      depVars.has(n.expression.expression.text) &&
      ELEM_METHODS.has(n.expression.name.text)
    ) {
      const cb = n.arguments[0];
      if (
        (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
        cb.parameters.length > 0 &&
        ts.isIdentifier(cb.parameters[0].name)
      ) {
        elemAliases.set(cb.parameters[0].name.text, n.expression.expression.text);
      }
    }
    ts.forEachChild(n, collectAliases);
  };
  ts.forEachChild(bodyNode, collectAliases);

  // JSX attr sites whose value is rooted at a dep var or an element alias.
  const sites: Site[] = [];
  const rootedAt = (expr: ts.Expression): { root: string; path: string[] } | undefined => {
    let n: ts.Node = expr;
    const path: string[] = [];
    while (ts.isPropertyAccessExpression(n)) {
      path.unshift(n.name.text);
      n = n.expression;
    }
    if (ts.isIdentifier(n) && (depVars.has(n.text) || elemAliases.has(n.text))) {
      return { root: n.text, path };
    }
    return undefined;
  };
  const collectSites = (n: ts.Node): void => {
    if (ts.isJsxAttribute(n)) {
      const init = n.initializer;
      const expr = init ? (ts.isJsxExpression(init) ? init.expression : init) : undefined;
      const tag = owningTag(n);
      const attr = ts.isIdentifier(n.name) ? n.name.text : n.name.getText();
      if (expr && tag) {
        // Ternary/logical branches all reach the child — take every leaf.
        const queue: ts.Node[] = [expr];
        while (queue.length > 0) {
          const e = queue.shift() as ts.Node;
          if (
            ts.isConditionalExpression(e) ||
            ts.isBinaryExpression(e) ||
            ts.isParenthesizedExpression(e) ||
            ts.isJsxExpression(e)
          ) {
            e.getChildren().forEach((c) => queue.push(c));
            continue;
          }
          const found = rootedAt(e as ts.Expression);
          if (found) sites.push({ tag, attr, root: found.root, path: found.path });
        }
      }
    }
    ts.forEachChild(n, collectSites);
  };
  collectSites(bodyNode);
  if (sites.length === 0) return;

  for (const site of sites) {
    const wanted = valueToShape(childExpected[site.tag]?.[site.attr]);
    if (!wanted) continue;
    const aliasOf = elemAliases.get(site.root);
    for (const dep of dataDeps) {
      const isElem = aliasOf !== undefined && dep.varName === aliasOf;
      const isVar = dep.varName === site.root;
      if (!isVar && !isElem) continue;
      if (isElem && dep.shape.kind !== "array") continue;
      const head = isElem && dep.shape.kind === "array" ? dep.shape.element : undefined;
      if (isElem) {
        const element = applyPath(head ?? { kind: "unknown" }, wanted, site.path);
        dep.shape = { ...dep.shape, element };
      } else {
        dep.shape = applyPath(dep.shape, wanted, site.path);
      }
    }
  }
}

/**
 * Merge `wanted` at `path` below `root`, rebuilding objects on the way so a
 * shape shared between two deps cannot leak. A path hop that does not exist
 * yet grows an object field; the merge lands at the end of the path.
 */
function applyPath(root: MockShape, wanted: MockShape, path: string[]): MockShape {
  if (path.length === 0) return mergeShape(root, wanted);
  if (root.kind !== "object") {
    // The read went THROUGH this hop, so it has to be an object whatever
    // the body inferred here — unless what stands here already answers it.
    if (root.kind !== "unknown" && root.kind !== "truthy-object") return root;
    root = { kind: "object", fields: [] };
  }
  const [head, ...tail] = path;
  const fields = [...root.fields];
  const i = fields.findIndex((f) => f.name === head);
  if (i === -1) {
    const made = applyPath({ kind: "unknown" }, wanted, tail);
    fields.push({ name: head, shape: made, rendersAsText: false });
  } else {
    fields[i] = { ...fields[i], shape: applyPath(fields[i].shape, wanted, tail) };
  }
  return { kind: "object", fields };
}

/** The JSX element an attribute belongs to — its tag text, for child lookups. */
function owningTag(n: ts.Node): string | undefined {
  let cur: ts.Node = n.parent;
  while (
    cur &&
    !(ts.isJsxOpeningElement(cur) || ts.isJsxSelfClosingElement(cur) || ts.isJsxElement(cur))
  ) {
    cur = cur.parent;
  }
  if (!cur) return undefined;
  if (ts.isJsxElement(cur)) cur = cur.openingElement;
  return ts.isJsxOpeningLikeElement(cur) ? cur.tagName.getText() : undefined;
}
