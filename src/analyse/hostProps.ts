import type { PropsShape, PropValue } from "../types.ts";

/**
 * A curated, closed table of host-element props — deliberately NOT a model of
 * the DOM. `ComponentProps<"div">` is the dominant props shape in shadcn/base-ui
 * codebases, and without this every such component synthesises zero props and
 * gets an assertion-free smoke test.
 *
 * Three rules are baked in, each because breaking them produces *false test
 * failures* rather than missing coverage:
 *
 * 1. Never synthesise `value`/`checked` — a value without an onChange makes
 *    React warn about a controlled input and turns `userEvent.type` into a
 *    silent no-op. Always `defaultValue`.
 * 2. Never synthesise `placeholder`/`name`/`required` — an empty-string default
 *    is useless to the scaffolder and `getByPlaceholderText("")` throws.
 * 3. `type` is always a valid literal, never `""` — `<button type="">` is
 *    invalid HTML.
 */

export interface HostElementProps {
  shape: PropsShape;
  variantOptions?: Record<string, PropValue[]>;
  acceptsChildren: boolean;
  /** Implicit ARIA role, only where unambiguous. */
  role?: string;
  /** Handler props the scaffolder stubs with vi.fn(). */
  handlers: string[];
}

/** Present on every HTML element — safe for any tag, known or not. */
const BASE: PropsShape = { className: "", id: "" };

export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const CONTAINER_TAGS = [
  "div",
  "span",
  "p",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "figure",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "dl",
  "dt",
  "dd",
  "pre",
  "code",
  "em",
  "strong",
  "small",
  "fieldset",
  "legend",
];

function container(role?: string): HostElementProps {
  return { shape: { ...BASE }, acceptsChildren: true, handlers: [], ...(role ? { role } : {}) };
}

const TABLE: Record<string, HostElementProps> = {};
for (const tag of CONTAINER_TAGS) TABLE[tag] = container();

TABLE.nav = container("navigation");
TABLE.ul = container("list");
TABLE.ol = container("list");
TABLE.li = container("listitem");
for (const h of ["h1", "h2", "h3", "h4", "h5", "h6"]) TABLE[h] = container("heading");

TABLE.label = {
  shape: { ...BASE, htmlFor: "" },
  acceptsChildren: true,
  handlers: [],
};

TABLE.button = {
  shape: { ...BASE, type: "button", disabled: false },
  variantOptions: { type: ["button", "submit", "reset"] },
  acceptsChildren: true,
  role: "button",
  handlers: ["onClick"],
};

TABLE.a = {
  shape: { ...BASE, href: "/" },
  acceptsChildren: true,
  role: "link",
  handlers: ["onClick"],
};

TABLE.input = {
  shape: { ...BASE, type: "text", defaultValue: "", disabled: false },
  variantOptions: { type: ["text", "email", "password", "number"] },
  acceptsChildren: false,
  role: "textbox",
  handlers: ["onChange"],
};

TABLE.textarea = {
  shape: { ...BASE, defaultValue: "", disabled: false, rows: 3 },
  acceptsChildren: false,
  role: "textbox",
  handlers: ["onChange"],
};

TABLE.select = {
  shape: { ...BASE, defaultValue: "", disabled: false },
  acceptsChildren: true,
  role: "combobox",
  handlers: ["onChange"],
};

TABLE.form = {
  shape: { ...BASE },
  acceptsChildren: true,
  role: "form",
  handlers: ["onSubmit"],
};

TABLE.img = {
  shape: { ...BASE, src: "/flawless.png", alt: "placeholder" },
  acceptsChildren: false,
  role: "img",
  handlers: [],
};

for (const tag of ["svg", "path", "circle", "rect", "g"]) {
  TABLE[tag] = {
    shape: { ...BASE },
    acceptsChildren: !VOID_ELEMENTS.has(tag),
    handlers: [],
  };
}

export const HOST_ELEMENT_PROPS: Readonly<Record<string, HostElementProps>> = TABLE;

/** Tag → implicit ARIA role, shared with the selector emitters so they cannot drift. */
export const TAG_TO_ROLE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TABLE)
    .filter(([, v]) => v.role !== undefined)
    .map(([k, v]) => [k, v.role as string]),
);

export function isHostTagRecognised(tag: string): boolean {
  return tag in TABLE;
}

/**
 * Never undefined. An unknown tag still gets `className`/`id` (present on every
 * HTML element) and a children flag from the closed void-element list — both
 * are facts about HTML, not guesses about this component.
 */
export function hostPropsFor(tag: string): HostElementProps {
  const known = TABLE[tag];
  if (known) return { ...known, shape: { ...known.shape } };
  return {
    shape: { ...BASE },
    acceptsChildren: !VOID_ELEMENTS.has(tag),
    handlers: [],
  };
}
