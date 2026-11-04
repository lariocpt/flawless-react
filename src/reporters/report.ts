import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { UnresolvableImport } from "../analyse/bootability.ts";
import { hasSpec } from "../analyse/bootability.ts";
import { type FlatComponent, flattenTrees, hostEligibility } from "../scaffold-tests/registry.ts";
import type { ComponentTree, TaskId, TaskResult, TodoKind } from "../types.ts";
import { VERSION } from "../version.ts";

/**
 * A human-readable account of what the run covered and what it did not.
 *
 * The number that matters is not "175 components analysed" — that is a file
 * count wearing a suit. It is whether every component the analyser found ended
 * up somewhere you can point at: a spec, or a stated reason it has none. This
 * file is what makes that checkable, and its component table is arranged so the
 * totals have to add up.
 *
 * Deliberately timestamp-free and fully sorted. REPORT.md is committed, so a
 * clock in it would churn `git status` on every run and defeat the idempotence
 * check that catches non-deterministic emission.
 */

export interface UnparseableFile {
  file: string;
  reason: string;
}

/**
 * One emitted `test.skip` with the reason carried in its title. The chunk-9
 * skip contract: a skip must NAME what it cannot do, and the count must be
 * auditable without running the suite — so generation counts the skips it
 * emitted, and REPORT.md renders them.
 */
export interface NamedSkip {
  /** The spec file that carries the skip (already relative-ready). */
  file: string;
  /** The skip's title, verbatim — the reason lives in it after the "—". */
  title: string;
}

export const SPEC_FILE = /\.(flawless\.)?(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Extract every `test.skip("<title>"…)` from the given spec files, plus every
 * spec file found under `scanRoots` (a kept write-once colocated spec is not
 * in the run's outputs, but it is still part of the suite the report counts).
 * Titles are captured verbatim, including `${…}` interpolations in
 * template-literal titles — this is a generation-time census of what
 * generation emitted, not a runtime result, and it never executes the spec.
 */
export function collectNamedSkips(
  files: readonly string[],
  scanRoots: readonly { dir: string; pattern: RegExp }[] = [],
): NamedSkip[] {
  const targets = new Set(files.filter((f) => SPEC_FILE.test(f)));
  const walk = (dir: string, pattern: RegExp): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, pattern);
      else if (pattern.test(e.name)) targets.add(abs);
    }
  };
  for (const root of scanRoots) walk(root.dir, root.pattern);
  const out: NamedSkip[] = [];
  for (const file of [...targets].sort()) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes("test.skip(")) continue;
      const m = /test\.skip\(\s*(?:true,\s*)?(["`])((?:(?!\1)[^\\]|\\.)*)\1/.exec(line);
      if (m?.[2]) out.push({ file, title: m[2] });
    }
  }
  return out;
}

export interface ReportInput {
  trees: ComponentTree[];
  results: TaskResult[];
  outDir: string;
  /** Repo root, so paths read as they do in an editor. */
  projectRoot?: string;
  /** Files the analyser could not read a component out of. */
  unparseable?: UnparseableFile[];
  /**
   * Packages the analysed sources import that the suite cannot resolve, so the
   * specs that import them will fail at collect (see analyse/bootability.ts).
   * The section renders only when something is in here.
   */
  unresolvable?: UnresolvableImport[];
  /**
   * A command that reproduces this run.
   *
   * Rebuilt from the run's options rather than captured from argv, so it is the
   * same line for a programmatic caller as for the CLI and carries no absolute
   * path — this file is committed, and a path under one machine's root churns
   * `git status` on every other. See reproCommand in core.ts.
   */
  command?: string;
  /** Every task id the tool has, so a partial run can say that it was partial. */
  allTaskIds?: readonly string[];
  /**
   * flawless:* scripts kept because their package.json value is not one the
   * tool recognizes as its own. In here — the committed artifact — because
   * the run's log line is invisible under --ci and programmatic use.
   */
  keptScripts?: readonly string[];
  /**
   * The skips generation emitted into the specs, counted so a suite cannot
   * go quietly yellow. Collected from the written spec files (collectNamedSkips).
   */
  namedSkips?: readonly NamedSkip[];
  /**
   * Every component symbol each swept file exports (or hides), from the parse.
   * The name-level coverage ledger is keyed on this — the file's own symbols —
   * not on the analyser's component set, which is exactly what let 54 shadcn
   * subcomponents vanish between runs without a word (audit C19). Absent means
   * not measured; the ledger says so rather than rendering an empty truth.
   */
  exportInventory?: readonly FileExports[];
  /** The run's root mode — the reason a non-root export went unanalysed. */
  rootMode?: string;
  /**
   * The accumulated verdict this run just wrote: where it lives (display path)
   * and which task ids have an entry. The "N of M tasks / Not run" line is
   * retired for every plane in `tasks` — those are on record, not missing.
   */
  verdict?: { path: string; tasks: readonly string[] };
}

/** One swept file's component symbols, as the file itself declares them. */
export interface FileExports {
  file: string;
  symbols: { name: string; exportKind: "default" | "named" | "none" }[];
}

/** First path that exists, or undefined. */
function firstExisting(paths: readonly string[]): string | undefined {
  for (const p of paths) if (existsSync(p)) return p;
  return undefined;
}

interface LedgerRow {
  name: string;
  file: string;
  status: string;
}

/**
 * The name-level coverage ledger: every component symbol of every swept file,
 * keyed on the file's own exports, each with its coverage named.
 *
 * The count table this replaces let 54 exported subcomponents go from spec'd
 * to neither spec'd nor accounted for in one scoping change, invisibly
 * (audit C19). The ledger makes the scoping visible: a symbol with a spec
 * points at the file that holds it; one without carries a named reason —
 * `covered-through: <parent>` when a spec'd parent renders it, `not-analysed`
 * when this run never analysed it, `not-spec'd` when it was analysed but no
 * spec file stands on disk.
 */
function coverageLedger(
  input: ReportInput,
  flat: readonly FlatComponent[],
  rel: (p: string) => string,
): LedgerRow[] {
  const inventory = input.exportInventory;
  if (!inventory || inventory.length === 0) return [];

  // Which symbols this run analysed, per file; which of them are spec targets;
  // and each analysed symbol's nearest parent (for the covered-through name).
  const analysed = new Map<string, Set<string>>();
  const targets = new Map<string, string[]>();
  const parentOf = new Map<string, string | undefined>();
  for (const c of flat) {
    const f = c.info.filePath;
    const pub = c.info.exportedAs ?? c.info.componentName;
    let set = analysed.get(f);
    if (!set) {
      set = new Set();
      analysed.set(f, set);
    }
    set.add(pub);
    parentOf.set(`${f}::${pub}`, c.parentName);
    if (hasSpec(c.info)) {
      let list = targets.get(f);
      if (!list) {
        list = [];
        targets.set(f, list);
      }
      list.push(pub);
    }
  }

  const notAnalysedReason =
    input.rootMode === "exported"
      ? "not analysed by this run"
      : "not a root of this run and not rendered by one — the sweep analysed each " +
        "file's primary component and the components its JSX renders";

  const rows: LedgerRow[] = [];
  for (const fe of inventory) {
    const dir = path.dirname(fe.file);
    const base = path.basename(fe.file).replace(/\.(tsx|jsx|ts|js)$/, "");
    const fileTargets = targets.get(fe.file) ?? [];
    for (const sym of fe.symbols
      .slice()
      .sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1))) {
      const pub = sym.name;
      let status: string;
      if (sym.exportKind === "none") {
        const parent = parentOf.get(`${fe.file}::${pub}`);
        status = parent
          ? `covered-through: \`${parent}\``
          : "covered-through: the file's primary component";
      } else {
        const ownSpec = firstExisting([
          path.join(dir, `${base}.${pub}.flawless.test.tsx`),
          path.join(input.outDir, "unit", `${base}.${pub}.test.tsx`),
          path.join(input.outDir, "unit", `${pub}.test.tsx`),
        ]);
        if (ownSpec) {
          status = `spec: \`${rel(ownSpec)}\``;
        } else if (fileTargets.includes(pub)) {
          const stem =
            fileTargets.length === 1
              ? firstExisting([
                  path.join(dir, `${base}.flawless.test.tsx`),
                  path.join(input.outDir, "unit", `${base}.test.tsx`),
                ])
              : undefined;
          status = stem
            ? `spec: \`${rel(stem)}\``
            : "not-spec'd: analysed this run; no spec file on disk — the unit-browser plane writes it";
        } else {
          status = `not-analysed: ${notAnalysedReason}`;
        }
      }
      rows.push({ name: pub, file: rel(fe.file), status });
    }
  }
  return rows.sort((a, b) =>
    a.file === b.file
      ? a.name === b.name
        ? 0
        : a.name < b.name
          ? -1
          : 1
      : a.file < b.file
        ? -1
        : 1,
  );
}

export function renderReportMarkdown(input: ReportInput): string {
  const root = input.projectRoot ?? input.outDir;
  const rel = (p: string): string => {
    const r = path.relative(root, p);
    if (!r.startsWith("..")) return r;
    // Without --nextjs, root is outDir — but colocated specs live in the
    // project tree BESIDE it, so they escape. Its parent is the tree both
    // share; relative to that they stay readable and machine-independent.
    const rp = path.relative(path.dirname(root), p);
    if (!rp.startsWith("..")) return rp;
    // This file is committed: an absolute path is forbidden because it names
    // one machine's checkout and churns `git status` on every other. A path
    // outside even the parent degrades to its basename instead.
    return path.basename(p);
  };

  const flat = flattenTrees(input.trees);
  const byMode = new Map<string, { hosted: number; excluded: number }>();
  const excluded: Array<{ name: string; file: string; reason: string }> = [];

  for (const c of flat) {
    const mode = c.info.renderMode ?? (c.info.isAsync ? "rsc" : "client");
    const row = byMode.get(mode) ?? { hosted: 0, excluded: 0 };
    const verdict = hostEligibility(c.info);
    if (verdict.eligible) row.hosted += 1;
    else {
      row.excluded += 1;
      excluded.push({
        name: c.info.componentName,
        file: rel(c.info.filePath),
        reason: verdict.reason ?? "not eligible",
      });
    }
    byMode.set(mode, row);
  }

  const unparseable = [...(input.unparseable ?? [])].sort((a, b) => (a.file < b.file ? -1 : 1));
  const hostedTotal = [...byMode.values()].reduce((n, r) => n + r.hosted, 0);
  const excludedTotal = [...byMode.values()].reduce((n, r) => n + r.excluded, 0);

  const lines: string[] = [
    "# flawless-react run report",
    "",
    `Generated by flawless-react ${VERSION}. This file is regenerated on every run;`,
    "edit the specs, not this.",
    "",
  ];
  if (input.command) {
    // Paths in it are relative to the same directory the file paths below are,
    // so it only reproduces the run when run from there.
    lines.push(
      "Reproduce this run from the project root:",
      "",
      "```bash",
      input.command,
      "```",
      "",
    );
  }

  // --- components ----------------------------------------------------------
  lines.push(
    "## Components",
    "",
    `${flat.length} component(s) across ${new Set(flat.map((c) => c.info.filePath)).size} file(s).`,
    "",
    "| Render mode | Mountable in the browser host | Not mountable |",
    "| --- | ---: | ---: |",
  );
  for (const mode of [...byMode.keys()].sort()) {
    const row = byMode.get(mode) as { hosted: number; excluded: number };
    lines.push(`| ${mode} | ${row.hosted} | ${row.excluded} |`);
  }
  lines.push(
    `| **total** | **${hostedTotal}** | **${excludedTotal}** |`,
    "",
    `${hostedTotal} + ${excludedTotal} = ${hostedTotal + excludedTotal} — every component ` +
      "the analyser found is in exactly one of those columns. " +
      (unparseable.length > 0
        ? `A further ${unparseable.length} file(s) yielded no component at all; they are listed below.`
        : "Every file it was pointed at yielded at least one component."),
    "",
  );

  if ((input.keptScripts ?? []).length > 0) {
    lines.push(
      `> Kept script(s): ${(input.keptScripts ?? []).join(", ")} — their package.json ` +
        "commands are not ones this tool version writes, so they were left in place. " +
        "Delete a key to take the tool's current command.",
      "",
    );
  }

  if (unparseable.length > 0) {
    lines.push("### Files no component could be read from", "");
    for (const u of unparseable) {
      // The reason usually repeats the absolute path the header already carries.
      const reason = u.reason
        .replace(u.file, "")
        .replace(/\s+in\s*[.:]/, ":")
        .trim();
      lines.push(`- \`${rel(u.file)}\` — ${reason}`);
    }
    lines.push("");
  }

  // --- what each task produced ---------------------------------------------
  // A `--tasks load` run used to rewrite this table with one row and no
  // qualification, so the report read as "this project has one task" rather
  // than "this run selected one". Two sessions reverted a truncated REPORT.md
  // by hand before anyone noticed the file was the thing lying.
  //
  // M1 retires the lying half of that line: a plane with a verdict entry is
  // never "Not run" — its last result is on record in VERDICT.md, and saying
  // otherwise is what audit C16/C31 caught ("This run selected 1 of 7 tasks"
  // after a full run). Only planes that have NEVER run are still named.
  const ran = new Set<string>(input.results.map((r) => r.id));
  const verdictTasks = new Set<string>(input.verdict?.tasks ?? []);
  const neverHeard = (input.allTaskIds ?? []).filter((id) => !ran.has(id) && !verdictTasks.has(id));
  const onRecordElsewhere = (input.allTaskIds ?? []).filter(
    (id) => !ran.has(id) && verdictTasks.has(id),
  );
  lines.push("## Tasks", "");
  if (input.verdict) {
    lines.push(
      `Run results for every plane, accumulated across runs: \`${input.verdict.path}\` —`,
      "each plane's last run, keyed by the target it describes.",
      "",
    );
  }
  if (neverHeard.length > 0) {
    lines.push(
      `This run selected ${input.results.length} of ${(input.allTaskIds ?? []).length} tasks.`,
      `Not run, and therefore not described below: ${neverHeard.map((id) => `\`${id}\``).join(", ")}.`,
    );
    if (onRecordElsewhere.length > 0 && input.verdict) {
      lines.push(
        `The other ${onRecordElsewhere.length} ran in an earlier invocation; their last results are in \`${input.verdict.path}\`.`,
      );
    }
    lines.push("");
  } else if (onRecordElsewhere.length > 0 && input.verdict) {
    lines.push(
      `This run selected ${input.results.length} of ${(input.allTaskIds ?? []).length} tasks; the rest ran in an earlier invocation, and their last results are in \`${input.verdict.path}\`.`,
      "",
    );
  }
  lines.push(
    "| Task | Files written | Findings | Status | Summary |",
    "| --- | ---: | ---: | --- | --- |",
  );
  for (const r of input.results) {
    // The full component list in a task summary runs to thousands of characters.
    const summary = r.summary.length > 120 ? `${r.summary.slice(0, 117)}…` : r.summary;
    lines.push(
      // An em dash, not an empty cell: only perf-harness reports a lifecycle
      // status today, and an empty cell reads as a rendering bug.
      `| \`${r.id}\` | ${r.outputs.length} | ${r.findings.length} | ${r.status ?? "—"} | ${summary.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");

  // --- what the React Compiler did for this run -----------------------------
  // The Tasks table row says "12 finding(s)". Whether that 12 was once 148 is a
  // fact about the compiler, and it is not in the table — so a reader of the
  // committed file cannot tell a suppressed zero from an honest one. Same
  // principle as the native-a11y denominator: a zero has to say what kind of
  // zero it is. Rendered only for the two states that change what the number
  // means or could have changed (see compilerNote in tasks/staticPerfAnalysis.ts).
  const compiler = input.results.find((r) => r.reactCompiler !== undefined)?.reactCompiler;
  if (compiler && compiler.state !== "off") {
    const suppressed = compiler.suppressed ?? [];
    const suppressedFindings = suppressed.reduce((n, s) => n + s.count, 0);
    lines.push(
      compiler.state === "on"
        ? `> \`perf-static\`: ${suppressed.length} memo rule(s) suppressed — React Compiler ` +
            `detected (\`${compiler.evidence}\`), so ${suppressedFindings} finding(s) of work ` +
            "it does by itself were not reported. A zero from `unstable-child-prop`, " +
            "`missing-memo-leaf` or `no-memoisation-with-children` here means the compiler " +
            "memoises it, not that nothing was found."
        : "> `perf-static`: React Compiler state undetermined " +
            `(\`${compiler.evidence}\`) — all nine rules ran, and the memo-family findings ` +
            "above may be pre-compiled noise on a compiler-on app.",
      "",
    );
  }

  // --- spec quality ----------------------------------------------------------
  // The other half of the perf-static number, deliberately not in the findings
  // column above. `perf/unresolved-prop` is the analyser failing to invent a
  // value, not the app rerendering: on the dogfood run it was 713 of 926
  // "findings", one component contributing 148, and the 127 findings that needed
  // someone were under it. Bucketed per component because that is the unit a
  // person fixes.
  const specQuality = input.results.find((r) => r.specQuality !== undefined)?.specQuality;
  if (specQuality) {
    lines.push(
      "## Spec quality",
      "",
      `\`${specQuality.rule}\`: ${specQuality.props} prop(s) across ` +
        `${specQuality.components.length} component(s) where the analyser could not synthesise a ` +
        "default, so the generated spec passes `undefined` for that prop. Not performance " +
        "findings, and not in the table above — they are this tool's own fixture limits, and a " +
        "component's specs stay weak until they are filled.",
      "",
      "Fix one with `--props '{\"name\":1}'`, or by editing that spec's `DEFAULTS`.",
      "",
      "| Component | File | Props |",
      "| --- | --- | --- |",
    );
    for (const bucket of specQuality.components.slice(0, 25)) {
      const shown = bucket.props
        .slice(0, 8)
        .map((p) => `\`${p}\``)
        .join(", ");
      const more = bucket.props.length > 8 ? `, +${bucket.props.length - 8} more` : "";
      lines.push(`| \`${bucket.component}\` | \`${rel(bucket.file)}\` | ${shown}${more} |`);
    }
    if (specQuality.components.length > 25) {
      lines.push(`| … | | ${specQuality.components.length - 25} more component(s) |`);
    }
    lines.push("");
  }

  // --- hand-work remaining --------------------------------------------------
  // The one adoption-cost number the component table cannot show: how many
  // TODO(flawless) markers the emitters planted, and of what kind. Counted at
  // the emission sites (TodoCounter), never recovered from the emitted text.
  // The section is ALWAYS present, in one of three states — a table, an
  // explicit "none", or an explicit "not measured" — because a silently absent
  // table reads as zero debt, and on the dogfood app the truth was 181 markers.
  // Which tasks can feed this section at all. Named once, and the copy below is
  // BUILT from who actually reported — B-12 added e2e as a second contributor
  // and a single global "measured / not measured" split immediately started
  // lying in both directions: an e2e-only run with a filled hook printed
  // "none — no TODO markers were emitted" (implying unit-browser measured zero
  // when it never ran), and a unit-browser-only run claimed the e2e auth hook
  // was counted. The scope sentence outliving the set of emitters behind it is
  // exactly how this section lied before.
  const CONTRIBUTING: readonly TaskId[] = ["unit-browser", "e2e"];
  const nameList = (ids: readonly TaskId[]): string =>
    ids.length === 1
      ? `\`${ids[0]}\``
      : `${ids
          .slice(0, -1)
          .map((i) => `\`${i}\``)
          .join(", ")} and \`${ids[ids.length - 1]}\``;
  const reported = CONTRIBUTING.filter((id) =>
    input.results.some((r) => r.id === id && r.handWork !== undefined),
  );
  const silent = CONTRIBUTING.filter((id) => !reported.includes(id));
  const measured = input.results.filter((r) => r.handWork !== undefined);
  lines.push("## Hand-work remaining", "");
  if (reported.length === 0) {
    lines.push(
      // "did not include the task" was false when the task ran and threw; this
      // wording is true in both states.
      `Not measured — ${nameList(CONTRIBUTING)} did not report a count (not selected, or it failed).`,
      "Absence of a table here is absence of measurement, not absence of debt.",
      "",
    );
  } else {
    lines.push(
      `Counted for ${nameList(reported)} — the load and provider files carry their`,
      "own `TODO(flawless)` markers, not counted here." +
        (silent.length > 0
          ? ` ${nameList(silent)} did not report a count (not selected, or it failed), so this is not a total.`
          : ""),
      "",
    );
    const byKind = new Map<TodoKind, { count: number; exemplar: string }>();
    for (const r of measured) {
      for (const t of r.handWork ?? []) {
        const row = byKind.get(t.kind);
        if (!row) byKind.set(t.kind, { count: t.count, exemplar: t.exemplar });
        else {
          row.count += t.count;
          if (t.exemplar < row.exemplar) row.exemplar = t.exemplar;
        }
      }
    }
    if (byKind.size === 0) {
      lines.push(`none — ${nameList(reported)} emitted no TODO markers.`, "");
    } else {
      lines.push(
        "Each `TODO(flawless)` marker is a place where a spec needs a human: a",
        "fixture, an addressable target, or an assertion the source could not",
        "support statically. Search the marker to find every site of a kind.",
        "",
        "| Kind | Markers | Example file |",
        "| --- | ---: | --- |",
      );
      for (const kind of [...byKind.keys()].sort()) {
        const row = byKind.get(kind) as { count: number; exemplar: string };
        lines.push(`| \`${kind}\` | ${row.count} | \`${rel(row.exemplar)}\` |`);
      }
      lines.push("");
    }
  }

  // --- inverted predicates (B-19) ------------------------------------------
  {
    const emitted = new Map<string, number>();
    const refused = new Map<string, { count: number; exemplar: string }>();
    for (const c of flat) {
      for (const inv of c.info.predicateInversions ?? []) {
        emitted.set(inv.kind, (emitted.get(inv.kind) ?? 0) + 1);
      }
      for (const r of c.info.predicateRefusals ?? []) {
        const row = refused.get(r.reason);
        const at = `${rel(r.pos.file)}:${r.pos.line}`;
        if (!row) refused.set(r.reason, { count: 1, exemplar: at });
        else row.count += 1;
      }
    }
    if (emitted.size > 0 || refused.size > 0) {
      lines.push(
        "## Inverted predicates",
        "",
        "Second mounts that exercise the OTHER side of a decidable predicate — a",
        "boolean dep flipped false, a nullable dep flipped null, a list flipped",
        "empty, a prop overridden. Each flip is certified against the values the",
        "mocks actually hold; refusals are the certifier declining by name, not",
        "hand-work to fill.",
        "",
        "| Outcome | Count | Example |",
        "| --- | ---: | --- |",
      );
      for (const kind of [...emitted.keys()].sort()) {
        lines.push(`| emitted \`${kind}\` | ${emitted.get(kind)} | — |`);
      }
      for (const reason of [...refused.keys()].sort()) {
        const row = refused.get(reason) as { count: number; exemplar: string };
        lines.push(`| refused \`${reason}\` | ${row.count} | \`${row.exemplar}\` |`);
      }
      lines.push("");
    }
  }

  // --- bootability ---------------------------------------------------------
  // Vitest resolves a spec's imports at COLLECT time, so a package the suite
  // cannot find takes the whole file down before one test runs. Without this
  // section the run reads as "N files failed, no tests" and nothing says why.
  const broken = input.unresolvable ?? [];
  if (broken.length > 0) {
    const affected = broken.reduce((n, b) => n + b.count, 0);
    lines.push("## Imports that will not resolve", "");
    lines.push(
      `${broken.length} package(s) the analysed sources import are installed nowhere the suite`,
      `resolves from, and ${affected} component(s) import them. Vitest resolves imports while it`,
      "collects a spec file, so each of those files fails before a single test runs:",
      "`Failed to resolve import`. Install the package, or leave those components out of the",
      "pattern. Not listed here: modules this suite stubs (`next/*`, the provider shims,",
      "auth libraries), `import type` specifiers, and assets vite loads by extension.",
      "",
      "| Module | Components | Examples |",
      "| --- | --- | --- |",
    );
    for (const b of broken.slice(0, 25)) {
      const shown = b.examples.map((n) => `\`${n}\``).join(", ");
      const more = b.count > b.examples.length ? `, …` : "";
      lines.push(`| \`${b.specifier}\` | ${b.count} | ${shown}${more} |`);
    }
    if (broken.length > 25) lines.push(`| … | | ${broken.length - 25} more module(s) |`);
    lines.push("");
  }

  // --- skips ---------------------------------------------------------------
  lines.push("## Not covered, and why", "");
  if (excluded.length === 0) {
    lines.push("Every component is mountable in the browser host.", "");
  } else {
    lines.push(
      `${excluded.length} component(s) have no browser profile spec. Most still have a unit`,
      "spec — these are only the ones that cannot mount in the profiling host. The",
      "exception is `not exported`: nothing can import those, so they have no spec of",
      "any kind and are covered through the parent that renders them.",
      "",
      "| Component | File | Reason |",
      "| --- | --- | --- |",
    );
    for (const e of [...excluded].sort((a, b) =>
      a.file === b.file ? (a.name < b.name ? -1 : 1) : a.file < b.file ? -1 : 1,
    )) {
      lines.push(`| \`${e.name}\` | \`${e.file}\` | ${e.reason} |`);
    }
    lines.push("");
  }

  // --- coverage ledger ------------------------------------------------------
  // The name-level ledger (audit C19 sharpening): keyed on each file's own
  // exports, so a scoping change that drops symbols from the analyser's set
  // shows up as named `not-analysed` rows instead of silence.
  const ledger = coverageLedger(input, flat, rel);
  if (input.exportInventory === undefined) {
    lines.push(
      "### Coverage ledger",
      "",
      "Not measured — no export inventory reached the report. Absence of a",
      "ledger here is absence of measurement, not absence of uncovered symbols.",
      "",
    );
  } else if (ledger.length > 0) {
    const count = (prefix: string): number =>
      ledger.filter((r) => r.status.startsWith(prefix)).length;
    lines.push(
      "### Coverage ledger",
      "",
      `${ledger.length} component symbol(s) across ${new Set(ledger.map((r) => r.file)).size} file(s), keyed on each`,
      "file's own exports — not on what this run analysed. Every symbol is named;",
      "a symbol with a spec points at it, one without carries a named reason:",
      "`covered-through: <parent>` (a spec'd parent renders it), `not-analysed: <reason>`",
      "(this run did not analyse it), or `not-spec'd: <reason>`.",
      "",
      `With a spec: ${count("spec:")}. Covered through a parent: ${count("covered-through:")}. ` +
        `Not analysed: ${count("not-analysed:")}. Analysed, no spec file: ${count("not-spec'd:")}.`,
      "",
      "| Symbol | File | Coverage |",
      "| --- | --- | --- |",
    );
    for (const r of ledger) lines.push(`| \`${r.name}\` | \`${r.file}\` | ${r.status} |`);
    lines.push("");
  }

  // --- named skips ----------------------------------------------------------
  // The chunk-9 skip contract, counted at generation time: every emitted
  // test.skip carries its reason in its title, and this section makes the
  // count auditable without running the suite. A skip that names no reason
  // is a tool defect (the guard test in the dogfood baseline reddens one).
  lines.push("## Named skips", "");
  const namedSkips = [...(input.namedSkips ?? [])].sort((a, b) =>
    rel(a.file) === rel(b.file) ? (a.title < b.title ? -1 : 1) : rel(a.file) < rel(b.file) ? -1 : 1,
  );
  if (namedSkips.length === 0) {
    lines.push("No emitted spec skips a test by name.", "");
  } else {
    lines.push(
      `${namedSkips.length} emitted test(s) skip by name. Every skip title carries its`,
      "reason — a capability the host cannot provide or a fixture this analysis",
      "could not synthesise. Runtime skips a test declares for itself (`t.skip()`)",
      "are counted by the runner, not here: generation cannot see a run it did",
      "not make.",
      "",
      "| Spec | Skipped test |",
      "| --- | --- |",
    );
    for (const s of namedSkips) {
      lines.push(`| \`${rel(s.file)}\` | ${s.title} |`);
    }
    lines.push("");
  }

  // --- standing limitations ------------------------------------------------
  lines.push(
    "## Standing gaps",
    "",
    "These are properties of the analysis, not of this run. They do not go away by",
    "re-running it.",
    "",
    "- Mocks come from each component's OWN imports. A component that renders",
    "  `<Link>` only through a child gets no `next/link` mock in its own spec.",
    "- Props typed through `node_modules` (`ButtonPrimitive.Props`) are not",
    "  resolved; the spec passes `undefined` unless the body indexes a",
    "  same-file literal table with them. `z.infer` aliases resolve by reading",
    "  the zod schema syntactically; only schemas outside the supported subset",
    "  (.transform, unions, records, dates) fall back the same way.",
    "- A cva variant is asserted to render DIFFERENTLY from its siblings, never to",
    "  carry a specific class: `cn()` is usually tailwind-merge, which drops base",
    "  classes a later variant conflicts with.",
    "- An early return this analysis cannot decide means the component may render",
    "  nothing at the props a spec can synthesise; its interaction tests are",
    "  skipped rather than failed.",
    "- An element is addressed by test id, `aria-label`, role plus name, `id` or",
    "  literal copy. The bare host tag is a last resort and only stands when it is",
    "  the only element of its kind in that render — otherwise the test is skipped,",
    "  because `button` names nothing when there are two of them.",
    "- A form is submitted through the control its markup declares: a host",
    "  `<button>` unless its `type` says otherwise, a component tag only with an",
    '  explicit `type="submit"`. No such control, or one disabled at these props,',
    "  means no submit test — the button's copy is never guessed at.",
    "- A component that calls `console.error`, or `.error()` on an imported",
    "  binding, reports errors by design, so its browser spec does not also assert",
    "  that mounting produced none.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

export async function writeReportMarkdown(input: ReportInput): Promise<string> {
  const out = path.join(input.outDir, "REPORT.md");
  await Bun.write(out, renderReportMarkdown(input));
  return out;
}
