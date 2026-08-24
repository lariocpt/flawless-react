import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AffectedSpecs } from "../src/changed.ts";
import { runAffectedTests, runGeneratedTests } from "../src/runner/runTests.ts";

const tmpDirs: string[] = [];

// bun test runs every test file in one process, so an env var set here leaks
// into whichever file runs next; restore whatever value the process started with.
let savedSkipInstall: string | undefined;

beforeAll(() => {
  savedSkipInstall = process.env.FLAWLESS_SKIP_BROWSER_INSTALL;
  process.env.FLAWLESS_SKIP_BROWSER_INSTALL = "1";
});

afterAll(() => {
  if (savedSkipInstall === undefined) delete process.env.FLAWLESS_SKIP_BROWSER_INSTALL;
  else process.env.FLAWLESS_SKIP_BROWSER_INSTALL = savedSkipInstall;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** A standalone suite dir with the given test:* scripts.
 *
 * Scripts that must ignore their arguments end in `#`: the affected-run path
 * appends `-- --grep <pattern>` and bash's `exit` builtin errors out (code 1)
 * when handed extra arguments, which would turn an intended `exit 0` red. */
function suiteDir(scripts: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-run-"));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "suite", scripts }));
  // Present so the runners skip their bun install step.
  mkdirSync(path.join(dir, "node_modules"));
  return dir;
}

describe("runGeneratedTests", () => {
  // --run-tests used to discard the suites' outcome entirely: runCore computed
  // its exit code from generation failures alone, so a CI consumer shipped
  // green on red. The return value here is what core.ts folds into exitCode.
  test("reports failure when a generated suite fails", async () => {
    const dir = suiteDir({ "test:unit": "exit 1" });
    expect(await runGeneratedTests(dir, ["unit-browser"])).toBe(false);
  });

  test("reports success when the suites pass", async () => {
    const dir = suiteDir({ "test:unit": "exit 0" });
    expect(await runGeneratedTests(dir, ["unit-browser"])).toBe(true);
  });
});

describe("runAffectedTests", () => {
  const affected = (components: string[], routes: string[] = []): AffectedSpecs => ({
    changedFiles: [],
    components,
    routes,
    withoutSpecs: [],
  });

  test("reports failure when an affected suite fails", async () => {
    const dir = suiteDir({ "test:perf": "exit 1 #" });
    expect(await runAffectedTests(dir, ["perf-harness"], affected(["X"]))).toBe(false);
  });

  test("reports success when the affected suites pass", async () => {
    const dir = suiteDir({ "test:perf": "exit 0 #" });
    expect(await runAffectedTests(dir, ["perf-harness"], affected(["X"]))).toBe(true);
  });

  test("nothing affected: succeeds without running any suite", async () => {
    // The script fails on purpose — a true here is only possible if no spawn happened.
    const dir = suiteDir({ "test:perf": "exit 1 #" });
    expect(await runAffectedTests(dir, ["perf-harness"], affected([], []))).toBe(true);
  });
});
