import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGeneratedTests } from "../src/runner/runTests.ts";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** A standalone suite dir whose test:unit script exits with the given code. */
function suiteDir(exitCode: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-run-"));
  tmpDirs.push(dir);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "suite", scripts: { "test:unit": `exit ${exitCode}` } }),
  );
  // Present so runGeneratedTests skips its bun install step.
  mkdirSync(path.join(dir, "node_modules"));
  return dir;
}

describe("runGeneratedTests", () => {
  // --run-tests used to discard the suites' outcome entirely: runCore computed
  // its exit code from generation failures alone, so a CI consumer shipped
  // green on red. The return value here is what core.ts folds into exitCode.
  test("reports failure when a generated suite fails", async () => {
    process.env.FLAWLESS_SKIP_BROWSER_INSTALL = "1";
    expect(await runGeneratedTests(suiteDir(1), ["unit-browser"])).toBe(false);
  });

  test("reports success when the suites pass", async () => {
    process.env.FLAWLESS_SKIP_BROWSER_INSTALL = "1";
    expect(await runGeneratedTests(suiteDir(0), ["unit-browser"])).toBe(true);
  });
});
