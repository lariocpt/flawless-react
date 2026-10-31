// core.ts (via the analyser) imports the TypeScript compiler — ~110ms of
// startup nobody running --help/--version should pay. Only type-only imports
// of that graph may appear here; the value imports of runCore and TASKS happen
// inside main(), after parseArgs and its fast paths have had their chance to
// exit. UsageError comes from types.ts, a leaf, precisely so this file never
// needs core.ts at load time.
import { FLAG_NAMES, renderHelp } from "./cliFlags.ts";
import type { CoreResult } from "./core.ts";
import { flawlessArgv, stripTrailingComment } from "./docLine.ts";
import { isMcpArgv, parseMcpCommand } from "./mcp/spec.ts";
import { confirmRunTests, outro, promptInteractive } from "./prompt.ts";
import { printSummaryTable } from "./reporters/findings.ts";
import {
  isSkillsArgv,
  parseSkillsCommand,
  renderSkillsHelp,
  type SkillsCommand,
} from "./skills/spec.ts";
import {
  type CliArgs,
  type HeapMode,
  type PropsShape,
  type RootMode,
  type TaskId,
  UsageError,
} from "./types.ts";
import { VERSION } from "./version.ts";

const VALID_TASK_IDS: ReadonlySet<TaskId> = new Set<TaskId>([
  "perf-harness",
  "unit-browser",
  "perf-static",
  "a11y",
  "react-rules",
  "e2e",
  "load",
]);

/** A closed set, so a typo fails at the CLI rather than silently profiling everything. */
function readHeapMode(raw: string | undefined): HeapMode {
  if (raw === "off" || raw === "stress" || raw === "all") return raw;
  throw new Error(`--heaps must be off, stress or all (got ${JSON.stringify(raw ?? "")})`);
}

export function parseArgs(argv: string[]): CliArgs {
  let entry: string | undefined;
  let out: string | undefined;
  let depth = 3;
  let variants = 5;
  let heaps: HeapMode = "stress";
  let changed: string | true | undefined;
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
  let expo: string | undefined;
  let appResolver: string | undefined;
  let swaggerUrl: string | undefined;
  let colocate = false;
  let ci = false;
  let roots: RootMode = "primary";
  const exclude: string[] = [];
  let useDefaultExcludes = true;
  let help = false;
  let version = false;

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
      const v = argv[++i];
      if (v === undefined) throw new Error("--depth requires a value");
      depth = Number(v);
    } else if (a.startsWith("--depth=")) {
      depth = Number(a.slice("--depth=".length));
    } else if (a === "--changed") {
      // Optional value: `--changed` alone means HEAD, `--changed main` a ref.
      const next = argv[i + 1];
      changed = next !== undefined && !next.startsWith("-") ? (argv[++i] as string) : true;
    } else if (a.startsWith("--changed=")) {
      changed = a.slice("--changed=".length) || true;
    } else if (a === "--heaps") {
      heaps = readHeapMode(argv[++i]);
    } else if (a.startsWith("--heaps=")) {
      heaps = readHeapMode(a.slice("--heaps=".length));
    } else if (a === "--variants") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--variants requires a value");
      variants = Number(v);
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
      propsOverride = parsePropsJson(v);
    } else if (a.startsWith("--props=")) {
      propsOverride = parsePropsJson(a.slice("--props=".length));
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
    } else if (a === "--expo") {
      const peek = argv[i + 1];
      if (peek !== undefined && !peek.startsWith("-")) {
        expo = argv[++i] as string;
      } else {
        expo = ".";
      }
    } else if (a.startsWith("--expo=")) {
      expo = a.slice("--expo=".length) || ".";
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
      // `break`, not a return: --help used to process.exit(0) right here, so
      // everything after it went unread and the post-loop validation never ran.
      // Both are preserved deliberately — `--depth=-1 --help` printed help then,
      // and prints help now, rather than becoming a usage error.
      help = true;
      break;
    } else if (a === "-V" || a === "--version") {
      version = true;
      break;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (entry === undefined) {
      entry = a;
    } else {
      throw new Error(`unexpected positional: ${a}`);
    }
  }

  if (!help && !version) {
    // A project is one or the other. Checked here rather than in either detector
    // so the message names the conflict instead of whichever ran first, and so
    // it costs nothing on the --help path.
    if (nextjs !== undefined && expo !== undefined) {
      throw new Error(
        "--nextjs and --expo are mutually exclusive: a project is a Next.js app or an Expo app, not both.",
      );
    }
    if (!Number.isFinite(depth) || depth < 0) throw new Error(`--depth must be >= 0`);
    if (!Number.isFinite(variants) || variants < 0) throw new Error(`--variants must be >= 0`);
  }

  return {
    entry,
    out,
    depth,
    variants,
    heaps,
    changed,
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
    expo,
    appResolver,
    swaggerUrl,
    colocate,
    ci,
    roots,
    exclude,
    useDefaultExcludes,
    help,
    version,
  };
}

/** A raw JSON.parse error ("JSON Parse error: …") names no flag; keep the
 *  diagnostic but say which flag carried the bad value. */
function parsePropsJson(raw: string): PropsShape {
  try {
    return JSON.parse(raw) as PropsShape;
  } catch (err) {
    throw new Error(`--props is not valid JSON: ${(err as Error).message}`);
  }
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

export interface LineProblem {
  line: string;
  problem: string;
}

export interface CheckReport {
  /** flawless-react invocations examined, whether or not they parsed. */
  checked: number;
  /** Lines that invoke something else. Not a failure, but see the note below. */
  skipped: number;
  problems: LineProblem[];
}

/**
 * Parse every documented flawless-react invocation in `text` without running it.
 *
 * The lint for shipped examples. Parsing is pure — parseArgs opens no file and
 * spawns nothing — so an example naming ./src/Dashboard.tsx or a seeded database
 * checks clean on a machine that has neither.
 *
 * `checked === 0` is reported, never smoothed over. A run that examined nothing
 * and said "ok" is the exact false pass this tool exists to eliminate, and it is
 * the likeliest failure of a doc lint: the extractor breaks, no line survives to
 * be checked, and the gate stays green while the docs rot behind it.
 */
export function checkLines(text: string): CheckReport {
  const report: CheckReport = { checked: 0, skipped: 0, problems: [] };
  for (const raw of text.split("\n")) {
    const line = stripTrailingComment(raw).trim();
    if (line === "" || line.startsWith("#")) continue;
    let argv: string[] | null;
    try {
      argv = flawlessArgv(line);
    } catch (err) {
      report.checked++;
      report.problems.push({ line, problem: (err as Error).message });
      continue;
    }
    if (argv === null) {
      report.skipped++;
      continue;
    }
    report.checked++;
    try {
      // Two other grammars, neither of which parseArgs speaks: `skills …` is a
      // subcommand and `--flags` a bare switch. Left to parseArgs, a working
      // `flawless-react skills install --all` would be reported broken (its verb
      // read as an entry glob) and a stale flag in prose would pass uncaught —
      // both directions of the same silence. `mcp …` is a third: without it a
      // documented `flawless-react mcp` line passes as an entry glob named "mcp",
      // which is the wrong-reason pass skills/spec.ts exists to prevent.
      if (isSkillsArgv(argv)) parseSkillsCommand(argv.slice(1));
      else if (isMcpArgv(argv)) parseMcpCommand(argv.slice(1));
      else if (argv[0] === "--flags") {
        if (argv.length > 1) throw new Error("--flags takes no arguments");
      } else parseArgs(argv);
    } catch (err) {
      report.problems.push({ line, problem: (err as Error).message });
    }
  }
  return report;
}

export async function main(argv: string[]): Promise<void> {
  // The skills subcommand, ahead of parseArgs for the same reason as the two
  // surfaces below it: `skills` is not an entry glob, and falling through would
  // mean parsing it as one. The bytes stay behind a dynamic import — the grammar
  // here costs a few hundred bytes, the ~70 KB of embedded SKILL.md comes in only
  // once a verb is actually being run.
  if (isSkillsArgv(argv)) {
    let cmd: SkillsCommand;
    try {
      cmd = parseSkillsCommand(argv.slice(1));
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(2);
    }
    if (cmd.verb === "help") {
      process.stdout.write(renderSkillsHelp());
      process.exit(0);
    }
    const { runSkillsCommand } = await import("./skills/cli.ts");
    process.exit(await runSkillsCommand(cmd));
  }

  // The MCP server, dispatched for the same reason as `skills` above: `mcp` is a
  // subcommand, not an entry glob. Falling through would start a generation run
  // over a project called "mcp" — and the docs lint would still call that line
  // clean. The whole server (the analyser, the rules, the child plane) stays
  // behind a dynamic import so `--help` and `--check` never pay for the TypeScript
  // compiler it reaches through (FR-031); only a host that actually speaks the
  // protocol loads it.
  if (isMcpArgv(argv)) {
    const { runMcpCli } = await import("./mcp/server.ts");
    process.exit(await runMcpCli(argv.slice(1)));
  }

  // Two parse-only surfaces, ahead of parseArgs and well ahead of the core
  // graph. They exist for consumers that CANNOT import this module: the website
  // repo keeps hand-copied examples and a "every flag flawless-react accepts"
  // table, and its CI can run the published binary even though it can have no
  // opinion about this source tree. Both must stay clear of core.ts, or --help
  // and --check start paying for the TypeScript compiler (FR-031).
  if (argv[0] === "--flags") {
    if (argv.length > 1) {
      process.stderr.write("--flags takes no arguments\n");
      process.exit(2);
    }
    process.stdout.write(`${FLAG_NAMES.join("\n")}\n`);
    process.exit(0);
  }
  if (argv[0] === "--check") {
    if (argv.length < 2) {
      process.stderr.write("--check requires a line to check\n");
      process.exit(2);
    }
    // Several operands are joined rather than rejected: a caller feeding a whole
    // doc page one block per argument is the normal shape, and an unquoted line
    // would otherwise be silently truncated to its first word.
    const report = checkLines(argv.slice(1).join("\n"));
    for (const p of report.problems) {
      process.stderr.write(`${p.problem}\n  in: ${p.line}\n`);
    }
    if (report.problems.length > 0) process.exit(1);
    if (report.checked === 0) {
      process.stderr.write(
        `--check found no flawless-react invocation in ${report.skipped} line(s)\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `ok: ${report.checked} invocation(s) parse (${report.skipped} line(s) skipped)\n`,
    );
    process.exit(0);
  }

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }

  // Printed here rather than inside parseArgs, so that parsing a documented
  // line stays a pure function call. It used to process.exit(0) mid-loop, which
  // meant no test — and no lint — could parse `flawless-react --help` in-process.
  if (args.help) {
    process.stdout.write(renderHelp());
    process.exit(0);
  }
  if (args.version) {
    process.stdout.write(`flawless-react ${VERSION}\n`);
    process.exit(0);
  }

  let pattern = args.entry;
  let outDir = args.out;
  let taskIds = args.tasks;

  const wantInteractive = !args.noInteractive && pattern === undefined && process.stdin.isTTY;
  if (wantInteractive) {
    // Deferred with core.ts: tasks/index.ts pulls every task module, and only
    // the interactive menu needs the registry before runCore does.
    const { TASKS } = await import("./tasks/index.ts");
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

  if (pattern === undefined && args.nextjs === undefined && args.expo === undefined) {
    process.stderr.write(
      "missing entry path or glob. Pass a .tsx path, a glob, or run in a TTY for the interactive menu. See --help.\n",
    );
    process.exit(2);
  }

  // First value-touch of the core graph (and with it the TypeScript compiler):
  // every exit path above must stay reachable without paying for it.
  const { runCore } = await import("./core.ts");

  let result: CoreResult;
  try {
    result = await runCore({
      pattern: pattern as string,
      outDir,
      taskIds,
      depth: args.depth,
      variants: args.variants,
      heaps: args.heaps,
      ...(args.changed === undefined ? {} : { changed: args.changed }),
      includeChildren: args.includeChildren,
      force: args.force,
      report: args.report,
      propsOverride: args.propsOverride,
      provider: args.provider ?? args.appResolver,
      apiSpec: args.apiSpec,
      inlineSummary: args.inlineSummary,
      nextjs: args.nextjs,
      expo: args.expo,
      swaggerUrl: args.swaggerUrl,
      colocate: args.colocate,
      roots: args.roots,
      exclude: args.exclude,
      useDefaultExcludes: args.useDefaultExcludes,
      // --json (and --ci, which implies it) asks for a machine-readable run, so
      // the progress and finding lines have to stay off stdout or the blob is
      // preceded by prose and the whole thing fails to parse.
      log: !args.json,
      runTests: args.runTests || (wantInteractive && (await confirmRunTests())),
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }

  if (!args.json) printSummaryTable(result.results);
  if (args.json) {
    // exitCode rides inside the blob: suite failures under --run-tests fold
    // into it, and a --ci consumer parsing stdout alone must see them without
    // shell plumbing around $?.
    //
    // testRun and errors are what make the exit code EXPLICABLE rather than
    // merely correct. Without testRun, exit 0 conflates "the suites passed"
    // with "no suite ran" (B-14); without errors, a failure belonging to no
    // task gives exit 1 with every result ok:true and no reason anywhere
    // (FR-041). Both are omitted from the JSON when empty/absent — `testRun`
    // because absent genuinely means "no run was asked for".
    process.stdout.write(
      `${JSON.stringify(
        {
          exitCode: result.exitCode,
          outDir: result.outDir,
          results: result.results,
          keptScripts: result.keptScripts,
          testRun: result.testRun,
          ...(result.errors.length > 0 ? { errors: result.errors } : {}),
        },
        null,
        2,
      )}\n`,
    );
  }
  if (wantInteractive) {
    // The skills question, asked here rather than never: an interactive run is a
    // person who has just watched the tool work, with a terminal in front of them.
    // It goes BEFORE the outro because clack owns the session, and the gate is the
    // project having no `flawless-*` skill yet — so answering it is what stops it
    // being asked, with no marker file trailing the user. npm's postinstall asks
    // the same question at install time; `FLAWLESS_NO_SKILLS` silences both.
    const { defaultSkillsIO, offerSkills } = await import("./skills/cli.ts");
    await offerSkills(defaultSkillsIO());
    await outro(result.exitCode !== 0 ? "done (with failures)" : "done");
  }
  process.exit(result.exitCode);
}

// Harmless when imported (bin.ts, the compiled binary, tests) and the
// difference between a run and a silent exit-0 no-op when someone invokes
// `bun src/cli.ts …` directly — the trap bin.ts's header documents.
if (import.meta.main) {
  try {
    await main(Bun.argv.slice(2));
  } catch (err) {
    // A rejection escaping main() must land on the documented exit-1 contract,
    // not surface as the runtime's uncaught-error dump.
    process.stderr.write(`${String((err as Error | undefined)?.stack ?? err)}\n`);
    process.exit(1);
  }
}
