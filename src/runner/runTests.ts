import { existsSync } from "node:fs";
import path from "node:path";
import type { AffectedSpecs } from "../changed.ts";
import { grepFor, grepForRoutes } from "../changed.ts";
import { VITEST_CONFIG } from "../suiteScripts.ts";
import type { TaskId } from "../types.ts";

/** One suite invocation the runner will spawn, in order. */
export interface PlannedRun {
  id: string;
  cmd: string[];
}

/**
 * The command plan for a full generated-suite run — a PURE function (FR-019:
 * the two shipped bugs in this module both lived in these branches, guarded
 * only by comments; tests/runPlan.test.ts pins the matrix now).
 *
 * Standalone suites carry test:* scripts in their own package.json; Next.js
 * mode runs the target project's flawless:* scripts. The browser suite needs
 * BOTH unit-browser and perf-harness: its specs mount through perf-harness's
 * host, so the script exists only when both were generated — asking for it
 * otherwise invoked a script that had never been written. Standalone suites
 * have no e2e script at all.
 */
/**
 * What a suite-run phase actually DID.
 *
 * `ran` is the number of suites that were spawned, and it exists because
 * `green` alone cannot tell "every suite passed" from "no suite ran" — both
 * were `true`. Both runners returned that bare boolean and both said so out
 * loud ("all generated/affected suites passed") over an EMPTY plan, which is
 * the false pass this project exists to kill: FR-042 reached it through plain
 * `--changed --tasks e2e`, FR-043 through `--run-tests` with an `--out` dir
 * that happened to hold a package.json.
 *
 * The rule at every call site: check `ran === 0` BEFORE reading `green`.
 */
export interface SuiteRunOutcome {
  /** Suites actually spawned. Zero means nothing ran — never report green. */
  ran: number;
  /** No spawned suite failed. Meaningless unless `ran > 0`. */
  green: boolean;
  /** Why nothing ran. Set exactly when `ran === 0`, for the caller to relay. */
  reason?: string;
}

export function planGeneratedRuns(selectedTasks: TaskId[], standalone: boolean): PlannedRun[] {
  const prefix = standalone ? "test" : "flawless";
  const script = (name: string): string[] => ["bun", "run", `${prefix}:${name}`];
  const runs: PlannedRun[] = [];
  if (selectedTasks.includes("unit-browser")) runs.push({ id: "unit", cmd: script("unit") });
  if (selectedTasks.includes("perf-harness")) runs.push({ id: "perf", cmd: script("perf") });
  if (selectedTasks.includes("unit-browser") && selectedTasks.includes("perf-harness")) {
    runs.push({ id: "browser", cmd: script("browser") });
  }
  if (!standalone && selectedTasks.includes("e2e")) {
    runs.push({ id: "e2e", cmd: script("e2e") });
  }
  return runs;
}

/**
 * Run the generated suites. Standalone mode (no nextRoot): the suite is its
 * own package under outDir with test:* scripts. Next.js mode: the target
 * project's package.json carries flawless:* scripts and owns node_modules,
 * so everything runs with cwd = nextRoot.
 */
export async function runGeneratedTests(
  outDir: string,
  selectedTasks: TaskId[],
  nextRoot?: string,
  quiet = false,
): Promise<SuiteRunOutcome> {
  // Under --json/--ci stdout is contractually one JSON blob; in quiet mode
  // everything the runner says — and the child suites' own stdout — goes to
  // stderr so the blob stays parseable on exactly the red runs it exists for.
  const say = sayInto(quiet);
  const standalone = existsSync(path.join(path.resolve(outDir), "package.json"));
  const cwd = standalone ? path.resolve(outDir) : (nextRoot ?? path.resolve(outDir));

  if (!existsSync(path.join(cwd, "node_modules"))) {
    say(`\n› bun install in ${cwd}\n`);
    await spawn("bun", ["install"], cwd, quiet);
  }

  const wantsPlaywright =
    selectedTasks.includes("perf-harness") ||
    selectedTasks.includes("unit-browser") ||
    selectedTasks.includes("e2e");
  if (wantsPlaywright) {
    await ensureChromium(cwd, quiet);
  }

  const scripts = planGeneratedRuns(selectedTasks, standalone);

  // FR-043. Checked BEFORE anything is spawned, because the loop below cannot
  // distinguish an empty plan from a plan that all passed — it reports both as
  // "all generated suites passed".
  //
  // The previous comment here claimed this was unreachable through runCore.
  // That was WRONG, and the correctness lens refuted it with a repro:
  // `standalone` is `existsSync(outDir/package.json)`, NOT "outside Next.js
  // mode". Point --out at any directory holding a package.json — a leftover
  // standalone suite, a package root — and `standalone` is true inside Next.js
  // mode, where planGeneratedRuns(["e2e"], true) plans nothing at all.
  if (scripts.length === 0) {
    const reason = `no generated suite matched the selected task(s): ${selectedTasks.join(", ")}`;
    say(`\n${reason}\n`);
    return { ran: 0, green: true, reason };
  }

  const failed: string[] = [];
  for (const s of scripts) {
    say(`\n› ${s.cmd.join(" ")}\n`);
    const ok = await spawn(s.cmd[0] as string, s.cmd.slice(1), cwd, quiet);
    if (!ok) failed.push(s.id);
  }

  if (failed.length > 0) {
    say(`\nfailed suites: ${failed.join(", ")}\n`);
    return { ran: scripts.length, green: false };
  }
  say("\nall generated suites passed\n");
  return { ran: scripts.length, green: true };
}

function sayInto(quiet: boolean): (s: string) => void {
  return (s) => void (quiet ? process.stderr : process.stdout).write(s);
}

/**
 * Best-effort chromium install so Playwright suites run hands-free. No
 * --with-deps (it sudo-prompts on Linux and would hang unattended runs);
 * bounded by a kill-timer; opt out with FLAWLESS_SKIP_BROWSER_INSTALL=1.
 */
const INSTALL_TIMEOUT_MS = 300_000;

async function ensureChromium(cwd: string, quiet = false): Promise<void> {
  if (process.env.FLAWLESS_SKIP_BROWSER_INSTALL === "1") return;
  sayInto(quiet)(
    "\n› bunx playwright install chromium (set FLAWLESS_SKIP_BROWSER_INSTALL=1 to skip)\n",
  );
  const proc = Bun.spawn(["bunx", "playwright", "install", "chromium"], {
    cwd,
    // fd 2: in quiet mode even the child's stdout belongs on stderr.
    stdout: quiet ? 2 : "inherit",
    stderr: "inherit",
  });
  const timer = setTimeout(() => proc.kill(), INSTALL_TIMEOUT_MS);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) {
    process.stderr.write(
      "playwright browser install failed — if suites can't find a browser, run: bunx playwright install chromium --with-deps\n",
    );
  }
}

async function spawn(cmd: string, args: string[], cwd: string, quiet = false): Promise<boolean> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    // fd 2: in quiet mode the child suite's stdout must not contaminate the
    // parent's stdout (the --json blob is the only thing allowed there).
    stdout: quiet ? 2 : "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  return code === 0;
}

/**
 * Run only the suites that cover the changed components.
 *
 * Two different narrowing mechanisms, because the two runners offer different
 * and better ones:
 *
 * - **vitest `--related`** walks the module graph, so it finds every spec that
 *   imports a changed file without the tool having to reproduce its own spec
 *   naming rules. It is also transitively correct for free.
 * - **Playwright `--grep`** anchored on `\b(Name): `, because every emitted
 *   title starts that way. Anchoring matters: a bare "Card" would also select
 *   CardHeader, CardFooter and CardTitle.
 *
 * e2e is selected by whether a page's tree RENDERS a changed component — the
 * relationship a path filter cannot see — and narrowed the same way, by
 * grepping for the route templates its titles embed.
 */
/**
 * The command plan for an affected-only run — pure, same discipline as
 * planGeneratedRuns. Unit narrowing keys on changed FILES (vitest `related`
 * walks the module graph from them), so it fires even when components+routes
 * are empty — the case of a change confined to an unexported component, which
 * has no spec name of its own but whose parent's spec DOES import it. An
 * affected set that matches no branch plans nothing; runAffectedTests then
 * reports why (nothing affected, or affected-but-unnarrowable).
 */
export function planAffectedRuns(
  outDir: string,
  selectedTasks: TaskId[],
  affected: AffectedSpecs,
  standalone: boolean,
): PlannedRun[] {
  // No blanket empty-set early return: the unit branch below keys on
  // affected.changedFiles, not components/routes, so vitest `related` must
  // still fire for a change confined to an UNEXPORTED component (no spec name
  // of its own, so components is empty) — related walks the module graph from
  // the file and reaches the parent's spec. An all-empty affected set still
  // matches no branch and returns [] naturally; runAffectedTests then reports
  // why. The old early return made --changed report "nothing affected" and
  // exit 0 green for exactly that change.
  const runs: PlannedRun[] = [];
  const prefix = standalone ? "test" : "flawless";

  if (selectedTasks.includes("unit-browser") && affected.changedFiles.length > 0) {
    // `related` is a vitest SUBCOMMAND, not a flag, so it cannot be appended to
    // the generated `vitest run` script — vitest exits with "Unknown option
    // --related". Invoking vitest directly with the emitted config is the only
    // way to reach it, and it is worth reaching: it walks the module graph, so
    // it finds every spec that transitively imports a changed file without this
    // tool having to reproduce its own spec-naming rules.
    const configPath = path.join(path.resolve(outDir), VITEST_CONFIG);
    runs.push({
      id: "unit",
      cmd: ["bunx", "vitest", "related", ...affected.changedFiles, "--run", "--config", configPath],
    });
  }
  if (affected.components.length > 0) {
    const grep = grepFor(affected.components);
    if (selectedTasks.includes("perf-harness")) {
      runs.push({ id: "perf", cmd: ["bun", "run", `${prefix}:perf`, "--", "--grep", grep] });
    }
    if (selectedTasks.includes("unit-browser") && selectedTasks.includes("perf-harness")) {
      runs.push({ id: "browser", cmd: ["bun", "run", `${prefix}:browser`, "--", "--grep", grep] });
    }
  }
  if (selectedTasks.includes("e2e") && affected.routes.length > 0) {
    // Same narrowing as perf/browser: every emitted e2e title embeds its route
    // template ("GET /things/[id] renders …"), so the affected routes select
    // their specs by grep — the whole suite must not run for one route.
    runs.push({
      id: "e2e",
      cmd: ["bun", "run", `${prefix}:e2e`, "--", "--grep", grepForRoutes(affected.routes)],
    });
  }
  return runs;
}

export async function runAffectedTests(
  outDir: string,
  selectedTasks: TaskId[],
  affected: AffectedSpecs,
  nextRoot?: string,
  quiet = false,
): Promise<SuiteRunOutcome> {
  const say = sayInto(quiet);
  const standalone = existsSync(path.join(path.resolve(outDir), "package.json"));
  const cwd = standalone ? path.resolve(outDir) : (nextRoot ?? path.resolve(outDir));

  const runs = planAffectedRuns(outDir, selectedTasks, affected, standalone);
  // FR-042. The old guard demanded runs.length === 0 AND both affected sets
  // empty, so an empty plan WITH affected work fell through the loop below and
  // announced "all affected suites passed" having spawned nothing. Two plain
  // routes reached it: --changed --tasks e2e when the edited component sits on
  // no page route, and --changed --tasks perf-harness when the only affected
  // work is a route. The plan being empty is the whole condition — what made
  // it empty only decides which sentence to say.
  if (runs.length === 0) {
    // withoutSpecs in the "nothing" test is load-bearing: a change confined to
    // unexported components is NOT "nothing affected" — the file changed and
    // is covered through a parent's spec. It is simply not reachable by a
    // task set that narrows by spec name.
    const nothingAffected =
      affected.components.length === 0 &&
      affected.routes.length === 0 &&
      affected.withoutSpecs.length === 0;
    let reason: string;
    if (nothingAffected) {
      reason = "changed: nothing affected — no specs to run";
    } else if (affected.components.length === 0 && affected.routes.length === 0) {
      reason = `changed: ${affected.withoutSpecs.length} unexported component(s) changed (covered through a parent's spec), but the selected task(s) (${selectedTasks.join(", ")}) narrow by spec name and cannot reach them — add unit-browser to run vitest \`related\``;
    } else {
      reason = `changed: ${affected.components.length} affected component(s) and ${affected.routes.length} affected route(s), but the selected task(s) (${selectedTasks.join(", ")}) plan no run for them`;
    }
    say(`\n${reason}\n`);
    return { ran: 0, green: true, reason };
  }

  const failed: string[] = [];
  for (const r of runs) {
    say(`\n› ${r.cmd.join(" ")}\n`);
    const ok = await spawn(r.cmd[0] as string, r.cmd.slice(1), cwd, quiet);
    if (!ok) failed.push(r.id);
  }
  if (failed.length > 0) {
    say(`\nfailed suites: ${failed.join(", ")}\n`);
    return { ran: runs.length, green: false };
  }
  say("\nall affected suites passed\n");
  return { ran: runs.length, green: true };
}
