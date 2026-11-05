# Plan — depth, cheap planes, continuity (v0.3.3 baseline)

Successor to `REDESIGN-PLAN.md` (M1–M7, `8ca7a58`, M1 shipped as `b44dde5`). This plan
takes the three weaknesses the v0.3.3 dogfood evaluation named and turns each into
shippable, measured steps. Everything else is out of scope by design (§ Non-goals).

The three weaknesses, in the evaluation's own words:

1. **"Broad and shallow."** 445 passing unit tests on a real 132-component app are
   mostly mount + literal copy + derivable interaction; ~65 % line coverage is the fair
   read. "Depth still requires the hardening loop; the tool raises a floor, it doesn't
   buy a ceiling."
2. **"The expensive planes are setup-gated."** e2e needs a seeded DB and a hand-written
   login; load needs a prod build and an auth header. Most teams run unit/perf/a11y and
   leave those generated-but-unrun.
3. **"Bus factor 1."** CI, release, the dogfood corpus and the incident lore all live on
   one machine or in one head.

Each step is its own branch off `main`, independently shippable, and **nothing merges
without the operator** — same contract as the redesign plan.

## Order

**D0 → D1 → D2 → D3 → D4** (track D), **S1 → S2 → S3** (track S), **C1 → C2 → C3 → C4**
(track C). The tracks are independent of each other and can interleave; inside a track
the order is a dependency chain.

| Step | Subfile | One line |
| --- | --- | --- |
| D0 — depth measurement | `docs/plans/PLAN-00-depth-measurement.md` | Build the ruler before cutting: an assertion-tier census and a mutation falsifier probe over the pinned dogfood tree. Nothing in track D may claim depth without it. |
| D1 — depth already derivable, unemitted | `docs/plans/PLAN-01-depth-free-derivation.md` | Seven assertion classes whose facts the analyser already produces and the emitter drops on the floor. No new analysis. |
| D2 — loaded/error/empty content on the DOM plane | `docs/plans/PLAN-02-depth-content-witness.md` | Port the native plane's `displayWitness` trick to the four `TODO(flawless)` fetch states. |
| D3 — state transitions and status flags | `docs/plans/PLAN-03-depth-state-transitions.md` | The first genuinely new analysis: `setX(v)` → rendered witness, and which copy is keyed on `isLoading`/error. |
| D4 — payload and argument claims | `docs/plans/PLAN-04-depth-payload-claims.md` | `toHaveBeenCalled()` → `toHaveBeenCalledWith(...)`: form payloads and callback arguments. |
| S1 — e2e first run | `docs/plans/PLAN-05-e2e-first-run.md` | Cut the e2e cold start from five hand-writes to one command that says exactly which of them are still missing. |
| S2 — load first run | `docs/plans/PLAN-06-load-first-run.md` | Same for load: prod-build detection, session handoff from e2e, baseline bootstrap, crust contract. |
| S3 — runtime truth in the verdict | `docs/plans/PLAN-07-verdict-runtime-channel.md` | `VERDICT.json` records generation facts today; give executed planes a write-back channel so "emitted but never run" is a named state with a number, not a silence. |
| C1 — machine-independent CI | `docs/plans/PLAN-08-machine-independent-ci.md` | The Jenkinsfile is one host: `/srv/apps`, `/opt/publish`, a tailnet registry, an IPv4 pin. Make the pipeline portable and the private services optional. |
| C2 — scripted release | `docs/plans/PLAN-09-release-scripted.md` | v0.3.3 was shipped by hand across 9 steps, and the last one (npm staged approval) is still open. Script everything a script can do; document the one human 2FA step. |
| C3 — onboarding + prose-to-tests | `docs/plans/PLAN-10-onboarding-and-knowledge.md` | The clone-to-green path exists only as tribal knowledge; the incident rules that no test enforces are the next maintainer's landmines. |
| C4 — reproducible dogfood | `docs/plans/PLAN-11-dogfood-reproducible.md` | Every acceptance receipt in this repo is measured on a private repo at a pinned SHA a stranger cannot fetch. |

## What "depth" means here, operationally

The evaluation's complaint is unfalsifiable as stated, so the plan defines it. Every
emitted assertion falls in one tier:

- **T0 — mount-only.** `not.toThrow()`, `innerHTML.length > 0`, `toJSON() !== null`.
  True of almost any component; falsifies almost nothing.
- **T1 — shape and copy.** Named root tag, literal static text, children/className
  forwarding, variant matrix. Falsified by markup and copy changes.
- **T2 — derived interaction effect.** Click → prop spy / mocked module / router call;
  fill → value read-back; guard throws; predicate inversion; disabled-at-props.
  Falsified by behaviour changes, not just markup.
- **T3 — state and payload.** The rendered result of a state transition, of a response
  body, of a submitted payload; `toHaveBeenCalledWith` on a derived argument.
  Falsified by data-flow changes.

Two numbers, both computed on the pinned dogfood tree (`mybodycorpai @ c00697f`):

- **Tier census** — per spec file, the strongest tier it asserts; reported as a
  distribution plus the count of specs whose strongest tier is T0.
- **Falsifier rate** — the fraction of mutated components whose own spec goes red.
  Mutations are named and mechanical (swap a branch, invert a predicate, rename a
  rendered field, change a payload key), not random.

D1–D4 are only allowed to claim depth as a movement in these two numbers, measured
before and after with the same binary lineage (`AGENTS.md`, *Measure with the newest
code*). A step that raises the census without raising the falsifier rate produced
decoration, and says so.

## Measured baseline for this plan

Measured 2026-11-05 on `main` @ `67336ee` (tag `v0.3.3`), bun 1.4.3:

- `rm -rf node_modules/.cache/biome && bun run check` → `Checked 251 files`, 0 errors,
  2 warnings.
- `bunx tsc --noEmit` → clean.
- `bun test` → `1793 pass / 11 skip / 0 fail`, 6,379 `expect()` calls, 1,804 tests
  across 120 files, 57.21 s.
- Source: 127 files / 46,042 lines under `src/`; 120 test files / 1,787 `test()` calls
  under `tests/`.
- Emission refusals currently on the shelf: 22 `test.skip`/`ctx.skip` sites in
  `src/scaffold-tests/templates.ts`, 7 in `src/scaffold-tests/nativeTemplates.ts`, and
  5 `todoLine()` markers — the four fetch-state TODOs at
  `src/scaffold-tests/templates.ts:2204/2213/2222/2231` plus the fixture-less one at
  `:2184`.
- Inherited, **not re-measured here**: the v0.3.3 dogfood tallies (501 unit / 445 pass /
  2 honest-red / 54 reasoned skips, 164 browser, 145 native, on `c00697f`). They are
  quoted from the prior session's receipts; D0 re-measures them with the ruler it
  builds.

## Merge-back criteria — mechanical, per step

Identical to the redesign plan's four, restated because they bind here too
(`git show 8ca7a58:REDESIGN-PLAN.md`):

1. **Receipts landed** — every acceptance item re-run on the merge commit, its measured
   result (number + command + decisive line) appended to the subfile's Receipts section
   as a dated one-liner. A pinned-SHA property is shown with a pinned-SHA command.
2. **The five gates green at the merge commit** — cold biome; `bunx tsc --noEmit`;
   `bun test` twice with identical tallies; `bun test` under a stripped `PATH`; scope
   hygiene (`git log main..<branch>` is only this step; `git diff main...<branch>
   --stat` touches only the subfile's declared surface).
3. **Regen idempotence probe** — a binary compiled from the merge commit
   (`bun build --compile --minify --outfile /tmp/opencode/fl-bintest-<sha> src/bin.ts`)
   runs a full-task regen on the pinned tree twice in fresh worktrees; the second run is
   0 A / 0 D with `M` equal to the first run's fixed point, and every write-once file is
   byte-identical.
4. **Operator review and merge** — `gh pr create --body-file` with the receipts in the
   body; the operator merges. A subagent prepares and pushes; it never merges.

Track D adds one criterion of its own: **the two depth numbers move, and the mutation
probe proves the new assertions can fail.** Every new assertion class ships with a named
mutation that turns it red — the pattern the repo already uses in
`tests/predicateInversionExecution.test.ts`, `tests/guardPolarityExecution.test.ts` and
`tests/depReturnsExecution.test.ts`. An assertion with no falsifier is a T0 wearing a
T3 costume.

Track S adds one: **the setup path is measured as a cold start.** The receipt is a
command sequence run in a fresh clone of a fresh target, timed, with its output pasted —
not "it works on my machine".

Track C adds one: **the step must be verifiable by someone who is not the maintainer**,
or it is not a continuity fix. Concretely: a step that only documents a private resource
does not close a bus-factor item; one that removes the need for it does.

## Non-goals

- **No runtime in the CLI.** `docs/architecture.md:454` — "The CLI never imports React
  or Playwright. It does not boot a server." Depth comes from static derivation and from
  what the *emitted* suite can prove, not from the generator executing the app.
- **No model-generated assertions.** The product's position is that it never claims more
  coverage than it derived. A guessed assertion is worse than a named skip, and the
  whole skip-reason apparatus exists to keep that line visible.
- **Not re-planning M2–M7.** They stand as written in `REDESIGN-PLAN.md`; this plan does
  not touch them, and a step here that collides with one there is resolved in the
  redesign plan's favour and recorded as a note.
- **Not exposing private infrastructure.** Continuity means removing the *dependency* on
  the maintainer's tailnet, Jenkins mounts and npm tokens — not making them public.
- **No new plane.** Seven task ids stay seven.

## Receipts

- `bun test` on `main` @ `67336ee`, 2026-11-05, before any change on this branch:
  `1793 pass / 11 skip / 0 fail`, 6,379 expect() calls, `Ran 1804 tests across 120
  files. [57.21s]`. Cold biome and `bunx tsc --noEmit` as above. This branch adds
  documents only, so the tally above is the branch's own gate result as well; it is
  re-run at the merge commit per criterion 2.
