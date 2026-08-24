---
name: flawless-api
description: Use flawless-react programmatically — runFlawless/runCore options and results, exit-code and error contracts, the analyse()/ComponentTree surface for custom reporting, the tasks registry, and the --ci JSON contract. Use when scripting suite generation (CI, sandboxes, agents), building custom reports on the analysis, or embedding the tool in another workflow.
---

# flawless programmatic API

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
`outDir`) plus `changed`, `runTests`, `force`, `report`, and `log` (progress
lines, default false programmatically).

## Contracts

- **Never calls `process.exit`.** Bad input throws `UsageError` (exported from
  the package and from `types.ts`); everything else is a plain error.
- **CLI exit codes:** 0 clean · 1 a task failed OR a `--run-tests`/`--changed`
  suite run failed (suite outcomes fold into the exit code) · 2 usage error.
- **`--ci`** = `--no-interactive --json`: stdout is exactly one JSON blob
  `{ exitCode, outDir, results, keptScripts }` and nothing else. Progress goes away entirely; parse
  the whole stdout, not a line of it.
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
