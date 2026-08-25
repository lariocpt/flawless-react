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
    expect(await runGeneratedTests(dir, ["unit-browser"])).toEqual({ ran: 1, green: false });
  });

  test("reports success when the suites pass", async () => {
    const dir = suiteDir({ "test:unit": "exit 0" });
    expect(await runGeneratedTests(dir, ["unit-browser"])).toEqual({ ran: 1, green: true });
  });

  // FR-043. An empty plan used to return the same bare `true` as a clean run
  // and announce "all generated suites passed". The PR that added the guard
  // claimed this was unreachable through runCore; it is not — `standalone` is
  // existsSync(outDir/package.json), so an --out directory holding one puts
  // Next.js mode on the standalone plan, where e2e plans nothing at all.
  test("an empty plan reports ran:0 and never claims the suites passed", async () => {
    // Every script fails, so a green here can only mean nothing was spawned.
    const dir = suiteDir({ "test:unit": "exit 1", "test:perf": "exit 1" });
    const outcome = await runGeneratedTests(dir, ["e2e"]);
    expect(outcome.ran).toBe(0);
    expect(outcome.reason).toContain("no generated suite matched");
  });

  // Control for the test above: the SAME suiteDir with a task that does plan a
  // run reports ran > 0, so ran:0 is a statement about the plan and not just
  // what this fixture always returns.
  test("a task that does plan a run reports ran > 0 from the same fixture", async () => {
    const dir = suiteDir({ "test:unit": "exit 1", "test:perf": "exit 1" });
    const outcome = await runGeneratedTests(dir, ["unit-browser"]);
    expect(outcome.ran).toBeGreaterThan(0);
    expect(outcome.reason).toBeUndefined();
  });
});

describe("quiet mode", () => {
  // Under --json/--ci stdout is contractually one JSON blob, but the runner
  // used to write its banners (and inherit the child suites' stdout) straight
  // into it, so `--ci --run-tests` emitted unparseable output on exactly the
  // red runs the blob exists for. In quiet mode everything the runner says —
  // its own lines and the child processes' stdout — must land on stderr.
  test("keeps stdout empty while a suite fails loudly on stderr", async () => {
    const dir = suiteDir({ "test:unit": "echo suite-noise && exit 1" });
    const runner = path.resolve(__dirname, "../src/runner/runTests.ts");
    const script = [
      `process.env.FLAWLESS_SKIP_BROWSER_INSTALL = "1";`,
      `const { runGeneratedTests } = await import(${JSON.stringify(runner)});`,
      `const outcome = await runGeneratedTests(${JSON.stringify(dir)}, ["unit-browser"], undefined, true);`,
      `process.stdout.write(JSON.stringify({ ok: outcome.green }));`,
    ].join("\n");
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    // stdout is exactly the caller's blob — parseable, nothing else.
    expect(JSON.parse(stdout)).toEqual({ ok: false });
    // The runner's account (banner + verdict + the child's own stdout) moved.
    expect(stderr).toContain("failed suites: unit");
    expect(stderr).toContain("suite-noise");
  }, 30000);
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
    expect(await runAffectedTests(dir, ["perf-harness"], affected(["X"]))).toEqual({
      ran: 1,
      green: false,
    });
  });

  test("reports success when the affected suites pass", async () => {
    const dir = suiteDir({ "test:perf": "exit 0 #" });
    expect(await runAffectedTests(dir, ["perf-harness"], affected(["X"]))).toEqual({
      ran: 1,
      green: true,
    });
  });

  test("nothing affected: succeeds without running any suite", async () => {
    // The script fails on purpose — a green here is only possible if no spawn happened.
    const dir = suiteDir({ "test:perf": "exit 1 #" });
    const outcome = await runAffectedTests(dir, ["perf-harness"], affected([], []));
    expect(outcome).toMatchObject({ ran: 0, green: true });
    expect(outcome.reason).toContain("nothing affected");
  });

  // FR-042, both reachable shapes. The old guard required an empty plan AND
  // both affected sets empty, so an empty plan with affected WORK fell through
  // to `say("all affected suites passed")` and returned green having spawned
  // nothing. Every script here exits 1, so green can only mean no spawn.
  test("affected components but no task that can run them: ran:0, and it says why", async () => {
    // --changed --tasks e2e where the edited component sits on no page route.
    const dir = suiteDir({ "test:perf": "exit 1 #", "test:e2e": "exit 1 #" });
    const outcome = await runAffectedTests(dir, ["e2e"], affected(["Badge"], []));
    expect(outcome.ran).toBe(0);
    expect(outcome.reason).toContain("plan no run for them");
    // The old bug in one assertion: it must not report a mode that promises
    // suites ran. Nothing spawned, so nothing may claim to have passed.
    expect(outcome.reason).not.toContain("all affected suites passed");
  });

  test("affected routes but only perf-harness selected: ran:0, and it says why", async () => {
    const dir = suiteDir({ "test:perf": "exit 1 #" });
    const outcome = await runAffectedTests(dir, ["perf-harness"], affected([], ["/things/[id]"]));
    expect(outcome.ran).toBe(0);
    expect(outcome.reason).toContain("plan no run for them");
  });

  test("the e2e run is narrowed with --grep, not run whole", async () => {
    // Affected routes must reach playwright as `--grep <pattern>` the way
    // perf/browser already do — every emitted e2e title embeds its route
    // template, so running the whole e2e suite for one route is pure waste.
    // bun run appends passthrough args to the script's command LINE (they are
    // not positional params of the script shell — that is the quirk behind
    // suiteDir's `#` note), so a shell function is what can count them: the
    // appended `--grep <pattern>` become the function's own "$@".
    const dir = suiteDir({
      "test:e2e": 'f(){ [ "$1" = "--grep" ] && [ -n "$2" ] && exit 0 || exit 1; }; f',
    });
    expect(await runAffectedTests(dir, ["e2e"], affected([], ["/things/[id]"]))).toEqual({
      ran: 1,
      green: true,
    });
  });
});
