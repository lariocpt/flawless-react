import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { analyse, createAnalyseSharedContext } from "../src/analyse/index.ts";

const FIXTURES = path.resolve(__dirname, "fixtures");

describe("analyse wall-clock", () => {
  test("the top-level fixture sweep stays an order of magnitude under the bound", async () => {
    const entries = readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".tsx") && !f.startsWith("_"))
      .map((f) => path.join(FIXTURES, f));
    // The sweep must actually sweep — an empty glob would pin nothing.
    expect(entries.length).toBeGreaterThan(20);

    const shared = createAnalyseSharedContext();
    const start = performance.now();
    for (const entry of entries) {
      try {
        await analyse({ entry, depth: 3, includeChildren: true }, shared);
      } catch (err) {
        // Non-detection fixtures (NoopConstant.tsx) throw by design; the sweep
        // tolerates exactly the error core.ts tolerates, nothing else.
        if (!(err instanceof Error && err.message.includes("could not locate a React component"))) {
          throw err;
        }
      }
    }
    const elapsed = performance.now() - start;

    // The bound exists to catch accidental O(n^2) walks or a typechecker
    // adoption, not to benchmark: 2000ms is ~40x the measured wall for this
    // set (~45ms cold on 2026-08-24, 41 entries, shared parse cache).
    expect(elapsed).toBeLessThan(2000);
  });
});
