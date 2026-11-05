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

_None yet._
