---
name: flawless-api
description: Use flawless-react programmatically — runFlawless/runCore options and results, exit-code and error contracts, the analyse()/ComponentTree surface for custom reporting, the tasks registry, and the --ci JSON contract. Use when scripting suite generation (CI, sandboxes, agents), building custom reports on the analysis, or embedding the tool in another workflow.
---

# flawless programmatic API

> **`expo` is a `CoreOptions` field beside `nextjs`**, and the two are mutually
> exclusive — `runCore` throws a `UsageError` for the pair, because it is a public API a
> programmatic caller reaches without `parseArgs`. `RunContext` carries
> `expo?: ExpoContext`; ask `platformOf(ctx)` rather than testing `ctx.expo` yourself, so
> widening the rule later happens in one place. An unported task returns a **failed
> `TaskResult`**, not a throw, so a refusal is readable from `results[]` and the `--ci`
> blob.

```ts
import { runFlawless } from "flawless-react";

const { exitCode, outDir, results, trees } = await runFlawless({
  entry: "src/components/Widget.tsx",   // path or glob; optional in Next.js mode
  nextjs: ".",                          // enables Next.js mode, "." = cwd
  tasks: ["unit-browser", "perf-static"],
  colocate: true,
});
```

`runFlawless` is the friendly wrapper (`entry`/`tasks`/`out`); `runCore` from
`core.ts` is the same engine with CLI-shaped names (`pattern`/`taskIds`/
`outDir`) plus `changed` and `heaps`. Everything else — `runTests`, `force`,
`report`, `log`, `quiet` — is on **both**.

Two output flags, and they answer different questions:

- **`log`** — may this run write to **stdout**? Off by default programmatically.
  It gates the progress narration *and* the per-file findings listing. `--json`
  turns it off because stdout must parse whole.
- **`quiet`** — should `runCore`'s own diagnostics on **stderr** be suppressed?
  Off by default, so the warnings **do** speak, even when `log` is off. Pass
  `quiet: true` only if you route them yourself.

One flag for both is how `--ci` became the mode that lost its warnings.
`quiet` is deliberately narrow: it silences `runCore`'s `warn()` lines, not
stderr as a whole — the suite runner's output is routed by a different flag,
and task-level `console.warn`s have no gate. Redirect fd 2 if you need silence.

## Contracts

- **Never calls `process.exit`.** Bad input throws `UsageError` (exported from
  the package and from `types.ts`); everything else is a plain error.
- **CLI exit codes:** 0 clean · 1 a task failed, a `--run-tests`/`--changed`
  suite run failed (suite outcomes fold into the exit code), or a non-task
  failure such as a broken Next.js emit · 2 usage error. The code alone does not
  say which — `results`, `testRun` and `errors` do.
- **`--ci`** = `--no-interactive --json`: stdout is exactly one JSON blob
  `{ exitCode, outDir, results, keptScripts, testRun, errors? }` and nothing
  else. Progress goes away entirely; parse the whole stdout, not a line of it.
  **stderr still carries diagnostics** — skipped files, an unparseable spec,
  script collisions, a failed Next.js emit. Capture it: those lines are the only
  account of work the run quietly dropped.
- **Never read exit 0 as "the suites passed."** Read `testRun`. The invariant:
  `mode: "none"` **if and only if** zero suites executed, so `green` never
  appears on a phase that ran nothing.
  - `{ mode: "generated" | "affected", green }` → suites really RAN; `green` is
    what folded into `exitCode`;
  - `{ mode: "none", reason }` → **nothing ran**, and `reason` says which of the
    three causes it was: no selected task generates a suite `--run-tests`
    executes (only `perf-harness`, `unit-browser` and `e2e` do — `load` emits
    pipes you run with `bun run flawless:load`), nothing was affected, or the
    selected tasks plan no run for the work that was;
  - absent → the run never REACHED the test-run phase. That is NOT "no run was
    asked for": a request blocked by a failed task is also absent, exits 1, and
    is explained by `results`. Read absent as "look elsewhere" (FR-046).
- **`errors`** carries failures belonging to no task, so `results` cannot show
  them — a Next.js emit that threw sets `exitCode: 1` with every task `ok: true`.
  Omitted on a clean run, so branch on its presence.
- `results` is `TaskResult[]`: `{ id, ok, outputs, findings, summary, error?,
  status? }` — `ok: false` with `error` set is a real task failure.
  `status` ("generated" | "refreshed" | "kept", perf-harness only for now)
  says where the run sat in the suite lifecycle: a re-run over an existing
  suite is ok:true + "refreshed", and a `--changed` run keeps the harness
  (ok:true, "kept", outputs empty) rather than regenerating it.
- `reproCommand` semantics: REPORT.md's repro line is rebuilt from options,
  relative paths only, defaults omitted — two identical runs produce the same
  line byte-for-byte, so run from the project root with relative inputs if you
  care about a stable REPORT.md.

## Running from a checkout

`bun src/bin.ts <args>` and `bun src/cli.ts <args>` both work (cli.ts has an
`import.meta.main` guard), as does the compiled `bin/flawless-react`. In
sandboxed or scripted contexts still prefer the programmatic API with evidence
written to files — stdout may be captured, truncated, or lost, and the
flawless-regen skill's run-proof discipline applies.

Cwd matters in Next.js mode: `nextjs: "."` resolves against the process cwd,
and the run merges `flawless:*` scripts into THAT root's `package.json`.
`process.chdir(appRoot)` first, or pass absolute paths deliberately.
The merge never clobbers a user-customised `flawless:*` value: only the
tool's own recognised spellings upgrade; kept keys surface in
`CoreResult.keptScripts`, the `--ci` blob, and REPORT.md.

## The analysis surface

```ts
import { analyse } from "flawless-react";

const tree = await analyse({ entry: "src/Nav.tsx", depth: 3, includeChildren: true });
// tree: ComponentTree — entry: ComponentInfo (propsShape, variants, hooks,
// interactions, dataDeps, unresolvedProps/unresolvedTypes), children: ComponentTree[]
// A dataDep whose usage inference came up empty may carry inferredReturn
// (a fixture value from its Promise<T> annotation, provenance "annotation")
// or wrapsFetch (method+path for the emit-time OpenAPI join); a server-action
// moduleImport may carry serverActionReturns (module-side name -> literal).
```

`analyse()` is pure static analysis — no files written — and is the right base
for custom reporting. The honesty contract worth preserving in anything you
build on it: an extraction that fails is RECORDED (`unresolvedProps`,
`unresolvedTypes`, `uncertain` on data deps), never silently empty; treat an
empty shape with empty unresolved records as a bug to report, not a component
with no props.

Tasks are a registry: `findTask(id).run(ctx)` with
`ctx: { trees, outDir, force, … }` returning a `TaskResult`. A custom task is
a new entry in `src/tasks/index.ts` honouring one rule — write findings and
outputs, throw only for genuine failure, and make `ok` mean what it says.

## The MCP server — the same contracts for a host

`flawless-react mcp` serves this tool over the Model Context Protocol on stdio:
eight tools, and **no new API surface to learn**. `flawless_run` answers with the
child's exit line plus the same `--ci` blob documented above, so every contract in
this file — `testRun` as the only proof suites ran, `errors` belonging to no task,
`absent` meaning "look elsewhere" (FR-046) — is how to read what an agent gets
back. It spawns a `flawless-react` child per run call (a suite runner inherits
stdout; in-process would write vitest's report into a JSON-RPC frame), so nothing
is held between calls. The six `flawless_*` read tools parse in-process and write
nothing; unknown arguments are rejected, not ignored; `flawless_findings` is the
static engine only, so zero findings is not "accessible and lint-clean". List the
tools from the binary rather than from memory:

```bash
flawless-react mcp
flawless-react mcp --help
```

The two planes, the arguments and the honest limits: `docs/mcp.md`.

## Never

- Never scrape the human console output — use `--ci` or the API's `results`.
- Never run Next.js mode from an arbitrary cwd without pinning it: the
  package.json merge follows the resolved root, wherever that is.
- Never treat `exitCode: 1` as "the tool crashed". Two distinct causes: a
  task failed (`results[].error` names it) or a `--run-tests`/`--changed`
  suite run went red — in the suite case every `results[]` entry is `ok:true`
  and the outcome lives in `exitCode` and `CoreResult.testRun` ({mode:
  "affected"|"generated", green}), not in any error field. A re-run over an
  existing suite is not a failure: it refreshes the harness and exits 0.
