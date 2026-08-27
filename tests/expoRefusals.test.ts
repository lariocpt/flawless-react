// What --expo does and does not do TODAY, proven by running the real binary.
//
// The mode ships one wave at a time. That is only honest if an unported task
// refuses by name instead of silently emitting DOM artefacts for a React Native
// project — a suite that would run, pass, and test nothing. These tests are the
// guard on that promise, and they check the refusal where a consumer actually
// reads it: in results[], in the --ci blob, and in the exit code.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_TASK_IDS } from "../src/tasks/index.ts";

const REPO_ROOT = path.resolve(__dirname, "..");
const EXPOAPP = path.join(REPO_ROOT, "tests", "fixtures", "expoapp");
const BIN = path.join(REPO_ROOT, "src", "bin.ts");

/** Tasks that have a real Expo implementation today. Grows by one per wave. */
const IMPLEMENTED = new Set(["perf-static", "react-rules"]);
const REFUSING = ALL_TASK_IDS.filter((id) => !IMPLEMENTED.has(id));

let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "flawless-expo-refuse-"));
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface Blob {
  exitCode: number;
  results: Array<{ id: string; ok: boolean; summary: string; error?: string }>;
  errors?: string[];
}

async function run(args: string[], out: string): Promise<{ code: number; blob: Blob }> {
  const proc = Bun.spawn(
    [
      "bun",
      BIN,
      "--expo",
      EXPOAPP,
      "--out",
      path.join(tmpRoot, out),
      "--ci",
      "--roots",
      "exported",
      "--no-inline-summary",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT },
  );
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, blob: JSON.parse(stdout) as Blob };
}

describe("--expo: what runs today", () => {
  test("perf-static and react-rules run, and the run is green", async () => {
    const { code, blob } = await run(["--tasks", "perf-static,react-rules"], "ok");
    expect(code).toBe(0);
    expect(blob.exitCode).toBe(0);
    expect(blob.results.map((r) => r.id).sort()).toEqual(["perf-static", "react-rules"]);
    expect(blob.results.every((r) => r.ok)).toBe(true);
    // Not a vacuous pass: the fixture is written to produce findings, so a run
    // that analysed nothing would show up here as a zero.
    const perf = blob.results.find((r) => r.id === "perf-static");
    expect(perf?.summary).toMatch(/across [1-9]\d* root\(s\)/);
  }, 120_000);
});

describe("--expo: what refuses, and how", () => {
  test.each(REFUSING)("%s refuses by name rather than emitting DOM artefacts", async (id) => {
    const { code, blob } = await run(["--tasks", id], `refuse-${id}`);
    expect(code).toBe(1);
    expect(blob.exitCode).toBe(1);
    const r = blob.results.find((x) => x.id === id);
    // The refusal is a TaskResult, not a thrown error: it has to be readable
    // from the blob alone, because --ci is the mode an agent refreshes in and
    // a stderr-only reason is exactly what B-13 found --ci losing.
    expect(r).toBeDefined();
    expect(r?.ok).toBe(false);
    expect(r?.summary).toContain("no Expo implementation yet");
    // It must name the task AND the escape, or the reader has to read the source
    // to find out what to select instead.
    expect(r?.error).toContain(id);
    expect(r?.error).toMatch(/perf-static,react-rules/);
  }, 120_000);

  test("every refusing task names the wave that will implement it", async () => {
    // A refusal that says only "not supported" is a dead end. Naming the wave
    // makes the gap a schedule rather than a wall — and keeps this list honest,
    // because a wave that lands must delete its entry here.
    const { blob } = await run(["--tasks", REFUSING.join(",")], "refuse-all");
    for (const r of blob.results) {
      expect(r.error).toMatch(/wave \d+ — /);
    }
    expect(blob.results).toHaveLength(REFUSING.length);
  }, 120_000);

  test("a mixed selection still runs what it can", async () => {
    // Partial credit is the point: selecting one unported task must not cost the
    // user the two that work.
    const { code, blob } = await run(["--tasks", "perf-static,e2e"], "mixed");
    expect(code).toBe(1);
    expect(blob.results.find((r) => r.id === "perf-static")?.ok).toBe(true);
    expect(blob.results.find((r) => r.id === "e2e")?.ok).toBe(false);
  }, 120_000);
});

describe("--expo and --nextjs together", () => {
  test("exit 2, the usage-error code, from the real binary", async () => {
    const proc = Bun.spawn(
      ["bun", BIN, "--expo", EXPOAPP, "--nextjs", ".", "--ci", "--tasks", "perf-static"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT },
    );
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toMatch(/mutually exclusive/);
  }, 60_000);
});
