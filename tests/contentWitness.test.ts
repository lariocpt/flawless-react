import { describe, expect, test } from "bun:test";
import { contentWitness } from "../src/scaffold-tests/templates.ts";

/**
 * Guard-the-guard tests for the D2a content witness (PLAN-02 items 1-2).
 *
 * The rule is a PORT, so its guards pin what the port is and is not:
 * the two conditions, the refusal of the DISPLAY_KEYS heuristic, and the
 * total order that makes the selection byte-stable (a witness chosen by
 * Object.entries order would not be — PLAN-02 Gates).
 */

describe("contentWitness — the two conditions", () => {
  test("a rendered field carrying a sentinel value qualifies", () => {
    const w = contentWitness({ greeting: "flawless-depthapp-p8", count: 3 }, new Set(["greeting"]));
    expect(w).toEqual({ value: "flawless-depthapp-p8", field: "greeting", path: "greeting" });
  });

  test("a sentinel field the subtree does NOT render is refused (condition b)", () => {
    // The 16-of-31 failure: the value is fixture data, but nothing in the
    // subtree renders `title`, so asserting it would be a fake.
    expect(contentWitness({ title: "flawless-x" }, new Set(["greeting"]))).toBeUndefined();
  });

  test("a rendered field without a sentinel value is refused (condition a)", () => {
    // A real app copy under a rendered field is not a fixture value: the
    // same string could be anywhere in the app, so it witnesses nothing.
    expect(
      contentWitness({ greeting: "Hello from the API" }, new Set(["greeting"])),
    ).toBeUndefined();
  });

  test("a non-string under a rendered field is refused", () => {
    expect(contentWitness({ greeting: 5, other: null }, new Set(["greeting", "other"]))).toBe(
      undefined,
    );
  });

  test("the sentinel prefix is exact: `flawless` without the dash is not one", () => {
    expect(
      contentWitness({ greeting: "flawless", other: "xflawless-x" }, new Set(["greeting"])),
    ).toBe(undefined);
  });

  test("a bare string inside an array has no owning field and is not a candidate", () => {
    // Matches the native refusal: displayWitness returns undefined for
    // non-object values — there is no key for condition (b) to check.
    expect(
      contentWitness({ rows: ["flawless-x", "flawless-y"] }, new Set(["rows"])),
    ).toBeUndefined();
  });

  test("an empty fixture, a null fixture and a bare-string fixture all refuse", () => {
    expect(contentWitness({}, new Set(["greeting"]))).toBeUndefined();
    expect(contentWitness(null, new Set(["greeting"]))).toBeUndefined();
    expect(contentWitness(undefined, new Set(["greeting"]))).toBeUndefined();
    expect(contentWitness("flawless-x", new Set(["greeting"]))).toBeUndefined();
  });
});

describe("contentWitness — the DISPLAY_KEYS heuristic stays refused", () => {
  test("an EMPTY renderedFields set refuses every field, however display-ish its name", () => {
    // `name`, `title`, `label`, `body` are all on the native's DISPLAY_KEYS
    // list. A port that smuggled the fallback across would pick one of these
    // off an unrendered component — the documented 16-of-31 mistake.
    const fixture = {
      name: "flawless-name",
      title: "flawless-title",
      label: "flawless-label",
      body: "flawless-body",
      business_name: "flawless-business",
      email: "flawless-email",
    };
    expect(contentWitness(fixture, new Set())).toBeUndefined();
  });

  test("a display-ish key name counts ONLY as a rendered member", () => {
    // The same name is evidence when the subtree renders it and nothing
    // when the subtree does not: the key list must not leak in from either
    // direction.
    const fixture = { title: "flawless-x", name: "flawless-y" };
    expect(contentWitness(fixture, new Set(["title"]))).toEqual({
      value: "flawless-x",
      field: "title",
      path: "title",
    });
    expect(contentWitness(fixture, new Set(["name"]))).toEqual({
      value: "flawless-y",
      field: "name",
      path: "name",
    });
  });
});

describe("contentWitness — the total order (byte-stability gate)", () => {
  test("same depth: key ascending wins over Object.entries order", () => {
    // Inserted zeta first; the selection must not follow insertion order.
    const insertedFirst = { zeta: "flawless-z", alpha: "flawless-a" };
    const w = contentWitness(insertedFirst, new Set(["zeta", "alpha"]));
    expect(w?.field).toBe("alpha");
  });

  test("key insertion order cannot move the selection", () => {
    const a = { greeting: "flawless-a", title: "flawless-b" };
    const b = { title: "flawless-b", greeting: "flawless-a" };
    const rendered = new Set(["greeting", "title"]);
    expect(contentWitness(a, rendered)).toEqual(contentWitness(b, rendered));
    expect(contentWitness(a, rendered)?.field).toBe("greeting");
  });

  test("depth dominates key: a shallow field under a late key beats a deep field under an early one", () => {
    const fixture = {
      zrows: [{ alpha: "flawless-deep" }],
      beta: "flawless-shallow",
    };
    // `alpha` < `beta`, but alpha sits at depth 2 and beta at depth 0: the
    // shallow candidate is the one a root-level render is most likely to
    // show, and the order must say so regardless of key spelling.
    expect(contentWitness(fixture, new Set(["alpha", "beta"]))?.field).toBe("beta");
  });

  test("same depth and key: the full path breaks the tie", () => {
    const fixture = { rows: [{ label: "flawless-r0" }, { label: "flawless-r1" }] };
    const w = contentWitness(fixture, new Set(["label"]));
    expect(w).toEqual({ value: "flawless-r0", field: "label", path: "rows.0.label" });
  });

  test("the order is total: three candidates at mixed depths select deterministically", () => {
    const fixture = {
      rows: [
        { id: 1, note: "flawless-d2a" },
        { id: 2, note: "flawless-d2b" },
      ],
      mid: { znote: "flawless-d1z" },
      anote: "flawless-d0",
      bnote: "flawless-d1",
    };
    const rendered = new Set(["note", "znote", "anote", "bnote"]);
    // depth 0: anote  |  depth 1: bnote, znote  |  depth 2: note(rows.0), note(rows.1)
    expect(contentWitness(fixture, rendered)).toEqual({
      value: "flawless-d0",
      field: "anote",
      path: "anote",
    });
    // Remove the depth-0 candidate: depth 1, key order bnote < znote.
    const no0 = { ...fixture, anote: "plain" };
    expect(contentWitness(no0, rendered)).toEqual({
      value: "flawless-d1",
      field: "bnote",
      path: "bnote",
    });
    // Remove both depth-1 candidates: depth 2, path order rows.0 < rows.1.
    const no01 = { ...no0, mid: { znote: "plain" }, bnote: "plain" };
    expect(contentWitness(no01, rendered)).toEqual({
      value: "flawless-d2a",
      field: "note",
      path: "rows.0.note",
    });
  });
});

describe("contentWitness — nesting and envelopes", () => {
  test("a field nested in an object envelope qualifies with its path", () => {
    const w = contentWitness({ data: { greeting: "flawless-x" } }, new Set(["greeting"]));
    expect(w).toEqual({ value: "flawless-x", field: "greeting", path: "data.greeting" });
  });

  test("an array-of-objects envelope qualifies each row field at the row's depth", () => {
    const w = contentWitness({ items: [{ id: 1, title: "flawless-t1" }] }, new Set(["title"]));
    expect(w).toEqual({ value: "flawless-t1", field: "title", path: "items.0.title" });
  });

  test("the recursion visits every level: a sentinel deep under a non-rendered key still qualifies by its own key", () => {
    // The walk recurses into ALL values; a non-rendered intermediate key does
    // not block a rendered field below it.
    const w = contentWitness(
      { envelope: { wrapper: { greeting: "flawless-deep" } } },
      new Set(["greeting"]),
    );
    expect(w).toEqual({
      value: "flawless-deep",
      field: "greeting",
      path: "envelope.wrapper.greeting",
    });
  });
});
