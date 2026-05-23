import { existsSync } from "node:fs";
import path from "node:path";
import type { TaskId } from "../types.ts";

export async function runGeneratedTests(outDir: string, selectedTasks: TaskId[]): Promise<void> {
  const cwd = path.resolve(outDir);
  if (!existsSync(path.join(cwd, "node_modules"))) {
    process.stdout.write(`\n› bun install in ${cwd}\n`);
    await spawn("bun", ["install"], cwd);
  }

  const scripts: Array<{ id: string; cmd: string[] }> = [];
  if (selectedTasks.includes("unit-browser")) {
    scripts.push({ id: "unit", cmd: ["bun", "run", "test:unit"] });
  }
  if (selectedTasks.includes("perf-harness")) {
    scripts.push({ id: "perf", cmd: ["bun", "run", "test:perf"] });
  }
  if (selectedTasks.includes("unit-browser")) {
    scripts.push({ id: "browser", cmd: ["bun", "run", "test:browser"] });
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

async function spawn(cmd: string, args: string[], cwd: string): Promise<boolean> {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  return code === 0;
}
