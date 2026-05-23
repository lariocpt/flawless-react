import { existsSync } from "node:fs";
import path from "node:path";
import { analyse } from "./analyse/index.ts";
import { confirmRunTests, outro, promptInteractive } from "./prompt.ts";
import { printFindings, printSummaryTable, writeInlineSummaries, writeSummaryJson } from "./reporters/findings.ts";
import { runGeneratedTests } from "./runner/runTests.ts";
import { TASKS, findTask } from "./tasks/index.ts";
import type {
  CliArgs,
  ComponentTree,
  PropsShape,
  RunContext,
  Task,
  TaskId,
  TaskResult,
} from "./types.ts";

const HELP = `flawless-react — multi-task quality kit for React components

Usage:
  flawless-react <entry-or-glob> [options]
  flawless-react                       (interactive menu)

Positional:
  <entry-or-glob>      A .tsx file path or a glob (e.g. "src/**/*.tsx").
                       Each matched file is analysed as its own entry component.

Options:
  --out <dir>            Output directory (default: ./.flawless)
  --tasks <csv>          Comma-separated task ids to run (skip the interactive menu).
                         Available: perf-harness, unit-browser, perf-static, a11y, react-rules
  --no-interactive       Never prompt; require a positional + --tasks.
  --run-tests            After generating, run the produced test suites.
  --no-inline-summary    Don't drop <Component>.flawless.json next to each source file.
  --json                 Print machine-readable JSON summary to stdout.
  --depth N              Levels of locally-imported children to follow (default 3)
  --variants N           Variant rows per component (default 5)
  --include-children     Walk children (default true). Pass --include-children=false to skip.
  --props '<json>'       Override the synthesised default props for the first entry.
  --provider <file>      Path to a .tsx file default-exporting a Provider wrapper.
  --api <spec>           Path to an OpenAPI/Swagger spec; scaffolds a mock server.
  --force                Overwrite an existing output dir.
  --report               Emit scripts/report.mjs to aggregate run output.
  -h, --help             Show this help.
  -V, --version          Show version.
`;

const VALID_TASK_IDS: ReadonlySet<TaskId> = new Set<TaskId>([
  "perf-harness",
  "unit-browser",
  "perf-static",
  "a11y",
  "react-rules",
]);

export function parseArgs(argv: string[]): CliArgs {
  let entry: string | undefined;
  let out: string | undefined;
  let depth = 3;
  let variants = 5;
  let includeChildren = true;
  let force = false;
  let report = false;
  let propsOverride: PropsShape | undefined;
  let provider: string | undefined;
  let apiSpec: string | undefined;
  let tasks: TaskId[] | undefined;
  let noInteractive = false;
  let json = false;
  let runTests = false;
  let inlineSummary = true;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--out") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--out requires a value");
      out = v;
    } else if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
    } else if (a === "--depth") {
      depth = Number(argv[++i] ?? "3");
    } else if (a.startsWith("--depth=")) {
      depth = Number(a.slice("--depth=".length));
    } else if (a === "--variants") {
      variants = Number(argv[++i] ?? "5");
    } else if (a.startsWith("--variants=")) {
      variants = Number(a.slice("--variants=".length));
    } else if (a === "--include-children") {
      includeChildren = true;
    } else if (a.startsWith("--include-children=")) {
      const v = a.slice("--include-children=".length).toLowerCase();
      includeChildren = !(v === "false" || v === "0" || v === "no");
    } else if (a === "--props") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--props requires a JSON value");
      propsOverride = JSON.parse(v) as PropsShape;
    } else if (a.startsWith("--props=")) {
      propsOverride = JSON.parse(a.slice("--props=".length)) as PropsShape;
    } else if (a === "--provider") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--provider requires a file path");
      provider = v;
    } else if (a.startsWith("--provider=")) {
      provider = a.slice("--provider=".length);
    } else if (a === "--api") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--api requires a file path");
      apiSpec = v;
    } else if (a.startsWith("--api=")) {
      apiSpec = a.slice("--api=".length);
    } else if (a === "--tasks") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--tasks requires a csv value");
      tasks = parseTaskList(v);
    } else if (a.startsWith("--tasks=")) {
      tasks = parseTaskList(a.slice("--tasks=".length));
    } else if (a === "--no-interactive") {
      noInteractive = true;
    } else if (a === "--run-tests") {
      runTests = true;
    } else if (a === "--no-inline-summary") {
      inlineSummary = false;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--report") {
      report = true;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === "-V" || a === "--version") {
      process.stdout.write("flawless-react 0.2.0-dev\n");
      process.exit(0);
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (entry === undefined) {
      entry = a;
    } else {
      throw new Error(`unexpected positional: ${a}`);
    }
  }

  if (!Number.isFinite(depth) || depth < 0) throw new Error(`--depth must be >= 0`);
  if (!Number.isFinite(variants) || variants < 0) throw new Error(`--variants must be >= 0`);

  return {
    entry,
    out,
    depth,
    variants,
    includeChildren,
    force,
    report,
    propsOverride,
    provider,
    apiSpec,
    tasks,
    noInteractive,
    json,
    runTests,
    inlineSummary,
  };
}

function parseTaskList(s: string): TaskId[] {
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const ids: TaskId[] = [];
  for (const p of parts) {
    if (!VALID_TASK_IDS.has(p as TaskId)) {
      throw new Error(`unknown task id: ${p}. Available: ${[...VALID_TASK_IDS].join(", ")}`);
    }
    ids.push(p as TaskId);
  }
  return ids;
}

function defaultOutDir(): string {
  return path.join(process.cwd(), ".flawless");
}

export async function main(argv: string[]): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }

  let pattern = args.entry;
  let outDir = args.out;
  let taskIds = args.tasks;

  const wantInteractive = !args.noInteractive && pattern === undefined && process.stdin.isTTY;
  if (wantInteractive) {
    const picked = await promptInteractive({
      taskChoices: TASKS.map((t) => ({ id: t.id, label: t.label, description: t.description })),
      defaultTaskIds: ["perf-harness", "perf-static"],
    });
    if (!picked) {
      process.exit(0);
    }
    pattern = picked.pattern;
    outDir = picked.outDir;
    taskIds = picked.tasks;
  }

  if (pattern === undefined) {
    process.stderr.write(
      "missing entry path or glob. Pass a .tsx path, a glob, or run in a TTY for the interactive menu. See --help.\n",
    );
    process.exit(2);
  }

  if (taskIds === undefined || taskIds.length === 0) {
    taskIds = ["perf-harness"];
  }

  outDir = path.resolve(outDir ?? defaultOutDir());

  const files = await expandGlob(pattern);
  if (files.length === 0) {
    process.stderr.write(`no files matched: ${pattern}\n`);
    process.exit(2);
  }

  const trees: ComponentTree[] = [];
  for (const file of files) {
    try {
      const tree = await analyse({
        entry: file,
        depth: args.depth,
        includeChildren: args.includeChildren,
      });
      trees.push(tree);
    } catch (err) {
      process.stderr.write(`warning: skipping ${file}: ${(err as Error).message}\n`);
    }
  }
  if (trees.length === 0) {
    process.stderr.write("no analysable components found\n");
    process.exit(2);
  }

  const firstTree = trees[0];
  if (firstTree && args.propsOverride) {
    firstTree.entry.propsShape = { ...firstTree.entry.propsShape, ...args.propsOverride };
  }

  const selected = taskIds
    .map((id) => findTask(id))
    .filter((t): t is Task => Boolean(t));

  const ctx: RunContext = {
    trees,
    outDir,
    variants: args.variants,
    force: args.force,
    report: args.report,
    provider: args.provider,
    apiSpec: args.apiSpec,
    inlineSummary: args.inlineSummary,
    json: args.json,
  };

  const results: TaskResult[] = [];
  let anyFailed = false;
  for (const task of selected) {
    try {
      const r = await task.run(ctx);
      results.push(r);
      if (!r.ok) anyFailed = true;
      printFindings(r.findings);
    } catch (err) {
      anyFailed = true;
      results.push({
        id: task.id,
        ok: false,
        outputs: [],
        findings: [],
        summary: "task threw",
        error: (err as Error).message,
      });
    }
  }

  if (args.inlineSummary) {
    await writeInlineSummaries(trees, results, outDir);
  }
  await writeSummaryJson(outDir, results);
  printSummaryTable(results);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ outDir, results }, null, 2)}\n`);
  }

  const wantToRunTests =
    !anyFailed &&
    selected.some((t) => t.id === "perf-harness" || t.id === "unit-browser") &&
    (args.runTests || (wantInteractive && (await confirmRunTests())));

  if (wantToRunTests) {
    await runGeneratedTests(outDir, selected.map((t) => t.id));
  }

  if (wantInteractive) {
    await outro(anyFailed ? "done (with failures)" : "done");
  }

  process.exit(anyFailed ? 1 : 0);
}

async function expandGlob(pattern: string): Promise<string[]> {
  const abs = path.resolve(pattern);
  if (existsSync(abs)) return [abs];
  const hasGlobChar = /[*?[\]{}]/.test(pattern);
  if (!hasGlobChar) {
    return [];
  }
  const glob = new Bun.Glob(pattern);
  const out: string[] = [];
  for await (const f of glob.scan({ cwd: process.cwd(), absolute: true })) {
    out.push(f);
  }
  return out.sort();
}
