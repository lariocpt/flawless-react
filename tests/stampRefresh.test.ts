import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { hashBody, STAMP_RE, splitStamp } from "../src/scaffold-tests/stamp.ts";
import type { TaskResult } from "../src/types.ts";

/**
 * The --force refresh matrix, end to end through runCore with the host
 * project's own biome formatting the freshly written spec. The stamp is only
 * trustworthy if it names the FORMATTED bytes — a hash of the raw render would
 * classify every untouched spec as hand-edited on the very next --force, and
 * the refresh feature would be dead on arrival. Runs are sequential over one
 * project dir on purpose: each run's verdict depends on what the previous one
 * left on disk, exactly like real use.
 */

const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "Dashboard.tsx");

let proj: string;
let SPEC: string;

beforeAll(() => {
  proj = mkdtempSync(path.join(os.tmpdir(), "flawless-stamp-refresh-"));
  mkdirSync(path.join(proj, "src"), { recursive: true });
  copyFileSync(FIXTURE, path.join(proj, "src", "Dashboard.tsx"));
  SPEC = path.join(proj, "src", "Dashboard.flawless.test.tsx");
  // Tab indentation is the anti-vacuity axis: the templates emit spaces, so a
  // tab in the spec body can only have come from biome actually running.
  writeFileSync(
    path.join(proj, "biome.json"),
    `${JSON.stringify({ formatter: { enabled: true, indentStyle: "tab" } }, null, 2)}\n`,
  );
  // adoptProjectStyle resolves biome by walking UP from biome.json's dir for a
  // node_modules/.bin/biome — from an os tmpdir there is none, so biome would
  // silently never run and every assertion below about formatting would be
  // vacuously testing the raw template (the trap adoptStyle.test.ts documents).
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(proj, "node_modules"), "dir");
  const biome = path.join(proj, "node_modules", ".bin", "biome");
  if (!existsSync(biome)) {
    // requireInterpreter discipline: a broken environment must fail loudly,
    // never skip past the one thing this suite exists to prove.
    throw new Error(`biome not reachable through the symlink at ${biome}`);
  }
});

afterAll(() => {
  if (proj) rmSync(proj, { recursive: true, force: true });
});

async function run(force?: boolean): Promise<TaskResult> {
  const result = await runCore({
    pattern: path.join(proj, "src", "Dashboard.tsx"),
    outDir: path.join(proj, "flawless"),
    taskIds: ["unit-browser"],
    colocate: true,
    force,
    log: false,
    inlineSummary: false,
  });
  expect(result.exitCode).toBe(0);
  const unit = result.results.find((r) => r.id === "unit-browser");
  expect(unit).toBeDefined();
  expect(unit?.ok).toBe(true);
  return unit as TaskResult;
}

describe("hash-stamped colocated refresh through runCore", () => {
  test("run 1: the spec lands stamped, and the stamp names the FORMATTED bytes", async () => {
    const unit = await run();
    expect(unit.outputs).toContain(SPEC);
    const text = readFileSync(SPEC, "utf8");
    expect(STAMP_RE.test(text)).toBe(true);
    const { hash, body } = splitStamp(text);
    expect(hash).toBe(hashBody(body));
    // Tabs prove biome ran AND the restamp hashed what biome left behind; if
    // the provisional pre-format stamp had survived, hashBody(body) above
    // would already have failed, and if biome never ran, this fails instead.
    expect(body).toContain("\t");
  });

  test("run 2: without --force the spec is kept byte-identical", async () => {
    const before = readFileSync(SPEC, "utf8");
    const unit = await run();
    expect(readFileSync(SPEC, "utf8")).toBe(before);
    expect(unit.outputs).not.toContain(SPEC);
    expect(unit.summary).toContain("kept — rerun with --force");
  });

  test("run 3: --force over an untouched spec refreshes it with a valid stamp", async () => {
    const unit = await run(true);
    expect(unit.outputs).toContain(SPEC);
    expect(unit.summary).not.toContain("kept");
    const { hash, body } = splitStamp(readFileSync(SPEC, "utf8"));
    expect(hash).toBe(hashBody(body));
    expect(body).toContain("\t");
  });

  test("run 4: --force keeps a hand-edited spec byte-for-byte and reports it", async () => {
    appendFileSync(SPEC, "// hand-hardened: this line must survive --force\n");
    const before = readFileSync(SPEC, "utf8");
    const unit = await run(true);
    expect(readFileSync(SPEC, "utf8")).toBe(before);
    expect(unit.outputs).not.toContain(SPEC);
    expect(unit.summary).toContain("1 hand-edited or reformatted colocated spec(s) kept");
    expect(unit.summary).toContain("delete to regenerate");
    expect(unit.summary).toContain("Dashboard.flawless.test.tsx");
    // A kept file's discarded render must not tally hand-work (the tally-level
    // pinning with a marker-bearing tree lives in todoCounts.test.ts).
    expect(unit.handWork).toEqual([]);
  });

  test("run 5: --force keeps a pre-stamp spec and lists it separately", async () => {
    const stamped = readFileSync(SPEC, "utf8");
    const stampless = splitStamp(stamped).body;
    expect(stampless).not.toBe(stamped);
    writeFileSync(SPEC, stampless);
    const unit = await run(true);
    expect(readFileSync(SPEC, "utf8")).toBe(stampless);
    expect(unit.outputs).not.toContain(SPEC);
    expect(unit.summary).toContain("1 pre-stamp colocated spec(s) kept");
    expect(unit.summary).toContain("Dashboard.flawless.test.tsx");
    expect(unit.summary).not.toContain("hand-edited");
  });

  test("guard-the-guard: one corrupted stamp hex means kept, never clobbered", async () => {
    // Back to a pristine generated state first.
    unlinkSync(SPEC);
    await run(true);
    const text = readFileSync(SPEC, "utf8");
    const hash = (text.match(STAMP_RE) as RegExpMatchArray)[1] as string;
    const flipped = hash[0] === "0" ? `f${hash.slice(1)}` : `0${hash.slice(1)}`;
    const corrupted = text.replace(hash, flipped);
    writeFileSync(SPEC, corrupted);

    const unit = await run(true);
    expect(readFileSync(SPEC, "utf8")).toBe(corrupted);
    expect(unit.summary).toContain("1 hand-edited or reformatted colocated spec(s) kept");
  });
});
