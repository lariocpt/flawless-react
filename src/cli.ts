import { runCore, UsageError } from "./core.ts";
import { confirmRunTests, outro, promptInteractive } from "./prompt.ts";
import { printSummaryTable } from "./reporters/findings.ts";
import { TASKS } from "./tasks/index.ts";
import type { CliArgs, PropsShape, RootMode, TaskId } from "./types.ts";

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
                         Available: perf-harness, unit-browser, perf-static, a11y,
                         react-rules, e2e, load
  --roots <mode>         primary (default) analyses each file's main component;
                         exported emits a tree per exported component, which is what a
                         whole-app sweep needs (a shadcn card.tsx exports 7 of them).
  --exclude <glob>       Skip matching files (repeatable). Appended to the defaults,
                         which already skip *.flawless.test.*, *.test.*, *.spec.*,
                         *.d.ts, node_modules, .next, dist, build, coverage, flawless/.
  --no-default-excludes  Drop those defaults (then a glob can match generated specs).
  --colocate             Emit unit specs beside the analysed sources as
                         <name>.flawless.test.tsx (existing colocated specs are kept
                         unless --force). The flawless/ dir keeps config + mocks.
  --ci                   Shorthand for --no-interactive --json.
  --no-interactive       Never prompt; require a positional + --tasks.
  --run-tests            After generating, run the produced test suites.
  --no-inline-summary    Don't drop <Component>.flawless.json next to each source file.
  --json                 Print machine-readable JSON summary to stdout.
  --nextjs [<path>]      Treat <path> (or cwd) as a Next.js project: detect router style,
                         emit MSW handlers + swagger from app/api or pages/api, auto-set the
                         app resolver from app/layout.tsx or pages/_app.tsx, merge generated
                         deps into the project's package.json (devDependencies) and place
                         everything under <nextRoot>/flawless/.
  --app-resolver <file>  Override the auto-detected Next.js app resolver (alias for --provider
                         in Next.js mode; the file must default-export a wrapper component).
  --swagger-url <url>    Fetch an OpenAPI spec from a live URL (e.g.
                         http://localhost:3000/api/docs from next-swagger-doc) and prefer it
                         over static AST inference. In --nextjs mode the default URL above is
                         tried automatically with a short timeout; pass --swagger-url to
                         force a specific URL or skip the auto-try via --swagger-url=off.
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
  "e2e",
  "load",
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
  let nextjs: string | undefined;
  let appResolver: string | undefined;
  let swaggerUrl: string | undefined;
  let colocate = false;
  let ci = false;
  let roots: RootMode = "primary";
  const exclude: string[] = [];
  let useDefaultExcludes = true;

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
    } else if (a === "--nextjs") {
      const peek = argv[i + 1];
      if (peek !== undefined && !peek.startsWith("-")) {
        nextjs = argv[++i] as string;
      } else {
        nextjs = ".";
      }
    } else if (a.startsWith("--nextjs=")) {
      nextjs = a.slice("--nextjs=".length) || ".";
    } else if (a === "--app-resolver") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--app-resolver requires a file path");
      appResolver = v;
    } else if (a.startsWith("--app-resolver=")) {
      appResolver = a.slice("--app-resolver=".length);
    } else if (a === "--swagger-url") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--swagger-url requires a value");
      swaggerUrl = v;
    } else if (a.startsWith("--swagger-url=")) {
      swaggerUrl = a.slice("--swagger-url=".length);
    } else if (a === "--roots" || a.startsWith("--roots=")) {
      const v = a.startsWith("--roots=") ? a.slice("--roots=".length) : argv[++i];
      if (v !== "primary" && v !== "exported") {
        throw new Error(`--roots must be "primary" or "exported", got: ${v ?? "<missing>"}`);
      }
      roots = v;
    } else if (a === "--exclude" || a.startsWith("--exclude=")) {
      const v = a.startsWith("--exclude=") ? a.slice("--exclude=".length) : argv[++i];
      if (v === undefined) throw new Error("--exclude requires a glob");
      exclude.push(v);
    } else if (a === "--no-default-excludes") {
      useDefaultExcludes = false;
    } else if (a === "--colocate") {
      colocate = true;
    } else if (a === "--ci") {
      ci = true;
      noInteractive = true;
      json = true;
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
    nextjs,
    appResolver,
    swaggerUrl,
    colocate,
    ci,
    roots,
    exclude,
    useDefaultExcludes,
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

  if (pattern === undefined && args.nextjs === undefined) {
    process.stderr.write(
      "missing entry path or glob. Pass a .tsx path, a glob, or run in a TTY for the interactive menu. See --help.\n",
    );
    process.exit(2);
  }

  let result: Awaited<ReturnType<typeof runCore>>;
  try {
    result = await runCore({
      pattern: pattern as string,
      outDir,
      taskIds,
      depth: args.depth,
      variants: args.variants,
      includeChildren: args.includeChildren,
      force: args.force,
      report: args.report,
      propsOverride: args.propsOverride,
      provider: args.provider ?? args.appResolver,
      apiSpec: args.apiSpec,
      inlineSummary: args.inlineSummary,
      nextjs: args.nextjs,
      swaggerUrl: args.swaggerUrl,
      colocate: args.colocate,
      roots: args.roots,
      exclude: args.exclude,
      useDefaultExcludes: args.useDefaultExcludes,
      runTests: args.runTests || (wantInteractive && (await confirmRunTests())),
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }

  printSummaryTable(result.results);
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ outDir: result.outDir, results: result.results }, null, 2)}\n`,
    );
  }
  if (wantInteractive) {
    await outro(result.exitCode !== 0 ? "done (with failures)" : "done");
  }
  process.exit(result.exitCode);
}
