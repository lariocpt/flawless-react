# Verdict-shape exploration — making flawless-react crust-shaped

Read-only exploration on **0.3.1**, measured against the real target
(`mybodycorpai`, branch `test/dogfood-2026-10`, commits `289cec6 → 0db32f5 → 0e0a2f4 → c00697f → 586c766 → 903e7ab`).
Companion to `DOGFOOD-0.3.1-FIX-PLAN.md` (the nine defects as ten chunks); this document sits *above*
those chunks — what the product should become so fewer of this class can exist.
Every number below was measured in this session or quoted from the three evidence docs; the measuring
command follows the number. Read-only throughout: scratch in `/tmp/opencode/`, no repo touched.

**Verdict up front:** the three principles are right, but "zero glue" as framed (the user must not
hand-patch *their own config* first) is the wrong target for the suite's own config files — those are
generated files, and the defect is that the generator wrote them wrong, which chunks 1, 2 and 8 already
fix at the root. The real design levers are: **commit-set shape** (what a PR shows), a **verdict
document** (what a run says), a **coverage ledger keyed on exports** (what is silently out of scope),
and a **composition seam with crust** (who owns ids/auth/baselines/evidence). Details in §2–§5.

---

## 1. Where we actually are

### 1.1 Residue — measured

The prompt and the `c00697f` commit message say "344 committed suite files". **That number is wrong
and the correction splits the residue into two different problems.**

| Claim | Measured | Command |
| --- | --- | --- |
| web suite files on disk | **344** | `find apps/web/flawless -type f \| wc -l` |
| web suite files committed | **212** | `git ls-files apps/web/flawless \| wc -l` |
| untracked (the dangerous ones) | **0** | `git ls-files --others --exclude-standard apps/web/flawless \| wc -l` |
| on-disk files in ignored dirs | **132**, in 7 ignored dirs | `git ls-files --others --ignored --exclude-standard …` |

344 = 212 committed + 132 gitignored artifacts (test-results, heaps, `reports/`, `load/last-*.json`,
node_modules) that the tool itself gitignores. The 132 are *by design* (evidence, regenerated each run);
the 212 are the owned-forever residue. Plus the tool appends an 11-line ignore block to
`apps/web/.gitignore` (lines 5–15, `flawless/reports/` … `*.flawless.json`) — residue the user's repo
carries to keep the suite's runtime out of `git status`.

The committed 212, by bucket (files, bytes — `git ls-files … \| xargs wc -c \| tail -1`):

| Bucket | Files | Bytes | Regenerable? | Reviewable content? |
| --- | ---: | ---: | --- | --- |
| `profile/` (perf-harness specs + `_heap.ts`, `_helpers.ts`) | 74 | 239,823 | yes (task `perf-harness`) | perf budgets in assertions |
| `browser/` (host specs + playwright.config) | 73 | 103,494 | yes (unit-browser) | behaviour assertions |
| `e2e/` (31 route specs + global-setup, params, config, README) | 36 | 108,718 | specs yes; setup+params **write-once** | flows |
| `host/` (browser host server: server.ts, main.tsx, registry.ts, index.html, _polyfill) | 5 | 51,854 | yes | machinery |
| `mocks/` (MSW handlers/browser/node + README) | 4 | 60,771 | yes | mock shapes |
| `mock/` (`routes.ts` + `server.ts`, from `--api` OpenAPI) | 2 | 61,899 | **write-once** ("Edit freely — there is no regeneration step that will overwrite this file") | route stubs + bodies |
| `load/` (routes.pipes, routes.setup.ts, env.sh, README) | 4 | 24,074 | pipes merge; **setup write-once** | crust pipes |
| `scripts/report.mjs` | 1 | 2,277 | yes | evidence aggregator |
| root (README, REPORT.md, budgets.json, package.json, playwright.config, pnpm-workspace, provider.fixtures.ts, provider.tsx, server-only-stub.ts, setup.ts, swagger.json, tsconfig.json, vitest.config.mts) | 13 | 293,028 | mixed | REPORT.md, budgets |

Colocated + mobile, same method:

| Set | Files | Bytes |
| --- | ---: | ---: |
| colocated web specs (`*.flawless.test.tsx` under `apps/web/src`) | 119 | 458,688 |
| mobile suite `apps/mobile/flawless` (34 e2e, 32 unit, 4 load, 3 config) | 74 | 389,937 |
| colocated mobile specs | 32 | 215,371 |
| **total committed generated content** | **437** | **2,009,934 (~1.91 MB)** |

Sidecars: 128 web + 48 mobile `*.flawless.json` on disk, all gitignored (`find apps/web/src -name '*.flawless.json'`).
Each sidecar: per-component counts by task, top findings, and pointers into `reports/`
(`apps/web/src/app/(auth)/_components/ForgotPasswordForm.flawless.json` read this session).
`reports/` (gitignored) holds the machine-readable per-task findings: `a11y.json`
(`{task, filesScanned, findingCount, findingsByFile}`) + per-component `<C>.perf-static.json`.
So the machine-readable findings base already exists on disk — it is just not committed, not
accumulated, and not the thing REPORT.md is built from.

**PR size today** (what a reviewer or agent reads): `git show c00697f --numstat` → **335 files,
42,386 insertions, 3 deletions** (web); `git show 586c766 --numstat` → 77 files, 9,169 insertions
(mobile). REPORT.md itself: 154 lines / 12,812 bytes (web) at `c00697f`, 153 / 11,251 (mobile) at `586c766`.

### 1.2 Glue — measured

Five hand-edits across the two dogfood rebuilds (each verified in the commit diffs):

| # | Edit | Chunk | Receipt |
| --- | --- | --- | --- |
| 1 | `apps/web/tsconfig.json`: add `"flawless"` to `exclude` | 2 | diff of `c00697f` |
| 2 | `apps/mobile/tsconfig.json`: same | 2 | diff of `586c766` |
| 3 | root `biome.json`: `!apps/web/flawless/setup.ts` | 8 | diff of `c00697f` |
| 4 | `flawless/tsconfig.json`: baseUrl/paths (suite's own tsconfig wrong as emitted) | 1 | diff of `c00697f` |
| 5 | two doc-root spec edits: `react-dom/server.browser` import + zustand fixtures | 3/4 class | hand-edit recorded in `c00697f` message |

Not glue, by design: `e2e/global-setup.ts`, `e2e/params.json`, `load/routes.setup.ts`,
`mock/routes.ts`, `provider.fixtures.ts` — all carry write-once markers ("flawless-react writes this
file once and never again — not even with --force", provider.fixtures.ts header, read this session).

### 1.3 Red — quoted from the evidence docs (plane tallies, FLAWLESS-DOGFOOD-31-oct.md)

| Plane | pass / fail / skip | Unexplained? |
| --- | --- | --- |
| web unit | 392 / **30** / 50 | one mechanism: `resolveAsyncUi` never awaits promise-valued props/children → tree suspends under `createRoot` → empty container (fix-plan chunk 9; `templates.ts:2294`) |
| web browser | 145 / 0 / 11 | skips named |
| web perf-static | 166 / 1 / 193 | 193 = counted named skips |
| web e2e | 39 / 0 / — | — |
| web load | 10 / 0 / — | 22 of 33 pipes commented `TODO(flawless): no value for LOAD_<PARAM>` (routes.pipes, read this session) |
| native unit | 122 / 0 / 23 | — |
| mobile e2e | 45 / **23** / — | all 23 = CORS (one env/mechanism) |

The 30 reds are one mechanism with a receipt: the fix plan names `resolveAsyncUi`
(`src/scaffold-tests/templates.ts:2294`) as the cause — never awaits promise-valued props/children, so
the tree suspends and commits nothing, and the spec fails on "expected content, got empty container".
The generator *measured* the props (`PROMISE_PROPS` list per spec — visible in the emitted
`dialog.flawless.test.tsx`, read this session) and still emitted a spec whose failure mode it could have
named. That is the test case for §3.

Also measured: the committed web `REPORT.md` after the full 7-task run says
**"This run selected 1 of 7 tasks. Not run, and therefore not described below: unit-browser,
perf-static, a11y, react-rules, e2e, load"** (`git show c00697f:apps/web/flawless/REPORT.md`, read).
The mobile report says "6 of 7" — the runs were driven as several `flawless_run` calls, and the report
on disk is the *last invocation's*. The committed report is therefore a per-invocation artifact that,
in the repo state where all seven planes just ran, declares six of them "Not run". **The current
"report" is not a verdict: it cannot say what the suite's state is.** That line is the single best
receipt in this document.

### 1.4 The old run, stated exactly

`git show 644473a` (old generation): 79 web unit failures, 926 perf-static findings, five tsconfig/lint
contract gaps worked around in-repo (biome ignore, tsconfig excludes, `src/flawless-matchers.d.ts`
shim, four zero-arg `ctx.skip()`s, e2e landing record). Its REPORT.md says **"183 component(s) across
99 file(s)"** with a table that sums to 183 (client 102, compound-part 46, document-root 2, null 1,
rsc 32). The commit message calls it "183 colocated unit specs" — **the message counted components,
not specs**: the measured old tree has **174** web colocated specs (183 components − 9 with no export).
A number nobody measured, carried into a permanent record. The new tree: 128 components / 119 web
specs / 287 test blocks vs the old 174 / 383.

### 1.5 Question F, answered: the 183 → 119 drop is better scoping **and** a ledger gap

F asks whether the spec drop is lost coverage or better scoping. Measured answer: **both, and the
second half is a defect**.

| Number | Value | Receipt |
| --- | ---: | --- |
| old run: components found | 183 across 99 files | `git show 644473a:apps/web/flawless/REPORT.md` (table sums to 183: client 102, compound-part 46, doc-root 2, null 1, rsc 32) |
| old run: web specs on tree | **174**, not 183 | spec-tree diff, old vs new; the commit message's "183 colocated unit specs" counted components (183 − 9 unexported = 174) |
| new run: components found | 128 across 99 files | current `REPORT.md` (client 81, compound-part 12, doc-root 2, null 1, rsc 32) |
| new run: web specs | 119 files, 287 test blocks (old: 383) | `git ls-files 'apps/web/src/*.flawless.test.tsx'` |
| specs lost | 59 = 58 per-component `components/ui` specs + `status-pill.JobStatusPill` | spec-tree diff, old vs new |
| specs gained | 4 per-file: `alert-dialog`, `dialog`, `select`, `table` | spec-tree diff, old vs new |

- **The better-scoping half.** Sampled assertions in the lost specs are the shallowest in the suite —
  `dialog.DialogContent` asserts "mounts inside its family wrapper" with
  `querySelectorAll("*").length > 1`; `JobStatusPill` is mount-only. The new family spec
  (`dialog.flawless.test.tsx`) tests the primary and states its limits explicitly. Trading 96 shallow
  test blocks for honest ones is defensible.
- **The defect half.** The naming rule did not change (`templates.ts:267–271`: per-component when a
  file has >1 spec target, otherwise the file stem). What shrank is the *target set*:
  `specTargets = flat.filter(c => hasSpec(c.info))` (`templates.ts:247`), with `hasSpec` =
  `exportKind !== "none"` (`bootability.ts:188`). The 54 shadcn subcomponents (Dialog**Content**,
  Select**Item**, Table**Row**, AlertDialog**Action**, …) are no longer in the analyser's component set
  at all: **0 hits** for them anywhere in the new `REPORT.md` (re-measured this session), while the old
  ledger tracked them. 54 exported symbols silently went from *spec'd* to *neither spec'd nor
  accounted for* — invisible in the report, in the exact class of scoping change the coverage ledger
  exists to make visible.
- **Verdict.** Keep the scoping; fix the ledger. The ledger must key on the set of **exported
  symbols** (stable, derivable from the file), not on the analyser's component set: every export
  without a spec needs a named reason (`covered-through: <parent>` / `not-analysed: <reason>`). That
  is "zero unexplained red" applied to coverage, and it is what makes stop-list row 6 in §4 defensible.
---

## 2. Four competing designs

Common to all four: the suite keeps its seven tasks, the write-once layers stay human-owned, and CI
runs the same commands the dogfood ran. The designs differ in **what is committed**, which decides what
a PR diff shows, what CI must regenerate, and what an agent reads per run. Agent token cost is
estimated as committed-diff bytes ÷ 4 (receipts: byte tallies in §1.1; the c00697f diff is 42,386
inserted lines ≈ 200 KB).

### A. Status quo — commit everything (344-class)

- **Committed:** all 212 web + 74 mobile + 151 colocated files; harness, configs, mocks, host, swagger copy.
- **CI:** runs the suites directly; deterministic because everything it imports is in the tree.
- **PR diff:** 335 files / 42,386 insertions for one app (measured). Review = diff of generated text;
  an agent reading it pays ~100k tokens per app per run, most of it host/MSW/config churn it cannot act on.
- **Breaks when two people generate on different machines:** silently — both trees commit, next `--force`
  regenerates wholesale and one person's hand-edited specs die (the tool already warns: "a run without
  --force leaves an existing suite alone, and --force regenerates it wholesale", `flawless_run` description).
  There is no drift detection today; the idempotence check catches non-deterministic *emission*, not divergence.
- **Failure mode:** residue ownership (437 files, 1.91 MB) plus §1.3: the committed report says "1 of 7 tasks"
  after a full run. This is the design that produced the dogfood complaint.

### B. Committed specs + ephemeral harness

Split the 212 by the regenerability column in §1.1. Minimum committable set:

| Kept committed (web) | Files | Bytes | Why committed |
| --- | ---: | ---: | --- |
| colocated unit specs | 119 | 458,688 | the assertions; colocation is the review surface |
| browser host specs (`.spec.ts` only) | 72 | 102,270 | behaviour assertions |
| profile specs (`.spec.ts` only) | 72 | 231,022 | perf budgets |
| e2e specs (`.spec.ts` only) | 31 | 99,520 | flows |
| write-once layers | 6 | ~10 k (est. from bucket) | params.json ×2, global-setup, routes.setup.ts, mock/routes.ts, provider.fixtures.ts |
| configs the runners need to *start* (vitest, playwright ×2, package.json, tsconfig) | 6 | ~20 k | runners read these before any regeneration could help |
| REPORT.md + budgets.json | 2 | ~25 k | the verdict |
| **≈** | **310** | **~950 k** | |

- **Committed:** the spec files + write-once layers + minimal configs + verdict.
- **CI:** `flawless-react --check` (validate committed specs against a fresh emission, fail on drift)
  → regenerate harness (`host/`, `mocks/`, `provider.tsx`, `mock/server.ts`, stubs) → run planes.
  Determinism requires the harness to be a pure function of (source tree, openapi.json, version) — which
  it is *except* the write-once layers and `mock/routes.ts` (fine: those are committed) and the
  per-invocation report (see D's verdict doc).
- **PR diff:** ~950 KB → ~240k tokens worst case; realistically the delta between two runs is small
  (specs change only when components change) — but the *first* PR is still ~180 files.
- **Breaks when two people generate:** less (harness never committed, so no harness drift), but the
  spec-drift check becomes load-bearing; a stale committed spec vs a regenerated one is now a CI failure
  instead of a silent overwrite.
- **Failure mode:** the split is artificial in two places, both measured: (1) colocated unit specs import
  `../../../flawless/provider` (measured in `status-pill.StatusPill.flawless.test.tsx`) — the harness root
  is *inside* the spec's dependency graph, so "ephemeral harness" means CI must regenerate *before*
  collecting specs, and a developer running one spec locally still needs the harness on disk; (2)
  browser specs import only `@playwright/test` (measured) — they are genuinely standalone, which proves
  the split is possible per-plane, not globally.

### C. Fully on-demand — nothing but a manifest committed

- **Committed:** a lockfile/manifest (analyser version, task set, source-tree hash, openapi hash,
  write-once layers, verdict doc) + the write-once layers themselves (~6–10 files).
- **CI:** regenerate the whole suite from source (deterministic if emission is deterministic — the
  tool already has an idempotence check for exactly this), run planes, publish verdict + evidence as
  CI artifacts, commit nothing new.
- **PR diff:** the manifest delta + the verdict doc. Agent cost: ~2–5 KB ≈ 1–1.5k tokens per run.
  This is the only design where the PR diff *is* the verdict.
- **Breaks when two people generate:** nothing breaks — there is nothing shared; but **reviewability
  inverts**: the PR no longer shows the assertions at all. A reviewer cannot see what changed in the
  tests without running CI, and CI is the thing under review. Colocation dies (the 119+32 colocated
  specs exist to live beside the source they test — that is their entire review ergonomics), and a
  red in CI has no file to point at in the PR. The constraint "what makes CI deterministic and PRs
  reviewable" (prompt, Constraints) is answered for CI and *failed* for PRs.
- **Failure mode:** the suite becomes invisible; ownership of the assertions moves to the CI artifact
  store, which expires. This is "delete the generated suite and run on demand" — explicitly the
  proposal the constraints say must answer reviewability, and it does not.

### D. Recommended shape — verdicts with receipts, committed specs, crust at the seam
*(full argument in §3; the table row for completeness)*

- **Committed:** same as B's spec set (≈310 files web, ~950 KB) **minus** the harness that B kept
  committed for runner-start reasons — D keeps only what a runner must read to start (configs,
  ~20 KB) and regenerates `host/`, `mocks/`, stubs in a pre-step; **plus** the accumulated verdict
  doc (`flawless/VERDICT.json` + rendered `VERDICT.md`) and the per-plane evidence pointers.
- **CI:** pre-step `flawless-react --ci --emit` (regenerate, diff against committed specs, fail on
  unexplained drift) → run planes via `run_tests` → `flawless verdict` aggregates the last run of
  **every** plane into one document (the fix for §1.3's "1 of 7") → JUnit + verdict as CI artifacts;
  load plane runs crust natively (`test-pipes` with `--out` stats, JUnit) and contributes its verdict.
- **PR diff:** spec delta + VERDICT.md delta. Agent cost per run: spec delta (small after first) +
  verdict (~5–15 KB) ≈ **1.5–5k tokens** to read the whole picture, vs ~100k for A.
- **Breaks when two people generate:** the emit-diff in CI turns divergence into a named CI failure
  ("spec X differs from emission Y; re-run or accept with --force" — the acceptance is explicit, not
  silent).
- **Failure mode (honest one):** the emit-diff check has two new failure classes of its own —
  environment-sensitive emission (locale, node_modules layout) and the write-once layers legitimately
  differing from a fresh emission. Both are exactly the "named skip with a reason" class §3 builds,
  so the failure is self-describing; but it is a new moving part, and the migration (§5) ships it last.

---

## 3. Recommendation: D — and the contract it buys

D is B with two upgrades: the **verdict document** (so a run says what the suite's state is) and the
**crust seam** (so the planes that already speak crust stop being re-implemented in a shell). It beats
the others on the three principles:

1. **Zero glue** — D does not claim more than chunks 1/2/8 already deliver: the suite's own tsconfig
   emits correct paths (chunk 1), the app's tsconfig is never edited because the suite lives outside
   the app's program *by layout*, not by an `exclude` the user adds (chunk 2 made moot — see §5 step
   order), and `setup.ts` passes lint as emitted (chunk 8). What D adds is layout: a suite directory
   whose tsconfig is its own program root, so there is nothing for the app's `tsc`/biome to see.
   Cost of the layout (measured, not guessed): the colocated specs import `flawless/provider` through
   a relative path — that stays, and it is *the* feature (review beside source); what changes is that
   the app's configs never list the suite, so there is nothing to forget.
2. **Zero unexplained red** — the contract in §3.1 below, with the 30 `resolveAsyncUi` reds as the
   test case. The generator already measures everything the contract asks for (`PROMISE_PROPS` per
   spec, the fixture table, the mock provenance in `mocks/handlers.ts`); it just does not say so
   inside the failing spec.
3. **Minimal residue / verdicts with receipts** — residue drops from 437 files to ~310 committed
   (the spec set) with the harness ephemeral in CI and locally regenerable by the same command the
   first run used (first-run experience unchanged: one command still produces a runnable suite on
   disk — it just also produces the verdict doc now). The verdict doc is the receipt: per plane,
   pass/fail/skip tallies, per-finding evidence pointers (trace, heap snapshot in `heaps/`, the mock
   shape that produced a given response), and the coverage ledger (Q-F, answered in §1.5).

### 3.1 The zero-unexplained-red contract

Every generated spec, per test, must end in exactly one of:

| Outcome | Requirement | Already true? |
| --- | --- | --- |
| pass | — | yes |
| skip | named reason string, counted in the report | **yes, and this is the culture to keep**: `test.skip("${name}: ${reason}")` emitted throughout `templates.ts` (lines 2724, 2774, 2830, 2856, 2896, 3002, 3010, 3156, 3216, read this session); `uncertainEscape()` (line 2423) converts admitted mock-shape gaps to `console.warn` + skip; the load plane already does it at pipe granularity (22 of 33 commented `TODO(flawless): no value for LOAD_<PARAM>`, counted in the report) |
| fail | the failure carries a cause the tool asserts: which mock, which unresolved shape, which missing capability — emitted as a comment + a machine tag next to the assertion | **no**: the 30 reds fail on "got empty container" with no named cause |

What the generator has to know, and therefore must measure, to honour the fail branch:

1. **Whether a mount can suspend** — i.e. run `resolveAsyncUi`'s own rule *at generation time*: does
   this component's props/children chain contain a promise-valued node the resolver does not await
   (the exact chunk-9 mechanism, `templates.ts:2294`)? If yes, the spec must either (a) emit the
   awaiting variant, or (b) carry a generated comment naming the un-awaited promise path and the
   spec becomes a counted skip with reason `async-surface: <path>`. The measurement is the same
   walk `resolveAsyncUi` performs; running it at generation is a reuse, not a new analysis.
2. **Which mock produced each shape** — `mocks/handlers.ts` already records the source
   (spec example vs synthesised); the emitted spec should name it per fetch it stubs, so a red
   "body mismatch" is "mock M (synthesised from schema, no example in openapi.json) returned X".
3. **The absent `catch { return; }`** — one silent swallow remains in the static-text render path
   (`templates.ts:2487–2491`, read this session); the RSC guard-catch (2392–2409) already does it
   right (assertion hoisted outside the try, guard rethrows non-guard errors). The contract makes
   2487–2491 a bug of the same class as the 30 reds: a red the user cannot interpret.
4. **Counted skips in the report, not just in specs** — REPORT.md already receives a `TodoCounter`
   (templates.ts:167–172 doc comment: "mutated as each marker is emitted … so the unit-browser
   task can hand the tallies to the run report"); extend the same pipe to the verdict doc so skip
   reasons are aggregated per reason-string, not per file.

The contract is satisfiable *today* with the data the tool already measures — that is the whole point
of using the 30 reds as the test case: no new analysis, only emission discipline.
---

## 4. What we would stop doing

A plan that only adds is not a strategy, so this is explicit. Each row names the surface and where
it goes.

| # | Stop | Replace with | Receipt that it exists today |
| --- | --- | --- | --- |
| 1 | **Emitting a per-invocation REPORT.md as the suite's face.** It says "1 of 7 tasks" after a full run (§1.3). REPORT.md becomes the *coverage* ledger (components, not-covered-and-why, standing gaps — keep, it is good) and a separate accumulated **verdict doc** carries run results. | `VERDICT.json`/`VERDICT.md`, updated per plane, keyed by (task, target-hash), so the last run of every plane is always on record | `git show c00697f:apps/web/flawless/REPORT.md` line "This run selected 1 of 7 tasks" |
| 2 | **The baseline ritual around the inline gate.** The generated pipes inline `assert (async s => { const b = await Bun.file("baseline-*.json").json(); … s.p95 < 2 * b.summary.p95 })` per route (33 routes, read). The lambda itself is **not** the defect: crust's own `docs/USAGE.md` "Baselines" documents exactly this async-assert-reading-`Bun.file` pattern as *the* gate — `test-pipes` has no native baseline flag, so the pipes are not re-implementing anything. What dies is the ritual around it: "copy a good `last-*.json` to `baseline-*.json`" is a user chore nobody asked for. | Baseline dir becomes a **committed directory with a deliberate-bump convention** (a baseline change shows in the PR diff, which is the review surface); `last-*.json` stays gitignored evidence. Optional future: a crust-side `test-pipes -b <dir>` flag reading the same committed dir — one small upstream change, not a dependency of this design | `apps/web/flawless/load/routes.pipes` every pipe tail; `crust/docs/USAGE.md` "Baselines" (read this session) |
| 3 | **Owning an MSW mock server (`mock/`) that duplicates crust's mock-server** when the project is already running one (mybodycorpai runs crust mock-server on :4000 per its AGENTS.md, read). For apps that use crust, `mock/routes.ts` + `mock/server.ts` (61,899 bytes) are a second source of truth for the same openapi.json. | In crust-hosts: point the suite's MSW handlers at the same openapi.json examples crust serves (the examples already are the shared truth — "Response examples are load-bearing", host AGENTS.md); in non-crust apps, keep emitting `mock/`. | `apps/web/flawless/mock/routes.ts` header + `apps/web/AGENTS.md` crust section |
| 4 | **The per-component `*.flawless.json` sidecars as the findings channel.** 176 ignored files, each a small JSON with pointers back into `reports/` — a layer that exists only because the findings live in two places. | Findings live in `reports/` (already machine-readable, §1.1); sidecars either die or become the verdict doc's per-component slice generated *from* reports/, not beside them | `find … -name '*.flawless.json'` → 128+48; shape read this session |
| 5 | **`scripts/report.mjs`** (playwright-stdout → markdown aggregator) as a bespoke evidence path. | Crust/runner JUnit output + the verdict doc; `stats --out` JSONs are the evidence, `report.mjs` is a legacy bridge to delete when the verdict doc ships | file read this session (2,277 B) |
| 6 | **Emitting subcomponent specs that are mount-smoke only** (the 96 lost test blocks' class) — and, per §1.5's F, *silently* dropping them from the ledger at the same time. | Emit per family-primary (as 0.3.1 already does) **and** record every exported symbol without a spec in the ledger with a named reason (`covered-through: <parent>` or `not-analysed: <reason>`). The scoping rule becomes visible, which is what makes it a design decision instead of a regression risk. | spec-tree diff: 58 per-component ui specs lost; sampled assertions §1.5 |
| 7 | **MCP tools returning generation results as the unit of truth.** `flawless_run` returns the `--ci` blob (exitCode, results, testRun, errors) — correct for a *run* call, but `flawless_project_status` reports inventory (spec count, TODO count, scripts missing), not state. | Keep `flawless_run` as-is (a run is a run). Add **one** verdict surface: a `flawless verdict` CLI + tool that reads the accumulated verdict doc and returns plane tallies + per-finding evidence pointers + open skips. `flawless_project_status` gains "last verdict: <path, tally, age-of-source-hash>". | `src/mcp/runTools.ts:127–140`, `analysisTools.ts:612+` (descriptions read this session) |

Not on the list (considered, kept): the host browser (`host/`, 51,854 B) — it is the only thing that
makes 72 mountable components profile-able in a real browser, and crust does not do DOM; the perf
budgets (`budgets.json`, per-component mountMs/updateMs — read, all currently 50/16, i.e.
placeholder-grade until baselined deliberately); the 14 skills (they are the agent's entry point and
cost nothing to commit as links).

---

## 5. Migration from 0.3.1

Ordered, each step independently shippable, each row stating which fix-plan chunks it makes **moot**
(the chunk's fix is no longer needed because the design removed the defect class) versus **still
required** (the chunk fixes an emission bug the design keeps). Chunk numbers are the fix plan's.

| Step | Ships | Makes moot | Still required |
| --- | --- | --- | --- |
| **M1** — Verdict doc, per plane | `VERDICT.json`+`VERDICT.md` updated by each task's result (tallies, per-finding evidence pointers into `reports/`, `heaps/`, `load/last-*.json`); REPORT.md keeps its coverage role and gains a pointer to the verdict. The "1 of 7" class dies: a full run's six missing planes are simply *previous* verdict entries, still visible. | — (adds the receipt layer) | chunk 0 (harness) unchanged |
| **M2** — Zero-unexplained-red emission | The §3.1 contract: generation-time suspension check (reuse `resolveAsyncUi`'s walk), mock provenance named per stub, delete the silent `catch { return; }` (templates.ts:2487–2491), skip-reasons aggregated per reason-string in the verdict. The 30 reds become 0 red + N named skips (or fixed awaits). | **chunk 9 in substance** (the 30-red mechanism is named and skipped-or-fixed at generation — the hand-fix of the emitted helper disappears because the emitted helper is right or the test is a named skip) | chunk 0 |
| **M3** — Suite tsconfig by construction | The suite's tsconfig emits correct paths as-is, **and** the suite directory is its own program root (its own `include`, no reliance on the app's compilerOptions). | **chunk 1** (harness tsconfig paths emitted right — the measured edit #4 disappears) | — |
| **M4** — Layout outside the host program | The suite is placed so the app's `tsc`/`biome`/`next build` never include it without the user opting in: no app-config edit, ever. The `exclude` entries were the *user's* workarounds; the layout makes them unnecessary. (Cost paid: the suite is a self-contained program — the one relative import from colocated specs into `flawless/provider` is documented as the single seam and kept.) | **chunk 2** (both measured tsconfig excludes, web + mobile) **and chunk 8** (the biome ignore for setup.ts — a file the host linter can't see needs no ignore; the suite lints itself with its own config) | — |
| **M5** — The emit-diff CI pre-step | `flawless-react --ci --emit` validates committed specs against fresh emission; divergence is a named CI failure with the exact diff, acceptance only via explicit `--force`. Two-people-diverge stops being silent. | — (new; this is what makes §2-D safe) | chunk 3/4 class: the doc-root spec hand-edits (edit #5) remain real work — the generator's RSC/server-module handling still needs its fix; M5 just makes the *regression* visible next time |
| **M6** — Crust seam consolidation | Baseline bumps become committed-dir changes reviewed in the PR (§4.2); the inline gate lambda stays — it is crust's documented pattern; `mock/` suppressed when the host runs crust mock-server (§4.3); evidence = `stats --out` JSONs + JUnit, `report.mjs` retired (§4.5). The load plane stops being flawless's bespoke crust. | — (composition, not a fix-plan chunk; defect #7 MCP-exit and #10 CORS are unaffected) | chunk 7 (MCP exit), chunk 6 (bound workers) unchanged |
| **M7** — Commit-set re-shape | Adopt §2-D's commit set: harness files (host/, mocks/, stubs, provider.tsx) move out of the default commit into the ephemeral set; configs + specs + write-once + verdict stay. The .gitignore block shrinks accordingly. First PR after migration is the one big diff; subsequent PRs are spec deltas. | — | chunk 5 (sync mock shapes) still required — MSW handlers must still match the app's fetch shapes; the design changes where they live, not whether they're right |

**Independently shippable:** M1, M2, M3+M4 (one layout change, two chunks killed), M5, M6, M7 are
each a separate PR with its own green definition. Suggested order: **M1 → M2 → M3+M4 → M5 → M6 → M7**.
M1 first because every later step's "no unexplained red" claim is *checked* by the verdict doc, and
M7 last because it moves files out from under everything else. Chunks still required after all steps:
0 (harness correctness), 3/4 (RSC/server.browser emission — M5 makes regressions visible but the fix
is real work), 5 (mock shape sync), 6 (bound workers), 7 (MCP exit), 10 (CORS). Nine defects, four of
whose *classes* (1, 2, 8, and the 30-red half of 9) the design removes rather than patches.
---

## 6. Open questions — each with its named measurement

| # | Question | Known now | Named measurement | Accept / defer |
| --- | --- | --- | --- | --- |
| 1 | **Steady-state agent-token cost of D after the first run.** A's one-shot PR is 42,386 inserted lines (measured); D's steady state should be spec delta + VERDICT.md (~1.5–5k tokens, §2-D) — but "small after first" is an assumption | — | On the target: mutate one source component, run `flawless-react --ci` twice, diff the committed tree between runs; report files + bytes | Ship the number with M7. Accept: steady-state diff < 5% of first-run diff |
| 2 | **Emit-diff pre-step CI time on large repos.** The pre-step re-runs the analyser (the expensive pass) to diff emission against committed specs | full-run timings exist in the dogfood doc for the *old* shape | Time `flawless-react --ci --emit` on the target with an identical committed suite (the no-drift path): wall time + peak RSS, next to one unit-plane run | Accept: pre-step < 2× one unit plane. If not: emit-diff over a hash-keyed emission cache instead of full re-analysis |
| 3 | **Local browser-plane runs with an ephemeral host.** Browser specs import only `@playwright/test` (measured), but `browser/playwright.config.ts` carries `webServer: { command: "bun ../host/server.ts" }` (measured) — a committed spec depends on an ephemeral file, started by playwright only if `host/` exists on disk | none | Fresh checkout, no harness on disk, run one browser spec; expect config start to fail on the missing file. Then choose: (a) a `flawless sync` pre-step documented in the suite README, or (b) the config invoking the pinned generator | Blocker for M7's local story, not for its CI story — CI's pre-step regenerates first. Whichever fix, the suite README must state in one line how committed specs run without a full regenerate |
| 4 | **`budgets.json` is all 50/16 placeholders.** Every entry `{mountMs: 50, updateMs: 16}` (read). The browser config comments say budgets only warn, so placeholders gate nothing today | none | One baselined profile run per app → real per-component numbers → committed as the initial baseline, under the same deliberate-bump convention as load baselines (§4.2) | No design change; needs only the first *meaningful* run per app |
| 5 | **183-vs-174.** | **Resolved** — §1.5: 183 is the component count in the old REPORT.md; the measured old spec count is 174; the commit message conflated the two | — | Nothing open. The hygiene lesson (permanent records quoting unmeasured numbers) is covered by the verdict-doc discipline |
| 6 | **Verdict doc shape for multi-app monorepos.** One `flawless/` suite per app (measured: web + mobile); nothing accumulates across suites today | none | Deferred until a second dogfood app exists; if needed, a root-level aggregate of per-app verdicts by pointer (no content copying) | Deferred |

---

## Appendix — receipt index (read-only; nothing in either repo was modified)

**Files read** (paths relative to their repo):

- `mybodycorpai` — `apps/web/flawless/`: `REPORT.md`, `budgets.json`, `provider.fixtures.ts`, `package.json`, `tsconfig.json`, `vitest.config.mts`, `playwright.config.ts`, `scripts/report.mjs`, `mock/routes.ts`, `mocks/handlers.ts`, `mocks/README.md`, `host/server.ts`, `load/routes.pipes`, `load/routes.setup.ts`, `load/env.sh`, `e2e/playwright.config.ts`, `e2e/params.json`, `e2e/global-setup.ts`, `browser/playwright.config.ts`; one colocated spec and one family spec under `apps/web/src`; `apps/web/.gitignore`; the parallel `apps/mobile/flawless` set; `apps/web/AGENTS.md`
- `flawless-react` — `src/scaffold-tests/templates.ts` (150–294, 247, 267–271, 2294, 2392–2409, 2423, 2487–2491, 2724–3216), `src/analyse/bootability.ts:188`, `src/mcp/runTools.ts:127–140` + `src/mcp/run.ts:224`, `src/mcp/analysisTools.ts:310,612`, `src/core.ts:147`, `src/scaffold-tests/nativeTemplates.ts`
- `crust` — `docs/USAGE.md` §"CI gates: thresholds, baselines, exit codes" (incl. "Baselines", the async-assert `Bun.file` pattern)

**Commands run** (all read-only): `find | wc -l`; `git ls-files | wc -l`; `git ls-files --others [--ignored] --exclude-standard`; `git ls-files <bucket> | xargs wc -c | tail -1` (every byte figure in §1.1/§2); `git show c00697f --numstat` and `git show 586c766 --numstat` (PR sizes); `git show 644473a:apps/web/flawless/REPORT.md` (old ledger); old-vs-new spec-tree diff (58/4/59 numbers, §1.5); `grep -c` ledger probes (§1.5); `git show <sha>:…` for `REPORT.md` at each dogfood commit ("1 of 7 tasks" line).

---

## Re-audit at v0.3.2 (main @ `903a2e1`) — 2026-11-04

Every load-bearing claim above (C1–C46) re-measured cold against **v0.3.2** on
bigcachy (bun 1.4.3, live npm registry). Three evidence channels: pinned receipts via
`git show`/`git ls-tree`/`git cat-file --batch-check='%(objectsize)'` on the dogfood SHAs;
emitter behaviour via the `903a2e1` binary regenerating the `c00697f` and tip trees; and
in-repo anchor re-mapping on `main`. Tally: **21 stands / 21 changed / 4 dead**. "Changed"
rows are label/anchor/number corrections where the design they feed is intact or shrinks;
"dead" rows are mechanisms v0.3.2 already removed. Dead/changed rows name what they kill
or shrink in M1–M7 (§5).

### §1.1 Residue

| Claim | 0.3.1 receipt | 0.3.2 measurement (command → decisive line) | Verdict |
| --- | --- | --- | --- |
| **C1** — "344 committed" is wrong; web suite = 344 on disk = 212 committed + 132 gitignored, untracked 0 | `find apps/web/flawless -type f \| wc -l` → 344; `git ls-files` → 212; `--others` → 0; `--ignored` → 132 in 7 dirs | same commands on the current `ec107e8` checkout → **8,756** ignored (8,382 node_modules, 223 browser, 100 reports, 14 test-results, 13 playwright-report, 12 heaps, 10 load, 2 e2e), untracked 0; committed 212 holds at all 7 pinned SHAs | **changed** — the on-disk 344/132 was a session snapshot, not a pinned-tree property; the 212-owned / 132-artifact *split* stands. No M-step impact (M7 uses committed counts, C7) |
| **C2** — committed 212 by bucket: 74/239,823; 73/103,494; 36/108,718; 5/51,854; 4/60,771; 2/61,899; 4/24,074; 1/2,277; 13/293,028; total 945,938 | `git ls-files <bucket> \| xargs wc -c` at c00697f | `git ls-tree -r c00697f -- apps/web/flawless/…` + `git cat-file --batch-check='%(objectsize)'` → all nine rows byte-identical | **stands** |
| **C3** — tool appends an 11-line ignore block to `apps/web/.gitignore` (lines 5–15) | read of the committed file at c00697f | `git show c00697f:apps/web/.gitignore` → same 11 lines, 5–15 | **stands** |
| **C4** — colocated web specs 119 / 458,688 B | `git ls-files 'apps/web/src/*.flawless.test.tsx'` | same at c00697f and 903e7ab → identical (zero diff between the two SHAs) | **stands** |
| **C5** — mobile suite 74 / 389,937 B, breakdown "34 e2e, 32 unit, 4 load, 3 config" | `git ls-files apps/mobile/flawless` at 586c766/903e7ab | file-level recount → 34 e2e + 32 unit + 4 load + **4 root files** (`jest.config.cjs`, `jest.setup.ts`, `REPORT.md`, `styleStub.js`) = 74; 388,302 B @586c766 + exactly the 2-file diff (52+/21−, 10+/10−) = 389,937 @903e7ab | **changed** — the total stands; "3 config" mislabels four root files (one is `styleStub.js`, not config). No M-step impact |
| **C6** — "colocated mobile specs" 32 / 215,371 B | `git ls-files` under `apps/mobile/src` implied by the label | `git ls-tree -r <each of the 7 pinned SHAs> -- apps/mobile/src` → **zero** test files under `apps/mobile/src` at any of them; the 32 files are `apps/mobile/flawless/unit/` *inside the suite* (already counted in C5's 74) | **changed** — mislabeled: never colocated, never under `src/`. Feeds C7's double-count; no M-step impact by itself |
| **C7** — "total committed generated content" 437 files / 2,009,934 B (~1.91 MB) | 212 + 74 + 151 (119 web + 32 mobile colocated) | the 32 mobile "colocated" of C6 are already inside the 74 of C5 → unique committed = 212 + 74 + 119 = **405 files / 1,794,563 B** (1,414,855 B is the *new-version* bytes of the 335 web-PR files, C21) | **changed** — double-count; the true residue is 405 / ~1.71 MB. **Shrinks M7**: its commit-set re-shape starts from 405 files / 1,794,563 B, not 437 / 1.91 MB |
| **C8** — "sidecars: 128 web + 48 mobile `*.flawless.json` on disk, all gitignored" | `find apps/web/src -name '*.flawless.json'` → 128+48 | `git ls-tree -r <each pinned SHA>` → **0** committed sidecars at all 7 SHAs (gitignored, as claimed); the 128/48 counts are session-snapshot values; the `903a2e1` binary's regen of the `c00697f` tree reproduces exactly **128** web sidecars | **changed** — "all gitignored" stands; the counts are not pinned-tree properties. No M-step impact (stop-list row 4, C34, carries the correction) |
| **C9** — PR sizes: c00697f = 335 files / 42,386 ins / 3 del; 586c766 = 77 / 9,169; REPORT.md 154 / 12,812 (web) and 153 / 11,251 (mobile) | `git show c00697f --numstat`, `git show 586c766 --numstat`; `git show <sha>:…/REPORT.md` | same commands → identical tallies at the pinned SHAs | **stands** |

### §1.2 Glue

| Claim | 0.3.1 receipt | 0.3.2 measurement (command → decisive line) | Verdict |
| --- | --- | --- | --- |
| **C10** — five hand-edits (web/mobile tsconfig excludes, root biome ignore, suite tsconfig paths, two doc-root spec edits), each verified in the commit diffs | `git show c00697f -- <path>`, `git show 586c766 -- <path>` | same → all five edits present in the pinned diffs, byte-identical | **stands** (they remain the measured evidence for *why* M3/M4 exist; 0.3.2 makes them unneeded — C41/C42) |
| **C11** — the five write-once layers "all carry write-once markers" ("flawless-react writes this file once and never again — not even with --force") | header read of `provider.fixtures.ts` at c00697f | header grep across the five files → the literal marker is in **3 of 5** (`e2e/global-setup.ts`, `mock/routes.ts`, `provider.fixtures.ts`); `e2e/params.json` and `load/routes.setup.ts` carry no such header; the `903a2e1` binary's `--force` runs (tip-tree regen + the doc-root regen) **never rewrote any of the five** | **changed** — "5 of 5 behavioral, 3 of 5 literal". No M-step impact: M7's write-once set is defined behaviorally |

### §1.3 Red

| Claim | 0.3.1 receipt | 0.3.2 measurement (command → decisive line) | Verdict |
| --- | --- | --- | --- |
| **C12** — plane tallies: web unit 392/30/50; web browser 145/0/11; perf-static 166/1/193; web e2e 39/0; web load 10/0; native unit 122/0/23; mobile e2e 45/**23** (all CORS) | commit messages of c00697f and 586c766; `FLAWLESS-DOGFOOD-31-oct.md` line 19 | `git show c00697f`, `git show 586c766`, the evidence doc → identical tallies (they are 0.3.1 *run* records; no 0.3.2 plane run was measured on a regen tree, so they stand as history, not as 0.3.2 behaviour) | **stands** |
| **C13** — the 30 reds are one mechanism: `resolveAsyncUi` never awaits promise-valued props/children → tree suspends → empty container (`templates.ts:2294`) | `templates.ts:2294` read; the 30 reds' shared failure shape in the c00697f run | the `903a2e1` `resolveAsyncUi` (now `templates.ts:2529`) **walks every prop and awaits top-level thenables**, and the new `RSC_RENDER_SETTLED` path (`templates.ts:2602`) renders under `Suspense` with a `data-flawless-suspended` fallback and settles before asserting → the regen tree's resolved specs no longer carry the empty-container failure mode | **dead** — the mechanism is fixed in 0.3.2. **Kills M2's acceptance case** "30 reds → 0 red + N named skips" and pre-satisfies M2's silent-catch item (C29). Emission-level receipt only — no 0.3.2 plane run was measured, so no "0 reds" tally is claimed |
| **C14** — load plane "22 of 33 pipes commented `TODO(flawless): no value for LOAD_<PARAM>`" | `load/routes.pipes` read at c00697f | `git show c00697f:apps/web/flawless/load/routes.pipes` → **23** of 33 pipes commented, 10 active; the "22" is `load/env.sh` line 16's own comment ("22 of 33 measured the 404 handler"); `git diff v0.3.1 v0.3.2 -- src/tasks/loadPipes.ts` → **empty** (emitter unchanged); the 0.3.2 regen's 33-active / 0-TODO state comes from the committed, human-filled `e2e/params.json` values, not from a new pipe | **changed** — 23, not 22 (feeds C44); the "counted in the report" half stands |
| **C15** — "the generator measured the props (`PROMISE_PROPS` list per spec — visible in `dialog.flawless.test.tsx`) and still emitted a spec whose failure mode it could have named" | the `dialog.flawless.test.tsx` read at c00697f | `grep -L 'PROMISE_PROPS: \[\]'` over the c00697f spec set → non-empty `PROMISE_PROPS` on exactly **25** specs (22 `["params"]`-only, 2 `["searchParams"]`-only, 1 both — `maintenance/page`); `dialog.flawless.test.tsx` has `PROMISE_PROPS: []` and is **not** one of the 30 reds (c00697f message: "5 async-RSC detail pages plus dashboard/layout") | **changed** — the cited example is a mislabel; the substance (measured props on the 25 async-RSC pages) stands |
| **C16** — committed REPORT.md says "This run selected 1 of 7 tasks… Not run: unit-browser, perf-static, a11y, react-rules, e2e, load"; mobile says "6 of 7" | `git show c00697f:apps/web/flawless/REPORT.md` line 29; `git show 586c766:…/REPORT.md` line 19 | same → identical; emitter now `reporters/report.ts:241–242`; the `903a2e1` regen still emits per-invocation "2 of 7 tasks" in both worktrees | **stands** — the per-invocation class is unchanged in 0.3.2; **M1's premise is intact** |
| **C17** — `resolveAsyncUi` cited at `templates.ts:2294` (×3: §1.3 table, §1.3 mechanism paragraph, §3.1 item 1) | 0.3.1 `templates.ts` read | 0.3.2 `templates.ts` → `resolveAsyncUi` at **2529** | **changed** — anchor drift only (mechanism verdict: C13) |
| **C18** — old run 644473a: "183 colocated unit specs" message vs "183 component(s) across 99 file(s)" REPORT (table sums to 183: 102+46+2+1+32); old tree 174 specs / 383 test blocks vs new 128 components / 119 specs / 287 blocks; 59 lost (58 `components/ui` + `JobStatusPill`) / 4 gained (`alert-dialog`, `dialog`, `select`, `table`); 79 unit fails, 926 perf-static findings, five contract gaps | `git show 644473a` + REPORT; spec-tree diff old vs new; `grep -c` probes | `git show 644473a`, row-sum check (102+46+2+1+32=183; 81+12+2+1+32=128), the spec-tree diff re-run → 174/383, 128/119/287, 59/4 all reproduce | **stands** (includes §1.5's Q-F table) |
| **C19** — "54 shadcn subcomponents … 0 hits anywhere in the new REPORT.md, while the old ledger tracked them" | `grep -c` of the 54 names in old/new REPORT.md at the pinned trees | old REPORT.md's ledger is a **count table**: of the 55 dropped subcomponents, 38 are tracked only by count (the `client`/`rsc` rows), 17 by name (9 `select.*` + 8 `dropdown-menu.*` + `AvatarImage`); the 54 zero-hits in the new REPORT reproduce **exactly** on the 0.3.2 regen (58 lost ui-specs − 3 renamed primaries = 55 dropped; − 1 `SelectGroup` one-hit = 54 zero-hit) | **changed** — "tracked them" overstates the old ledger (it mostly tracked by count); the 54-gap itself stands. **Sharpens M1**: the verdict's coverage ledger must be **name-level** (38 of 55 were invisible-by-name even in 0.3.1), which is a stronger bar than the doc's "counted in the report" |
| **C20** — §1.5 anchors: naming rule `templates.ts:267–271`, `specTargets … :247`, `bootability.ts:188` (and the appendix's anchor list for `templates.ts`) | 0.3.1 reads | 0.3.2 → naming `const stem` at **283–289**, `specTargets` at **263**, `bootability.ts` **188–189** (unchanged); the appendix's `templates.ts` ranges and `core.ts:147` (now `testRun` at **153**) all drift by the same insertion block | **changed** — anchor drift only; the scoping rule and its `hasSpec` gate are textually unchanged |

### §2 Designs

| Claim | 0.3.1 receipt | 0.3.2 measurement (command → decisive line) | Verdict |
| --- | --- | --- | --- |
| **C21** — agent token cost "committed-diff bytes ÷ 4"; c00697f "42,386 inserted lines ≈ 200 KB" ≈ **~100k tokens per app per run** | byte tallies §1.1 + `git show c00697f --numstat` | `git cat-file --batch-check='%(objectsize)'` over the 335 files' **new versions** at c00697f → **1,414,855 B** (≈1.35 MiB) → ÷4 ≈ **354k** tokens, ~7× under the estimate; the "inserted *lines*" figure was used where *bytes* were meant | **changed** — ~100k → ~354k (≈1.4 MB). **Shrinks §2-A's cost argument but in its favour** (A is worse than claimed); D's relative position (spec delta + verdict ≈ 1.5–5k tokens) is unaffected; no M-step number changes (M7 quotes files/bytes, C45) |
| **C22** — §2-A: "--force regenerates it wholesale and one person's hand-edited specs die" | `flawless_run` description, 0.3.1 | the `903a2e1` binary's `--force` runs on the two regen worktrees: divergent existing specs are **kept and flagged** ("hand-edited or reformatted … kept — delete to regenerate" — seen live on the two doc-root specs carrying 0.3.1 stamps while `app/page` was rewritten at 0.3.2); scaffold-time files (tsconfig, playwright configs, `host/`, `mock/`, `report.mjs`, budgets, load `env.sh`/`routes.setup.ts`) are never rewritten | **changed** — the failure mode softens: 0.3.2 keeps hand-edits and says so. **Shrinks M5**: its emit-diff pre-step now defends a tool that already refuses to clobber; the pre-step's job narrows to *detecting* divergence the run didn't flag (e.g. a spec deleted on one machine) |
| **C23** — §2-B minimum-committable table: 119/458,688; 72/102,270; 72/231,022; 31/99,520; ≈310 files / ~950 k | `git ls-files` per set at c00697f | same per-set counts at c00697f → identical | **stands** |
| **C24** — §2-B failure mode: colocated specs import `../../../flawless/provider` (38× + deeper variants); browser specs import **only** `@playwright/test` (72/72) | import greps at c00697f | same greps on the pinned tree and on the 0.3.2 regen tree → 38× + deeper variants; 72/72 browser specs import only `@playwright/test` | **stands** — the split is per-plane, not global, in both versions |
| **C25** — §2-C: on-demand cost ~2–5 KB ≈ 1–1.5k tokens; colocation dies; reviewability inverts | design argument on measured imports (C24) | imports unchanged in 0.3.2 (C24) | **stands** |

### §3 Recommendation

| Claim | 0.3.1 receipt | 0.3.2 measurement (command → decisive line) | Verdict |
| --- | --- | --- | --- |
| **C26** — zero glue: D claims nothing beyond chunks 1/2/8; layout cost = the relative `flawless/provider` import stays | chunk measurements + C24 | the provider import is unchanged (C24); 0.3.2 emission of the suite's own tsconfig is now correct (C41) | **stands** |
| **C27** — §3.1 skip row: named `test.skip` sites at `templates.ts` lines 2724, 2774, 2830, 2856, 2896, 3002, 3010, 3156, 3216; `uncertainEscape()` at 2423; load plane skips at pipe granularity | 0.3.1 reads | 0.3.2 → **18** skip sites (2338, 3055, 3105, 3161, 3187, 3227, 3333, 3341, 3487, 3547, 3562, 3587, 3609, 3634, 3648, 3666, 3713, 3867), `uncertainEscape` at **2743**, `TodoCounter` doc comment at **169–174** | **changed** — anchor drift + count 9→18 (more named-skip sites, same culture); the pipe-granularity number is C14. No M-step impact beyond C40's rebased aggregation |
| **C28** — §3.1 fail row: "the 30 reds fail on 'got empty container' with no named cause" | the 30-red failure shape in the c00697f run (C13) | emission no longer produces that shape: the resolver awaits (C13) and `RSC_RENDER_SETTLED` settles under `Suspense` before the assertion — a spec that still cannot resolve now surfaces the suspended marker, not an empty container; no 0.3.2 plane run was measured on a regen tree, so this is an **emission-level** receipt | **dead** — the fail-branch test case no longer exists to fix; **kills M2's framing** (C40) |
| **C29** — §3.1 item 3: "one silent `catch { return; }` remains in the static-text render path (`templates.ts:2487–2491`); the RSC guard-catch (2392–2409) already does it right" | 0.3.1 reads | the 0.3.2 static-text render path has **no** silent catch (removed); the RSC guard-catch structure is **identical** at ~2703–2718 (assertion hoisted outside the try, guard rethrows non-guard errors) | **dead** — the named bug is already fixed in 0.3.2; the guard-catch half stands at its new anchor. **Pre-satisfies M2's silent-catch item** (C40) |
| **C30** — "the contract is satisfiable *today* with the data the tool already measures — no new analysis, only emission discipline" | C13/C15/C27 receipts | 0.3.2 now emits the awaiting resolver, the settled render, per-stub provenance in `mocks/handlers.ts` (`handlersProvenance` 6/0 on the regen tree) and named skips — the measured-data half is even more true than in 0.3.1 | **stands** — if anything, 0.3.2 moved the contract from "satisfiable" to "half-emitted" |

### §4 Stop list

| Claim | 0.3.1 receipt | 0.3.2 measurement (command → decisive line) | Verdict |
| --- | --- | --- | --- |
| **C31** — row 1: per-invocation REPORT.md says "1 of 7 tasks" after a full run | `git show c00697f:…/REPORT.md` line 29 (C16) | 0.3.2 regen emits per-invocation "2 of 7 tasks" (emitter `reporters/report.ts:241–242`) | **stands** — the class M1 kills is unchanged |
| **C32** — row 2: the inline baseline lambda is crust's documented pattern, not a defect; the *ritual* ("copy a good `last-*.json` to `baseline-*.json`") dies | `load/routes.pipes` pipe tails; `crust/docs/USAGE.md` "Baselines" | pipe-tail read on the pinned tree → the lambda's actual text is `assert (async s => { const b = Bun.file("<baseline>"); return !(await b.exists()) \|\| s.p95 < 2 * (await b.json()).summary.p95 })` — the doc's "…" elided the `!exists()` guard; the referent is the **local crust repo** `docs/USAGE.md` lines 743–749, not the pinned mbc `crust/` tree | **stands** (guard elision noted; referent pinned — feeds C44) |
| **C33** — row 3: "mybodycorpai runs crust mock-server on :4000 **per its AGENTS.md** … 'Response examples are load-bearing', host AGENTS.md" | `apps/web/AGENTS.md` read at c00697f | `git show c00697f:apps/web/AGENTS.md` → **does not exist**; the crust :4000 section is in the **root** `AGENTS.md` (line 80; lines 112–119) and "Response examples are load-bearing" is at its lines 63–64 (); the appendix's file-read list names `apps/web/AGENTS.md` — the same misfiled referent (no such file at any pinned SHA) | **changed** — the referent is root `AGENTS.md`, not `apps/web/AGENTS.md`. **Fixes M6's receipt** (C44): the crust-host detection reads the root AGENTS.md's :4000 section |
| **C34** — row 4: "176 ignored files" of sidecars (128+48), a layer that exists only because findings live in two places | `find … -name '*.flawless.json'` → 176 | 0 committed sidecars at any pinned SHA (C8); 0.3.2 regen reproduces 128 web; the two-place findings base (`reports/` + sidecars) is unchanged in 0.3.2 | **changed** — 176 is a session snapshot (128 web reproducible, 48 mobile session-only); the defect (two findings locations) stands — M1's verdict doc still replaces this layer |
| **C35** — row 5: `scripts/report.mjs` (2,277 B) is a bespoke evidence bridge to delete when the verdict doc ships | file read at c00697f | `git show c00697f:…/scripts/report.mjs` → 2,277 B, unchanged; the 0.3.2 `--force` runs never rewrite it (scaffold-time file) | **stands** — M6's retirement target (C44) |
| **C36** — row 6: stop emitting mount-smoke subcomponent specs *and* silently dropping them; 58 per-component ui specs lost, sampled assertions shallowest in the suite | spec-tree diff old vs new (C18); sampled reads of the lost specs | diff re-run → 58/4 unchanged; 0.3.2 keeps family-primary emission (same `hasSpec` gate, C20) | **stands** — with the C19 sharpening: the ledger entry must be name-level |
| **C37** — row 7: `flawless_run` returns the `--ci` blob; `flawless_project_status` reports inventory, not state (`runTools.ts:127–140`, `analysisTools.ts:612+`) | 0.3.1 reads | 0.3.2 → `runTools.ts:127–140` and `analysisTools.ts:612` **unchanged**; `run.ts` `renderCiRun` now at 289, `core.ts` `testRun` at 153 | **stands** — M6's MCP-exit chunk (7) is untouched by 0.3.2 |
| **C38** — "not on the list": host browser 51,854 B (72 mountable components, crust does not do DOM); budgets all 72× 50/16 placeholders; the 14 skills | reads at c00697f | same at the pinned SHAs: 51,854 B; `budgets.json` 72 entries all `{mountMs: 50, updateMs: 16}`; `.agents/skills` has 24 entries — **14** `flawless-*` + 10 `crust-*` (the "14 skills" is the flawless subset, correctly scoped) | **stands** |

### §5 Migration (M1–M7) + §6 Open questions

| Claim | 0.3.1 receipt | 0.3.2 measurement (command → decisive line) | Verdict |
| --- | --- | --- | --- |
| **C39** — M1: verdict doc per plane; "the '1 of 7' class dies"; REPORT.md keeps the coverage role | C16/C31 receipts | the per-invocation class is unchanged in 0.3.2 (C16/C31), so the receipt M1 replaces still exists to be replaced; the 0.3.2 `TodoCounter` pipe (169–174) is the aggregation seam M1 extends (C27) | **stands** — M1 required as written, with the C19 sharpening (name-level coverage ledger, not counts) |
| **C40** — M2: "the 30 reds become 0 red + N named skips (or fixed awaits)"; delete the silent `catch { return; }` | C13/C28/C29 receipts | all three inputs are gone: the mechanism is fixed (C13), the fail shape is not emitted (C28), the silent catch is removed (C29); what 0.3.2 *does not* yet emit: per-stub mock provenance named inside specs, and skip-reason aggregation in a verdict (that is M1's doc) | **dead** — as framed. **M2 is rebased** on emission-shape receipts: dogfood-baseline #7 18/0, per-stub provenance naming, skip-reason aggregation — acceptance is measured on emission, not on a 30-red regression that no longer exists |
| **C41** — M3: "the suite's tsconfig emits correct paths as-is, **and** the suite directory is its own program root" | C10 edit #4 (suite tsconfig paths hand-patched) | the 0.3.2 `--force` runs **never rewrite** the suite `tsconfig.json` (byte-identical across regens; the "Hand-patched, not generated" comment intact) — it is **scaffold-time only** (`templates.ts:161`), and the regen log now prints `tsconfig.json: kept — "flawless" already excluded`; the fresh-scaffold emission of correct paths is the 0.3.2 chunk-1 fix | **changed** — M3 **shrinks**: the "emits correct paths" half is done (fresh scaffolds); what remains is the *own-program-root layout* (the suite's `include`/`compilerOptions` not inheriting the app's program), which 0.3.2 does not do |
| **C42** — M4: "the suite is placed so the app's `tsc`/`biome`/`next build` never include it … no app-config edit, ever"; kills chunk 2 (both tsconfig excludes) and chunk 8 (biome ignore) | C10 edits #1–#3 | chunks 2 and 8 are **already fixed in 0.3.2** at the emitter (fresh scaffolds emit the exclude/ignore correctly; the pinned trees' hand-edits are artifacts of the 0.3.1 scaffolds) | **changed** — M4 **shrinks** to its layout half: *default placement* outside the host program (a fresh app must need zero app-config edits without the user opting in); the "no app-config edit, ever" guarantee for *existing* 0.3.1-era suites is a migration, not an emission, property |
| **C43** — M5: "the doc-root spec hand-edits (edit #5) remain real work — the generator's RSC/server-module handling still needs its fix; M5 just makes the regression visible" | C10 edit #5; the 0.3.1 doc-root specs' `react-dom/server.browser` hand-edit | the `903a2e1` binary, run fresh on the doc-root (`layout.flawless.test.tsx`, `global-error.flawless.test.tsx` deleted then regenerated): both emit `renderToReadableStream` from **`react-dom/server.browser`** with the "do not simplify this back" comment, the streaming renderer and the full thenable-walking resolver — **the chunk-3 class is dead for fresh emission**. What the fresh emission does *not* reproduce from the 0.3.1 human edit: the store shape — the 0.3.2 leave-real guard (`src/scaffold-tests/mocks.ts:370–383`, "defect #4, mechanism 2", `group.pkg && !moduleHasEvidence`) applies to **packages only**, so the fresh `layout` spec mocks `@/lib/store`'s `createAppStore` as a flagged guess `vi.fn(async () => ({}))` + `TODO(flawless): createAppStore guessed async {} — no call-site evidence` + synthesized "flawless-*" selector fixtures, where the human edit left the real `zustand/vanilla` store with true-shape plain-function fixtures. Measured `--force` refresh lifecycle (same regen): **126 M / 0 A / 0 D** (124 fixed-point + 2 fresh doc-root — double-regen idempotence), unit-browser "files:123 … (browser specs skipped — add perf-harness…)", load "33 target(s) — 33 live" | **changed** — M5 **shrinks**: doc-root emission is fixed; remainder = (a) the app-internal store-shape decision (extend the leave-real guard past packages, or emit real-shape fixtures for app-internal module factories), and (b) the emit-diff pre-step for the measured keep-and-flag lifecycle (C22) |
| **C44** — M6: baseline committed-dir convention; inline lambda stays; `mock/` suppressed when the host runs crust; evidence = `stats --out` + JUnit, `report.mjs` retired | C31–C35 receipts | pipes: committed `routes.pipes` @c00697f has **23** of 33 commented (C14), and the v0.3.1→v0.3.2 `loadPipes.ts` diff is **empty** — the seam's emitter side is unchanged; the baseline referent is the local crust repo's `docs/USAGE.md` lines 743–749 (C32); the crust-host detection referent is the **root** `AGENTS.md` :4000 section (C33) | **changed** — the work is unchanged in scope but corrected in its receipts: pipes 23 not 22; detection reads root `AGENTS.md`; `report.mjs` (C35) and the committed-dir convention (C32) stand as the retirement/target |
| **C45** — M7: "harness files move out of the default commit … the .gitignore block shrinks accordingly"; first PR = one big diff | C7's 437/1.91 MB starting point; C9's 335/42,386 first-PR size | unique committed residue is **405 files / 1,794,563 B** (C7); the 0.3.2 `--force` lifecycle (C22/C43: 126 M / 0 A / 0 D, scaffold-time files never rewritten, divergent specs kept + flagged) is the refresh story the new commit set must fit | **changed** — M7 **shrinks** to 405 / 1,794,563 B and inherits C22: the ephemeral set is safe to regenerate because 0.3.2 already refuses to clobber; the §6 Q3 local-browser story (C46) is the open edge |
| **C46** — §6 Q3: browser config carries `webServer: { command: "bun ../host/server.ts" }` while 72/72 browser specs import only `@playwright/test`; Q5: 183-vs-174 resolved | config read + import greps at c00697f (C24/C38) | unchanged at the pinned SHAs and in the 0.3.2 regen tree: committed specs depend on the ephemeral `host/` started by playwright; Q5's resolution (183 components vs 174 specs, C18) stands | **stands** — M7's local story (sync pre-step vs pinned generator) is still open in 0.3.2; CI story unaffected (pre-step regenerates) |
