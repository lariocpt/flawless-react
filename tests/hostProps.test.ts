import { describe, expect, test } from "bun:test";
import {
  HOST_ELEMENT_PROPS,
  hostPropsFor,
  isHostTagRecognised,
  TAG_TO_ROLE,
  VOID_ELEMENTS,
} from "../src/analyse/hostProps.ts";

/**
 * The host table is the one place in the analyser that ships *asserted* facts
 * rather than facts read from the user's source, so its three baked-in rules are
 * pinned here as invariants over the whole table — a future tag added by hand
 * cannot quietly reintroduce `value` or an empty `type`.
 */

/** Props whose synthesised default would break the generated spec at runtime. */
const FORBIDDEN = ["value", "checked", "placeholder", "name", "required"];

describe("hostPropsFor", () => {
  test("div: className + id, accepts children", () => {
    const div = hostPropsFor("div");
    expect(div.shape).toEqual({ className: "", id: "" });
    expect(div.acceptsChildren).toBe(true);
    expect(div.handlers).toEqual([]);
    expect(div.role).toBeUndefined();
  });

  test("button: a real type literal, an onClick stub, and the button role", () => {
    const button = hostPropsFor("button");
    expect(button.shape).toEqual({ className: "", id: "", type: "button", disabled: false });
    expect(button.variantOptions?.type).toEqual(["button", "submit", "reset"]);
    expect(button.acceptsChildren).toBe(true);
    expect(button.role).toBe("button");
    expect(button.handlers).toEqual(["onClick"]);
  });

  test("input: defaultValue instead of value, and no placeholder/name/required", () => {
    const input = hostPropsFor("input");
    expect(input.shape).toEqual({
      className: "",
      id: "",
      type: "text",
      defaultValue: "",
      disabled: false,
    });
    for (const key of FORBIDDEN) expect(key in input.shape).toBe(false);
    expect(input.variantOptions?.type).toEqual(["text", "email", "password", "number"]);
    expect(input.acceptsChildren).toBe(false);
    expect(input.handlers).toEqual(["onChange"]);
  });

  test("unknown tag: className + id, children decided by the void-element list", () => {
    // Both facts hold for any HTML element, so neither is a guess about the tag.
    const custom = hostPropsFor("marquee");
    expect(custom.shape).toEqual({ className: "", id: "" });
    expect(custom.acceptsChildren).toBe(true);
    expect(custom.role).toBeUndefined();

    const wbr = hostPropsFor("wbr");
    expect(isHostTagRecognised("wbr")).toBe(false);
    expect(wbr.shape).toEqual({ className: "", id: "" });
    expect(wbr.acceptsChildren).toBe(false);
  });

  test("the returned shape is a copy — a caller cannot poison the table", () => {
    const first = hostPropsFor("button");
    first.shape.type = "poisoned";
    delete first.shape.className;
    expect(hostPropsFor("button").shape).toEqual({
      className: "",
      id: "",
      type: "button",
      disabled: false,
    });
  });

  test("isHostTagRecognised only claims tags the table really carries", () => {
    for (const tag of ["div", "button", "input", "h1", "svg", "label"]) {
      expect(isHostTagRecognised(tag)).toBe(true);
    }
    // A component, not a host element — and a tag nobody curated.
    for (const tag of ["Button", "custom-element", "marquee"]) {
      expect(isHostTagRecognised(tag)).toBe(false);
    }
  });
});

describe("host table invariants", () => {
  test("no entry synthesises value/checked/placeholder/name/required", () => {
    const offenders: string[] = [];
    for (const [tag, entry] of Object.entries(HOST_ELEMENT_PROPS)) {
      for (const key of FORBIDDEN) {
        if (key in entry.shape) offenders.push(`${tag}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every declared `type` is a non-empty literal drawn from that tag's options", () => {
    for (const [tag, entry] of Object.entries(HOST_ELEMENT_PROPS)) {
      const declared = entry.shape.type;
      if (declared === undefined) continue;
      expect(typeof declared).toBe("string");
      expect(declared).not.toBe("");
      const options = entry.variantOptions?.type;
      if (options) expect(options).toContain(declared as string);
      expect(tag.length).toBeGreaterThan(0);
    }
  });

  test("void elements never accept children", () => {
    const wrong = Object.entries(HOST_ELEMENT_PROPS)
      .filter(([tag, entry]) => VOID_ELEMENTS.has(tag) && entry.acceptsChildren)
      .map(([tag]) => tag);
    expect(wrong).toEqual([]);
    // The table really does cover void elements, so the check above has teeth.
    expect(
      Object.keys(HOST_ELEMENT_PROPS)
        .filter((t) => VOID_ELEMENTS.has(t))
        .sort(),
    ).toEqual(["img", "input"]);
  });

  test("TAG_TO_ROLE is exactly the table's role entries", () => {
    const fromTable = Object.entries(HOST_ELEMENT_PROPS)
      .filter(([, entry]) => entry.role !== undefined)
      .map(([tag, entry]) => [tag, entry.role as string]);
    expect(TAG_TO_ROLE).toEqual(Object.fromEntries(fromTable));
    expect(TAG_TO_ROLE.button).toBe("button");
    expect(TAG_TO_ROLE.input).toBe("textbox");
    expect(TAG_TO_ROLE.div).toBeUndefined();
  });

  test("every entry that stubs handlers names real React handler props", () => {
    for (const entry of Object.values(HOST_ELEMENT_PROPS)) {
      for (const handler of entry.handlers) {
        expect(handler).toMatch(/^on[A-Z]/);
      }
    }
  });
});
