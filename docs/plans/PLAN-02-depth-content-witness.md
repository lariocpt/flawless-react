# D2 — the loaded content witness on the DOM plane

## Scope

`src/scaffold-tests/templates.ts` (`emitFetchTests`, `emitStateTests`'s RSC sibling,
`emitFormTest`'s action branch), `src/scaffold-tests/mocks.ts` (fixture reuse, no shape
change), `src/analyse/extractPropUsage.ts` (read-only consumer), the RSC spec path, and
`tests/fetchContentExecution.test.ts` (new). No new task, flag, or plane.

## Premise

Four `TODO(flawless)` markers are the shallowest four lines the tool emits, and they are
all in one function. `emitFetchTests` (`src/scaffold-tests/templates.ts:2157-2236`)
stands up four real MSW scenarios — success, delayed, 500, empty payload — and asserts
only `expect(calls).toBeGreaterThan(0)` in each, then writes:

- `:2204` `TODO(flawless): assert rendered content derived from FIXTURE.`
- `:2213` `TODO(flawless): assert the loading indicator while the response is pending.`
- `:2222` `TODO(flawless): assert the error-state UI.`
- `:2231` `TODO(flawless): assert the empty-state copy.`

The fixture is already a concrete object with sentinel strings in it
(`mockLiteral` emits `flawless-<seed>` for every unresolved string field,
`src/scaffold-tests/mockValues.ts:36`, `:121`, `:159`). So the tool knows what the
server will answer and refuses to look at what the component does with it.

**The native plane already solved this, and its solution is the design.**
`nativeTemplates.ts` builds `renderedFields` from `propUsage` `jsx-child` members across
the component tree (`:80-95`), then `displayWitness` (`:1338-1361`) picks a fixture string
that (a) starts with the `flawless-` sentinel and (b) sits under a field name the component
provably renders as text — real evidence, with the failure mode documented at `:80-84`:
*"The first cut picked the witness from a hand-written list of display-ish key names, and
16 of 31 loaded-state tests asserted a field the row does not render."* The result is the
native loaded-state test (`:1382-1450`), which asserts `getAllByText("flawless-…")`.

## What it ships

1. **`contentWitness(fixture, renderedFields)` in the DOM emitter** — the ported rule,
   same two conditions, same refusal when no field qualifies (the refusal is a named
   `TODO`, not a silent drop). `renderedFields` comes from `extractPropUsage`'s
   `jsx-child` members, which the DOM plane already computes for DEFAULTS
   (`src/scaffold-tests/registry.ts:198`, `:333`).
2. **Loaded test becomes real**: the success scenario asserts the witness text appears
   (T3). When no witness qualifies it keeps today's call-count assertion plus the named
   TODO — no regression, no fake.
3. **Empty-state test becomes real where the copy is known**: `extractStaticText` already
   harvests conditional text; when the empty branch's copy is a literal the empty-payload
   scenario asserts it appears and the witness disappears (T2/T3). Where the empty branch
   has no harvested copy, the TODO stays.
4. **Server-action results**: `serverActionMock` already returns the derived literal
   (`src/scaffold-tests/mocks.ts:657-664`, `JSON.stringify(v)`), so after the action
   fires, the same witness rule asserts the result's rendered text instead of only
   `toHaveBeenCalled()` (T3). Only when the action's return literal is resolved — the
   existing `server-action-stub` TODO (`:685`) gates it.
5. **RSC loaded content**: the same witness in `rscSpec`'s data path
   (`templates.ts:2703-2720` currently asserts `container.innerHTML.length > 0`, which
   is T0).
6. **The branch-stability rule carries over verbatim.** The native emitter's warning
   (`nativeTemplates.ts:1278-1285`) is the constraint: a fixture rich enough to carry a
   witness must not change *which branch renders* — "a one-row fixture put three of the
   dogfood app's screens into exactly that mismatch". The DOM port uses the same
   richest-fixture-that-does-not-flip-the-branch selection, and when the two goals
   conflict it prefers branch stability and keeps the TODO.

Out of scope here: the loading indicator and the error-state UI (`:2213`, `:2222`). Those
need to know *which copy is keyed on `isPending`/error*, which is a new derivation and
belongs to D3. This step leaves both TODOs in place, unchanged, and says so.

## Acceptance (measured on the merge commit)

1. `tests/fetchContentExecution.test.ts` generates a fixture app with four components:
   text-rendering fetch, list-rendering fetch, server-action form, RSC page. Each spec is
   green with a witness assertion present, and **red** under its named mutation: rename the
   rendered field in the component, or change the fixture field the witness reads. The
   mutation set is the one the native plane already uses for its loaded-state tests.
2. The four DOM TODO kinds shrink on the pinned tree (`c00697f`): the `REPORT.md` TODO
   table shows `assert rendered content derived from FIXTURE.` and
   `assert the empty-state copy.` counts drop by a stated number, and the drop equals the
   number of specs that gained a witness assertion — one census, two views.
3. Zero witness assertions on fields the component does not render: for every emitted
   witness on the pinned tree, the field name appears in that component's `propUsage`
   `jsx-child` members. This is checked by a script over the emitted suite and its count
   is in the receipts (the native plane's "16 of 31" failure is the thing being refused).
4. Census: T3 count goes from 0 (today: no DOM T3 assertion exists) to a stated number;
   T0 drops correspondingly. Falsifier rate rises by at least the number of new witness
   tests that their mutations catch.
5. No spec got slower than a stated budget: the witness adds no new mount, so the emitted
   unit suite's runtime on the pinned tree is within +10 % of the control binary's.

## Gates

Plan-level criteria 1–4 plus track D's census criterion. Criterion 3's regen probe must
show the witness assertions as byte-stable between the two runs — a witness chosen by
`Object.entries` order would not be, so the selection must be deterministic and sorted.

## Moot vs required

- Moot: inventing display-field heuristics that are not backed by `propUsage` (the
  documented 16-of-31 mistake); asserting a witness for a field the component only logs.
- Required: the witness rule, the four surfaces (fetch success, empty payload, server
  action, RSC), the branch-stability rule, and the named refusal when no witness exists.

## Dependencies

D0 (ruler, baseline). D1 item 3 widens which specs have fetch tests at all; D2 deepens
them — either order works, D1 first is cheaper. D3 takes the two remaining TODOs.

## Receipts

**D2a (chunk 8) — items 1, 2 shipped; item 6 PARTIAL (the remaining
surfaces ship with items 3–5, chunk 9).** Branch
`feat/d2a-content-witness` off `main` @ `2c283f7` (the D1-closure merge,
PR #172). Commits: `095e8a8` (ruler), `7022f2b` (witness port),
`d72b30c` (wiring), `3ffcab0` (execution test), `cc6bbbd` (depth-surface P8
restructure + pin flip), `a6827df` (depth-surface census re-pin), and this
receipt. Measurement: control = `main` @ `2c283f7` binary, treatment =
branch tip `a6827df` binary, both `bun build --compile --minify` per *Measure
with the newest code*; pinned tree mybodycorpai @ `c00697f` on three fresh
worktrees (control, treatment, and a second treatment for the two-regen
identity check), seven-plane regen each, census per worktree.

### Binary lineage — proven byte-exact in both directions

`bun build --compile` (bun 1.4.3) is deterministic per (tree, outfile name)
but not across names: the binary embeds its own outfile path in its bunfs
root, so two builds of one tree under two names differ only in those
embedded-name bytes (measured: 741 differing bytes between two same-tree
builds under names of differing length). Two name-matched rebuilds close the
lineage exactly:

- **Control** `fl-bintest-2c283f7` (sha256 `32d14965a788fe1a1752d65894d6a8bdc55de2abf56a404e28a1f9dced85deee`)
  built from `main` @ `2c283f7`. The same tree built under the D1c binary's
  name (`fl-bintest-df865c7`) reproduced the recorded end-of-D1 sha256
  `89ff0e5713b0ee49c05dd3ad4846f429ecdf35b8b7ce42baf373b6e57f2ed28d`
  byte-for-byte — the control is the end-of-D1 measurement itself, and the
  merge's `src/` is provably the D1c tip's `src/` (the merge diff is
  docs/tests only).
- **Treatment** `fl-bintest-a6827df` (sha256 `a1e418b55d031d364e5e21279a76f70011fc69dcba5d698d39aab65c30045d06`)
  built from the branch tip. The same tree built under `fl-bintest-cc6bbbd`
  reproduced the recorded depth-surface re-pin sha256
  `fd2642eff11f677b340ce255b60f7ade52c74e04883471667658e2c5b28c2cdb`
  byte-for-byte — `src/` is unchanged since `d72b30c` (commits 4–6 touch
  tests/docs/fixtures only), exactly as the lineage rule requires.

### Item 1 — `contentWitness(fixture, renderedFields)` in the DOM emitter — SHIPPED

The native `displayWitness` rule ported to `templates.ts` (commit `7022f2b`):
the same two conditions — (a) the fixture value starts with the `flawless-`
sentinel, (b) the field name sits under a rendered field (the component
subtree's `propUsage` `jsx-child` members) — and the same refusal when no
candidate qualifies (the named TODO stays; a silent drop is not an option).
Candidate selection is a documented total order (depth asc → key asc → path
asc, plain codepoint comparison, never locale) so the choice is stable
across `Object.entries` order — the PLAN-02 Gates criterion 3 (byte-stable
between two runs) holds by construction and was then measured (below). Bare
array-string fixture values are refused: a value with no owning field name
cannot satisfy condition (b), and falling back to a display-ish key list is
the documented 16-of-31 mistake this plan exists to stop — the fallback is
refused with a comment citing the Moot list and acceptance 3. 17 guard tests
(`tests/contentWitness.test.ts`), including the total-order and refusal
guards.

### Item 2 — the success scenario asserts the witness — SHIPPED

`emitFetchTests` (commit `d72b30c`) threads a `renderedFields` set built in
`renderUnitBrowser` right after `flattenTrees` (the DOM plane already
computes `propUsage` there for DEFAULTS), through `renderUnitFile` →
`unitSpec` → `emitFetchTests` in the native emitter's parameter order. In
the success scenario the witness, when it exists, REPLACES the named TODO
`assert rendered content derived from FIXTURE.` with a
`expect(screen.getAllByText(<sentinel>, { exact: false }).length).toBeGreaterThan(0)`
assertion plus a self-documenting comment block naming the field and the
`propUsage` jsx-child evidence. The other three scenario TODOs (delayed, 500,
empty) are untouched — not even reordered. `getAllByText` is synchronous here
because the success handler resolves the fixture before the assertion runs
(the call-count `waitFor` above it has already settled the response).
`apiRouteFixture` returns the stored OpenAPI example verbatim, so the
witness value is the fixture's value at the selected path — no mock-literal
sentinels are invented, and the emission on the existing corpus is
byte-unchanged where no witness qualifies (the suite count was invariant
through the wiring commit).

**Falsifier** (`tests/fetchContentExecution.test.ts`, commit `3ffcab0`): a
generated fixture app with TWO fetch components — `Greeting` (text-rendering:
the parent fetches `/api/items` into `data`, the child renders
`{data.greeting}`) and `Row` (list-rendering: the parent fetches `/api/rows`,
`RowList` maps, the grandchild renders `{row.label}`) — each spec green with
its witness present, then red under each named mutation (rename the rendered
field in the component; separately, change the fixture field the witness
reads), then green again on revert, with no regeneration between green and
red. Red output carries exactly one failing-test line; the parser counts
only `×`/`✗` list lines and deliberately excludes the repeated ` FAIL `
section and the `Ignored nodes:` lines (a wider class counted 3 where the
truth is 1 — the bug and the fix are commented in the test).

**Pinned-tree movement: none — measured, and that is the named finding.**
The pinned tree's only two bare-fetch components are `NotificationsBell`
(POST `/api/me/notifications/read-all`) and `AshaRail` (GET + POST the
conversation endpoints), and both render their fetched data from loop
variables over local state — `propUsage` `jsx-child` records no field name
for either, so `renderedFields` is empty for both and `contentWitness`
refuses. The measurement, on fresh `c00697f` worktrees (below): the
treatment's seven-plane suite is byte-identical to the control's — zero
witness assertions emitted, the FIXTURE-TODO count is 3 → 3 (drop 0, equal
to the 0 specs that gained a witness), and the census is byte-identical to
the recorded end-of-D1 census. Per the acceptance rule a step whose pinned
census does not move ships as a report-only census change; the depth witness
for items 1–2 is the green→red execution falsifier, which proves the claim
is real and falsifiable on a shape the pinned app does not contain. The
non-vacuous T3 crossing the plan's item 4 asks for is pinned on the depth
surface instead: `depthapp` P8 crosses T1→T3 (re-pinned at `cc6bbbd`,
census re-pinned at `a6827df` — `docs/plans/baselines/depth-surface.json`).

**Acceptance 3, pinned-tree view:** for every witness emitted on the pinned
tree the field name appears in that component's `propUsage` `jsx-child`
members — 0 witnesses emitted, so 0 of 0 to check (vacuously met). The rule
enforces this non-vacuously by construction (candidates come only from the
jsx-child set) and the falsifier proves the mutation side on the fixture.
**Acceptance 5:** the emitted unit suites are byte-identical between control
and treatment, so their runtimes are identical by construction (0% ≤ +10%) —
no separate measurement is possible or needed. **Acceptance 1's four-component
set** ships across this chunk and chunk 9: the two fetch components above,
and the server-action and RSC components with items 4–5.

### The pinned-tree measurement (fresh worktrees, `c00697f`, 2026-11-13)

Three fresh worktrees of mybodycorpai @ `c00697f`
(`/tmp/opencode/mbc-d2a-final-{control,treatment,treatment2}`), each
regenerated with its side's binary
(`perf-harness,unit-browser,perf-static,a11y,react-rules,e2e,load`), each
censused with its own tree's `scripts/depth-census.ts` (the script imports
the classifier from `src/`, so the protocol runs each side's own tree):

- **Census:** all three census JSONs are byte-identical, sha256
  `318d5ec9889025b0cc9288f73f2e97888917df090ad4cf18c3b410f086e882b4` — the
  exact sha recorded for the end-of-D1 census
  (`depth-d1-df865c7.json`). Headline: **191 specs, T0 100 / T1 44 / T2 43 /
  T3 0** (testsClassified 437, unclaimed 23, skipped 84, all-skipped 4);
  crossCheck 119 specs (T0 28 / T1 45 / T2 42 / T3 0). Versus the end-of-D1
  line: **zero movement — T3 0→0 and the T0 drop is 0**, the named finding
  above. The three `c00697f` baseline files stay byte-identical: this is an
  additional reading, not a re-pin.
- **Seven-plane suite:** byte-identical between control↔treatment and
  treatment↔treatment2 after normalising the worktree path prefix. The only
  raw difference between worktrees is the VERDICT `targetHash` (7 lines in
  `VERDICT.json` + 7 in `VERDICT.md` per pair), which by design
  (`verdict.ts:43`) hashes each analysed file's ABSOLUTE path with its
  bytes — a per-location staleness key, not a content claim. Recomputed over
  the same 99-file analysed set with the path prefix normalised, all three
  worktrees hash to `sha256:02bee3c323bf6720`, and the as-is recomputation
  reproduces the control's recorded VERDICT hash
  (`sha256:5ecb956622b2e24c`) exactly: the analysed source bytes are
  identical across all three worktrees, and every emitted file is
  byte-identical. Each worktree's `git status` shows 158 modified files, all
  under `apps/web/flawless/` plus the one merged `package.json`; no
  `src/**` file is touched.
- **Witness-line identity between the two treatment regens:** there are zero
  witness lines (no `getAllByText("flawless-…")` assertion in any of the
  three suites) and the suites are byte-identical, so the Gates criterion 3
  byte-stability holds trivially and strictly — the total-order selection is
  what would have made it non-trivial, and its guards are in
  `tests/contentWitness.test.ts`.
- **The REPORT.md TODO table** (`Hand-work remaining`, counted for
  `unit-browser` and `e2e`) is identical in all three worktrees:
  `compound-root-wrap` 8, `other` 35, `server-action-stub` 47,
  `unaddressable-target` 15, `uninferred-return-shape` 30 — **total 135 →
  135** (≤ pre-step, per the acceptance walk; D1c's 143→135 was the
  previous drop). Per-wording over the emitted out-dir suite, identical in
  all three: `assert rendered content derived from FIXTURE.` **3 → 3**
  (`AshaRail.test.tsx` ×2 for its GET and POST fetches,
  `NotificationsBell.test.tsx` ×1) — **drop 0 = 0 specs gaining a witness**;
  `assert the empty-state copy.` **3 → 3** (must-not-move, met); `assert the
  loading indicator…` 3 → 3 and `assert the error-state UI.` 3 → 3,
  byte-identical (the suites are byte-identical). `TODO(flawless)` markers
  present in the out-dir text: **132 → 132** (the REPORT.md 135 is the
  emission-site count, a different view; neither moves).

### Item 6 — branch stability — PARTIAL

For the success scenario the rule holds vacuously: the test declares the
loaded branch (its own handler returns the FIXTURE), so no richer fixture
can flip a branch that the test itself pins. The full rule — the
richest-fixture-that-does-not-flip-the-branch selection and the explicit
preference for branch stability over the witness when the two goals
conflict — ships with items 3–5 (chunk 9), when the empty-payload,
server-action and RSC surfaces gain witnesses.

**Status: items 1, 2 SHIPPED (execution-falsified; report-only on the pinned
census, the measured reason named above); item 6 PARTIAL; the four
surfaces' remaining three and the plan's four-component execution set ship
in chunk 9.**
