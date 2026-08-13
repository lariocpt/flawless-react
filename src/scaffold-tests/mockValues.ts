import type { MockField, MockShape } from "../types.ts";

/**
 * Renders an inferred MockShape as JavaScript source text for a generated
 * spec. Every branch answers the same question: which literal keeps the
 * component rendering when the inference was only half right?
 */
export function mockLiteral(shape: MockShape, seed: string): string {
  switch (shape.kind) {
    case "array":
      // Exactly one element. An empty array would let a spec pass without ever
      // rendering the row markup it claims to check.
      return shape.element ? `[${mockLiteral(shape.element, seed)}]` : "[]";
    case "object":
      return objectLiteral(shape.fields);
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

function objectLiteral(fields: MockField[]): string {
  if (fields.length === 0) return "{}";
  return `{ ${fields.map((f) => `${keyText(f.name)}: ${fieldLiteral(f)}`).join(", ")} }`;
}

function fieldLiteral(field: MockField): string {
  // A field with no evidence is a leaf, and a string survives the most uses: it
  // renders as text, it is truthy, and an unexpected property read off it is
  // `undefined` rather than a throw. The bare-`{}` rule above is for a whole
  // dependency, where the component is far more likely to be reading fields.
  if (field.shape.kind === "unknown") return quote(`flawless-${field.name}`);
  return mockLiteral(field.shape, field.name);
}

const BARE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function keyText(name: string): string {
  return BARE_KEY.test(name) ? name : quote(name);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
