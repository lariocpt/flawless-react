# Route e2e, load pipes, and the programmatic API

Three surfaces that arrived together with the analyser rework: browser-level
route tests, crust load pipelines, and running the whole tool from code instead
of a shell.

## Route e2e (`--tasks e2e`)

In `--nextjs` mode, every analysed entry that is an app-router `page.tsx`
becomes one spec under `flawless/e2e/`:

```text
flawless/e2e/
├── playwright.config.ts   # boots the target's `bun run dev`, port read from that script
├── global-setup.ts        # auth hook — written once, never overwritten
├── README.md
└── <route-stem>.spec.ts   # e.g. dashboard-buildings-id.spec.ts
```

Each spec navigates the route, asserts the response is not 5xx, waits for
`networkidle`, and requires an empty `pageerror` + console-error list. When the
component tree contains click interactions, up to three of them are replayed in
a second test — each guarded by a visibility check, so a spec never fails
merely because an element is behind state it did not open.

Dynamic segments read env vars, defaulting to an obvious placeholder:

```bash
FLAWLESS_E2E_ID=<seeded-id> bun run flawless:e2e
# or per-segment: FLAWLESS_E2E_BUILDINGID=…
```

### Why it runs against the real app

MSW can only intercept `fetch`. A React server component that calls the
database directly — the common shape in app-router code — never issues one, so
an MSW-backed e2e would render against the real data anyway while *claiming* to
be mocked. Two honest options remain: run against the real dev server with
seeded data, or edit the target app's instrumentation hook to load `msw/node`
on the server (invasive, and still incomplete for direct DB access).

v1 picks the first. Seed the database with whatever the repo already provides,
then run. Nothing is stubbed and nothing pretends to be.

### Authentication

`global-setup.ts` ships a stub that writes an empty storage state (so the
config's `storageState` reference always resolves) plus a worked example:
request the login endpoint with a Playwright request context and persist
`storageState` to `.auth.json`. Fill it in once; the file is yours and is
gitignored.

### Contract-checked runs

The config honours `FLAWLESS_E2E_BASEURL`, and skips its own `webServer` when
that is set — which lets you put a [crust](https://github.com/lariocpt/crust)
validation proxy between the browser and the app and assert that nothing the UI
triggered violated the OpenAPI spec:

```bash
crust -c 'mock-server --swagger openapi.json --port 4747 --proxy http://localhost:3001' &
FLAWLESS_E2E_BASEURL=http://localhost:4747 bun run flawless:e2e
crust -c 'GET :4747/__crust/violations | (v => v.violations.filter(x => x.direction === "response")) | assert (a => a.length === 0)'
```

## Load pipes (`--tasks load`)

Emit-only: `flawless/load/routes.pipes` plus a README, and a `flawless:load`
script. Targets are the analysed page routes and the **GET** endpoints the
components actually fetch (mutations are excluded deliberately — a default
load run should not write junk into whatever environment it is pointed at).

Each line follows crust's CI-gate shape — one assert per threshold, with the
baseline read back asynchronously:

```text
load 10s 50/s | parallel 16 | GET $LOAD_BASE/dashboard/buildings/$LOAD_ID -H "$LOAD_AUTH" --timeout 2s | expect 200 \
  | stats --out flawless/load/last-dashboard-buildings-id.json \
  | assert (async s => { const b = Bun.file("flawless/load/baseline-dashboard-buildings-id.json"); return !(await b.exists()) || s.p95 < 2 * (await b.json()).summary.p95 })
```

Env contract: `LOAD_BASE`, `LOAD_AUTH`, and one `LOAD_<PARAM>` per dynamic
segment. To arm the gate, copy a good `last-*.json` to `baseline-*.json` and
commit it; `last-*.json` is gitignored.

Two things decide whether a load run means anything:

- **`LOAD_BASE` must be a production build** — `bun run build && bun run start`,
  not `next dev`. The dev server compiles routes on demand, so the first request
  to each measures the compiler and the rest measure a warm cache.
- **`LOAD_AUTH` is a header line, and this app's is a cookie**:
  `cookie: session=<value>`, not `authorization: Bearer …`. Prove it
  authenticates before trusting the numbers — an unauthenticated request to a
  dashboard route redirects to the login page, which answers 200, so every pipe
  passes while measuring the login screen.

`source flawless/load/env.sh` exports one `LOAD_<PARAM>` per id in
`flawless/e2e/params.json`, so the load pipes and the e2e specs cannot drift
apart over which records they target.

### A pipe with no id for its segments is commented out

A pipe whose parameters are blank does not measure its route — it measures the
app's 404 handler. `GET /invite/` with an empty token answered 500 on every one
of 500 requests, and the run reported the route as failing when the truth was
that nothing seeds an invitation.

So a pipe whose ids are unfilled is emitted commented out, above a line naming
exactly which key to fill:

```text
# TODO(flawless): no value for LOAD_TOKEN. Fill "token" in flawless/e2e/params.json
# load 10s 50/s | parallel 16 | GET $LOAD_BASE/invite/$LOAD_TOKEN -H "$LOAD_AUTH" ...
```

The route stays visible, so the file itself says what is not being measured. Fill
the id and regenerate with `--force` and the pipe turns back on. The key is named
in the casing your source used — `"token"`, not `TOKEN` — because that is how
`params.json` is keyed, and `$LOAD_BUILDINGID` cannot be turned back into
`buildingId`.

The task's summary counts what the file actually measures, not how many routes
were found: `load pipes for 33 target(s) — 31 live, 2 commented out pending ids
(buildingId, conversationId, token)`. That string is what lands in REPORT.md.

### `--force` merges routes.pipes

`--force` folds this run's routes into the existing file rather than replacing
it. Only a pipe's comment state is ever changed; its body is not rewritten, so a
rate you tuned survives being gated and un-gated. Pipes are matched by the
`<name>` in their `stats --out .../last-<name>.json`, not by line number.

| On disk | Ids now filled | What happens |
| --- | --- | --- |
| absent | either | appended |
| commented by the tool | yes | un-gated, keeping any edit to the body |
| commented by the tool | no | left, with the TODO restated for the ids still missing |
| live | yes | left alone |
| live | no | gated, keeping the body |
| commented by you | either | left alone — that was a decision |

Nothing is pruned. A stale generated pipe and a POST flow you added by hand look
the same to a line-oriented parser, and losing the second to tidy up the first is
not a trade worth making.

The task succeeds even when crust is not installed — it says so in the summary
rather than failing a generation run over a missing optional tool.

## Programmatic API

```ts
import { runFlawless, analyse, analyseTree } from "flawless-react";

const { results, trees, outDir, exitCode } = await runFlawless({
  entry: "src/components/Widget.tsx",
  nextjs: ".",
  tasks: ["unit-browser", "perf-static"],
  apiSpec: "openapi.json",
  colocate: true,
});

for (const r of results) console.log(r.id, r.ok, r.summary);
```

- Never calls `process.exit`; bad input throws `UsageError`.
- `log` defaults to `false` here (the CLI passes `true`), so nothing is printed
  unless you ask for it.
- Also exported: `analyse` (entry → `ComponentTree`), `analyseTree` (the
  perf-static rules as a pure function over a tree), `scaffoldUnitBrowser`,
  `scaffold`, `detectNextjs`, `runCore`, and the shared types.

Building your own reporting is meant to be a tree walk, not a CLI-output parse:

```ts
const tree = await analyse({ entry, depth: 3, includeChildren: true });
const { findings } = analyseTree(tree);
const stale = findings.filter((f) => f.rule === "perf/hook-missing-dependency");
```

`--ci` on the CLI is shorthand for `--no-interactive --json`.

## Running the suites

`runner/runTests.ts` handles both layouts: a standalone suite (its own
`package.json` under `outDir`, `test:*` scripts) and Next.js mode (scripts on
the project's own `package.json`, run from the project root). Before any
Playwright suite it attempts `bunx playwright install chromium` — no
`--with-deps`, since that prompts for sudo and would hang an unattended run —
bounded by a five-minute kill timer, and skippable with
`FLAWLESS_SKIP_BROWSER_INSTALL=1`.
