# D1 — depth the analyser already knows and the emitter drops

## Scope

`src/scaffold-tests/templates.ts` (the emitter sites of items 1–6, plus item 7's
host-attribute site), `src/scaffold-tests/postDispatch.ts` (one rung),
`src/scaffold-tests/selectors.ts` (the locator rung, item 7's bound), the matching
execution tests, and this subfile. No new extractor, no new task, no new flag — item
7's salvage emits only what `collectHints` already carried. `src/analyse/extractChildAttrs.ts`
was the retired item 7's planned wiring (one field); it is touched by no D1 commit,
and the halves that stay dead are recorded below with the lines that keep them dead.

## Premise

The v0.3.3 evaluation said the suite is broad and shallow. Reading the emitter against
the analyser says something more useful: **a measurable part of the shallowness is not
missing analysis — it is analysis that already runs and is thrown away.** Each item
below is a fact the tool already derives, the exact line where the emitter refuses it,
and the assertion that refusal is standing in the way of. Every one of them is a
T1-or-better assertion whose only cost is wiring.

## What it ships

### 1. A provably disabled control asserts `toBeDisabled()` on the unit plane

`extractInteractions` reduces the `disabled` expression and records
`hints.disabled === "always"`. The browser plane already uses it —
`templates.ts:3575-3581` emits `await expect(<locator>).toBeDisabled()` with the comment
*"that it is disabled is the thing the source actually says, so assert that instead"*.
The unit plane does not: `postDispatch.ts:104-107` returns
`{ kind: "skip", reason: "disabled-control" }` for **any** `disabled !== undefined`,
including the provably-always case, so the same fact produces a skip in vitest and an
assertion in playwright.

Ship: when `hints.disabled === "always"` and a locator is derivable, emit
`expect(<el>).toBeDisabled()` (T2) instead of the skip. `"conditional"` keeps skipping —
an expression that did not reduce is not permission to assert anything.

### 2. Initial state that flows to an attribute asserts the attribute

`extractState` already records `flowsToJsx: { via: "attr", attr: "placeholder" }`
(`src/analyse/extractState.ts:330-340`, type at `src/types.ts:403-408`). `initialWitness`
accepts only `via === "child"` with a string ≥ 2 chars (`templates.ts:2111-2115`), so a
`useState("Search…")` rendered into `placeholder` is silently unasserted while the same
value in a child is asserted.

Ship: `expect(<el>).toHaveAttribute("<attr>", "<initial>")` (T1). `via: "condition"`
stays out — that is D3's subject, not this one.

### 3. Event-triggered fetches get the fetch tests effect-fetches get

`templates.ts:1801` filters to `const effectFetches = (info.fetchCalls ?? []).filter((f)
=> f.inEffect)`, so a `fetch` fired from an `onClick` gets nothing, even though
`extractFetchCalls` records it (`src/analyse/extractFetchCalls.ts:27`) and the fetch
emitter already receives a click trigger (`firstClickTrigger(info)`,
`templates.ts:1804`).

Ship: drop the filter, drive the handler that reaches the call using the same
`postDispatch` ladder the click tests use, and keep the current call-count assertion
(`calls > 0`, T2). The content assertions stay `TODO(flawless)` until D2 — this item
widens coverage of the *existing* four tests, it does not deepen them.

### 4. Predicate inversion on the client plane, prop-keyed

`extractPredicates` runs for every component (`src/analyse/index.ts:470`) and produces
certified `predicateInversions` with `trueWitness`/`falseWitness` and reachability at
defaults and when flipped. Only `rscSpec` consumes them (`templates.ts:2684`); a client
component with `const empty = items.length === 0` and two branches is left with a mount
smoke.

Ship: for an inversion whose flip is a **prop** (`kind: "prop"`, the leg shape already
built at `templates.ts:2968-2978`), render twice through the existing unit harness —
`renderTarget(DEFAULTS)` and `renderTarget({ ...DEFAULTS, <prop>: flipped })` — and assert
the witness pair (T2). Dep-keyed flips on the client plane ship only where the dep's
module is already in that spec's mock set (`mockedBindings`, `postDispatch.ts:80-84`),
because an unmocked dep cannot be flipped honestly. The existing refusal strings
(`templates.ts:3046-3055`) carry over unchanged: multi-call callees, exit-guard
predicates, unwitnessed flips and the inversion cap all still refuse by name.

### 5. Guard tests for multi-dep guards

`emitGuardTests` refuses any guard where `g.depVars.length !== 1`
(`templates.ts:2848`) — a restriction in the emitter, not the analyser, which already
carries the full `depVars`. `if (!user) return null` gets a test;
`if (!user || !org) return null` gets nothing.

Ship: emit the guard test when **every** dep in the guard has a resolved fixture
(`resolveDepReturns` / `inferredDepReturn`, `mocks.ts:249-259`), flipping them together
to their empty values. Partially-resolved guards keep refusing, by name.

### 6. Full variant coverage instead of a capped prefix

The variant matrix renders `opts.variants` options (`templates.ts:132`, `:436`,
`:1697`), and `extractProps` derives the complete literal option list
(`variantOptions`, `src/analyse/extractProps.ts:33`) which **no consumer in
`scaffold-tests`, `scaffold` or `reporters` reads** — the full list is computed and
discarded.

Ship: iterate the derived list up to the cap, and when the cap bites, say so in the spec
comment and in the report ("4 of 9 options exercised — the cap is `--variants`"). A
silent prefix is the same class of dishonesty M1 retired for plane tallies.

### 7. Static accessibility attributes on the asserted element

`extractChildAttrs` records attribute name and `valueKind` but throws away the literal
(`src/types.ts:474-482`), so a hard-coded `aria-label="Submit"` or `role="dialog"` can be
used as a locator (`templates.ts:3302`) but never asserted. Ship: keep the literal for
static string attributes and emit `expect(<el>).toHaveAttribute("aria-label", "Submit")`
(T1). This is the only item here that touches an analyser file, and it is one field.

## Acceptance (measured on the merge commit)

Each item is accepted by a falsifier, not by a green run — the pattern of
`tests/predicateInversionExecution.test.ts:115-214` and
`tests/guardPolarityExecution.test.ts:143-332`:

1. For each of the seven items, an execution test that (a) generates a fixture app whose
   component carries the fact, (b) shows the new assertion present and green, and (c)
   applies the named mutation that should turn it red, and shows it does. Mutations:
   remove the `disabled` attribute; change the initial string; rename the fetch URL;
   swap the inverted branch; delete one dep from the guard; rename a variant option;
   change the `aria-label`.
2. Census movement on the pinned tree (`c00697f`), measured with D0's ruler and
   committed to `docs/plans/baselines/`: the T0 spec count goes **down** and T1+T2 go up
   by a stated number. If the census does not move, the step is not depth and does not
   merge as written — it ships as a report-only change with the reason recorded here.
3. Skip census still balances: `skips == Σ skipReasons` in `VERDICT.json` after the
   skips this step removes, and the removed categories are visible in the reason table
   (`disabled-control`, `not-analysed` for variant-capped cases).
4. No new `TODO(flawless)` markers: the TODO tally in `REPORT.md` is ≤ the pre-step
   count on the pinned tree. This step adds assertions, not admissions.
5. Emitted specs type-check: the existing `tests/emittedTypes.test.ts` program covers the
   new assertion shapes (it must gain at least one case per new assertion form, with a
   mutation that produces a diagnostic).

## Gates

Plan-level criteria 1–4, plus track D's census criterion. Item 4's comparison is made
with two binaries built the same way — control = `main` @ merge-base, treatment = this
branch tip — per *Measure with the newest code*.

## Moot vs required

- Moot: raising the `--variants` default, or any change to what the analyser refuses.
  This step spends only what is already derived.
- Required: all seven items or a named reason per dropped one, in this file. An item
  that turns out to be unsound (e.g. item 4's witness pair proves unreachable on the
  client plane for every real component measured) is retired here with the measurement
  that killed it, not quietly dropped.

## Dependencies

D0 (the ruler and the baseline). Independent of D2–D4; item 3 hands its content
assertions to D2.

## Receipts

**D1a — items 1, 2 shipped; item 7 retired here, salvaged on
`feat/d1-surface-fixture` (host case only).** Branch `feat/d1a-attribute-claims`
off `main` @ `07072ac`. Control = `main` @ merge-base binary; treatment = this
branch tip (`e492b6b`) binary, both `bun build --compile --minify` per *Measure
with the newest code*. Pinned tree: mybodycorpai @ `c00697f`.

### Item 1 — `expect(<el>).toBeDisabled()` on an always-disabled control — SHIPPED

`emitClickTest` (`templates.ts:3247`) now intercepts `click.hints.disabled ===
"always"` and emits `expect(<target>).toBeDisabled()` (a T2 claim — the classifier
reads `toBeDisabled()` as T2, `depth.ts:521`, and the normative table puts it in the
T2 row; the original receipt text called it T1, corrected 2026-11-12 against the
table, which is the source of truth) in place of the
`disabled-control` skip and the false-red prop-spy that followed it. A
`"conditional"` control is untouched and still falls through to the skip.

- **Falsifier** (`tests/attributeClaimsExecution.test.ts`, runs vitest): a fixture
  with an always-disabled control generates a spec containing `toBeDisabled()`, runs
  **green** (exit 0), and the spec contains no `disabled-control` skip for it;
  removing `disabled` from the markup turns that test **red** on `toBeDisabled`.
- **Census movement on the pinned tree: none.** The D1a census is byte-identical to
  the D0 baseline (specs 191; T0 100 / T1 45 / T2 42 / T3 0; testsClassified 433;
  testsSkipped 60). mybodycorpai ships no control that is statically
  `disabled` at DEFAULTS on the unit plane — every one of its `disabled-control`
  skips reduces to `"conditional"` (`decidePostDispatch` skips any
  `disabled !== undefined`; the two unit-plane skips under that reason did not
  convert, which is exactly what a conditional control does). Per the Acceptance
  rule, a step whose census does not move on the pinned tree **ships as a
  report-only census change**; the depth witness here is the green→red execution
  falsifier, which proves the claim is real and falsifiable rather than the
  census, which cannot see a pattern this app does not contain.

### Item 2 — `toHaveAttribute(<attr>, <initial>)` for a string→host-attribute state — SHIPPED

`initialAttrWitness` (`templates.ts:2141`) emits
`expect(container.querySelector("<tag>[<attr>]")).toHaveAttribute("<attr>", <initial>)`
for a non-empty (≥2-char) string `useState` initial that the analyser saw flow into
a **lowercase host tag's** attribute (`via: "attr"`, `extractState.ts:337`).
`via: "condition"` (D3's subject) and uppercase component tags stay out — the latter
would emit a `querySelector` matching nothing and passing vacuously.

- **Falsifier** (same file): a fixture with `useState("Enter your email")` rendered
  into `placeholder` generates `toHaveAttribute("placeholder", "Enter your email")`,
  runs **green**; changing the initial string turns it **red** on `toHaveAttribute`.
- **Census movement on the pinned tree: none.** The app's only string `useState`
  initials are the empty string `""` (every other initial is `false`, `0`, or a
  non-literal), all excluded by the ≥2-char guard, so zero attribute witnesses are
  emitted here and the tier distribution is unchanged. Same report-only-census
  clause as item 1; the green→red falsifier carries the depth proof.

### Item 7 — static accessibility attributes on the asserted element — SALVAGED (host case)

D1a retired this item: the static-attr recorder `extractChildAttrs` never sees a
host element, the attrs it does see sit on children the unit spec mocks, and
asserting the value a locator already matches on is a tautology. All three still
hold — of the halves the analyser does not carry. What the measurement did not
cover is that the analyser carries a host element's static attrs through a second
path: `collectHints` runs on every walked element and attaches its result to every
click. The half a handler carries was carried all along; `feat/d1-surface-fixture`
(commit `5ae6d01`) ships its emitter, bounded by the locator's rung.

**What the analyser already carried.** `collectHints` (extractInteractions.ts:529)
is called for every walked element (:292) and records `data-testid` (:602),
`aria-label` (:605), `role` (:608), `id` (:611) — string literals only, via
`readStringInitializer` (:661–667), so a template-literal aria-label is never
recorded (the fixture's N2 refusal). The hints reach the emitter only through
`clicks.push` (:324), which requires an event attribute matching `eventPattern`
(:319–320) — a handler is REQUIRED. For a handler-less element they serve only
`extractLabel` (:298, the aria-label as accessible name) and are discarded.

**What stays dead — the D1a measurement, unchanged.**

1. **Child components** (old reasons 1–2): `extractChildAttrs`
   (extractChildAttrs.ts:15) records attrs on UPPERCASE tags only —
   `componentTagName` (:56–58) rejects a lowercase tag — and the unit spec mocks
   the child, so its attributes are not in the rendered DOM.
2. **Handler-less host elements**: `collectHints` runs, but its result is used
   only for label resolution and then discarded — nothing carries the attribute
   to the emitter.
3. **Form fields**: `collectFields` (:998) builds `FieldInfo` (types.ts:230–247),
   which has `label` (a `<label htmlFor>` lookup, :1039–1046) but no aria-label
   member — the field's own value is dropped. `findSubmitControl` (:967) records
   the submit control's `label` (:985) and `disabled` (:987) only.

**What the salvage emits.** `emitHostAttrTest` (templates.ts), unit plane only —
`emitInteractionTests` is called only from `unitSpec`, so rsc and constrained
specs cannot reach it. For each click on a locatable host element it adds a
render-only test asserting the static attributes the locator does NOT read,
bounded by `vitestSelectorRung` (f1523ed):

- **testid rung** — both `aria-label` and `role`; the locator reads neither.
- **label rung** — `role` only. The locator matches on the aria-label, so
  asserting it would be old reason 3 — a tautology, red-free by construction —
  now enforced as a bound instead of feared as a failure.
- **role rung and below** — nothing: a recorded aria-label is structurally absent
  (the label rung sits above), and a role INFERRED from the tag (`<button>` →
  "button") answers `getAttribute("role")` with null, so it must never be
  asserted. Gated elements, component tags and unlocatable clicks refuse.

**Evidence.** The falsifier (`tests/hostA11yAttrsExecution.test.ts`) runs both
rung shapes green, then mutates the aria-label literal WITHOUT regenerating the
spec and the run goes red on `toHaveAttribute` — the assertion reads the markup.
The pinned dogfood census is byte-identical (the baseline hashes every emitted
spec), so no pinned-app component fires the new site. The depth-surface fixture's
P3 is the one spec that moves — button A (testid rung) gains both asserts,
button B (label rung) the role assert only — and P3 is this item's row in
`docs/plans/baselines/depth-surface.json`.

Retired per *Moot vs required*: "an item that turns out to be unsound … is
retired here with the measurement that killed it." That measurement killed the
halves above and is kept; the handler-carrying host half was never unsound — it
was unwired — and now ships with its own measurement.

### Acceptance gate 5 — emitted specs type-check

`tests/emittedTypes.test.ts` gained three cases in
`describe("the D1a attribute assertions type-check")`: the `toBeDisabled()` /
`toHaveAttribute(attr, value)` shapes type-check clean, and two guard-the-guard
mutations (`screenBogus`, `containerBogus`) each produce a diagnostic.

### Skip census balance (gate 3)

On the D1a `VERDICT.json`: `unit-browser.skips = 132 == Σ skipReasons = 132`
(the `disabled-control` family — "its control is disabled at these props" ×2,
"its submit control is disabled at these props" ×3 — is present in the reason
table and, on this tree, unchanged, because neither shipped item fired).

### The depth-surface fixture is the movement metric (chunk 5)

Items 1 and 2 shipped with *census movement on the pinned tree: none* — not
because the emitter does not fire, but because the pinned app cannot exhibit
their patterns: mybodycorpai has no always-disabled control with a locatable
element on the unit plane (every `disabled` reduces to `"conditional"`), and
no string `useState` initial that flows into an attribute (its only string
initials are `""`, excluded by the ≥2-char guard). A real-app census cannot
measure a pattern the app does not contain.

`tests/fixtures/depthapp/` closes that gap: a committed app with exactly one
component per pattern (P1–P10 present/absent shapes, N1/N2 refusal controls),
guarded by `tests/depthSurface.test.ts` and pinned by
`docs/plans/baselines/depth-surface.json`. It is the movement metric for
track D: each pattern's emitted bytes and tier are pinned, every unshipped
behaviour is an EXPECTED-ABSENT row naming its owning item, and when an item
ships its row reddens by name. The pinned census stays the real-app reading —
the surface fixture measures *did the emitter fire on a shape known to carry
the fact*; the pinned census measures *what the real app gets*. Both run;
neither replaces the other.


**D1b — items 3, 4 shipped.** Branch `feat/d1b-interaction-claims` off `main` @
`94c6121` (#170 merged). Control = `main` @ `94c6121` binaries; treatment = this
branch tip binary (`fl-bintest-2c262d9`, sha256 `52b167be…`). Pinned tree:
mybodycorpai @ `c00697f` (fresh worktree `mbc-c00697f-d1b`); movement metric:
the depth-surface fixture.

### Item 3 — request-count after a derived dispatch is T2 — SHIPPED

The ruler first (commit `c83ba17`): PLAN-00's request-count row was amended —
`expect(calls).toBeGreaterThan(0)` is tiered by **where the counter is read**:
T0 at mount (a mount fetch is basically a mount claim), T2 when an unconditional
`await userEvent.*` / `await fireEvent.*` line precedes the counter site in the
same test body. The classifier rule is `hasDispatchBefore`
(`src/reporters/depth.ts:480`, call site :612); the conditional effect-fetch
trigger (`if (trigger) await userEvent.click(…)`) is a mount hedge, not a
dispatch, and keeps mount tests T0. **Control:** classifier change alone, no
emitter change — pinned census sha256 `9bae8c13…` and surface census sha256
`038c3eb0…` byte-identical before and after; the rule matched no existing
emitted shape. Guard-the-guard (`tests/depthCensus.test.ts`): mount fetch behind
the conditional trigger stays T0; the same counter after an unconditional
dispatch is T2; deleting the dispatch drops it back to T0; a dispatch *after*
the read does not lift the claim.

The emitter (commit `0da0416`): `extractFetchCalls` records the enclosing
handler of a NON-effect fetch (`handlerName` / `inlineHandlerEvent`);
`clickFetchDispatch` (`templates.ts:2225`) resolves it against the clicks the
interaction walk already found and refuses every unprovable link (gated element,
always-disabled control, non-click event, unlocatable target, guarded render) —
an unattributed fetch stays exactly as unemitted as before. `emitFetchTests`
(`templates.ts:2254`) drives the attributed fetch with the unconditional
dispatch instead of the conditional mount-hedge trigger.

- **Falsifier** (`tests/d1bInteractionClaimsExecution.test.ts`, spec generated
  once, only component source mutated between green and red): deleting
  `void fetch("/api/items")…` from the handler turns all four request-count legs
  red — `AssertionError: expected 0 to be greater than 0` on
  `click fetches and renders with a successful response` — and green returns on
  revert (`Test Files 2 passed, Tests 10 passed`).
- **Surface movement:** P4 `flawless/unit/P4ClickFetch.test.tsx` T1→T2 (3→7
  tests); P8's mount-fetch tests stay T0 behind the conditional trigger.
- **Pinned movement — the item fired on the real app:**
  `flawless/unit/NotificationsBell.test.tsx` T1→T2 (2→6 tests) — a
  `POST /api/me/notifications/read-all` fired from a click handler now gets the
  four dispatch-driven state tests. Census 191 specs: T1 45→44, T2 42→43;
  testsClassified 433→437.

### Item 4 — prop-keyed client branches assert the presence/absence mirror pair — SHIPPED (new derivation, not free)

PLAN-01 assumed item 4 was wiring. It is a derivation, and the honest cost is
commit `263eb0b` (+312 lines). Three gaps had to close: (1) `extractPredicates`
never ran for client components (`analyse/index.ts` gated it on `unit.isAsync`) —
it now runs on the unit plane with a `clientPlane` flag (`index.ts:425`),
dataDeps/guards staying async-only so a client component can only certify prop
controls; (2) the analyser modelled ternary/`&&` in JSX-child position only —
P5's shape (`if (prop) return <A/>; return <B/>`) is the same claim one statement
level up, collected by `collectReturnBranchSites` (`extractPredicates.ts:568`)
iff the pair is the function's ONLY branching return and the returns are adjacent
(or joined by `else`), with `certifyReturnSite` (:699) harvesting the arms'
literals as witnesses keyed to the predicate's polarity and proving absence
safety locally (`flippedAbsenceSafe`/`baselineAbsenceSafe`, :738–739); (3) a
boolean prop's flip candidate was a placeholder string — on the client plane the
prop's own negation now leads the candidates. The witnesses NEVER join the
unconditional static-text pool — `extractStaticText.ts:15` excludes branch text
on purpose; promoting it would assert branch content always renders and produce
false reds.

- **Falsifier** (same file): swapping the branch literals turns the mirror pair
  red — `AssertionError: expected 'No items yet' to contain '3 items in stock'`
  on `PropPredicate: empty flipped — 1 branch site(s) change side` — green again
  on revert.
- **Named refusals** (never silent, asserted as emitted bytes): keys on server
  data → "it keys on server data, not a prop; flipping a fetched value needs its
  dep mock (D1 item 5 owns that flip)" (`templates.ts:3206`); not reachable from
  a prop override → "the predicate is not reachable from a prop override this
  spec can build" (:3216); one-sided branch → "a branch it moves carries no
  assertable literal on one side" (:3239).
- **Surface movement:** P5 `flawless/unit/P5PropPredicate.test.tsx` T1→T2
  (2→3 tests) — the full mirror pair; every other pattern spec byte-identical.
- **Pinned movement — no mirror pair fired; the refusals did:** four new named
  refusal skips, all "a branch it moves carries no assertable literal on one
  side" — `ActionItems` (items, canManage), `CreateConversationForm`
  (candidates), `TicketUpdateComposer` (canPostInternal). The app's prop-keyed
  client branches are one-sided (a loading/empty branch opposite a rendered
  list), so the certifiable pair shape does not occur; testsSkipped 60→64.
  The pre-existing "X flipped — N branch site(s) change side" legs on the RSC
  pages are the async-plane inversions, unchanged by this item.

### D1b census accounting

Surface: 26 specs, T0 12 / T1 12→10 / T2 2→4 / T3 0 — exactly the P4/P5 rows the
items own; two fresh fixture copies produced byte-identical census JSON (sha256
`eb32f861…`). Pinned: 191 specs, T0 100 / T1 45→44 / T2 42→43 / T3 0,
testsClassified 433→437, testsSkipped 60→64 (census JSON sha256 `827db40b…`);
the three pinned c00697f baseline files stay untouched on this branch
(`git diff --stat main..HEAD -- docs/plans/baselines/` shows only
depth-surface.json) — the movement is recorded here, and the D1 aggregate
baseline (chunk 7) owns any re-pin of the pinned tree.
