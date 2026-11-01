# Exploration: make flawless-react crust-shaped

> Prompt file. Hand this whole document to a fresh session. It is self-contained: everything you need
> to start is either here or named in it.
>
> Companion document: `DOGFOOD-0.3.1-FIX-PLAN.md` (same directory) — the nine defects as ten
> implementation chunks. This exploration is what sits *above* those chunks: not how to fix the nine
> defects, but what the product should become so that fewer of this class can exist.

You are doing a **read-only design exploration**. Do not implement, do not open PRs, do not modify
either repo. Scratch work goes in `/tmp/opencode/`. The deliverable is one document (below).

## The bar we are holding the product to

> Keep it. Hold it to **"zero glue, zero unexplained red"**, and make it more **crust-shaped** in
> feel — verdicts with receipts, minimal residue. And they compose: the load pipes it generates
> *are* crust pipes.

Three principles to design against:

1. **Zero glue** — a generated suite must be committable and green in a linted, type-checked repo
   without the user hand-patching their own config first.
2. **Zero unexplained red** — every failing generated spec must carry its cause and its receipt, or
   become a named skip that is counted. A red the user cannot interpret is worse than no test,
   because it trains them to ignore the suite.
3. **Minimal residue / verdicts with receipts** — crust's shape: point at a running system, get a
   verdict backed by artifacts, leave nothing behind to maintain. flawless-react writes ~350 files
   into the repo that the user then owns forever.

## Evidence you must read first (do not take my word for any of it)

- `~/Projects/personal/flawless-react/DOGFOOD-0.3.1-FIX-PLAN.md` — the nine defects as ten
  implementation chunks, with measured output and file/line anchors.
- `~/FLAWLESS-DOGFOOD-31-oct.md` — the full dogfood report: what ran, what passed, what was wrong in
  my own first reading.
- `~/Projects/personal/mybodycorpai`, branch `test/dogfood-2026-10` — the real target: commits
  `289cec6` (wipe), `0db32f5`, `0e0a2f4`, `c00697f` (web suite + the four glue edits), `586c766`,
  `903e7ab`. Read `apps/web/flawless/REPORT.md` and the glue diffs — they are the residue cost,
  stated exactly.
- The previous generation's own accounting: `git show 644473a` in that repo (old run: 79 web unit
  failures, 926 perf-static findings, "five tsconfig/lint contract gaps" as repo workarounds).
- `~/Projects/personal/crust` (or wherever crust lives — find it) — read how crust actually works:
  pipes, `test-pipes`, `expect`/`stats`/`assert`, the `--out` stats artifacts, baseline gating, and
  how a pipe failure prints a verdict with evidence. This is the aesthetic we are borrowing, and
  flawless-react already emits crust pipes for the load plane.

Measured numbers worth keeping in view: web unit 392 pass / 30 fail / 50 skip; browser 145 / 0 / 11;
perf 166 / 1 / 193; e2e 39 / 0; load 10 / 0; native units 122 / 23 / 0; mobile e2e 45 / 23 (all
CORS). 344 committed suite files + 119 colocated specs + 4 hand-written glue edits.

## Questions to answer

**A. Residue.** What are the realistic alternatives to "commit 344 generated files"? Explore at
least: (a) status quo; (b) committed specs + ephemeral harness (what is the minimum committable
set?); (c) fully on-demand generation with a lockfile/manifest and nothing committed; (d) a hybrid
where only the human write-once layers are committed. For each: what is reviewable in a PR, what runs
in CI, what breaks when two people generate on different machines, and what it costs an agent in
tokens per run. Be concrete about which of today's 344 files fall in which bucket.

**B. Verdicts with receipts.** Crust returns a verdict backed by artifacts. What would that look like
layered over a generated vitest/playwright/jest suite — a `flawless verdict` surface that runs the
planes and emits one machine-readable document with per-finding evidence (trace, heap snapshot, diff,
the mock that produced the shape)? What already exists in `src/reporters/` and `REPORT.md` to build
on, and what is missing? Should the MCP tools return verdicts instead of generation results?

**C. Zero unexplained red.** Design the contract. Every generated spec must either pass, or fail with
a cause the tool itself asserts (which mock, which unresolved shape, which missing capability), or skip
with a named reason that is counted in the report. What does the generator have to know — and
therefore measure — to honour that? Where does the current `TODO(flawless)` / `catch { return; }`
culture have to die? Note that the 30 remaining reds are one mechanism (`resolveAsyncUi` never awaits
promise-valued props/children, so the tree suspends under `createRoot` and commits nothing) — use it
as the test case for "can the tool have known this and said so?".

**D. Zero glue.** Chunks 1, 2, 8 and 9 of the fix plan are glue. Explore whether there is a design
that makes them unnecessary rather than merely automated — e.g. a suite that is outside the host's
tsconfig/lint program by construction instead of by exclusion. Is there a layout where the host's
`next build` / `tsc` / biome can never see generated code, and what does that cost?

**E. Composition with crust.** The load plane already emits crust pipes. Where else does crust
substitute for bespoke machinery (contract checks against the OpenAPI spec, link/asset checks,
evidence storage, baseline gating)? Should flawless-react stop owning anything crust already does,
and what would the seam look like — who owns ids, auth, baselines, and the evidence directory?

**F. Open factual question.** The old run emitted 183 colocated web specs, 0.3.1 emitted 119 against
the same tree. Determine whether that is lost coverage or better scoping. Do not assume either.

## Constraints

- No new dependencies, no rewrite, no framework change. Proposals must be incremental on 0.3.1.
- Do not propose "delete the generated suite and just run agents on demand" without answering what
  makes CI deterministic and PRs reviewable.
- Do not propose anything that makes the first-run experience worse.
- Every claim about current behaviour must cite a file you read or a command you ran. Numbers in your
  document must be numbers you measured or quoted from the evidence above.

## Deliverable

Write `~/Projects/personal/flawless-react/VERDICT-SHAPE-EXPLORATION.md`:

1. **Where we actually are** — residue count, glue count, red count, with receipts. Short.
2. **Three or four competing designs** for the target product shape, each with: what gets committed,
   what CI runs, what a PR diff looks like, what an agent pays per run, and the failure mode.
3. **Recommendation** — one design, and why it beats the others on the three principles.
4. **What we would stop doing** — explicit list of current product surface to remove or fold into
   crust. This section is mandatory; a plan that only adds is not a strategy.
5. **Migration from 0.3.1** — ordered steps, each independently shippable, and which of the ten
   fix-plan chunks each step makes moot (versus still required).
6. **Open questions** you could not answer without more measurement, with the measurement named.

Cap it at ~600 lines. Prefer tables and receipts to prose. Where you disagree with the framing in
"The bar", say so directly and defend the alternative — this is an exploration, not an agreement.
