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
): Promise<boolean> {
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

  const failed: string[] = [];
  for (const s of scripts) {
    say(`\n› ${s.cmd.join(" ")}\n`);
    const ok = await spawn(s.cmd[0] as string, s.cmd.slice(1), cwd, quiet);
    if (!ok) failed.push(s.id);
  }

  if (failed.length > 0) {
    say(`\nfailed suites: ${failed.join(", ")}\n`);
    return false;
  }
  // "all generated suites passed" over an empty plan is a false pass in
  // waiting. Unreachable through runCore today — `standalone` is only true
  // outside Next.js mode, where the one task that plans nothing standalone
  // (e2e) has already failed and blocked this call — but the claim is written
  // here, not there, and the next caller need not preserve that accident.
  if (scripts.length === 0) {
    say(`\nno generated suite matched the selected task(s): ${selectedTasks.join(", ")}\n`);
    return true;
  }
  say("\nall generated suites passed\n");
  return true;
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
 * planGeneratedRuns. An empty components+routes set plans nothing at all
 * (the runner reports "nothing affected"); unit narrowing keys on changed
 * FILES because vitest `related` walks the module graph from them.
 */
export function planAffectedRuns(
  outDir: string,
  selectedTasks: TaskId[],
  affected: AffectedSpecs,
  standalone: boolean,
): PlannedRun[] {
  if (affected.components.length === 0 && affected.routes.length === 0) return [];

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
): Promise<boolean> {
  const say = sayInto(quiet);
  const standalone = existsSync(path.join(path.resolve(outDir), "package.json"));
  const cwd = standalone ? path.resolve(outDir) : (nextRoot ?? path.resolve(outDir));

  const runs = planAffectedRuns(outDir, selectedTasks, affected, standalone);
  if (runs.length === 0 && affected.components.length === 0 && affected.routes.length === 0) {
    say("\nchanged: nothing affected — no specs to run\n");
    return true;
  }

  const failed: string[] = [];
  for (const r of runs) {
    say(`\n› ${r.cmd.join(" ")}\n`);
    const ok = await spawn(r.cmd[0] as string, r.cmd.slice(1), cwd, quiet);
    if (!ok) failed.push(r.id);
  }
  if (failed.length > 0) {
    say(`\nfailed suites: ${failed.join(", ")}\n`);
    return false;
  }
  say("\nall affected suites passed\n");
  return true;
}
