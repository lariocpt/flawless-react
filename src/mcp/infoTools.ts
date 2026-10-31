// The read plane's reference tools: what the CLI can do, as data, computed from
// the same tables the CLI renders its help from.
//
// These exist because an agent's alternative is guessing a flag name from a
// conversation and finding out from an exit 2. Each one reads a table that
// already exists — cliFlags.ts's inventory, the task registry, the embedded skill
// names — so there is no second copy here to drift, which is the defect this
// repo's own docs lint was written to catch. All three open no project, spawn
// nothing, and write nothing.

import { checkLines } from "../cli.ts";
import { FLAGS, type FlagDoc, MAINTENANCE_FLAGS } from "../cliFlags.ts";
import { EXPO_IMPLEMENTED } from "../expo/refusal.ts";
import { SKILL_NAMES } from "../skills/spec.ts";
import { ALL_TASK_IDS, TASKS } from "../tasks/index.ts";
import { VERSION } from "../version.ts";
import type { JsonObject, JsonValue } from "./protocol.ts";
import { okJson, reqStr, requireKeys, type ToolDef } from "./support.ts";

// ------------------------------------------------------------ flawless_tasks ----

const flawlessTasks: ToolDef = {
  name: "flawless_tasks",
  description:
    "The task registry: every id `tasks` accepts, what it emits, and whether it runs under Expo " +
    "mode or refuses by design (perf-harness is measured-and-declined there — a browser host " +
    "cannot mount a route screen). Read-only, no project needed. Consult this before choosing " +
    "tasks rather than guessing an id: an unknown one is a usage error, exit 2.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run() {
    return okJson({
      task_ids: [...ALL_TASK_IDS],
      tasks: TASKS.map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        needs_tree: t.needsTree,
        runs_under_expo: EXPO_IMPLEMENTED.includes(t.id),
      })),
      expo_note:
        "A task that is not marked runs_under_expo refuses under --expo with its reason rather " +
        "than emitting DOM artefacts for a React Native project.",
    });
  },
};

// -------------------------------------------------------- flawless_reference ----

/** FlagDoc → JSON. `summary` is a string OR continuation lines in the table, and
 *  a caller should not have to handle both, so it is always an array here. */
function flagJson(flags: readonly FlagDoc[]) {
  return flags.map((f) => ({
    name: f.name,
    ...(f.alias ? { alias: f.alias } : {}),
    ...(f.value ? { value: f.value } : {}),
    summary: Array.isArray(f.summary) ? f.summary : [f.summary],
  }));
}

const flawlessReference: ToolDef = {
  name: "flawless_reference",
  description:
    "The CLI as data: every flag with its value form and summary, the maintenance flags " +
    "(--help, --version, --flags, --check), the task ids, the embedded skill names and the " +
    "version. Rendered from the same inventory --help and --flags print, so it cannot disagree " +
    "with the binary. Read-only, no project needed. Use it to build an invocation instead of " +
    "recalling flag names — the closed sets (--roots, --heaps) are where guessed arguments fail.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async run() {
    return okJson({
      version: VERSION,
      usage:
        "flawless-react [entry] [flags] | flawless-react skills <list|install> | flawless-react mcp",
      flags: flagJson(FLAGS),
      maintenance_flags: flagJson(MAINTENANCE_FLAGS),
      task_ids: [...ALL_TASK_IDS],
      skill_names: [...SKILL_NAMES],
      exits: {
        "0": "success",
        "1": "a task failed, or a suite failed under run_tests",
        "2": "usage error — bad flag, unknown task id, unresolvable props",
      },
      ci_contract:
        "With --ci the run is non-interactive and stdout is exactly one JSON document: " +
        "{exitCode, outDir, results, keptScripts, testRun?, errors?}. A usage error exits 2 with " +
        "its reason on stderr and no JSON.",
    });
  },
};

// ------------------------------------------------------- flawless_check_docs ----

const CHECK_DOCS_ARGS = ["text"] as const;

const flawlessCheckDocs: ToolDef = {
  name: "flawless_check_docs",
  description:
    "Parse documented flawless-react invocations without running them — the same checker this " +
    "repo's docs lint runs against README, the skills and the website. Give it prose or fenced " +
    "shell blocks: every line that invokes flawless-react is parsed for unknown flags, unknown " +
    "task ids and closed-set values, and lines that invoke something else are counted as skipped " +
    "rather than passed. Returns {checked, skipped, problems}. Read-only. A corpus with " +
    "checked=0 checked nothing — that is a gap in the extractor, not a pass.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "Documentation text. Shell-runner prefixes, env assignments, quotes and trailing # comments are stripped.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async run(args) {
    requireKeys(args, CHECK_DOCS_ARGS, ["text"]);
    const report = checkLines(reqStr(args, "text"));
    const out: JsonObject = {
      checked: report.checked,
      skipped: report.skipped,
      problems: report.problems.map((p): JsonValue => ({ line: p.line, problem: p.problem })),
    };
    if (report.checked === 0) {
      out.note = "nothing was checked: no line in the text invoked flawless-react";
    }
    // An example that does not parse is a broken documented command, and the
    // caller needs that to be a failure, not a field they might forget to read.
    return report.problems.length === 0
      ? okJson(out)
      : { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: true };
  },
};

export const INFO_TOOLS: ToolDef[] = [flawlessTasks, flawlessReference, flawlessCheckDocs];
