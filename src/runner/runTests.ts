import { existsSync } from "node:fs";
import path from "node:path";
import type { AffectedSpecs } from "../changed.ts";
import { grepFor } from "../changed.ts";
import type { TaskId } from "../types.ts";

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
): Promise<void> {
  const standalone = existsSync(path.join(path.resolve(outDir), "package.json"));
  const cwd = standalone ? path.resolve(outDir) : (nextRoot ?? path.resolve(outDir));

  if (!existsSync(path.join(cwd, "node_modules"))) {
    process.stdout.write(`\n› bun install in ${cwd}\n`);
    await spawn("bun", ["install"], cwd);
  }

  const wantsPlaywright =
    selectedTasks.includes("perf-harness") ||
    selectedTasks.includes("unit-browser") ||
    selectedTasks.includes("e2e");
  if (wantsPlaywright) {
    await ensureChromium(cwd);
  }

  const scripts: Array<{ id: string; cmd: string[] }> = [];
  const script = (name: string): string[] => ["bun", "run", name];
  if (standalone) {
    if (selectedTasks.includes("unit-browser"))
      scripts.push({ id: "unit", cmd: script("test:unit") });
    if (selectedTasks.includes("perf-harness"))
      scripts.push({ id: "perf", cmd: script("test:perf") });
    if (selectedTasks.includes("unit-browser"))
      scripts.push({ id: "browser", cmd: script("test:browser") });
  } else {
    if (selectedTasks.includes("unit-browser"))
      scripts.push({ id: "unit", cmd: script("flawless:unit") });
    if (selectedTasks.includes("perf-harness"))
      scripts.push({ id: "perf", cmd: script("flawless:perf") });
    // The browser suite was written into package.json (core.ts) and then never
    // run, so --run-tests generated browser specs, skipped them, and reported
    // "all generated suites passed". The --changed path already ran it.
    if (selectedTasks.includes("unit-browser"))
      scripts.push({ id: "browser", cmd: script("flawless:browser") });
    if (selectedTasks.includes("e2e")) scripts.push({ id: "e2e", cmd: script("flawless:e2e") });
  }

  const failed: string[] = [];
  for (const s of scripts) {
    process.stdout.write(`\n› ${s.cmd.join(" ")}\n`);
    const ok = await spawn(s.cmd[0] as string, s.cmd.slice(1), cwd);
    if (!ok) failed.push(s.id);
  }

  if (failed.length > 0) {
    process.stdout.write(`\nfailed suites: ${failed.join(", ")}\n`);
  } else {
    process.stdout.write("\nall generated suites passed\n");
  }
}

/**
 * Best-effort chromium install so Playwright suites run hands-free. No
 * --with-deps (it sudo-prompts on Linux and would hang unattended runs);
 * bounded by a kill-timer; opt out with FLAWLESS_SKIP_BROWSER_INSTALL=1.
 */
const INSTALL_TIMEOUT_MS = 300_000;

async function ensureChromium(cwd: string): Promise<void> {
  if (process.env.FLAWLESS_SKIP_BROWSER_INSTALL === "1") return;
  process.stdout.write(
    "\n› bunx playwright install chromium (set FLAWLESS_SKIP_BROWSER_INSTALL=1 to skip)\n",
  );
  const proc = Bun.spawn(["bunx", "playwright", "install", "chromium"], {
    cwd,
    stdout: "inherit",
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

async function spawn(cmd: string, args: string[], cwd: string): Promise<boolean> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: "inherit",
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
 * - **Playwright `--grep`** anchored on `^(Name): `, because every emitted
 *   title starts that way. Anchoring matters: a bare "Card" would also select
 *   CardHeader, CardFooter and CardTitle.
 *
 * e2e is selected by whether a page's tree RENDERS a changed component, which
 * is the relationship a path filter cannot see.
 */
export async function runAffectedTests(
  outDir: string,
  selectedTasks: TaskId[],
  affected: AffectedSpecs,
  nextRoot?: string,
): Promise<boolean> {
  const standalone = existsSync(path.join(path.resolve(outDir), "package.json"));
  const cwd = standalone ? path.resolve(outDir) : (nextRoot ?? path.resolve(outDir));

  if (affected.components.length === 0 && affected.routes.length === 0) {
    process.stdout.write("\nchanged: nothing affected — no specs to run\n");
    return true;
  }

  const runs: Array<{ id: string; cmd: string[] }> = [];
  const prefix = standalone ? "test" : "flawless";

  if (selectedTasks.includes("unit-browser") && affected.changedFiles.length > 0) {
    // `related` is a vitest SUBCOMMAND, not a flag, so it cannot be appended to
    // the generated `vitest run` script — vitest exits with "Unknown option
    // --related". Invoking vitest directly with the emitted config is the only
    // way to reach it, and it is worth reaching: it walks the module graph, so
    // it finds every spec that transitively imports a changed file without this
    // tool having to reproduce its own spec-naming rules.
    const configPath = path.join(path.resolve(outDir), "vitest.config.ts");
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
    runs.push({ id: "e2e", cmd: ["bun", "run", `${prefix}:e2e`] });
  }

  const failed: string[] = [];
  for (const r of runs) {
    process.stdout.write(`\n› ${r.cmd.join(" ")}\n`);
    const ok = await spawn(r.cmd[0] as string, r.cmd.slice(1), cwd);
    if (!ok) failed.push(r.id);
  }
  if (failed.length > 0) {
    process.stdout.write(`\nfailed suites: ${failed.join(", ")}\n`);
    return false;
  }
  process.stdout.write("\nall affected suites passed\n");
  return true;
}
