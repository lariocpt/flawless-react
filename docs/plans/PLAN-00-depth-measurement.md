# D0 — depth measurement: the ruler before the cut

## Why this exists before any depth work

The v0.3.3 evaluation's "broad and shallow" verdict is a reading, not a measurement, and
every step after this one will want to say it made the suite deeper. Without a ruler
that claim is unfalsifiable — and the repo's own rule is that an unmeasured number is a
false claim (`AGENTS.md`, *Land it*: "A number nobody measured is a false claim in
permanent record"). D0 builds the two instruments the rest of track D is measured with,
and pins their first reading.

## Scope

- `src/reporters/depth.ts` (new): a pure classifier that reads an **emitted spec file**
  and returns the strongest assertion tier it contains, per test, plus the counts.
- `src/reporters/report.ts`, `src/reporters/verdict.ts`: one depth block in `REPORT.md`
  and one column-set in `VERDICT.json`/`VERDICT.md`, fed by the classifier.
- `src/scaffold-tests/templates.ts`, `nativeTemplates.ts`: **nothing behavioural** — only
  the tier tag on the assertion emitters, if the classifier needs a marker to be
  unambiguous (preferred: none; the classifier reads emitted text, so the emitted suite
  stays the source of truth and cannot lie about itself).
- `scripts/depth-probe.ts` (new, maintainer tooling): the mutation probe.
- `scripts/depth-census.ts` (new, maintainer tooling): the census over an emitted suite —
  the out-dir planes (`flawless/unit|browser|native`) are the headline; a committed
  colocated copy (`*.flawless.test.ts(x)` outside the out dir) is classified separately
  as a cross-check and excluded from the headline denominator. Added by D0a as the
  reproducible surface for the pinned baseline; declared here so the subfile's scope
  matches the shipped tree.
- `docs/plans/baselines/` (new): the pinned baseline readings, committed.
- `tests/depthCensus.test.ts`, `tests/depthProbe.test.ts` (new).

Nothing in `src/analyse/` moves. The classifier is a reporter, not an analyser.

## The tier table (normative)

Tier of a **test**, strongest assertion wins; tier of a **spec** is the strongest over
its tests; the census is the distribution over specs.

| Tier | Emitted shape (what the classifier greps for) | Why this tier |
| --- | --- | --- |
| T0 | `not.toThrow()`, `innerHTML.length > 0`, `toJSON()).not.toBeNull()`, `toBeTruthy()` on a locator, `expect(calls).toBeGreaterThan(0)` with nothing after it | True of nearly any component; falsifies almost nothing |
| T1 | `querySelector("<tag>")`, `getAllByText`/`getByText` on a literal, `toHaveValue` after a fill, `getAllByText(<CHILD_TEXT>)`, `.flawless-cls`, variant `outerHTML` comparison | Falsified by markup/copy changes |
| T2 | `expect(handlers.onX).toHaveBeenCalled()`, `vi.mocked(...).toHaveBeenCalled()`, `routerMock.push` assertions, `rejects.toThrow(/notFound/)`, inversion legs' presence/absence pairs, `toBeDisabled()`, `getPathname()).toBe(` | Falsified by behaviour changes, not markup |
| T3 | `toHaveBeenCalledWith(...)`, `getAllByText(<fixture value>)`, `toHaveBeenCalledTimes(n)` where n > 1 derived from a call site, call-count **deltas** between two legs — a delta keyed on a flipped input and carrying a distinguishing marker, which nothing emitted today does (see the note below), `toHaveDisplayValue` after a state transition | Falsified by data-flow changes |

Note on the call-count row (amended 2026-11-05 against the emitted suite, D0b): the only
call-count shape the emitter produces today is the predicate-inversion counter —
`src/scaffold-tests/templates.ts:3005-3010` emits `const nXb = vi.mocked(f).mock.calls.length;`
before the flip and `expect(vi.mocked(f).mock.calls.length).toBe(nXb)` /
`.toBeGreaterThan(nXf)` after it (present in the pinned suite at
`flawless/unit/FinancePage.test.tsx:347-349`). That is a **single-leg count** against a
counter captured in the same test, not a delta between two legs: the number asserted is
the same variable the test itself sampled, nothing keys it on the flipped input, and no
marker distinguishes it as a data-flow claim. A T3 call-count claim therefore requires an
emitted shape whose asserted number is the **difference between two legs keyed on a
flipped input, with a distinguishing marker** — until such a shape is emitted, every
call-count assertion classifies T2. The conservative reading won because the classifier's
contract is asymmetric: it may under-read (an unknown shape lands low until this table
grows) and must never over-read — a census that inflates a tier is a census that lies.

Two rules the classifier must enforce, because they are where a census can lie:

- A test whose only assertion is a `TODO(flawless)` marker plus a vacuous tail (the
  `waitFor(() => expect(document.body).toBeTruthy())` filler at
  `src/scaffold-tests/templates.ts:2100-2102`) is **T0 and counted as unclaimed**, not
  silently T1.
- A `test.skip` is not a tier. Skips are already counted by reason (`verdict.ts`'s
  `skipReasons`); the census counts what actually runs.

## What it ships

1. `depth.ts`: `classifySpec(source: string): { tier: Tier; perTest: ... }` and
   `census(specs): DepthCensus`. Pure, no I/O, so it is testable without a host app.
2. `REPORT.md` gains a **Depth** section: tier distribution, the count of specs whose
   strongest tier is T0, and the pointer "T0 means mount-only; a mount-only spec is not
   a failure, it is the floor this tool guarantees and no more".
3. `VERDICT.json` gains `depth: { T0, T1, T2, T3, specs }` per (task, target-hash) —
   generation-measured, same contract as every other verdict field: absent means
   unmeasured, never zero (`src/reporters/verdict.ts:23-27`).
4. `scripts/depth-probe.ts`: for a target app and a **named mutation table**, generate
   the suite, run the app's own vitest, and report per mutation which specs went red.
   Mutations are mechanical and committed as a table (file, exact old string, new
   string, the tier that *should* catch it): swap a ternary branch, invert a predicate,
   rename a rendered field, change a payload key, drop a `setText` argument.
   Output: `falsifier rate = red specs / mutations`, plus the list of mutations nothing
   caught — the honest part.
5. `docs/plans/baselines/depth-<target>-<sha>.json`: the pinned census + falsifier
   reading, committed, so D1–D4 diff against a file rather than a memory.

## Acceptance (measured on the merge commit)

1. Classifier self-proof (`tests/depthCensus.test.ts`): a synthetic spec per tier is
   classified at exactly its tier, and **guard-the-guard cases** — a T2 spec with its
   spy assertion deleted reads T0; a T1 spec whose text assertion is replaced by a
   `toBeTruthy()` reads T0. Minimum 8 cases, all four tiers plus the two lying-shape
   rules above.
2. Census on the pinned dogfood tree (`mybodycorpai @ c00697f`, `apps/web`) produces a
   distribution over the emitted specs with **zero unclassified spec files**, and the
   T0 count is reported. Committed as the baseline JSON.
3. Falsifier probe runs end-to-end on the pinned tree and reports a rate plus the
   caught/missed table; the missed list is non-empty and is quoted in this subfile's
   receipts — a probe that catches everything is measuring the wrong mutations.
4. `REPORT.md`/`VERDICT.md` on that run show the depth block, and the block's totals
   equal the census totals (one census, two views — the same discipline as
   `verdict.ts`'s skip/reason agreement).
5. Two consecutive runs on the unchanged tree: the depth block is byte-stable (it joins
   the existing byte-stability property M1 established).

## Gates

Plan-level criteria 1–4. D0-specific: criterion 3's idempotence probe must show the new
depth fields as part of the byte-stable verdict, and the mutation probe must be run with
a binary built from the merge commit, not a staged one.

## Moot vs required

- Moot: any depth claim made in prose without the census behind it — including the
  "~65 % line coverage" figure from the evaluation, which is a coverage number, not a
  depth number, and is retired by this step.
- Required: the tier table as normative text, the classifier, the two report surfaces,
  the mutation probe, the committed baseline.

## Dependencies

None — first in track D. D1–D4 cannot be accepted without it. Independent of tracks S
and C, except that S3 (runtime truth) will want the census to be a verdict field
already, which is why the census lands here and not in a report-only form.

## Receipts

Measured 2026-11-05 on branch tip `0e6bb75` with `/tmp/opencode/fl-bintest-0e6bb75`
(sha256 `c4727c7117adad7ec60c2ed0086c3508e7ce81e9ab87251894255e7f26194d45`,
`bun build --compile --minify` from that exact tree), on the fresh worktree
`/tmp/opencode/mbc-c00697f-d0` (`git worktree add … c00697f` in the pinned
`mybodycorpai` repo), command run from `apps/web`:
`fl-bintest-0e6bb75 'src/**/*.tsx' --nextjs --api openapi.json --report --tasks perf-harness,unit-browser,perf-static,a11y,react-rules,e2e,load`.

2. Census over the emitted suite (`cd /tmp/opencode/mbc-c00697f-d0/apps/web && bun run <repo>/scripts/depth-census.ts .`): distribution over **310** spec files — T0 **128** / T1 **90** / T2 **84** / T3 **0**; per plane: unit-colocated 28/45/42/0, unit (out-dir) 28/45/42/0, browser 72/0/0/0. Decisive lines: `specs unclassified:      0` and `specs strongest T0:      128`; also `tests classified: 720`, `tests unclaimed: 46`, `tests skipped: 110`, `specs all-skipped: 8`. T3 == 0 on the DOM plane, as expected — no DOM T3 assertion is emitted today. Committed as `docs/plans/baselines/depth-c00697f.json` (binary hash, tree hash `c00697f`, command and date inside).

1. _Not yet measured — later D0 chunk._
3. _Not yet measured — later D0 chunk._
4. _Not yet measured — later D0 chunk._
5. _Not yet measured — later D0 chunk._
