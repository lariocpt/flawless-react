---
name: flawless-perf-harness
description: Run and interpret flawless-react's runtime performance plane — the `host/` bundle, `profile/` Playwright suite, mount/update times from React's Profiler, budgets.json (warn-only, and NOT baselines), `--heaps` V8 snapshots, FLAWLESS_WORKERS, the shared 127.0.0.1:5173 host with the browser specs, and what a number is worth. Use before running `flawless:perf`, when a profile spec is red or a budget warns, when snapshots are missing, or before quoting a mount time. For the static `perf/*` findings that need no browser see flawless-perf-static; for load-test p95s and their baselines see flawless-load.
---

# flawless perf harness

`perf-harness` builds a real Chromium surface for components: a Bun-served host
bundle, one Playwright spec per host-mountable component, and a budget file. It is
also the host the **browser specs** run on, so most "the perf plane is broken"
reports are really "the host is broken", and both planes share the symptom.

## What it writes

```bash
bunx flawless-react "src/app/**/page.tsx" --nextjs . --tasks unit-browser,perf-harness
```

The `perf-harness` task is what builds this plane, and `unit-browser` alongside it
is what makes the **browser specs** appear — they run on the same host, so without
this task there is no browser plane either.

| file | regenerated? |
| --- | --- |
| `host/index.html`, `host/server.ts`, `host/_polyfill.ts` | yes |
| `host/registry.ts` — the component tables the host mounts from | yes, every run |
| `host/main.tsx` — boot: providers, MSW worker, the `ALL` spread | **write-once** |
| `profile/_helpers.ts`, `profile/_heap.ts` | yes |
| `profile/<Component>.profile.spec.ts` | yes while the component stays host-mountable; stamped, so your edits mark it as yours |
| `budgets.json` | **write-once** |
| `playwright.config.ts` (the perf plane) | yes |

Two consequences people trip on:

- A component hand-added to `host/registry.ts` is **lost on the next run**. Register
  it in the `ALL` spread in `host/main.tsx`, which nothing rewrites.
- `budgets.json` keeps whatever you wrote. That protects your tightened numbers — and
  means a **deleted key silently reverts to the default** at the next measurement,
  because the file is never rewritten to remind you.

## What is measured

- **Mount time** and **update times** per component, via React's built-in
  `<Profiler>`.
- **Unnecessary rerenders** flagged by `react-scan`.
- A wall-clock distribution (min / avg / p50 / p95 / max) over a forced-rerender
  loop.

Scenarios per component: `mounts at defaults`, `variant matrix` (when the analyser
found variants), `stress-click-rerender x 50` (when a handler prop exists — skipped
with a stated reason when it does not), and `forced rerender x N`.

**Only two things fail a profile spec**: the mount witness (`renderCount ≥ 1`) and
the forced-rerender smoke check (at least one update timed). **Every budget is a
`console.warn`.** A green perf run therefore means "it mounts and it re-renders",
not "it is fast" — read the `[budget]` lines, not the exit code.

## Budgets, not baselines

`budgets.json` is per component: `{ "HomePage": { "mountMs": 50, "updateMs": 16 } }`.
Defaults are 50 ms mount, 16 ms update (one frame). Breaching one warns:

```
[budget] HomePage mount 61.42ms > 50ms
```

To make a budget a gate, change that `console.warn` into an
`expect(...).toBeLessThan(...)` in the spec — the suite README says so, and it is
your call because a threshold you did not measure is theatre. The intended loop is:
run once, tighten each number to what you actually observed, keep the diff in the
commit.

**There is no baseline file in this plane.** `last-<name>.json` /
`baseline-<name>.json` are load pipes (flawless-load). Comparing a mount time here
means comparing two runs' output by hand, which is why the recorded numbers should
come from a one-worker run (below).

## Running it

```bash
bun run flawless:perf                          # from the app root
node node_modules/@playwright/test/cli.js test --config playwright.config.ts   # from the suite dir
```

The config has **exactly one project**, `chromium`, with `testDir: "./profile"`; run
the plane from the suite dir so the suite's own copy of Playwright resolves — from
the app root, a second copy is how you get `No tests found` or `test.describe()
called here`.

It serves its own host: `webServer.command` is `bun host/server.ts` on
`http://127.0.0.1:5173`, with `reuseExistingServer: !process.env.CI`. The **browser
specs use the same host on the same port** (`browser/playwright.config.ts` runs
`bun ../host/server.ts`), so two planes at once is one server serving two runners
and noisy numbers at best. To clear a stuck host: `lsof -ti :5173 | xargs -r kill`.

Measurement hygiene: `FLAWLESS_WORKERS=1` forces a single worker; CI defaults to 1,
otherwise Playwright decides. Budgets only warn, so parallel measurement can't fail
a run — but it does make the numbers worse. Record a number with one worker.

Output lands in `test-results/` (already gitignored, and Playwright clears it at the
start of each run): `test-results/results.json` is the machine-readable one —
`scripts/report.mjs`, emitted with `--report`, aggregates it — while
`playwright-report/` is the HTML one. Traces are retained on failure only.

## `--heaps`: V8 snapshots as diagnostics

`--heaps off | stress | all` (default `stress`) is read at scaffold time and baked
into `profile/_heap.ts`:

- `off` — no CDP capture at all. A snapshot of a real app is tens of MB and one is
  taken **either side of every scenario**: an observer that costs more than the thing
  it observes, inside the measurement it brackets.
- `stress` (default) — keep snapshots for `stress-*` scenarios and for failures.
- `all` — keep every post-scenario snapshot.

Files land at `heaps/<spec>__<test>__<label>.heapsnapshot` with predictable names, so
you can take them from the filesystem instead of digging through
`playwright-report/data/<sha1>`, and they are attached to the HTML report too. Format
is the standard V8 `.heapsnapshot`: Chrome DevTools → Memory.

Snapshots are **diagnostics, not the measurement**: an open CDP session can fail for
reasons unrelated to the component (a page that already navigated, a Playwright and
Chromium that disagree about a target guid), so `_heap.ts` warns and returns nothing
rather than failing the spec it was added to observe. If snapshots are missing but
the run is green, look for the warning.

## Debugging the host

- **`ReferenceError: <name> is not defined` with no output from the host build** — a
  resolve-plugin fall-through in the host server dropped a bare specifier's module
  onto a variant that lacks that export (`msw`'s named imports were the casualty).
  Run `bun host/server.ts` from the suite dir to see the build; check the plugin's
  `args.path` gates, not the spec.
- **A component is not in the host at all** — REPORT.md's components table says why
  it is not mountable. Server components cannot mount in this host, and a compound
  part may only be reachable through its parent. Do not write a spec for what the
  host refuses to mount; fix the mountability.
- **A spec times out in `waitForFunction` waiting for `window.__profile.mount`** — the
  host never booted (see the resolve trap) or `host/main.tsx` was edited into a state
  where its boot script throws. Its edits are yours forever, so `git diff` it first.
- **`[flawless] react-scan disabled`** on React 17 — react-scan cannot instrument it;
  render counts still come from the Profiler, so the times are real and the
  unnecessary-rerender column is not.

## Under `--expo`

`perf-harness` **refuses** under `--expo`, by a measured decision (~0 host-mountable
components on an all-route-screens app), and the refusal names the recorded evidence.
It is a failed `TaskResult`, so it appears in `results[]`, the `--ci` blob and
REPORT.md. Do not work around it by dropping `--expo`: a DOM host pointed at React
Native produces specs that run, pass, and touch nothing. See flawless-expo.

## Never

- Never call a green perf run "within budget": budgets warn.
- Never compare a one-worker number against a parallel one.
- Never read load-test p95s out of this plane, or claim a perf baseline this tool
  does not keep.
