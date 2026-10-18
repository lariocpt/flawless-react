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
 *
 * Strings split in two. A synth-seeded placeholder ("flawless-handle", "")
 * carries no evidence about WHICH string fits, so it merges as the generic
 * string kind. A string that survived synthesis VERBATIM is type evidence —
 * an arm of a literal union ('like' | 'repost' | …) — and the mock must
 * emit exactly that: NotificationList indexes ICONS by n.kind, and a
 * plausible-but-wrong 'flawless-kind' looks up undefined and crashes the
 * render. Verbatim strings ride as the field's `equals` value.
 */
interface Wanted {
  shape: MockShape;
  equals?: unknown;
}

function valueToShape(v: unknown): Wanted | undefined {
  if (v === DATE_PROP_SENTINEL) return { shape: { kind: "date" } };
  if (typeof v === "number") return { shape: { kind: "number" } };
  if (typeof v === "string") {
    if (v === "" || v.startsWith("flawless-")) return { shape: { kind: "string" } };
    return { shape: { kind: "string" }, equals: v };
  }
  // A MISSING element means "no evidence" and mockValues renders []; an
  // UNKNOWN element means "render {}" — Replies learned the difference the
  // hard way when [] became [{}] and started mounting a crashing child.
  if (Array.isArray(v)) return { shape: { kind: "array" } };
  if (v !== null && typeof v === "object") {
    const fields: MockField[] = [];
    for (const [name, fv] of Object.entries(v as Record<string, unknown>)) {
      const w = valueToShape(fv);
      if (!w) continue;
      fields.push({
        name,
        shape: w.shape,
        rendersAsText: false,
        ...(w.equals !== undefined ? { equals: w.equals as MockField["equals"] } : {}),
      });
    }
    return { shape: { kind: "object", fields } };
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
      const at = fields.findIndex((f) => f.name === w.name);
      const prev = at === -1 ? undefined : fields[at];
      if (prev === undefined) {
        fields.push(w);
        continue;
      }
      const merged = { ...prev, shape: mergeShape(prev.shape, w.shape) };
      // A literal the parent never knew about is pure gain; a literal the
      // parent inferred from a comparison site (`kind === "repost"`) stays.
      if (merged.equals === undefined && w.equals !== undefined) merged.equals = w.equals;
      fields[at] = merged;
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
      const param =
        cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))
          ? cb.parameters[0]
          : undefined;
      if (param && ts.isIdentifier(param.name)) {
        elemAliases.set(param.name.text, n.expression.expression.text);
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
      if (isElem) {
        // A `.map()` site writes the ELEMENT, so only an array dep can take it.
        if (dep.shape.kind !== "array") continue;
        const element = applyPath(dep.shape.element ?? { kind: "unknown" }, wanted, site.path);
        dep.shape = { kind: "array", element };
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
function applyPath(root: MockShape, wanted: Wanted, path: string[]): MockShape {
  if (path.length === 0) return mergeShape(root, wanted.shape);
  if (root.kind !== "object") {
    // The read went THROUGH this hop, so it has to be an object whatever
    // the body inferred here — unless what stands here already answers it.
    if (root.kind !== "unknown" && root.kind !== "truthy-object") return root;
    root = { kind: "object", fields: [] };
  }
  // `path.length === 0` returned above, so the hop exists. Named because the
  // indexed reads below need `string`, not `string | undefined`.
  const head = path[0];
  if (head === undefined) return root;
  const tail = path.slice(1);
  const fields = [...root.fields];
  const at = fields.findIndex((f) => f.name === head);
  const prev = at === -1 ? undefined : fields[at];
  // A literal rides on the FIELD standing at the END of the path.
  const atEnd = tail.length === 0 && wanted.equals !== undefined;
  if (prev === undefined) {
    const made = applyPath({ kind: "unknown" }, wanted, tail);
    const field: MockField = { name: head, shape: made, rendersAsText: false };
    if (atEnd) field.equals = wanted.equals as MockField["equals"];
    fields.push(field);
  } else {
    const merged = { ...prev, shape: applyPath(prev.shape, wanted, tail) };
    if (atEnd && merged.equals === undefined) merged.equals = wanted.equals as MockField["equals"];
    fields[at] = merged;
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
