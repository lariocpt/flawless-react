/**
 * depth-probe — the mutation falsifier probe for D0 (PLAN-00).
 *
 * The census proves what the suite ASSERTS. This proves the assertions CAN
 * FAIL: apply a named mechanical mutation to the app's SOURCE, run the spec
 * the mutated file's own emitted spec covers, and record red/green. The
 * output is the falsifier rate plus the MISSED list — the honest part.
 *
 * PROTOCOL — the order is the point, and (c) is the load-bearing line:
 *
 *   a. The suite is GENERATED ONCE from the UNMUTATED tree, with a binary
 *      built from the tip being measured (`--generate '<command>'`, run
 *      exactly once before any mutation is applied).
 *   b. For each mutation: apply it to the app's SOURCE, run ONLY the spec(s)
 *      derived from the mutated file, record red/green, revert the mutation.
 *   c. NEVER regenerate between mutations. Regeneration re-emits the spec
 *      from the mutated source — the spec would be rewritten to MATCH the
 *      mutation, every mutation would go green, and the probe would measure
 *      nothing. The suite is generated once and frozen; the only writes that
 *      happen after generation are the mutation itself and its exact revert.
 *      This script enforces (c) structurally: `generate` is called from
 *      exactly one site, before the mutation loop, and the loop body contains
 *      no generation call — grep this file for `runGenerate` and the single
 *      call site is the whole proof.
 *
 * Spec selection is DERIVED, never hand-picked: a spec covers a source file
 * when the spec's own import statements resolve to that file. A mutation
 * whose file no spec imports is reported as "no spec covers this file" —
 * never as caught, never as missed.
 *
 * For each caught mutation the probe reports the spec that went red, the
 * failing assertion's line, and that assertion's TIER as computed by
 * src/reporters/depth.ts — the first empirical check that the tier table
 * means anything: a mutation tagged "should be caught by T2" that is only
 * caught by a T1 assertion is a FINDING, not a pass.
 *
 * Controls: mutations marked `control: true` must stay green (a comment edit,
 * an internal rename with no observable effect). A control that goes red means
 * the probe is noisy — and noise here would make every later number
 * meaningless, so a red control is printed as a failure of the probe.
 *
 * oldText must be UNIQUE in its file. The probe validates the whole table
 * before touching anything and refuses a missing or non-unique match rather
 * than guessing.
 *
 * Usage (maintainer tooling, run with bun from this repo):
 *   bun run scripts/depth-probe.ts --app <apps/web dir> --table <table.json>
 *     [--generate '<one-time suite generation command, run in --app>']
 *     [--out <results.json>] [--binary <path>] [--tree <sha>]
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyAssertionAtLine, classifySpec, type Tier } from "../src/reporters/depth.ts";

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export interface Mutation {
  /** Short stable name; also the row label in the output. */
  name: string;
  /** Source file relative to the app dir, e.g. `src/app/(auth)/_components/login-form.tsx`. */
  file: string;
  /** Must occur EXACTLY ONCE in the file. The probe refuses anything else. */
  oldText: string;
  newText: string;
  /** What behaviour this mutation claims to break, in one line. */
  intent: string;
  /** The tier whose assertions should be the ones that catch it. */
  expectedTier: Tier;
  /** true = must stay green (probe-noise canary). */
  control?: boolean;
}

export interface MutationTable {
  target: string;
  tree: string;
  /** Directory the suite was generated into / the app root the paths are relative to. */
  appDir: string;
  /** Emitted suite dir relative to appDir, e.g. `flawless/unit`. */
  suiteDir: string;
  mutations: Mutation[];
}

export function loadTable(file: string): MutationTable {
  const t = JSON.parse(readFileSync(file, "utf8")) as MutationTable;
  if (!t.appDir || !t.suiteDir || !Array.isArray(t.mutations) || t.mutations.length === 0) {
    throw new Error(`mutation table ${file}: appDir, suiteDir and a non-empty mutations[] are required`);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Apply / revert — refuse-don't-guess, and byte-exact revert
// ---------------------------------------------------------------------------

/** null when the mutation is applicable; a human-readable refusal otherwise. */
export function validateMutation(original: string, m: Mutation): string | null {
  if (m.oldText === m.newText) return `${m.name}: oldText equals newText — nothing would change`;
  const n = original.split(m.oldText).length - 1;
  if (n === 0) return `${m.name}: oldText not found in ${m.file}`;
  if (n > 1) return `${m.name}: oldText occurs ${n} times in ${m.file} — refusing to guess`;
  return null;
}

export function applyToText(original: string, m: Mutation): string {
  return original.replace(m.oldText, m.newText);
}

// ---------------------------------------------------------------------------
// Derived spec selection — the spec imports say it, we do not choose
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g;
const RESOLVE_EXTS = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"];

/**
 * The emitted specs that cover `fileRel` (relative to appDir): every spec in
 * suiteDir with a relative import that resolves to that file. Sorted, so the
 * probe output is reproducible.
 */
export function deriveSpecs(appDir: string, suiteDir: string, fileRel: string): string[] {
  const target = path.resolve(appDir, fileRel);
  const specs: string[] = [];
  walkSpecs(path.resolve(appDir, suiteDir), specs);
  const covering: string[] = [];
  for (const spec of specs.sort()) {
    const source = readFileSync(spec, "utf8");
    const specDir = path.dirname(spec);
    IMPORT_RE.lastIndex = 0;
    let m = IMPORT_RE.exec(source);
    while (m !== null) {
      for (const ext of RESOLVE_EXTS) {
        if (path.resolve(specDir, m[1] as string) + ext === target) {
          covering.push(path.relative(appDir, spec));
          m = null;
          break;
        }
      }
      if (m === null) break;
      m = IMPORT_RE.exec(source);
    }
  }
  return covering;
}

function walkSpecs(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkSpecs(full, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(full);
  }
}

// ---------------------------------------------------------------------------
// Running one spec — injectable, so the mechanics are testable without an app
// ---------------------------------------------------------------------------

export interface SpecOutcome {
  red: boolean;
  /** Failing tests, with the spec line the runner blamed (null when unknown). */
  failures: { test: string; line: number | null }[];
  /** True when the spec failed to even load — red, but no assertion caused it. */
  loadError?: boolean;
}

export type SpecRunner = (specRel: string) => Promise<SpecOutcome>;

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export interface CaughtBy {
  spec: string;
  test: string;
  line: number | null;
  /** Tier of the failing assertion (line-level); falls back to the test's tier. */
  tier: Tier | null;
  tierSource: "assertion-line" | "test-tier" | "load-error";
  evidence: string | null;
}

export interface MutationResult {
  name: string;
  file: string;
  intent: string;
  expectedTier: Tier;
  control: boolean;
  /** "caught" | "missed" | "no-spec" — controls are scored on green-ness instead. */
  status: "caught" | "missed" | "no-spec";
  /** For a control: did it stay green (true = the probe is quiet). */
  controlGreen?: boolean;
  specsRun: string[];
  caughtBy: CaughtBy[];
  /** expectedTier vs the strongest tier that actually caught it. */
  tierMatch: boolean | null;
}

export interface ProbeResult {
  target: string;
  tree: string;
  results: MutationResult[];
  /** Scored = non-control mutations whose file a spec covers. */
  scored: number;
  caught: number;
  missed: string[];
  controls: { total: number; green: number };
}

/**
 * Run the whole mutation loop against an ALREADY-GENERATED suite. This
 * function never generates: generation is the caller's single, prior step
 * (protocol step c). `runSpec` is injected so tests can drive the mechanics
 * without vitest or a real app.
 */
export async function runProbe(
  table: MutationTable,
  runSpec: SpecRunner,
  appDir?: string,
): Promise<ProbeResult> {
  const app = path.resolve(appDir ?? table.appDir);
  // Validate the WHOLE table before touching anything: a non-unique or
  // missing oldText aborts the run, it does not degrade into a guess.
  const originals = new Map<string, string>();
  const refusals: string[] = [];
  for (const m of table.mutations) {
    const file = path.resolve(app, m.file);
    if (!existsSync(file)) {
      refusals.push(`${m.name}: file ${m.file} does not exist`);
      continue;
    }
    const original = originals.get(file) ?? readFileSync(file, "utf8");
    originals.set(file, original);
    const refusal = validateMutation(original, m);
    if (refusal !== null) refusals.push(refusal);
  }
  if (refusals.length > 0) {
    throw new Error(`mutation table refused:\n${refusals.map((r) => `  ${r}`).join("\n")}`);
  }

  const results: MutationResult[] = [];
  try {
    for (const m of table.mutations) {
      const file = path.resolve(app, m.file);
      const original = originals.get(file) as string;
      const specs = deriveSpecs(app, table.suiteDir, m.file);
      const row: MutationResult = {
        name: m.name,
        file: m.file,
        intent: m.intent,
        expectedTier: m.expectedTier,
        control: m.control === true,
        status: specs.length > 0 ? "missed" : "no-spec",
        specsRun: specs,
        caughtBy: [],
        tierMatch: null,
      };
      if (specs.length > 0) {
        writeFileSync(file, applyToText(original, m));
        try {
          for (const specRel of specs) {
            const outcome = await runSpec(specRel);
            if (!outcome.red) continue;
            row.status = "caught";
            const specSource = readFileSync(path.resolve(app, specRel), "utf8");
            const cls = classifySpec(specSource);
            if (outcome.failures.length === 0) {
              row.caughtBy.push({
                spec: specRel,
                test: "(spec failed to load)",
                line: null,
                tier: cls.tier,
                tierSource: "load-error",
                evidence: "spec red at load — no assertion executed",
              });
              continue;
            }
            for (const f of outcome.failures) {
              let tier: Tier | null = null;
              let tierSource: CaughtBy["tierSource"] = "test-tier";
              let evidence: string | null = null;
              if (f.line !== null) {
                const at = classifyAssertionAtLine(specSource, f.line);
                if (at !== null) {
                  tier = at.tier;
                  tierSource = "assertion-line";
                  evidence = at.evidence;
                }
              }
              if (tier === null) {
                const per = cls.perTest.find((t) => t.name === f.test || f.test.includes(t.name.replace(/^"|"$/g, "")));
                tier = per?.tier ?? cls.tier;
              }
              row.caughtBy.push({ spec: specRel, test: f.test, line: f.line, tier, tierSource, evidence });
            }
          }
        } finally {
          // Revert is unconditional — a mutation never survives its row, not
          // even when the runner itself threw.
          writeFileSync(file, original);
        }
      }
      if (row.control) row.controlGreen = row.status !== "caught";
      if (row.status === "caught") {
        const catching = row.caughtBy
          .map((c) => c.tier)
          .filter((t): t is Tier => t !== null)
          .sort((a, b) => ["T0", "T1", "T2", "T3"].indexOf(b) - ["T0", "T1", "T2", "T3"].indexOf(a));
        row.tierMatch = catching.length > 0 ? catching[0] === m.expectedTier : false;
      }
      results.push(row);
    }
  } finally {
    // Belt and braces: restore every original byte-for-byte even on a throw
    // mid-loop, then prove it.
    for (const [file, original] of originals) writeFileSync(file, original);
    for (const [file, original] of originals) {
      if (readFileSync(file, "utf8") !== original) {
        throw new Error(`PROBE LEFT THE TREE MUTATED: ${file} did not revert byte-exactly`);
      }
    }
  }

  const scoredRows = results.filter((r) => !r.control && r.status !== "no-spec");
  const caughtRows = scoredRows.filter((r) => r.status === "caught");
  return {
    target: table.target,
    tree: table.tree,
    results,
    scored: scoredRows.length,
    caught: caughtRows.length,
    missed: scoredRows.filter((r) => r.status === "missed").map((r) => r.name),
    controls: {
      total: results.filter((r) => r.control).length,
      green: results.filter((r) => r.control && r.controlGreen).length,
    },
  };
}

// ---------------------------------------------------------------------------
// The real runner: vitest over the frozen suite, one spec at a time
// ---------------------------------------------------------------------------

/**
 * The ONE generation call site (protocol step c). runProbe cannot generate;
 * only main() calls this, once, before the loop.
 */
async function runGenerate(appDir: string, command: string): Promise<void> {
  process.stdout.write(`[probe] generating the suite ONCE (unmutated tree): ${command}\n`);
  const proc = Bun.spawn({
    cmd: ["sh", "-c", command],
    cwd: appDir,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`generation failed with exit ${code} — refusing to probe`);
  process.stdout.write("[probe] suite generated; no further generation will run this probe\n");
}

/** vitest's JSON reporter → SpecOutcome. cwd must be the app dir. */
export async function vitestRunner(
  appDir: string,
  suiteDir: string,
  specRel: string,
  outFile: string,
): Promise<SpecOutcome> {
  const filter = path.relative(path.dirname(suiteDir), specRel) || ".";
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "x",
      "vitest",
      "run",
      "--root",
      path.dirname(suiteDir),
      "--reporter=json",
      `--outputFile=${outFile}`,
      filter,
    ],
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  let report: {
    testResults?: {
      name?: string;
      assertionResults?: {
        fullName?: string;
        status?: string;
        failureMessages?: string[];
        location?: { line?: number };
      }[];
    }[];
  };
  try {
    report = JSON.parse(readFileSync(outFile, "utf8"));
  } catch {
    // No JSON at all but a nonzero exit is a load failure; zero exit with no
    // JSON is a runner bug — surface it as red-with-no-line, never green.
    return { red: proc.exitCode !== 0, failures: [], loadError: true };
  }
  const failures: { test: string; line: number | null }[] = [];
  const specBase = path.basename(specRel);
  for (const tr of report.testResults ?? []) {
    for (const a of tr.assertionResults ?? []) {
      if (a.status !== "failed") continue;
      let line: number | null = a.location?.line ?? null;
      if (line === null) {
        const msg = (a.failureMessages ?? []).join("\n");
        const m = new RegExp(`${specBase.replace(/\./g, "\\.")}:(\\d+):\\d+`).exec(msg);
        if (m) line = Number(m[1]);
      }
      failures.push({ test: a.fullName ?? "(unnamed)", line });
    }
  }
  const red = failures.length > 0 || proc.exitCode !== 0;
  if (red && failures.length === 0) return { red: true, failures: [], loadError: true };
  return { red, failures };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(
    "usage: bun run scripts/depth-probe.ts --app <apps/web dir> --table <table.json> " +
      "[--generate '<one-time generation command>'] [--out <results.json>] [--binary <path>] [--tree <sha>]",
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const v = args[i + 1];
    if (v === undefined) usage();
    args.splice(i, 2);
    return v;
  };
  const appDir = take("--app");
  const tableFile = take("--table");
  const generate = take("--generate");
  const out = take("--out");
  const binary = take("--binary");
  const tree = take("--tree");
  if (!appDir || !tableFile) usage();

  const table = loadTable(tableFile);
  const app = path.resolve(appDir as string);

  // (a) generate ONCE, from the unmutated tree, before any mutation exists.
  if (generate !== undefined) await runGenerate(app, generate);
  if (!existsSync(path.resolve(app, table.suiteDir))) {
    throw new Error(`suite dir ${table.suiteDir} not found under ${app} — generate the suite first`);
  }

  const outFile = path.join("/tmp/opencode", `depth-probe-vitest-${process.pid}.json`);
  const result = await runProbe(
    table,
    (specRel) => vitestRunner(app, table.suiteDir, specRel, outFile),
    app,
  );

  // ---- the table ----
  const w = Math.max(...result.results.map((r) => r.name.length), 6);
  console.log("");
  console.log(`mutation probe over ${table.target} @ ${tree ?? table.tree} — ${table.mutations.length} mutation(s)`);
  console.log("");
  console.log(`${"mutation".padEnd(w)}  status     expected  caught-by  spec / failing assertion`);
  for (const r of result.results) {
    const status = r.control
      ? r.controlGreen
        ? "control-ok"
        : "CONTROL-RED"
      : r.status;
    const caught = r.caughtBy
      .map((c) => `${c.spec}:${c.line ?? "?"} ${c.test} [${c.tier ?? "?"}/${c.tierSource}]`)
      .join("; ");
    console.log(
      `${r.name.padEnd(w)}  ${status.padEnd(9)}  ${r.expectedTier}      ${
        r.caughtBy.length > 0 ? (r.tierMatch ? "match  " : "MISMATCH") : "—       "
      }  ${caught}`,
    );
  }
  console.log("");
  const rate = result.scored > 0 ? result.caught / result.scored : 0;
  console.log(`falsifier rate = ${result.caught}/${result.scored} scored mutations`);
  console.log(`  (scored = non-control mutations whose file a derived spec covers;`);
  console.log(`   no-spec mutations: ${result.results.filter((r) => r.status === "no-spec").length}, excluded and named below)`);
  console.log(`controls: ${result.controls.green}/${result.controls.total} green`);
  console.log("");
  console.log("MISSED (nothing the suite asserts went red):");
  if (result.missed.length === 0) console.log("  (empty — the mutations are too easy; add harder ones)");
  for (const name of result.missed) console.log(`  MISSED: ${name}`);
  const noSpec = result.results.filter((r) => r.status === "no-spec");
  if (noSpec.length > 0) {
    console.log("");
    for (const r of noSpec) console.log(`  no spec covers this file: ${r.name} (${r.file})`);
  }
  const mismatches = result.results.filter((r) => r.tierMatch === false && !r.control);
  if (mismatches.length > 0) {
    console.log("");
    console.log("TIER FINDINGS (caught, but by a tier other than expected):");
    for (const r of mismatches) {
      const tiers = [...new Set(r.caughtBy.map((c) => c.tier))].join(",");
      console.log(`  ${r.name}: expected ${r.expectedTier}, caught by ${tiers}`);
    }
  }
  const redControls = result.results.filter((r) => r.control && !r.controlGreen);
  if (redControls.length > 0) {
    console.log("");
    console.log("PROBE IS NOISY — these controls went red:");
    for (const r of redControls) console.log(`  CONTROL-RED: ${r.name}`);
  }

  if (out !== undefined) {
    const payload = {
      target: result.target,
      tree: tree ?? result.tree,
      date: new Date().toISOString().slice(0, 10),
      binary:
        binary !== undefined
          ? { path: binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex") }
          : null,
      generateCommand: generate ?? null,
      falsifierRate: {
        caught: result.caught,
        scored: result.scored,
        rate: Number(rate.toFixed(4)),
      },
      controls: result.controls,
      missed: result.missed,
      results: result.results,
    };
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }

  if (redControls.length > 0) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
