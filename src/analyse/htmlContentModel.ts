/**
 * Facts about HTML's content model that a generated harness has to respect.
 *
 * This is not inference about the analysed app — it is the specification. A
 * `<tbody>` is only valid inside a `<table>`, so mounting `TableBody` straight
 * into the host's `#root` div made React 19 log
 *
 *   In HTML, <tbody> cannot be a child of <div>. This will cause a hydration error.
 *
 * on seven of the dogfood app's table primitives. The spec then failed them for
 * a warning the harness itself provoked. Wrapping the mount in the required
 * ancestors keeps those components covered instead of excluding them, and it is
 * a lookup rather than a guess.
 */

/** Ancestors a tag must be nested in, outermost first. */
const REQUIRED_ANCESTORS: Record<string, string[]> = {
  thead: ["table"],
  tbody: ["table"],
  tfoot: ["table"],
  caption: ["table"],
  colgroup: ["table"],
  col: ["table", "colgroup"],
  tr: ["table", "tbody"],
  td: ["table", "tbody", "tr"],
  th: ["table", "tbody", "tr"],
  option: ["select"],
  optgroup: ["select"],
  li: ["ul"],
  dt: ["dl"],
  dd: ["dl"],
  figcaption: ["figure"],
  legend: ["fieldset"],
  source: ["video"],
  track: ["video"],
  area: ["map"],
  param: ["object"],
  summary: ["details"],
};

/**
 * The chain a component's root tag must be mounted inside, or [] when it can
 * stand alone. Unknown tags (every component name, every custom element) return
 * [] — the harness only wraps where HTML demands it.
 */
export function requiredAncestors(rootTag: string | undefined): string[] {
  if (!rootTag) return [];
  return REQUIRED_ANCESTORS[rootTag] ?? [];
}

/** Elements a user can type into. Anything else rejects .fill()/.type() outright. */
const FILLABLE_TAGS = new Set(["input", "textarea", "select"]);

/**
 * Whether a change/input event target is something a test can type into.
 *
 * React's onChange bubbles, so it is idiomatic to put it on the `<form>` and
 * read `event.target`. Driving that literally emitted
 * `page.locator("form").fill("x")`, which Playwright rejects with "Element is
 * not an <input>, <textarea>, <select> or [contenteditable]" — the generator
 * describing event delegation as if it were a text box.
 */
export function isFillableTag(tag: string): boolean {
  return FILLABLE_TAGS.has(tag);
}

/** Input types that hold no user-suppliable text (or none a blind fill can supply). */
const UNFILLABLE_INPUT_TYPES = new Set([
  "hidden",
  "checkbox",
  "radio",
  "file",
  "image",
  "submit",
  "reset",
  "button",
  "range",
  "color",
]);

export type FillKind = "text" | "toggle" | "select" | "skip";

/** How (or whether) a form field can be driven, from its tag and type alone. */
export function fillKind(tag: string, type: string | undefined): FillKind {
  if (tag === "select") return "select";
  if (tag === "textarea") return "text";
  if (tag !== "input") return "skip";
  if (!type) return "text";
  if (type === "checkbox" || type === "radio") return "toggle";
  // A hidden input carries a value the component chose; typing into it asserts
  // nothing and, when several share a name, cannot even be addressed uniquely.
  if (UNFILLABLE_INPUT_TYPES.has(type)) return "skip";
  return "text";
}
