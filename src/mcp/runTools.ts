// The RUN plane of the MCP surface: the tools that change a project, and so run
// as a flawless-react child process (see run.ts for why that boundary exists).
//
// Both tools here map argument → argv rather than reaching into core.ts, and
// that is deliberate: the CLI is the contract agents are told about, the exit
// codes and the `--ci` blob are already its documented shape, and a second
// in-process path would be a second implementation to keep in agreement — the
// defect class this repo keeps finding in its own docs.

import { parseSkillsCommand } from "../skills/spec.ts";
import { ALL_TASK_IDS } from "../tasks/index.ts";
import type { HeapMode, RootMode } from "../types.ts";
import type { JsonObject } from "./protocol.ts";
import { callOpts, DEFAULT_TIMEOUT_MS, renderCiRun, renderRun, runFlawlessChild } from "./run.ts";
import {
  optBool,
  optEnum,
  optEnumArray,
  optJsonText,
  optStr,
  optStrArray,
  optStrOrTrue,
  requireKeys,
  type ToolDef,
  ToolError,
} from "./support.ts";

/** `--heaps` closed set, from HeapMode — the flag's own doc line is stale about
 *  this and parseArgs is the authority. */
const HEAP_MODES: readonly HeapMode[] = ["off", "stress", "all"];
const ROOT_MODES: readonly RootMode[] = ["primary", "exported"];

// ------------------------------------------------------------ flawless_run ----

const RUN_ARGS = [
  "entry",
  "tasks",
  "nextjs",
  "expo",
  "out",
  "colocate",
  "force",
  "report",
  "run_tests",
  "changed",
  "roots",
  "exclude",
  "no_default_excludes",
  "depth",
  "variants",
  "include_children",
  "heaps",
  "props",
  "provider",
  "app_resolver",
  "api",
  "swagger_url",
  "inline_summary",
  "cwd",
  "env",
  "timeout_ms",
] as const;

/**
 * Tool arguments → CLI argv, in the order the CLI reads them.
 *
 * `--ci` is always first: it is the non-interactive contract (no prompts, JSON on
 * stdout) and without it a run would wait forever on a stdin the protocol owns.
 * Boolean options are only emitted when they change the default, so the argv a
 * user reproduces by hand matches what the tool ran.
 */
function runArgv(a: JsonObject): string[] {
  const entry = optStr(a, "entry");
  const tasks = optEnumArray(a, "tasks", ALL_TASK_IDS);
  const nextjs = optStrOrTrue(a, "nextjs");
  const expo = optStrOrTrue(a, "expo");
  if (nextjs !== undefined && expo !== undefined) {
    // The CLI refuses this too; refusing here gives the agent the explanation
    // before a child pays for the module graph to say it.
    throw new ToolError(
      "nextjs and expo are mutually exclusive — one project, one framework mode per run",
    );
  }
  const argv = ["--ci"];
  if (entry) argv.push(entry);
  if (tasks?.length) argv.push("--tasks", tasks.join(","));
  if (nextjs === true) argv.push("--nextjs");
  else if (typeof nextjs === "string") argv.push("--nextjs", nextjs);
  if (expo === true) argv.push("--expo");
  else if (typeof expo === "string") argv.push("--expo", expo);
  const out = optStr(a, "out");
  if (out) argv.push("--out", out);
  if (optBool(a, "colocate")) argv.push("--colocate");
  if (optBool(a, "force")) argv.push("--force");
  if (optBool(a, "report")) argv.push("--report");
  if (optBool(a, "run_tests")) argv.push("--run-tests");
  const changed = optStrOrTrue(a, "changed");
  if (changed === true) argv.push("--changed");
  else if (typeof changed === "string") argv.push("--changed", changed);
  const roots = optEnum(a, "roots", ROOT_MODES);
  if (roots) argv.push("--roots", roots);
  for (const g of optStrArray(a, "exclude") ?? []) argv.push("--exclude", g);
  if (optBool(a, "no_default_excludes")) argv.push("--no-default-excludes");
  const depth = a.depth;
  if (typeof depth === "number") argv.push("--depth", String(depth));
  const variants = a.variants;
  if (typeof variants === "number") argv.push("--variants", String(variants));
  const includeChildren = optBool(a, "include_children");
  if (includeChildren === false) argv.push("--include-children=false");
  const heaps = optEnum(a, "heaps", HEAP_MODES);
  if (heaps) argv.push("--heaps", heaps);
  const props = optJsonText(a, "props");
  if (props) argv.push("--props", props);
  const provider = optStr(a, "provider");
  if (provider) argv.push("--provider", provider);
  const appResolver = optStr(a, "app_resolver");
  if (appResolver) argv.push("--app-resolver", appResolver);
  const api = optStr(a, "api");
  if (api) argv.push("--api", api);
  const swaggerUrl = optStr(a, "swagger_url");
  if (swaggerUrl) argv.push("--swagger-url", swaggerUrl);
  if (optBool(a, "inline_summary") === false) argv.push("--no-inline-summary");
  return argv;
}

const flawlessRun: ToolDef = {
  name: "flawless_run",
  description:
    "Generate or refresh a flawless-react suite. THIS WRITES FILES: the suite directory " +
    "(.flawless, or flawless/ in framework mode), regenerated specs and harness, REPORT.md, and " +
    "in Next.js/Expo mode the target project's package.json scripts and its config files. Every " +
    "CLI option is available; omit `tasks` to run perf-harness alone, the documented " +
    "non-interactive default. Runs a flawless-react child with --ci and returns its JSON blob " +
    "(exitCode, outDir, results, keptScripts, testRun, errors) plus stderr diagnostics — a " +
    "nonzero exit is an error result, never a green run. `run_tests` executes the generated " +
    "suites, which is minutes and needs their prerequisites: a dev server for e2e " +
    "(FLAWLESS_E2E_BASEURL, FLAWLESS_E2E_ID) and a seeded database for load pipes (LOAD_BASE, " +
    "LOAD_AUTH). Call flawless_project_status first: an existing suite is regenerated wholesale, " +
    "and hand-written assertions in it are lost unless they live in generated files.",
  inputSchema: {
    type: "object",
    properties: {
      entry: {
        type: "string",
        description:
          "Component file or glob. Omit in Next.js/Expo mode to sweep what the framework detection " +
          "finds. Relative paths resolve against `cwd`.",
      },
      tasks: {
        type: "array",
        items: { type: "string", enum: [...ALL_TASK_IDS] },
        description: "Which tasks to run. Default: perf-harness only.",
      },
      nextjs: {
        type: ["string", "boolean"],
        description: "Next.js mode: project root, or true for the current directory.",
      },
      expo: {
        type: ["string", "boolean"],
        description:
          "Expo / React Native mode: project root, or true for the current directory. Mutually " +
          "exclusive with nextjs.",
      },
      out: {
        type: "string",
        description:
          "Suite output directory, relative to cwd. Default .flawless, flawless/ in framework mode.",
      },
      colocate: {
        type: "boolean",
        description: "Write unit specs beside each source file instead of into the suite.",
      },
      force: {
        type: "boolean",
        description:
          "Overwrite a suite that exists. Without it an existing suite is left as-is (status kept).",
      },
      report: { type: "boolean", description: "Write REPORT.md." },
      run_tests: {
        type: "boolean",
        description:
          "Actually execute the generated suites and fold their exit code into the result. Slow, and " +
          "each suite fails with its own named prerequisite when its environment is missing.",
      },
      changed: {
        type: ["string", "boolean"],
        description:
          "Scoped mode: only components affected since a git ref (true = HEAD). A repo with no commits " +
          "refuses rather than treating everything as deleted.",
      },
      roots: {
        type: "string",
        enum: [...ROOT_MODES],
        description: "exported emits a tree per exported component — what a whole-app sweep needs.",
      },
      exclude: {
        type: "array",
        items: { type: "string" },
        description: "Extra glob patterns to skip, added to the defaults.",
      },
      no_default_excludes: {
        type: "boolean",
        description: "Drop the built-in excludes (fixtures, shadcn/ui kit, copy, stories).",
      },
      depth: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Component-tree depth to follow.",
      },
      variants: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Prop variants per component.",
      },
      include_children: {
        type: "boolean",
        description:
          "Follow JSX children through to leaf content. Default true; false is a speed control.",
      },
      heaps: {
        type: "string",
        enum: [...HEAP_MODES],
        description: "How much of the V8 heap the profiling suite keeps. Default stress.",
      },
      props: {
        type: "object",
        description:
          'Props override when the analyser cannot resolve a type, e.g. {"data": [{"id": "1"}]}.',
      },
      provider: {
        type: "string",
        description: "Provider wrapper file evaluated by the browser host.",
      },
      app_resolver: {
        type: "string",
        description: "Module resolver for the real-app browser host.",
      },
      api: {
        type: "string",
        description: "OpenAPI spec for the MSW layer, or off to disable route discovery.",
      },
      swagger_url: {
        type: "string",
        description: "Fetch the API spec from a URL, or off to disable it.",
      },
      inline_summary: {
        type: "boolean",
        description:
          "Drop <Component>.flawless.json beside each source file. Default true, so false to opt out.",
      },
      cwd: { type: "string", description: "Working directory for the run. Default: the server's." },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Extra environment variables, e.g. FLAWLESS_E2E_BASEURL for a run with run_tests.",
      },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        maximum: 14400000,
        description: `Watchdog; the process group is killed at the deadline. Default ${DEFAULT_TIMEOUT_MS}.`,
      },
    },
    required: [],
    additionalProperties: false,
  },
  async run(args) {
    requireKeys(args, RUN_ARGS);
    const opts = callOpts(args);
    const run = await runFlawlessChild(runArgv(args), opts);
    return renderCiRun(run, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  },
};

// ---------------------------------------------------------- flawless_skills ----

const SKILLS_ARGS = [
  "action",
  "all",
  "select",
  "global",
  "force",
  "copy",
  "cwd",
  "timeout_ms",
] as const;

const flawlessSkills: ToolDef = {
  name: "flawless_skills",
  description:
    "The fourteen agent skills flawless-react embeds, in the .agents/skills and .claude/skills " +
    "layout Codex, Cursor, OpenCode and Claude Code read. action=status reads both scopes and " +
    "writes nothing; action=install runs the CLI's install and WRITES those files (links by " +
    "default, copies with `copy` for Claude Code). Without `all` or `select`, install installs " +
    "every skill — the piped/CI behaviour, since this call has no terminal to answer a menu. " +
    "A skill whose file a user edited is reported as edited and is only overwritten with `force`.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "install"],
        description: "status reads; install writes.",
      },
      all: { type: "boolean", description: "install: every skill, no menu." },
      select: {
        type: "array",
        items: { type: "string" },
        description: "install: only these skill names.",
      },
      global: {
        type: "boolean",
        description: "install: target ~/.agents/skills instead of ./.agents/skills.",
      },
      force: {
        type: "boolean",
        description: "install: overwrite a SKILL.md the user edited locally.",
      },
      copy: {
        type: "boolean",
        description: "install: copy into .claude/skills instead of linking it.",
      },
      cwd: { type: "string", description: "Project directory for a project-scoped install." },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 300000 },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async run(args) {
    requireKeys(args, SKILLS_ARGS, ["action"]);
    const action = args.action;
    if (action !== "status" && action !== "install") {
      throw new ToolError('invalid argument "action": expected status or install');
    }
    const opts = callOpts(args);
    const argv = ["skills", action === "install" ? "install" : "list"];
    // Validated through the CLI's own parser, so an argument the verb does not
    // take is refused with the CLI's message instead of being silently dropped.
    parseSkillsCommand(argv.slice(1).concat(buildSkillFlags(args)));
    argv.push(...buildSkillFlags(args));
    const run = await runFlawlessChild(argv, opts);
    return renderRun(run, opts.timeoutMs ?? 30_000);
  },
};

/** install-only switches, in CLI spelling. `status` ignores them, and the parser
 *  above is what refuses them on a status call. */
function buildSkillFlags(a: JsonObject): string[] {
  const out: string[] = [];
  const select = optStrArray(a, "select");
  if (optBool(a, "all")) out.push("--all");
  if (select?.length) out.push("--select", select.join(","));
  if (optBool(a, "global")) out.push("--global");
  if (optBool(a, "force")) out.push("--force");
  if (optBool(a, "copy")) out.push("--copy");
  return out;
}

export const RUN_TOOLS: ToolDef[] = [flawlessRun, flawlessSkills];
