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
`networkidle`, **asserts it is still on the route it asked for**, and requires
an empty `pageerror` + console-error list. When the
component tree contains click interactions, up to three of them are replayed in
a second test — each guarded by a visibility check, so a spec never fails
merely because an element is behind state it did not open.

Dynamic segments read env vars. When nothing resolves, the spec skips with the reason rather than navigating — the old placeholder produced a URL that 404s and reported a missing fixture as an application bug:

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

### Authentication, and why the suite is not green before it is real

`global-setup.ts` ships a stub that writes an empty storage state (so the
config's `storageState` reference always resolves) plus a worked example:
request the login endpoint with a Playwright request context and persist
`storageState` to `.auth.json`. Fill it in once; the file is yours and is
gitignored.

Until you do, the suite is running **unauthenticated** — and that used to pass.
A protected route 302s to `/login`, `page.goto` follows the redirect, and the
login page answers **200** with a clean console. "Not 5xx" and "no console
errors" are both true of somebody else's form, so thirty route specs could go
green having tested one login screen.

Two things close it, and neither is a flag you can forget:

- **Every spec asserts the landing** — the render test and the interaction test
  both, since a login page swallows every visibility-guarded click and then
  reports a clean error list. After `networkidle` it compares the final pathname
  against the route it navigated to, trailing slashes normalised.

  **Scope, stated precisely, because an overclaim here is the same bug wearing a
  different hat.** It catches redirects that *change the URL* and have landed by
  the time the spec looks: a server 3xx, and a client-side navigation that
  completes before `networkidle` settles. It does **not** catch a middleware
  *rewrite* that serves the login page at the requested path, a 401 body, or a
  redirect that fires later than the spec waited. (A 401 usually still reds the
  spec — through the console-error check, not this one.)

  A route that redirects **on purpose** — a default sub-tab, a locale landing —
  would otherwise fail forever. Record the real destination in `params.json`
  under `landing`, keyed by route template:

  ```json
  { "landing": { "/dash": "/dash/overview" } }
  ```

  There, and not in the spec: `--force` regenerates specs and leaves
  `params.json` alone, so an expectation recorded in the spec is advice the next
  regeneration deletes.
- **REPORT.md says the hook is still a stub.** The e2e task reports it as
  hand-work when the on-disk `global-setup.ts` is byte-identical to what it
  emits — identity, not a grep for the TODO marker, so filling the file in while
  leaving the comment stops the report rather than nagging forever.

This is verified by executing the emitted spec in a real chromium against a
server that redirects — red before the hook is filled, green after
(`tests/e2eExecution.test.ts`, gated on `FLAWLESS_CI_BROWSER=1`). Reading the
spec is exactly what let the old behaviour survive: every assertion in it looked
reasonable.

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

`flawless/load/routes.setup.ts` does both jobs before a single pipe runs:
crust imports the sibling `<name>.setup.ts` of a pipes file and awaits its
default export first. It seeds one `LOAD_<PARAM>` per id in
`flawless/e2e/params.json`, so the load pipes and the e2e specs cannot drift
apart over which records they target, and it probes every static route to prove
`LOAD_AUTH` still authenticates — the check described above, enforced rather
than left to you. A route that redirects by design goes under `landing` in
`params.json`, the same map the e2e specs read.

The module is **write-once**: a hand-written check that knows your app (an
authenticated endpoint answering 401 is a sharper signal than a redirect) is
better than the generated one, and no regeneration will overwrite it. It is
written when absent, so a suite that predates it does get the guard.
`flawless/load/env.sh` is still emitted for shells that want the exports, but
nothing needs to source it any more. `--tasks load` on its own creates that
file, with a blank slot per id its pipes reference: the gate comments, this
README and `env.sh` all tell you to fill it in, and until they did it was a file
no run without the e2e task had written.

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
rather than failing a generation run over a missing optional tool. When you do want
it, both of its channels are public:

```bash
curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash
```

That writes a `crust` binary into `~/.local/bin`. `npm i -g @lariocpt/crust` is the same
tool through npm — the package's `postinstall` fetches the GitHub release binary, so it
works wherever GitHub does.

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
- `exitCode` says *whether* the run was clean, never *why*. `results` names a
  failed task, `testRun` says what the test-run phase did, and `errors` carries
  failures belonging to no task at all. Treating exit 0 as "the suites passed"
  is the mistake `testRun` exists to prevent.
- **`testRun`'s invariant**: `{ mode: "none", reason }` if and only if **zero
  suites executed** — so `{ mode: "generated" | "affected", green }` is a
  promise that suites really ran, and `green` never appears on a phase that ran
  nothing. Three things produce `"none"`: no selected task generates a suite
  `runTests` executes, nothing was affected, or the selected tasks plan no run
  for the work that was. An **absent** `testRun` means the run never reached the
  phase at all — which includes a request blocked by a failed task, so absent is
  "look at `results`", not "no run was asked for".
- `log` defaults to `false` here (the CLI passes `true`), so nothing is written
  to **stdout** unless you ask for it — neither the progress narration nor the
  per-file findings listing.
- **Diagnostics are separate.** Warnings — a file the sweep skipped, an
  unparseable OpenAPI spec, a provider that looks like a server component, a
  failed Next.js emit — go to **stderr** and are not gated by `log`. Pass
  `quiet: true` to suppress them, and only do that if you route them somewhere
  yourself: an embedder that silently swallows "could not parse your spec"
  reproduces the bug `--ci` had.
- `quiet` is narrow by design. It silences `runCore`'s own `warn()` lines, not
  stderr as a whole: the suite runner's output under `--run-tests`/`--changed`
  (`› bun run flawless:unit`, `failed suites: …`, and the child suites' own
  streams) is routed by `log`, and task-level `console.warn`s have no gate at
  all. Redirect fd 2 if you need a genuinely silent process.
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
