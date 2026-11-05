# D3 — state transitions and status flags: the first real new analysis

## Scope

`src/analyse/renderPath.ts` (a second env, not a rewrite), `src/analyse/extractState.ts`
(read-only consumer of `setterCalls`), `src/scaffold-tests/templates.ts`
(`emitStateTests`, `emitFetchTests`'s two remaining TODOs), `src/analyse/extractGuards.ts`
(read-only), new `tests/stateTransitionExecution.test.ts` and
`tests/statusStateExecution.test.ts`. No new task, flag, or plane.

## Premise

The tool can already answer "what renders at the initial render". It cannot answer "what
renders after the user does the thing", which is why the deepest tests it emits stop at
T2 and why two of the four fetch TODOs exist.

The machinery for the second question is closer than it looks. `renderPath.ts` is a
literal-composable branch evaluator:

- `RenderEnv` is `{ props: Map, state: Map, opaque: Set }` (`:30-37`) — state is a first
  class part of the environment, not an afterthought;
- `makeEnv(props, unresolvedProps, state)` fills `state` from each `StateInfo`'s
  **initial** value and marks the unknowable ones `opaque` (`:61-93`);
- `evaluate(expr, env)` (`:100`), `truthy` (`:216`) and `reachability(node, root, env)`
  (`:381`) decide, for any JSX node, whether it is on screen under a given env.

So "what renders after `setOpen(true)`" is the same question with a different env. What
is missing is (a) a second env where one state variable holds the setter's argument, and
(b) the wiring that pairs a click with the env that click produces.

## What it ships

### 1. A post-setter render env

`makeEnv` gains a sibling: `envAfterSetter(env, varName, value)` — clone, set, return.
The emitter then runs the existing `initialRenderExpression`/`reachability` pass against
that env and harvests the static text of the nodes that became reachable (the same
harvest `extractStaticText` does for the initial render).

Refusals, all named in the spec, none silent:

- `SetterCallSite.argKind` is `"literal"` only (`src/types.ts:400`). An `"updater"`
  (`setN(n => n + 1)`), an `"expression"` whose operands are not literal-composable, or
  a `"none"` refuses — the evaluator propagates unknown, and an unknown value must not
  become an assertion.
- A setter whose call site is `guarded: true` (`:399`) refuses unless the guard is
  provably open at the spec's props — the same reachability question, already answered by
  `reachability`.
- `useReducer` dispatches refuse: the reducer's case bodies are a separate derivation and
  are explicitly not in this step.
- A state variable that flows only through a function boundary (`crossedFunction` in
  `extractState.ts:341`) refuses.

### 2. The transition test

For a component where a derivable click handler calls `setX(<literal>)` and `x` has a
harvestable branch, emit (T3):

```
click the control (existing derived locator)
await waitFor(() => expect(screen.getAllByText("<branch copy>")).length)
and: the initial branch's copy is gone, when the two branches are exclusive
```

This replaces the current shape at `templates.ts:2082-2104`, which clicks, then writes
`TODO(flawless): assert the observable change for setX(...)` and pads the test with
`waitFor(() => expect(document.body).toBeTruthy())`. That padding is a T0 tail inside a
test that looks like an interaction test; D0's classifier counts it as unclaimed, and
this step deletes it wherever it can be replaced.

### 3. Status flags: the two remaining fetch TODOs

`isLoading` / `isPending` / `error` are state variables like any other. The same
env-after mechanism answers which copy is keyed on them: build the env with the flag true,
harvest; build it false, harvest; the difference is the loading or error copy. That fills
`templates.ts:2213` (*"assert the loading indicator while the response is pending"*) and
`:2222` (*"assert the error-state UI"*) with the same evidence rule as D2 — a harvested
literal, never a guess — and refuses by name when the branch carries no harvested copy.

The MSW scenarios that drive them already exist (the delayed handler and the 500 handler,
`:2208-2222`), so no new harness is needed: the scenario picks the env, the env picks the
copy.

### 4. Disclosure toggles (last item, first candidate to be cut)

`extractDisclosures` already pairs a trigger with the region it gates
(`src/analyse/extractDisclosures.ts`), and D1 item 2 makes a static attribute
assertable. Together they support: before the click `aria-expanded="false"`, after it
`"true"` — where the attribute is a literal-composable expression of a state variable.
Refuses when the attribute comes from a library's internal state (Radix), which is most
Radix triggers; the refusal is the existing `not-analysed` reason, not a silent pass.

## Acceptance (measured on the merge commit)

1. `tests/stateTransitionExecution.test.ts`: a fixture app with (a) a literal-setter
   toggle, (b) an updater-setter control, (c) a guarded setter, (d) a `useReducer`
   control. (a) is green with a T3 assertion and goes **red** when the branch's copy is
   renamed or the setter's argument changes; (b), (c) and (d) show the named refusal and
   **do not** gain an assertion. A guard-the-guard case: making the updater case emit an
   assertion anyway must fail this test.
2. `tests/statusStateExecution.test.ts`: loading and error copy are asserted where the
   fixture app has them, and each goes red when the copy moves off the flag.
3. On the pinned tree (`c00697f`): the TODO counts for
   `assert the observable change for setX(...)` and the two fetch-state TODOs drop by a
   stated number, and the vacuous `document.body).toBeTruthy()` tail count drops to 0 or
   is reported with the count of specs that still need it.
4. Census: T3 rises by at least the number of transition/status tests emitted; the
   falsifier rate rises. Both numbers are appended to
   `docs/plans/baselines/depth-<target>-<sha>.json` as a dated row.
5. Determinism: two runs on the unchanged tree emit byte-identical specs (the env clone
   and the harvest must be order-stable — `Object.entries` iteration is not, so the
   harvest is sorted).

## Gates

Plan-level criteria 1–4 plus track D's census criterion. Because this step changes an
analyser, criterion 3's regen probe is run on **both** the DOM and the Expo fixture apps:
the native emitter consumes the same `StateInfo` and must not change behaviour unless
this subfile says where.

## Moot vs required

- Moot: reducer support, updater-function support, context/store-driven state (zustand,
  redux) — each is its own derivation and each must be its own step with its own refusals.
  Pretending otherwise is how a "state test" ends up asserting nothing.
- Required: the env-after derivation, the literal-only rule, the named refusals, the two
  status TODOs, and the deletion of the vacuous tail wherever it is replaced.

## Dependencies

D0 (ruler). D2 first is preferred: D2 establishes the witness-harvest rule this step
reuses for branch copy. D4 builds on the same env for payload arguments.

## Receipts

_None yet._
