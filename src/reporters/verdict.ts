import path from "node:path";
import type { TaskResult } from "../types.ts";
import { VERSION } from "../version.ts";
import type { DepthBlock } from "./depth.ts";
import type { NamedSkip } from "./report.ts";

/**
 * The accumulated verdict: what every plane's LAST run said, on record together.
 *
 * REPORT.md is per-invocation: a run that selected one task described one task,
 * and the committed file then claimed the other six were "Not run" even when a
 * previous run had just run them (audit C16/C31 — "This run selected 1 of 7
 * tasks"). The verdict fixes that by accumulating: one entry per task, each
 * stamped with the target-hash it describes, so the last run of every plane is
 * always on record and a full run's six quiet planes are simply previous
 * entries, still visible.
 *
 * Keyed by (task, target-hash): an entry says which tree it describes. A run
 * against an unchanged tree rewrites its entries byte-identically — no
 * timestamps anywhere in this file, for the same reason REPORT.md carries
 * none: it is committed, and a clock would churn `git status` on every run and
 * defeat the idempotence check that catches non-deterministic emission.
 *
 * The tallies are generation tallies — what THIS tool measures when it writes
 * the suite: files emitted, findings reported, skips emitted with a named
 * reason. Runtime pass/fail belongs to the runner; when a plane's runner
 * reports, its numbers join the entry. A verdict never guesses at a number it
 * did not measure: an absent field is an unmeasured field, not a zero.
 */

export const VERDICT_JSON = "VERDICT.json";
export const VERDICT_MD = "VERDICT.md";

/**
 * Content hash of the analysed files — the verdict's target key.
 *
 * Content-based, not git-based: the dogfood tree is a corpus checkout the tool
 * never pushes, and a hash that needed a commit would be unavailable exactly
 * where the verdict matters most. Sorted paths + per-file content hashes, so
 * the hash is stable for an unchanged tree (byte-stable verdicts, acceptance
 * item 4) and changes when any analysed file's bytes change.
 */
export async function hashTargetFiles(files: readonly string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of [...files].sort()) {
    hasher.update(file);
    hasher.update("\0");
    try {
      hasher.update(await Bun.file(file).text());
    } catch {
      hasher.update("<unreadable>");
    }
    hasher.update("\0");
  }
  return `sha256:${hasher.digest("hex").slice(0, 16)}`;
}

/** One task's last known result against one target. */
export interface VerdictEntry {
  /** Content hash of the analysed files this entry describes (see hashTargets). */
  targetHash: string;
  /** Whether that run's task result was ok. */
  ok: boolean;
  /** Files the task wrote (TaskResult.outputs). */
  written: number;
  /** Findings the task reported. */
  findings: number;
  /** Emitted `test.skip`s counted in this task's specs (generation census). */
  skips: number;
  /**
   * The skips aggregated by reason-string — the reason part of each skip title,
   * counted. `skips` and the sum of these must agree: one census, two views.
   */
  skipReasons: { reason: string; count: number }[];
  /**
   * TODO(flawless) marker tallies this task measured (the TodoCounter pipe,
   * extended to the verdict). Absent means the task does not measure markers.
   */
  todos?: { kind: string; count: number }[];
  /**
   * The D0 depth census of the specs this task emitted (PLAN-00): tier
   * distribution over specs plus the test tallies. Present only on tasks that
   * emit specs — unit-browser today. Absent means UNMEASURED, never zero:
   * the same contract as every other field in this file.
   */
  depth?: DepthBlock;
  /** Evidence pointers, relative to the suite dir, sorted. */
  evidence: string[];
  /** The task's own summary line, verbatim. */
  summary: string;
}

export interface VerdictDoc {
  schema: "flawless-verdict/1";
  /** The tool version that wrote this file — not a timestamp; versions are stable bytes. */
  tool: string;
  /** Keyed by task id. Sorted on render, never on storage order. */
  entries: Record<string, VerdictEntry>;
}

/** One run's contribution: the tasks that ran, with their measured tallies. */
export interface VerdictRunInput {
  targetHash: string;
  results: readonly TaskResult[];
  /** The generation skip census (collectNamedSkips), already attributed per file. */
  skipCensus: readonly NamedSkip[];
  /**
   * Maps a spec file (as it appears in the census) to the task whose specs it
   * belongs to. Files no task claims land under the plane directory that
   * holds them — a kept write-once spec is still part of that plane.
   */
  claimFile: (file: string) => string | undefined;
  /** Evidence paths to record per task id, relative to the suite dir. */
  evidenceFor: (taskId: string) => string[];
}

/** Split a skip title into `name — reason`; a title with no " — " is its own reason. */
export function skipReasonOf(title: string): string {
  const i = title.indexOf(" — ");
  return i === -1 ? title : title.slice(i + 3);
}

/**
 * Build the census→task attribution the verdict's per-plane skip tallies need.
 *
 * A skip file belongs to the task that wrote it (its outputs); a file no task
 * claims — a kept write-once spec, not "written" this run — lands under the
 * plane directory that holds it, because a kept spec is still part of that
 * plane. That fallback is the TodoCounter pipe's rule, extended: the tallies
 * must cover the suite, not just this invocation's writes.
 */
export function makeFileClaimer(
  outDir: string,
  results: readonly { id: string; outputs: readonly string[] }[],
  colocatedTask: string | undefined,
): (file: string) => string | undefined {
  const claimed = new Map<string, string>();
  for (const r of results) for (const o of r.outputs) claimed.set(path.resolve(o), r.id);
  const planeDirs: Record<string, string> = {
    unit: "unit-browser",
    browser: "unit-browser",
    profile: "perf-harness",
    e2e: "e2e",
    load: "load",
  };
  return (file: string) => {
    const abs = path.resolve(file);
    const byOutput = claimed.get(abs);
    if (byOutput) return byOutput;
    const relFromOut = path.relative(outDir, abs);
    if (relFromOut.startsWith("..")) return colocatedTask;
    const top = relFromOut.split(path.sep)[0];
    return top ? planeDirs[top] : undefined;
  };
}

/** Aggregate skip titles by reason-string, sorted by reason then count-stable. */
export function aggregateSkipReasons(
  titles: readonly string[],
): { reason: string; count: number }[] {
  const byReason = new Map<string, number>();
  for (const t of titles) byReason.set(skipReasonOf(t), (byReason.get(skipReasonOf(t)) ?? 0) + 1);
  return [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => (a.reason === b.reason ? 0 : a.reason < b.reason ? -1 : 1));
}

/**
 * Merge this run's entries into the existing doc. An entry is replaced only by
 * a run of the same task; a task that did not run keeps its last entry — that
 * is the whole point: the last run of every plane is always on record.
 */
export function mergeVerdict(existing: VerdictDoc | null, run: VerdictRunInput): VerdictDoc {
  const entries: Record<string, VerdictEntry> = { ...(existing?.entries ?? {}) };
  const byTask = new Map<string, NamedSkip[]>();
  for (const s of run.skipCensus) {
    const task = run.claimFile(s.file);
    if (!task) continue;
    const list = byTask.get(task);
    if (list) list.push(s);
    else byTask.set(task, [s]);
  }
  for (const r of run.results) {
    const skips = byTask.get(r.id) ?? [];
    entries[r.id] = {
      targetHash: run.targetHash,
      ok: r.ok,
      written: r.outputs.length,
      findings: r.findings.length,
      skips: skips.length,
      skipReasons: aggregateSkipReasons(skips.map((s) => s.title)),
      ...(r.handWork ? { todos: r.handWork.map((t) => ({ kind: t.kind, count: t.count })) } : {}),
      ...(r.depth ? { depth: r.depth } : {}),
      evidence: [...new Set(run.evidenceFor(r.id))].sort(),
      summary: r.summary,
    };
  }
  return { schema: "flawless-verdict/1", tool: VERSION, entries };
}

/** Byte-stable JSON: keys sorted so two runs of one tree write one file. */
export function renderVerdictJson(doc: VerdictDoc): string {
  const entries: Record<string, unknown> = {};
  for (const id of Object.keys(doc.entries).sort()) {
    const e = doc.entries[id] as VerdictEntry;
    entries[id] = {
      targetHash: e.targetHash,
      ok: e.ok,
      written: e.written,
      findings: e.findings,
      skips: e.skips,
      skipReasons: e.skipReasons,
      ...(e.todos ? { todos: e.todos } : {}),
      ...(e.depth ? { depth: e.depth } : {}),
      evidence: e.evidence,
      summary: e.summary,
    };
  }
  return `${JSON.stringify({ schema: doc.schema, tool: doc.tool, entries }, null, 2)}\n`;
}

export function renderVerdictMarkdown(doc: VerdictDoc, thisRunTaskIds: readonly string[]): string {
  const ids = Object.keys(doc.entries).sort();
  const thisRun = new Set(thisRunTaskIds);
  const lines: string[] = [
    "# flawless-react verdict",
    "",
    `Generated by flawless-react ${doc.tool}. This file accumulates across runs:`,
    "one entry per task, each describing the LAST run of that task against the",
    "target it names. It is regenerated on every run; edit the specs, not this.",
    "",
    "Entries marked *(this run)* were written by this invocation; the rest are",
    "the last results a previous run measured, still on record — a plane that",
    "is not *(this run)* was not skipped, it simply was not selected.",
    "",
    "| Task | Result | Files | Findings | Skips | Target | Evidence |",
    "| --- | --- | ---: | ---: | ---: | --- | --- |",
  ];
  for (const id of ids) {
    const e = doc.entries[id] as VerdictEntry;
    const evidence = e.evidence.length > 0 ? e.evidence.map((p) => `\`${p}\``).join(", ") : "—";
    lines.push(
      `| \`${id}\`${thisRun.has(id) ? " *(this run)*" : ""} | ${e.ok ? "ok" : "fail"} | ${e.written} | ${e.findings} | ${e.skips} | \`${e.targetHash}\` | ${evidence} |`,
    );
  }
  lines.push("");

  // --- skips by reason ------------------------------------------------------
  // The chunk-9 skip contract, aggregated: every emitted skip names its reason
  // in its title; here the reasons are counted across every plane on record.
  // The totals below must equal the Skips column above — one census, two views.
  // The equality is a CHECKED claim: a plane whose reason rows do not sum to
  // its Skips column is named, because a silently-wrong total is the exact
  // vacuous green this tool refuses to print.
  const totals = new Map<string, number>();
  let grand = 0;
  const mismatches: string[] = [];
  for (const id of ids) {
    const e = doc.entries[id] as VerdictEntry;
    let sum = 0;
    for (const r of e.skipReasons) {
      totals.set(r.reason, (totals.get(r.reason) ?? 0) + r.count);
      grand += r.count;
      sum += r.count;
    }
    if (sum !== e.skips) {
      mismatches.push(`\`${id}\`: Skips column says ${e.skips}, reason rows sum ${sum}.`);
    }
  }
  lines.push("## Skips by reason", "");
  if (mismatches.length > 0) {
    for (const m of mismatches) lines.push(`> Tally mismatch — ${m}`);
    lines.push("");
  }
  if (grand === 0) {
    lines.push("No emitted skip on record.", "");
  } else {
    lines.push(
      `${grand} emitted skip(s) across the planes above, aggregated by reason-string.`,
      mismatches.length > 0
        ? "The totals do NOT equal the Skips column — see the mismatch lines above."
        : "The total equals the Skips column: one census, two views.",
      "",
      "| Reason | Count |",
      "| --- | ---: |",
    );
    for (const [reason, count] of [...totals.entries()].sort((a, b) =>
      a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1,
    )) {
      lines.push(`| ${reason} | ${count} |`);
    }
    lines.push("");
  }

  // --- depth ------------------------------------------------------------------
  // The D0 census (PLAN-00): assertion tiers over the specs each task emitted,
  // strongest assertion per spec, T0 mount-only → T3 state and payload. Only
  // tasks that emit specs measure it; an entry without a depth field was not
  // measured and says nothing about its depth — absence is absence, not zero.
  // The totals here equal the entry's `depth` object and the census script's
  // output over the same suite: one census, three views (checked by
  // tests/depthWiring.test.ts, not assumed).
  lines.push("## Depth", "");
  const depthIds = ids.filter((id) => (doc.entries[id] as VerdictEntry).depth !== undefined);
  if (depthIds.length === 0) {
    lines.push(
      "Not measured — no task on record emitted specs the tier table describes.",
      "Absence here is absence of measurement, not zero depth.",
      "",
    );
  } else {
    lines.push(
      "Assertion tiers of the emitted specs on record — the strongest assertion per",
      "spec, per the D0 tier table (T0 mount-only → T3 state and payload).",
      "",
      "| Task | Specs | T0 | T1 | T2 | T3 | Tests classified | Unclaimed | Skipped |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    let sumSpecs = 0;
    let sumT0 = 0;
    let sumUnclaimed = 0;
    for (const id of depthIds) {
      const d = (doc.entries[id] as VerdictEntry).depth as DepthBlock;
      sumSpecs += d.specs;
      sumT0 += d.T0;
      sumUnclaimed += d.testsUnclaimed;
      lines.push(
        `| \`${id}\` | ${d.specs} | ${d.T0} | ${d.T1} | ${d.T2} | ${d.T3} | ${d.testsClassified} | ${d.testsUnclaimed} | ${d.testsSkipped} |`,
      );
    }
    lines.push(
      "",
      `${sumT0} of ${sumSpecs} spec(s) on record have T0 — mount-only — as their strongest ` +
        `tier; ${sumUnclaimed} test(s) are unclaimed placeholders.`,
      "",
      "T0 means mount-only — not a failure, the floor this tool guarantees and no more.",
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

export interface VerdictWriteResult {
  jsonPath: string;
  mdPath: string;
  doc: VerdictDoc;
}

export async function writeVerdict(
  outDir: string,
  run: VerdictRunInput,
): Promise<VerdictWriteResult> {
  const jsonPath = path.join(outDir, VERDICT_JSON);
  let existing: VerdictDoc | null = null;
  try {
    const parsed = (await Bun.file(jsonPath).json()) as VerdictDoc;
    if (parsed && parsed.schema === "flawless-verdict/1" && parsed.entries) existing = parsed;
  } catch {
    // No verdict yet (or an unreadable one): this run starts the record.
  }
  const doc = mergeVerdict(existing, run);
  await Bun.write(jsonPath, renderVerdictJson(doc));
  const mdPath = path.join(outDir, VERDICT_MD);
  await Bun.write(
    mdPath,
    renderVerdictMarkdown(
      doc,
      run.results.map((r) => r.id),
    ),
  );
  return { jsonPath, mdPath, doc };
}
