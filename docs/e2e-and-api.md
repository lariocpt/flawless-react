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
