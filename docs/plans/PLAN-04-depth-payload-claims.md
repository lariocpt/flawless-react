# D4 — payload and argument claims: from "it was called" to "it was called with"

## Scope

`src/analyse/extractInteractions.ts` (one new record: callback argument literals),
`src/analyse/extractFetchCalls.ts` (one new record: request body key set),
`src/scaffold-tests/templates.ts` (`emitFormTest`, `emitClickTest`'s prop rung,
`emitFetchTests`), `src/scaffold-tests/selectors.ts` (field-name reuse, read-only), new
`tests/payloadClaims.test.ts` and `tests/payloadClaimsExecution.test.ts`. No new task,
flag, or plane.

## Premise

Every effect assertion the tool emits today is a **presence** claim:

- prop handler: `expect(handlers.onX).toHaveBeenCalled()` (`templates.ts:3201-3213`);
- mocked module: `expect(vi.mocked(binding)).toHaveBeenCalled()` (`:3236-3246`);
- server action: `expect(vi.mocked(action)).toHaveBeenCalled()` (`:3407-3408`);
- router: `toHaveBeenCalled()` or `toHaveBeenCalledWith(literal)` — the one place the
  argument is already asserted, because the target is a literal in the source
  (`:3248-3265`).

A presence claim is T2 and it is honest, but it survives any change to *what* was sent.
Renaming a form field, changing a callback's argument, or pointing a POST at a different
body shape keeps every current assertion green. The three items below are the payload
claims the source already states in literal form.

## What it ships

### 1. The submitted payload carries the fields the form declares

The emitter already harvests each field's tag, type, label/name/id/placeholder
(`extractInteractions`'s form harvest) and already knows the exact value it typed
(`emitVitestFillAssertion`, `src/scaffold-tests/selectors.ts:349-357`). The action
assertion at `templates.ts:3408` then throws all of that away and asserts the call
happened.

Ship: when the form's fields all have a derivable `name`, assert the payload contents —
for a server action wired through `useActionState`/`action={…}`, read the `FormData` the
mock received and assert each derived field name carries the value the test typed
(T3). The existing `fireEvent.submit` choice stays exactly as it is, including the reason
comment at `:3396-3405` (a click would be blocked by constraint validation on fields
`collectFields` cannot see).

Refusals, named: a field with no derivable `name` (the `<Input>`-component case the
comment above documents), a form whose submit path is a prop handler (its argument is an
event, not a payload — asserting `toHaveBeenCalledWith` there would be theatre), and a
form with no submit path the spec controls.

### 2. Callback arguments, where the source writes them literally

New derivation, deliberately tiny: when a handler invokes a **prop callback**
(`onX(...)` / `props.onX(...)`), record the argument expressions when each is a literal
or literal-composable (`renderPath.literalToValue`, `:226`). One field on the existing
interaction record; no new pass over the file.

Ship: `expect(handlers.onX).toHaveBeenCalledWith(<literal>)` where every argument
qualifies (T3); the presence claim stays where any argument does not. Refusals follow the
predicate-inversion precedent (`templates.ts:3046-3055`): a callback invoked at more than
one site with different arguments refuses rather than picking one, and a callback invoked
after an `await` refuses unless the spec's existing wait already covers it.

### 3. The request it makes is the request the source describes

`FetchCallInfo` already carries `urlTemplate` with `:holes`, the hole names in order, and
the method (`src/types.ts:703-712`), and the MSW handler is already installed by the
fetch tests. Ship: capture the request in the handler and assert (a) the URL matches the
derived template with each hole filled from the value the spec passed, and (b) for a JSON
body, the **key set** the source builds — a new one-field derivation on
`extractFetchCalls` (object-literal keys of the `body`, not their values). Values stay
out: a value that comes from state is D3's subject, and a guessed value is exactly what
this product refuses to emit.

Tier T3. Refuses when the body is not an object literal (`JSON.stringify(variable)`,
`FormData`, a serialized library call) — the key set of an opaque body is unknown, and
unknown must not become an assertion.

## Acceptance (measured on the merge commit)

1. `tests/payloadClaimsExecution.test.ts` — a fixture app with: a named-field form
   posting to a server action, a form with one unnamed field, a component calling
   `onPick(id)` with a literal, a component calling `onPick(id)` with a computed value,
   and a POST with an object-literal body. Expected: items 1–3 green with the payload
   assertion; the unnamed-field form, the computed-argument callback and the opaque body
   show the named refusal and gain nothing. Each green case goes **red** under its named
   mutation: rename the field's `name`, change the callback's literal, rename a body key,
   change the URL template.
2. `tests/payloadClaims.test.ts` — the derivation-level cases (no browser): argument
   classification, FormData shape, template-hole filling, and a guard-the-guard case per
   item proving the claim is not vacuous.
3. On the pinned tree (`c00697f`): the count of emitted `toHaveBeenCalledWith` assertions
   goes from its current value (router-only) to a stated number, and the count of bare
   `toHaveBeenCalled()` claims drops by the same number or is reported with the reasons
   the remainder cannot be strengthened.
4. Census: T3 rises; falsifier rate rises by at least the mutations this step catches.
   Both appended as a dated row to `docs/plans/baselines/depth-<target>-<sha>.json`.
5. Byte-stability: two runs emit identical specs (payload field order is sorted, not
   source order, so a reordered form does not churn the suite).

## Gates

Plan-level criteria 1–4 plus track D's census criterion. Criterion 2's scope hygiene:
this step touches two analyser files by **one field each**; a diff that restructures
either is two commits (`AGENTS.md`, *Make small edits*).

## Moot vs required

- Moot: asserting argument *values* that come from state, context or a store (D3's
  domain, or out of reach); asserting a payload for a prop-handler submit; deep-equality
  assertions on objects the analyser only partially sees — a partial object with
  `expect.objectContaining` over-claims, which is the failure this product is built to
  refuse.
- Required: all three items or a named measurement per dropped one, and the refusal
  strings in the same table as the existing ones so the skip census still balances.

## Dependencies

D0 (ruler). D2 and D3 are siblings, not prerequisites; D3's env makes the *values*
behind some payload arguments knowable, which is the natural follow-up step and is
deliberately not in this one.

## Receipts

_None yet._
