import { existsSync } from "node:fs";
import path from "node:path";
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
