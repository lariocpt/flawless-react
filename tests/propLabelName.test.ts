// `+{step}` is the accessible name "+1", not "1".
//
// The label model used to answer a prop interpolation with just the prop, and
// every matcher then queried the exact name of the VALUE — a click spec no
// rendered DOM can satisfy whenever the source wrapped static copy around the
// interpolation. These cover both halves: the extraction that must carry the
// static text, and the four emit sites that must compose it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { emitPlaywrightSelector, emitVitestSelector } from "../src/scaffold-tests/selectors.ts";
import { emitNativeSelector } from "../src/scaffold-tests/selectorsNative.ts";
import type { ClickHandler } from "../src/types.ts";

const propHandler = (
  over: Partial<Extract<ClickHandler["label"], { kind: "prop" }>> = {},
): ClickHandler => ({
  event: "onClick",
  tag: "button",
  label: { kind: "prop", propName: "step", ...over },
  hints: {},
  binding: { kind: "inline" },
});

describe("a prop interpolated into static copy", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-proplabel-"));
  const file = path.join(dir, "Stepper.tsx");
  writeFileSync(
    file,
    `import * as React from "react";
export function Stepper({ step, label, both }: { step: number; label: string; both: string }) {
  return (
    <div>
      <button onClick={() => {}}>+{step}</button>
      <button onClick={() => {}}>{label}</button>
      <button onClick={() => {}}>[{both}]</button>
    </div>
  );
}
`,
  );

  test("the static halves ride along with the prop label", async () => {
    const tree = await analyse({ entry: file, depth: 0, includeChildren: false });
    const info = tree.entry;
    const labels = (info.interactions?.clicks ?? []).map((c) => c.label);
    const plus = labels.find((l) => l.kind === "prop" && l.propName === "step");
    expect(plus).toMatchObject({ kind: "prop", before: "+" });
    expect((plus as { after?: string }).after).toBeUndefined();
    // A bare interpolation keeps the old shape: nothing static to carry.
    const bare = labels.find((l) => l.kind === "prop" && l.propName === "label");
    expect(bare).toEqual({ kind: "prop", propName: "label" });
    // Static text on BOTH sides is the accname " [<both>] " case.
    const both = labels.find((l) => l.kind === "prop" && l.propName === "both");
    expect(both).toMatchObject({ kind: "prop", before: "[", after: "]" });
  });

  test("Testing Library composes an anchored, case-insensitive name regex", () => {
    const sel = emitVitestSelector(propHandler({ before: "+" }));
    expect(sel).toContain('getAllByRole("button", { name: new RegExp(');
    expect(sel).toContain('"^" + "\\\\+" + "\\\\s*"');
    expect(sel).toContain('String(DEFAULTS["step"] ?? "").replace(/');
    expect(sel).toContain('"\\\\s*" + "$", "i")');
    // No static halves: the exact-string matcher is untouched.
    expect(emitVitestSelector(propHandler())).toContain('{ name: String(DEFAULTS["step"] ?? "") }');
  });

  test("Playwright composes a case-SENSITIVE regex (exact:true's semantics)", () => {
    const sel = emitPlaywrightSelector(propHandler({ before: "+", after: " items" }));
    expect(sel).toContain('page.getByRole("button", { name: new RegExp(');
    expect(sel).toContain('" items"');
    expect(sel).not.toContain("exact: true");
    expect(sel).not.toContain('"i"');
  });

  test("the native text rung matches the rendered string, not the bare value", () => {
    const withStatic = emitNativeSelector(propHandler({ before: "+" }));
    expect(withStatic?.locator).toContain("getAllByText(new RegExp(");
    const bare = emitNativeSelector(propHandler());
    expect(bare?.locator).toContain('getAllByText(String(DEFAULTS["step"] ?? ""))');
  });
});
