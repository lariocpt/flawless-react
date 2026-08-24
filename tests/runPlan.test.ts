import { describe, expect, test } from "bun:test";
import path from "node:path";
import { grepFor, grepForRoutes } from "../src/changed.ts";
import { planAffectedRuns, planGeneratedRuns } from "../src/runner/runTests.ts";
import { VITEST_CONFIG } from "../src/suiteScripts.ts";
import type { TaskId } from "../src/types.ts";

/**
 * FR-019: runner/runTests.ts is the module two shipped bugs lived in — the
 * browser script invoked when it was never written, and the browser suite
 * written and then never run — and its planning branches were guarded only
 * by comments naming those regressions. The planning is now a pure function,
 * and this matrix pins every branch: standalone vs Next.js script names, the
 * browser double-gate, vitest `related` vs playwright `--grep`, and the
 * nothing-affected early exit.
 */

const OUT = "/proj/flawless";

function ids(runs: Array<{ id: string }>): string[] {
  return runs.map((r) => r.id);
}

describe("planGeneratedRuns", () => {
  test("standalone: unit alone runs only test:unit — the browser script does not exist", () => {
    const runs = planGeneratedRuns(["unit-browser"], true);
    expect(ids(runs)).toEqual(["unit"]);
    expect(runs[0]?.cmd).toEqual(["bun", "run", "test:unit"]);
  });

  test("standalone: unit + perf adds the browser suite, in stable order", () => {
    const runs = planGeneratedRuns(["unit-browser", "perf-harness"], true);
    expect(ids(runs)).toEqual(["unit", "perf", "browser"]);
    expect(runs[2]?.cmd).toEqual(["bun", "run", "test:browser"]);
  });

  test("standalone: perf alone runs only test:perf", () => {
    expect(ids(planGeneratedRuns(["perf-harness"], true))).toEqual(["perf"]);
  });

  test("standalone has no e2e script — e2e alone plans nothing", () => {
    expect(planGeneratedRuns(["e2e"], true)).toEqual([]);
  });

  test("Next.js mode uses the flawless:* scripts and includes e2e", () => {
    const runs = planGeneratedRuns(["unit-browser", "perf-harness", "e2e"], false);
    expect(ids(runs)).toEqual(["unit", "perf", "browser", "e2e"]);
    expect(runs.map((r) => r.cmd[2])).toEqual([
      "flawless:unit",
      "flawless:perf",
      "flawless:browser",
      "flawless:e2e",
    ]);
  });

  test("non-runnable tasks plan nothing", () => {
    expect(planGeneratedRuns(["perf-static", "a11y"] as TaskId[], false)).toEqual([]);
  });
});

describe("planAffectedRuns", () => {
  const affected = (over: Partial<Parameters<typeof planAffectedRuns>[2]> = {}) => ({
    changedFiles: ["/proj/src/Card.tsx"],
    components: ["Card"],
    routes: [],
    withoutSpecs: [],
    ...over,
  });

  test("no affected components or routes plans nothing at all", () => {
    expect(
      planAffectedRuns(
        OUT,
        ["unit-browser", "perf-harness", "e2e"],
        affected({ changedFiles: [], components: [], routes: [] }),
        true,
      ),
    ).toEqual([]);
  });

  test("unit narrows through vitest `related` with the emitted config", () => {
    const runs = planAffectedRuns(OUT, ["unit-browser"], affected(), true);
    expect(ids(runs)).toEqual(["unit"]);
    expect(runs[0]?.cmd).toEqual([
      "bunx",
      "vitest",
      "related",
      "/proj/src/Card.tsx",
      "--run",
      "--config",
      path.join(path.resolve(OUT), VITEST_CONFIG),
    ]);
  });

  test("perf and browser narrow through an anchored --grep; browser needs both tasks", () => {
    const both = planAffectedRuns(OUT, ["unit-browser", "perf-harness"], affected(), true);
    expect(ids(both)).toEqual(["unit", "perf", "browser"]);
    expect(both[1]?.cmd).toEqual(["bun", "run", "test:perf", "--", "--grep", grepFor(["Card"])]);
    expect(both[2]?.cmd).toEqual(["bun", "run", "test:browser", "--", "--grep", grepFor(["Card"])]);
    const unitOnly = planAffectedRuns(OUT, ["unit-browser"], affected(), true);
    expect(ids(unitOnly)).toEqual(["unit"]);
  });

  test("e2e narrows by the route templates its titles embed", () => {
    const runs = planAffectedRuns(OUT, ["e2e"], affected({ routes: ["/things/[id]"] }), false);
    expect(ids(runs)).toEqual(["e2e"]);
    expect(runs[0]?.cmd).toEqual([
      "bun",
      "run",
      "flawless:e2e",
      "--",
      "--grep",
      grepForRoutes(["/things/[id]"]),
    ]);
  });

  test("Next.js mode uses the flawless:* prefix for the grep runs", () => {
    const runs = planAffectedRuns(OUT, ["perf-harness"], affected(), false);
    expect(runs[0]?.cmd?.[2]).toBe("flawless:perf");
  });

  test("unit is planned only when changed FILES exist, not just components", () => {
    const runs = planAffectedRuns(
      OUT,
      ["unit-browser", "perf-harness"],
      affected({ changedFiles: [] }),
      true,
    );
    expect(ids(runs)).toEqual(["perf", "browser"]);
  });
});
