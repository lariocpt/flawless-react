import type { MockField, MockShape, PropsShape, PropValue } from "../types.ts";

/**
 * Resolves an `equalsDep` note — the field of another dependency this one is
 * compared against — to the literal text that dep's own fixture holds there.
 * Undefined when the name is not a dep, or the field has no readable value.
 */
export type DepFieldResolver = (dep: string, field: string) => string | undefined;

/**
 * Renders an inferred MockShape as JavaScript source text for a generated
 * spec. Every branch answers the same question: which literal keeps the
 * component rendering when the inference was only half right?
 */
export function mockLiteral(
  shape: MockShape,
  seed: string,
  props?: PropsShape,
  depValues?: DepFieldResolver,
): string {
  switch (shape.kind) {
    case "array":
      // Exactly one element. An empty array would let a spec pass without ever
      // rendering the row markup it claims to check.
      return shape.element ? `[${mockLiteral(shape.element, seed, props, depValues)}]` : "[]";
    case "object":
      return objectLiteral(shape.fields, props, depValues);
    case "number":
      return "1";
    case "date-string":
      return quote("2024-01-01T00:00:00.000Z");
    case "string":
      return quote(`flawless-${seed}`);
    case "truthy-object":
      // The only evidence was `if (x)` / `!x`: any non-null object satisfies
      // that, and nothing in the component reads a field off it.
      return "{}";
    case "unknown":
      // NEVER `undefined`. `undefined` throws on *any* member access, so a
      // single `dep.anything` anywhere in the component fails the generated
      // spec. `{}` only gives way when the component calls an array method on
      // it, which is strictly rarer. This is the fix for the "items.length
      // crashes the generated test" failure mode.
      return "{}";
  }
}

function objectLiteral(
  fields: MockField[],
  props?: PropsShape,
  depValues?: DepFieldResolver,
): string {
  if (fields.length === 0) return "{}";
  return `{ ${fields.map((f) => `${keyText(f.name)}: ${fieldLiteral(f, props, depValues)}`).join(", ")} }`;
}

function fieldLiteral(field: MockField, props?: PropsShape, depValues?: DepFieldResolver): string {
  // A literal the component compares this field against wins over any
  // synthesised value: `m.status === "active"` against `status:
  // "flawless-status"` is a row the page's own lookup rejects, and twenty-two
  // of the dogfood app's page specs rendered nothing because of it.
  if (field.equals !== undefined) return JSON.stringify(field.equals);
  // The same, where the comparison is against one of the component's own props:
  // `m.building_id === id`, with `id` the route param. Read out of the fixture
  // the spec's DEFAULTS is built from, so the two agree by construction rather
  // than by both spelling "flawless-id".
  if (field.equalsProp && props) {
    const v = atPath(props, field.equalsProp);
    if (v !== undefined) return JSON.stringify(v);
  }
  // And against a field of ANOTHER dep: `m.user_id === user.id`. Resolved to
  // the literal the other dep's fixture actually holds, for the same reason —
  // two independently synthesised spellings never match, and the lookup that
  // compares them guard-exits the page.
  if (field.equalsDep && depValues) {
    const v = depValues(field.equalsDep.var, field.equalsDep.field);
    if (v !== undefined) return v;
  }
  // A field with no evidence is a leaf, and a string survives the most uses: it
  // renders as text, it is truthy, and an unexpected property read off it is
  // `undefined` rather than a throw. The bare-`{}` rule above is for a whole
  // dependency, where the component is far more likely to be reading fields.
  if (field.shape.kind === "unknown") return quote(`flawless-${field.name}`);
  return mockLiteral(field.shape, field.name, props, depValues);
}

/**
 * The literal ONE field of an object-shaped fixture resolves to — what an
 * `equalsDep` reference reads. Deliberately resolved WITHOUT a dep resolver of
 * its own: one hop is a value two fixtures can agree on, a chain is a graph
 * this has no business walking.
 */
export function fieldValueLiteral(field: MockField, props?: PropsShape): string {
  return fieldLiteral(field, props);
}

/** A prop path into the fixture; undefined at the first hop that is not there. */
function atPath(props: PropsShape, path: string[]): PropValue | undefined {
  let cur: PropValue | undefined = props as unknown as PropValue;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, PropValue>)[key];
  }
  return cur;
}

const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function keyText(name: string): string {
  return BARE_KEY.test(name) ? name : quote(name);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
