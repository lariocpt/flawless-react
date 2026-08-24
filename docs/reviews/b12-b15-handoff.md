# Handoff — B-12 … B-15 (the round-7 opportunity set)

Written 2026-08-24 at the close of round 7 (PRs #24–#26, ledger
`2026-08-r7-findings.json` FR-035…FR-040, readiness 57/70). Four backlog
items, all four grounded in something observed — no invented features. Seams
below were read at `ab31d4a`; **re-verify line numbers before editing.**

## Order of work

Do them in this order — it runs cheapest-verification-first, and B-14 gives
B-12 the reporting channel it wants:

1. **B-13** (S) — `--ci` keeps its diagnostics.
2. **B-14** (S) — `--run-tests` with nothing runnable stops being silent, and
   `testRun` joins the `--ci` blob.
3. **B-12** (M) — the e2e suite stops being green before it is real.
4. **B-15** (M) — cache the repeated work, but only what a measurement backs.

One branch + one PR per item, merged into main, mesh-repo-sync after each.

---

## B-13 — `--ci` suppresses the diagnostics an agent most needs

**Evidence.** `src/core.ts:166-171`: `log()` writes to stdout and `warn()`
writes to **stderr**, but both are gated on the same `opts.log !== false`.
`src/cli.ts:377` passes `log: !args.json`. So the mode built for machines is
the one that loses `warning: skipping <file>` and
`could not parse <path> as OpenAPI JSON — ignoring`. The stdout purity that
`--json` needs is a statement about **stdout**, not about stderr.

**The fix.** Split the gates: `log()` stays gated on `opts.log`, `warn()`
writes to stderr unless a separate quiet flag says otherwise. Keep one
predicate for "is this run interactive", never conflate it with "may I
speak at all".

**Watch out.** `tests/cli.test.ts`'s `--ci process contract` block carries a
deliberate comment saying a clean `--ci` run can be silent on **both**
streams — that comment is only true because of this bug. Update it, and add
the missing assertion: a `--ci` run over an input that provokes a warning
must show it on stderr while stdout stays exactly one JSON blob. That pairing
is the whole point — pin both halves in one test or the next change
re-conflates them.

---

## B-14 — `--run-tests` with only non-runnable tasks does nothing, quietly

**Evidence.** `src/core.ts:564` computes `runnableSelected`; the generated-run
branch at `:604` is `else if (!anyFailed && opts.runTests === true &&
runnableSelected)` with **no else**. So `--ci --tasks a11y --run-tests` exits
0 having run no suite, with empty stderr and a blob that cannot distinguish
it from a green suite run.

**The fix, two halves.**

1. Say it: when `runTests` was asked for and no selected task can run one,
   emit a warning naming the runnable task ids (`perf-harness`,
   `unit-browser`, `e2e`). B-13 must land first or `--ci` swallows it.
2. Mark it: `CoreResult.testRun` already exists — it was added precisely so a
   caller could tell "exit 0 because suites passed" from "exit 0 because no
   suite ran" (FR-017's seam) — but `src/cli.ts:392-397` omits it from the
   `--ci` blob. Add it, and record a third mode (`"none"` with a reason) for
   this case so the JSON says what happened rather than staying silent.

**Tests.** Extend the `--ci process contract` block: `--tasks a11y
--run-tests` → exit 0, blob parses, `testRun.mode === "none"`, stderr names
the runnable ids. Control: a real `--run-tests` run still reports
`mode: "generated"`. Note that adding a blob field is a contract change —
FR-020's tests assert the field set, so update them deliberately, not
incidentally.

---

## B-12 — the e2e suite is green before it is real

**Evidence.** `src/tasks/e2eRoutes.ts:164-186` emits `globalSetupStub()`,
which writes an **empty** `.auth.json` (`{cookies:[],origins:[]}`) on every
run and carries a `TODO(flawless)` telling the human to wire login. The
emitted route spec's only claim is `expect(resp?.status(), "no 5xx")
.toBeLessThan(500)` (`:272`) plus empty console/pageerror lists. On any
auth-gated app the unauthenticated request 302s to the login page, which
answers **200** — so the suite passes while testing the login screen. The
`flawless-e2e-load` skill's anti-vacuous probes exist *because* of this
shape, which is the tell: a documented workaround for a tool behaviour is a
tool problem.

**Design decision to make first** (write it down in the PR body). Two honest
options, and they are not equivalent:

- **(a) Fail until filled.** The stub throws unless the human has wired
  login — loudest, matches the house rule, but breaks the "generate, then
  fill in" flow for apps with no auth at all, so it needs an explicit
  "this app has no auth" opt-out that is itself recorded.
- **(b) Mark the run not-yet-meaningful.** The stub still writes empty state,
  but the emitted spec asserts it is not on the login route (or the task
  records `handWork` and REPORT.md says the e2e layer is not yet meaningful),
  so the green is *labelled* rather than silent.

Recommendation: **(b) plus a redirect assertion** — the spec should fail when
the response URL is not the route it asked for. That is a real assertion
about the app, it needs no opt-out, and it converts "green by default" into
"green when the route actually rendered". Add (a)'s loudness through
REPORT.md's hand-work table rather than through a throw.

**Tests.** The execution discipline applies: scaffold a tiny Next app with a
route that 302s to `/login`, run the emitted e2e spec, and prove it goes
**red** before the setup is filled and green after. Do not settle for
asserting the emitted text — this finding exists because reading the spec
looked fine.

---

## B-15 — repeated work the caches should absorb

**Evidence, and the honest framing.** `src/analyse/parseFile.ts:65` caches
the parse but re-runs `findComponents` plus `collectModuleImports`' whole-AST
JSX walk on every call, so a file with R components is re-scanned R+1 times
under `--roots exported`. `src/analyse/sourceCache.ts:100`'s
`findExportedDecl` re-walks the same barrels per member per component — and
`zodMemberSchema` (`src/analyse/extractProps.ts`) runs it even for non-zod
types before discarding the result. `src/analyse/index.ts:185` recomputes
sibling render modes O(R²) per file.

**This is an opportunity, not a finding, and the PR must keep it that way.**
The B-7 timing pin (`tests/analysePerf.test.ts:34`, 2000 ms budget, ~45 ms
measured) still holds comfortably. So:

1. **Measure first.** Write a benchmark over a synthetic tree that actually
   exhibits the shape (many components per file × wide barrels), and record
   the before number in the PR body. If the number is small, say so and stop
   — a cache that buys nothing is complexity the next reader pays for.
2. Then memoise, cheapest first: a per-(file,name) memo on `findExportedDecl`
   keyed inside the existing `SourceFileCache`; a components-per-file memo in
   `parseFile`; the sibling-mode loop last.
3. **Cache invalidation is the risk.** Every memo must be scoped to one
   analysis run (the caches already are) and keyed on everything that varies
   — `viaReexport` changes what `findExportedDecl` accepts, so it belongs in
   the key. Get that wrong and you resurrect exactly the shadowing bug round
   7 fixed.

**Tests.** Keep the B-7 pin; add an assertion that the memo is actually hit
(count parses via a spy or a counter on the cache) so a future refactor that
silently disables it is caught. Re-run the full suite: the analysis path is
the most cross-cut code in the repo.

---

## Standing rules for this engagement (unchanged)

- **Failing test first** for every behaviour change; the control that proves
  the new test *can* fail is part of the work.
- **Emitted artefacts are verified by EXECUTING them**, never by parsing
  them. Round 7's own RSC fix shipped a scoping bug that only running the
  spec caught.
- **Gates before every merge**: `bun test`, `bunx tsc --noEmit`,
  `bunx biome ci .` (repo-wide — it is stricter than lint-staged).
- **Two-lens adversarial review after the diff is committed**: a read-only
  correctness lens, and mutation probes in an isolated worktree (symlink
  `node_modules`; **commit before probing**). A probe that stays green is a
  coverage gap, not a pass.
- One branch + PR per item into main; mesh-repo-sync after each merge
  (`cachyos-mini-mobile` unreachable is normal).
- Closures per item: repo docs, the website
  (`~/Projects/static-websites/flawless-react-website`), skills in
  `.claude/skills/` **and** the copies in `~/.claude/skills/`, the backlog
  strike, a readiness rescore only if a dimension actually moved, a KB
  learnings file in
  `~/Projects/personal/agents/hermes/flawless-react-agent/knowledge/learnings/`
  re-ingested with `python3 deploy/ingest_kb.py flawless-react-agent`, and
  the `flawless-react-waves` memory.

## Gotchas these rounds paid for

- **A dead verifier is not a refutation.** Round 7's review workflow lost its
  verification fan-out to a spend limit and labelled every unverified finding
  "refuted — verifier died". Re-verify by hand; record what you could not
  reproduce as *unverified*, never as clean.
- zsh aborts the whole command line when **any** glob has no match — a
  cleanup `rm -rf /tmp/a-* /tmp/b-*` deletes nothing if `b-*` is empty. Use
  `find`.
- Apply source mutations with a python script asserting `count == 1`; never
  trust an unverified in-place edit.
- The dogfood app's `:3001` is a long-lived crust-procs supervisor under
  systemd-user with `restart: true` — **never kill it**. Run the load layer's
  prod build on `:3005` per the kept `.env.load`, refreshing its session
  value from `flawless/e2e/.auth.json` after the e2e run.
- Ledger ids continue at **FR-041**; the round-7 ledger is
  `docs/reviews/2026-08-r7-findings.json` and carries a
  `reportedNotReproduced` list worth re-checking with a proper probe.
