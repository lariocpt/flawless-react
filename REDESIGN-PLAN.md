# Redesign plan — making flawless-react crust-shaped (v0.3.2 baseline)

Companion to `VERDICT-SHAPE-EXPLORATION-OUTCOME.md` (the 0.3.1-era exploration, now with
its **v0.3.2 re-audit** section: 46 claims, 21 stands / 21 changed / 4 dead) and to
`DOGFOOD-0.3.1-FIX-PLAN.md` (re-audited on `main` @ `903a2e1` — same tally, no row moved).
This plan is the migration ordered as the re-audit leaves it: each step is a separate
branch off `main`, independently shippable, and **nothing merges to main without the
operator** (a subagent may prepare and push a step branch, never merge it).

## Order

**M1 → M2 → M3+M4 → M5 → M6 → M7** (M3 and M4 ship as one layout change).

| Step | Subfile | State after the v0.3.2 re-audit |
| --- | --- | --- |
| M1 — verdict doc + name-level coverage ledger | `REDESIGN-01-verdict-doc.md` | required as written, **sharpened**: the old ledger tracked 38 of 55 dropped subcomponents by count only, so the new ledger must be name-level (audit C19) |
| M2 — zero-unexplained-red emission | `REDESIGN-02-zero-unexplained-red.md` | **rebased**: the 30-reds `resolveAsyncUi` mechanism and the silent catch are already fixed in 0.3.2 (audit C13/C29 — dead); acceptance moves to emission-shape receipts |
| M3 — suite tsconfig / own program root | `REDESIGN-03-program-root.md` | **shrunk**: correct paths are already emitted at scaffold time in 0.3.2 (chunk 1 done); what remains is the program-root layout |
| M4 — layout outside the host program | `REDESIGN-04-host-layout.md` | **shrunk**: chunks 2/8 are already fixed at the 0.3.2 emitter; what remains is default placement (zero app-config edits, ever) |
| M5 — emit-diff CI pre-step + doc-root refresh | `REDESIGN-05-emit-diff.md` | **shrunk**: chunk-3 doc-root emission is already fixed in 0.3.2 (fresh emission is correct, audit C43); what remains is the app-internal store-shape decision + the measured keep-and-flag `--force` lifecycle |
| M6 — crust seam consolidation | `REDESIGN-06-crust-seam.md` | required, receipts corrected: pipes 23 of 33 commented (not 22), the `loadPipes.ts` v0.3.1→v0.3.2 diff is empty, the crust-host referent is the **root** `AGENTS.md` (audit C33/C44) |
| M7 — commit-set re-shape | `REDESIGN-07-commit-set.md` | **shrunk**: the residue starts at **405 files / 1,794,563 B** (not 437 / 1.91 MB — audit C7/C45); the ephemeral set is safe to regenerate because 0.3.2 `--force` refuses to clobber (keep-and-flag, audit C22/C43) |

Dead design input (do not re-plan): the 30-reds regression as an acceptance case, the
silent `catch { return; }` deletion, and "M5 fixes doc-root emission" — all three are
already done in 0.3.2.

## Merge-back criteria — mechanical, per step

A step branch merges to `main` only when **all** of the following hold, each re-measured
on the exact merge commit (a remembered number is a failed criterion):

1. **Receipts landed.** Every acceptance item in the step's subfile was re-run on the
   merge commit and its measured result (number + command + decisive line) is appended
   to the in-repo record as a dated one-line confirmation — the same discipline the
   fix-plan re-audit uses. A subfile item whose receipt names a pinned-SHA property must
   show the pinned-SHA command (`git show`/`ls-tree`), not a working-tree read.
2. **The five gates are green at the merge commit:**
   a. `rm -rf node_modules/.cache/biome && bun run check` → 0 errors;
   b. `bunx tsc --noEmit` → 0 errors;
   c. `bun test` run twice → both runs 0 fail, identical pass/skip tallies;
   d. `bun test` under a stripped `PATH` (minimal environment) → 0 fail;
   e. hygiene: `git log main..<step-branch>` contains only this step's commits, and
      `git diff main...<step-branch> --stat` touches only the surfaces the subfile
      declares (scope field).
3. **Regen idempotence probe.** A binary compiled from the merge commit
   (`bun build --compile --minify --outfile /tmp/opencode/fl-bintest-<sha> src/bin.ts`)
   runs a full-task regen on the pinned dogfood tree (`c00697f`) twice, in fresh
   worktrees: the second run is **0 A / 0 D** with `M` equal to the first run's
   fixed-point count, and every write-once file is byte-identical before and after.
4. **Operator review and merge.** `gh pr create --body-file` with the subfile's
   receipts in the body; the operator merges (`gh pr merge --merge`), then
   `git checkout main && git pull --ff-only`. No step merges on a subagent's say-so.

Steps that fail criterion 3 ship the divergence as a named follow-up commit in the same
PR (one idea: the probe failure and its fix), never by loosening the probe.

## Standing operator condition (checked at each step, not per claim)

A step is blocked — and the branch left unpushed with a note — only when the operator
environment cannot measure: no bun ≥ 1.4, or no reachable npm registry. At the time of
this plan (2026-11-04, bigcachy) bun is 1.4.3 and the registry is live, so no step is
blocked on environment.
