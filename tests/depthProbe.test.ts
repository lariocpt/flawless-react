import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  deriveSpecs,
  loadTable,
  type Mutation,
  type MutationTable,
  runProbe,
  validateMutation,
} from "../scripts/depth-probe.ts";

/**
 * The mutation probe's mechanics without a real app (PLAN-00 D0c): a fixture
 * app whose fake spec-runner reddens when a literal the spec asserts has
 * vanished from the (mutated) source. What is under test is the probe's
 * bookkeeping — apply/revert, derived spec selection, refusal of ambiguous
 * oldText, the no-spec bucket, tier attribution — not vitest itself.
 */

const WIDGET = `"use client";
// Widget renders the save affordance.
export const Widget = ({ onPress }: { onPress?: () => void }) => (
  <button onClick={onPress}>Save</button>
);
`;

// Line 5 is the T1 text assertion; line 9 the T2 spy assertion.
const WIDGET_SPEC = `import { Widget } from "../../src/widget";

test("renders copy", () => {
  render(<Widget />);
  expect(screen.getAllByText("Save").length).toBeGreaterThan(0);
});

test("click fires onPress", () => {
  expect(handlers.onPress).toHaveBeenCalled();
});
`;

const ORPHAN = `export const Orphan = () => <p>Nothing imports me</p>;\n`;

function fixture(): string {
  mkdirSync(path.join(import.meta.dir, ".tmp"), { recursive: true });
  const root = mkdtempSync(path.join(import.meta.dir, ".tmp", "depth-probe-"));
  mkdirSync(path.join(root, "app/src"), { recursive: true });
  mkdirSync(path.join(root, "app/flawless/unit"), { recursive: true });
  writeFileSync(path.join(root, "app/src/widget.tsx"), WIDGET);
  writeFileSync(path.join(root, "app/src/orphan.tsx"), ORPHAN);
  writeFileSync(path.join(root, "app/flawless/unit/Widget.test.tsx"), WIDGET_SPEC);
  return root;
}

function table(appDir: string, mutations: Mutation[]): MutationTable {
  return { target: "fixture", tree: "fixture", appDir, suiteDir: "flawless/unit", mutations };
}

/**
 * The fake runner: red when a literal the spec's text query asserts is no
 * longer present in the source on disk (which the probe has just mutated).
 * Failures name the failing test and the line of the expect that failed.
 */
function makeRunner(appDir: string) {
  return async (specRel: string) => {
    const spec = readFileSync(path.join(appDir, specRel), "utf8");
    const source = readFileSync(path.join(appDir, "src/widget.tsx"), "utf8");
    const failures: { test: string; line: number | null }[] = [];
    const lines = spec.split("\n");
    lines.forEach((line, i) => {
      const m = /getAllByText\("([^"]+)"\)/.exec(line);
      if (m && !source.includes(m[1] as string)) {
        failures.push({ test: "renders copy", line: i + 1 });
      }
    });
    return { red: failures.length > 0, failures };
  };
}

describe("depth-probe mechanics", () => {
  test("a mutation that reddens the derived spec is CAUGHT, with the assertion line and its tier", async () => {
    const root = fixture();
    const appDir = path.join(root, "app");
    const result = await runProbe(
      table(appDir, [
        {
          name: "rename rendered field",
          file: "src/widget.tsx",
          oldText: ">Save<",
          newText: ">Submit<",
          intent: "the button copy changes",
          expectedTier: "T1",
        },
      ]),
      makeRunner(appDir),
    );
    expect(result.results[0]?.status).toBe("caught");
    expect(result.results[0]?.specsRun).toEqual(["flawless/unit/Widget.test.tsx"]);
    const by = result.results[0]?.caughtBy[0];
    expect(by?.test).toBe("renders copy");
    expect(by?.line).toBe(5);
    expect(by?.tier).toBe("T1");
    expect(by?.tierSource).toBe("assertion-line");
    expect(result.caught).toBe(1);
    expect(result.missed).toEqual([]);
    // the tree is byte-exactly reverted
    expect(readFileSync(path.join(appDir, "src/widget.tsx"), "utf8")).toBe(WIDGET);
  });

  test("a caught mutation whose catching tier differs from the expected tier is a tier finding", async () => {
    const root = fixture();
    const appDir = path.join(root, "app");
    const result = await runProbe(
      table(appDir, [
        {
          name: "copy change tagged T2",
          file: "src/widget.tsx",
          oldText: ">Save<",
          newText: ">Submit<",
          intent: "tagged as behaviour, actually caught by copy",
          expectedTier: "T2",
        },
      ]),
      makeRunner(appDir),
    );
    expect(result.results[0]?.status).toBe("caught");
    expect(result.results[0]?.tierMatch).toBe(false);
    expect(result.results[0]?.caughtBy[0]?.tier).toBe("T1");
  });

  test("a control mutation that stays green is control-ok and never scored", async () => {
    const root = fixture();
    const appDir = path.join(root, "app");
    const result = await runProbe(
      table(appDir, [
        {
          name: "comment edit",
          file: "src/widget.tsx",
          oldText: "// Widget renders the save affordance.",
          newText: "// Widget renders the save button.",
          intent: "no observable effect",
          expectedTier: "T1",
          control: true,
        },
      ]),
      makeRunner(appDir),
    );
    expect(result.results[0]?.controlGreen).toBe(true);
    expect(result.controls).toEqual({ total: 1, green: 1 });
    expect(result.scored).toBe(0);
    expect(readFileSync(path.join(appDir, "src/widget.tsx"), "utf8")).toBe(WIDGET);
  });

  test("a non-unique oldText is refused before anything is written", async () => {
    const root = fixture();
    const appDir = path.join(root, "app");
    let threw = "";
    try {
      await runProbe(
        table(appDir, [
          {
            name: "ambiguous",
            file: "src/widget.tsx",
            oldText: "onPress",
            newText: "Submit",
            intent: "occurs twice — the probe must refuse, not guess",
            expectedTier: "T1",
          },
        ]),
        makeRunner(appDir),
      );
    } catch (err) {
      threw = String(err);
    }
    expect(threw).toContain("refused");
    expect(threw).toContain("ambiguous");
    expect(readFileSync(path.join(appDir, "src/widget.tsx"), "utf8")).toBe(WIDGET);
  });

  test("a missing oldText is refused the same way", () => {
    const refusal = validateMutation(WIDGET, {
      name: "ghost",
      file: "src/widget.tsx",
      oldText: "Export",
      newText: "Import",
      intent: "not in the file",
      expectedTier: "T1",
    });
    expect(refusal).toContain("not found");
  });

  test("a mutation whose file no spec covers is 'no spec covers this file' — never caught, never missed", async () => {
    const root = fixture();
    const appDir = path.join(root, "app");
    const result = await runProbe(
      table(appDir, [
        {
          name: "orphan copy",
          file: "src/orphan.tsx",
          oldText: "Nothing imports me",
          newText: "Nothing imports me either",
          intent: "no emitted spec imports this file",
          expectedTier: "T1",
        },
      ]),
      makeRunner(appDir),
    );
    expect(result.results[0]?.status).toBe("no-spec");
    expect(result.missed).toEqual([]);
    expect(result.caught).toBe(0);
    expect(result.scored).toBe(0);
  });

  test("spec selection is derived from imports, not from names", () => {
    const root = fixture();
    const appDir = path.join(root, "app");
    expect(deriveSpecs(appDir, "flawless/unit", "src/widget.tsx")).toEqual([
      "flawless/unit/Widget.test.tsx",
    ]);
    expect(deriveSpecs(appDir, "flawless/unit", "src/orphan.tsx")).toEqual([]);
  });

  test("loadTable refuses an empty mutation list", () => {
    const root = fixture();
    const f = path.join(root, "empty.json");
    writeFileSync(
      f,
      JSON.stringify({ target: "x", tree: "x", appDir: root, suiteDir: "u", mutations: [] }),
    );
    expect(() => loadTable(f)).toThrow("required");
  });
});
