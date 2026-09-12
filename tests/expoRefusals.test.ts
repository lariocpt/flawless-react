// What --expo does and does not do TODAY, proven by running the real binary.
//
// The mode ships one wave at a time. That is only honest if an unported task
// refuses by name instead of silently emitting DOM artefacts for a React Native
// project — a suite that would run, pass, and test nothing. These tests are the
// guard on that promise, and they check the refusal where a consumer actually
// reads it: in results[], in the --ci blob, and in the exit code.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXPO_IMPLEMENTED } from "../src/expo/refusal.ts";
import { ALL_TASK_IDS } from "../src/tasks/index.ts";

const REPO_ROOT = path.resolve(__dirname, "..");
const EXPOAPP = path.join(REPO_ROOT, "tests", "fixtures", "expoapp");
const BIN = path.join(REPO_ROOT, "src", "bin.ts");

/** Tasks that have a real Expo implementation today. Grows by one per wave. */
const IMPLEMENTED = new Set(["perf-static", "react-rules", "unit-browser", "a11y", "e2e"]);
const REFUSING = ALL_TASK_IDS.filter((id) => !IMPLEMENTED.has(id));

let tmpRoot: string;
let app: string;
beforeAll(() => {
  // The fixture is COPIED rather than pointed at, so each run's out dir can live
  // inside the project. The tool now refuses an out dir outside a --expo/--nextjs
  // root, because everything it writes into that project — package.json scripts,
  // .gitignore entries — is relative to it, and an outside out dir produced paths
  // that escaped the repo and named this machine.
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "flawless-expo-refuse-"));
  app = path.join(tmpRoot, "app");
  cpSync(EXPOAPP, app, { recursive: true });
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
      app,
      "--out",
      path.join(app, out),
      "--ci",
      "--roots",
      "exported",
      "--no-inline-summary",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  try {
    return { code, blob: JSON.parse(stdout) as Blob };
  } catch {
    // Without this the failure is "JSON Parse error: Unexpected EOF", which says
    // nothing about why the run produced no blob.
    throw new Error(`run exited ${code} with no JSON on stdout.\nstderr:\n${stderr}`);
  }
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

  test("a11y runs natively, and its summary carries the denominator", async (): Promise<void> => {
    // Wave 5. The old refusal was load-bearing — biome's 29 HTML/ARIA rules
    // returned 0 over React Native files while scoring 3/3 on the DOM offender
    // fixture — so the replacement must never be confusable with that vacuous
    // green: the summary states how many elements were examined and how many
    // rules ran, even (especially) when the finding count is 0.
    const { code, blob } = await run(["--tasks", "a11y"], "a11y-native");
    expect(code).toBe(0);
    const a11y = blob.results.find((r) => r.id === "a11y");
    expect(a11y?.ok).toBe(true);
    expect(a11y?.summary).toMatch(/[1-9]\d* press target\(s\)/);
    expect(a11y?.summary).toMatch(/\d+ text input\(s\)/);
    expect(a11y?.summary).toMatch(/[1-9]\d* native rules/);
    // The fixture plants offenders (an icon-only Pressable with no label among
    // them), so a native engine that examined the tree cannot report zero.
    expect(a11y?.summary).toMatch(/a11y: [1-9]\d* finding\(s\)/);
  }, 120_000);

  test("e2e runs against expo-router, and its summary names the routes", async (): Promise<void> => {
    // Wave 6. The summary lists the URL templates so a zero-spec run is
    // visible as such — the fixture's router root carries real routes,
    // including a dynamic one, so a run that discovered nothing cannot pass.
    const { code, blob } = await run(["--tasks", "e2e"], "e2e-expo");
    expect(code).toBe(0);
    const e2e = blob.results.find((r) => r.id === "e2e");
    expect(e2e?.ok).toBe(true);
    expect(e2e?.summary).toMatch(/e2e specs for [1-9]\d* route\(s\)/);
    expect(e2e?.summary).toContain("/items/[id]");
    expect(e2e?.summary).toContain("/login");
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
    expect(r?.error).toContain(`--tasks ${EXPO_IMPLEMENTED.join(",")}`);
    // The escape used to be the literal "perf-static,react-rules", written when
    // five tasks refused. From wave 3 it was telling every reader to leave out
    // unit-browser — the whole point of the mode. And it ended "See docs/expo.md",
    // which has never existed on any ref.
    expect(r?.error).toContain("unit-browser");
    expect(r?.error).not.toContain("docs/expo.md");
  }, 120_000);

  test("every refusing task names its wave or its recorded decline", async () => {
    // A refusal that says only "not supported" is a dead end. Naming the wave
    // makes the gap a schedule rather than a wall — and a wave that was
    // MEASURED AND DECLINED (perf-harness, wave 4: ~0 host-mountable
    // components on an all-route-screens app) must say that instead, with a
    // pointer to the evidence, or the refusal reads as a promise nobody is
    // keeping. This list stays honest either way: a wave that lands deletes
    // its entry, a wave that dies names its grave.
    const { blob } = await run(["--tasks", REFUSING.join(",")], "refuse-all");
    for (const r of blob.results) {
      expect(r.error).toMatch(/wave \d+ — |measured-and-declined .* docs\/reviews\/backlog\.md/);
    }
    expect(blob.results).toHaveLength(REFUSING.length);
  }, 120_000);

  test("a mixed selection still runs what it can", async () => {
    // Partial credit is the point: selecting one unported task must not cost the
    // user the ones that work.
    const { code, blob } = await run(["--tasks", "perf-static,load"], "mixed");
    expect(code).toBe(1);
    expect(blob.results.find((r) => r.id === "perf-static")?.ok).toBe(true);
    expect(blob.results.find((r) => r.id === "load")?.ok).toBe(false);
  }, 120_000);
});

describe("--expo and --nextjs together", () => {
  test("exit 2, the usage-error code, from the real binary", async () => {
    const proc = Bun.spawn(
      ["bun", BIN, "--expo", app, "--nextjs", ".", "--ci", "--tasks", "perf-static"],
      { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT },
    );
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toMatch(/mutually exclusive/);
  }, 60_000);
});

describe("the escape hatch names tasks that really run", () => {
  test("every task in EXPO_IMPLEMENTED runs under --expo rather than refusing", async () => {
    // Without this the list is just a string. It was one: `perf-static,
    // react-rules` stayed in the refusal for two waves after unit-browser
    // started working, so the tool told every reader to skip the one task the
    // Expo mode exists for.
    const { blob } = await run(["--tasks", EXPO_IMPLEMENTED.join(",")], "escape");
    for (const id of EXPO_IMPLEMENTED) {
      const r = blob.results.find((x) => x.id === id);
      expect(`${id}: ${r === undefined ? "absent" : r.ok}`).toBe(`${id}: true`);
    }
  }, 180_000);

  test("EXPO_IMPLEMENTED and the refusing set partition the seven tasks", () => {
    // A wave that lands must move its id from one list to the other; if it moves
    // it from neither, this reddens.
    const both = [...EXPO_IMPLEMENTED, ...REFUSING].sort();
    expect(both).toEqual([...new Set(both)].sort());
    expect(both.length).toBe(7);
  });
});
