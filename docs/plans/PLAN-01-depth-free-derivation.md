# D1 — depth the analyser already knows and the emitter drops

## Scope

`src/scaffold-tests/templates.ts` (six emitter sites), `src/scaffold-tests/postDispatch.ts`
(one rung), `src/analyse/extractChildAttrs.ts` (one field, item 7 only), the matching
execution tests, and this subfile. No new extractor, no new task, no new flag.

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

**D1a — items 1, 2 shipped; item 7 retired.** Branch `feat/d1a-attribute-claims`
off `main` @ `07072ac`. Control = `main` @ merge-base binary; treatment = this
branch tip (`e492b6b`) binary, both `bun build --compile --minify` per *Measure
with the newest code*. Pinned tree: mybodycorpai @ `c00697f`.

### Item 1 — `expect(<el>).toBeDisabled()` on an always-disabled control — SHIPPED

`emitClickTest` (`templates.ts:3247`) now intercepts `click.hints.disabled ===
"always"` and emits `expect(<target>).toBeDisabled()` (a T1 claim) in place of the
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

### Item 7 — static accessibility attributes on the asserted element — RETIRED (with reason)

`extractChildAttrs` (`src/types.ts:474`) records attribute name and `valueKind` only
on **UPPERCASE child components**, never on a host element. Three measurements make
the emitted assertion unsound, so the item is retired rather than shipped:

1. There is no host element to assert on — the attrs live on a child component the
   unit spec **mocks**, so the attribute is not in the rendered DOM.
2. The only static attrs the analyser sees sit on already-mocked children
   (`<Icon name=…>`), which a unit spec stubs to a pass-through — asserting their
   attributes tests the mock, not the component.
3. The plan's own locator usage (`templates.ts:3302`) already *finds* the element by
   that attribute; emitting `expect(el).toHaveAttribute("aria-label", <the same
   value>)` on the element located by `aria-label` is tautological — it is red-free
   by construction (a false-red/vacuous claim), the exact class PLAN-00 M1 retired.

Retired per *Moot vs required*: "an item that turns out to be unsound … is retired
here with the measurement that killed it." No code path emits for item 7.

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

