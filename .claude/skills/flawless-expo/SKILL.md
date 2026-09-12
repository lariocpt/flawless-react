---
name: flawless-expo
description: Work with flawless-react's Expo / React Native mode — what --expo detects, which tasks run and which refuse, the jest-expo + @testing-library/react-native unit plane, renderRouter vs render, the native selector ladder and why a skip is a skip, and the version pairing that has to be exact. Use when generating or fixing native specs, when a native suite is red, or when deciding whether a refusal is a bug or the design.
---

# flawless-expo

React Native is a **second element vocabulary**, not a Next.js variant. `<View>` is
capitalised and imported; there is no `<form>`, no implicit ARIA role, and
`className` is compiled away by babel before anything can observe it. Most of what
this skill records is the consequences of those four facts.

## What `--expo` detects

`detectExpo(root)` reads, off disk only:

| field | from | why it matters |
|---|---|---|
| `sdkMajor` | the project's own `expo` range, else what is installed | jest-expo's major must **match** it |
| `routerRoot` | `app/` or `src/app/`, **only if** `expo-router` is a dependency | decides which files get the route template |
| `reactCompiler` | `app.json` `experiments.reactCompiler`, or `babel-plugin-react-compiler` | three `perf-static` rules become advice about work already done |
| `nativewind` | `babel.config.js` mentioning nativewind | decides whether an unstyled host is honest to ship |
| `webPort` | the `web` then `start` script, default **8081** | Metro's port, not 3000 |

`sdkMajor` is `number | undefined` and **never guessed**. `latest`, `*`, a git url and
a `file:` specifier all produce *unknown*, and the run says so rather than substituting
a number — a jest-expo major that does not match the SDK fails deep inside
`expo-modules-core` with a message that names nothing.

## The version pairing, which has to be exact

```
jest-expo                       ~<the project's OWN sdk major>.0.0
jest                            ^29.7.0
@testing-library/react-native   ^13.3.3      <- 13, NOT 14
react-test-renderer             19.1.0
```

Each wrong answer fails somewhere unhelpful:

- **A bare `jest`** resolves to 30 while jest-expo 54's tooling is all `^29.2.1`, and the
  mismatch surfaces as `this._moduleMocker.clearMocksOnScope is not a function` from
  inside jest-runtime.
- **RNTL 14** replaced `react-test-renderer` with the `test-renderer` package, and
  expo-router 6's own testing-library is built against the former.

If you are tempted to "upgrade" any of these, run the suite. That is what caught all of it.

## Three spec shapes, chosen from the file

**Route screen** → `renderRouter` from `expo-router/testing-library`, at its own URL.
Not a preference: `useFocusEffect` reaches `useNavigation()`, which throws
`Couldn't find a navigation object` outside a navigator, and `useLocalSearchParams`
is empty. Inside a real navigator the screen is **focused**, so focus effects run and
the spec can assert loaded state instead of the loading skeleton.

**`_layout`** → its own navigator with one synthesised child. `<Tabs>` and `<Stack>`
call `useContextKey` and throw `No filename found. This is likely a bug in expo-router`
when rendered alone.

**Everything else** → RNTL `render()`.

### The context is the OBJECT form, always

```tsx
const CONTEXT = {
  "_layout": Layout0,
  "login": { default: LoginScreen },
  "signup": { default: () => null },   // a stub for every literal push target
};
```

expo-router resolves the string and `{ appDir }` forms through
`path.resolve(process.cwd(), …)`, so a spec using either breaks the moment jest runs
from the monorepo root instead of the app directory. The stub leaves are not
decoration: a push to a route the context does not know lands on expo-router's
injected `+not-found`, and the pathname assertion then fails for the wrong reason.

### fireEvent in route specs, userEvent in component specs

`renderRouter` calls `jest.useFakeTimers()` internally. `userEvent`'s press timing
under fake timers is not something the emitter vouches for, so route specs use
`fireEvent`, which has no timers in it. Do not "upgrade" one to the other.

## The selector ladder

```
testID → accessibilityLabel → accessibilityRole (+name) → placeholder
       → displayValue → text → text fragment → undefined
```

`placeholder` sits **above** text deliberately: a placeholder names *the element*,
text names a *child*.

**There is no last-resort rung, and that is a decision.** The DOM ladder bottoms out at
`container.querySelector("button")`; the two native candidates are both unsound.
`UNSAFE_getByType(Pressable)` compares component identity, and under NativeWind's
`jsxImportSource` the `Pressable` the source rendered went through `cssInterop`'s
wrapper while the one a spec imports is the bare component — so it matches zero
elements, and `fireEvent.press` on nothing is a green test that touched nothing.
"The first pressable in the tree" is wrong for the same reason the DOM ladder refuses
an ambiguous bare tag, only more often, because every screen is a stack of Pressables.

### A skip is not a gap in the tool

`getByRole("button")` matches **nothing** on a bare `<Pressable>`: RNTL's `getRole()`
reads the explicit `accessibilityRole` prop, else `"text"` for `Text`, else `"none"`.
There is no implicit-role table to lean on.

So a control with no `testID`, no `accessibilityLabel`, no `accessibilityRole` and no
text under it is a `test.skip` carrying the reason **and the fix**. The icon-only
wording wins over the ambiguous one when both apply, because one `accessibilityLabel`
resolves both — and the same absence is what makes the control silent to a screen
reader. **Answer a skip by adding the label to the app, not by loosening the ladder.**

## What a native spec does NOT assert

Three DOM assertions have no honest native equivalent and are dropped rather than faked:

- the root-tag `querySelector` — `rootTag` is a capitalised element name, and the only
  RNTL equivalents couple the spec to RN internals;
- the `.flawless-cls` className-flow check — NativeWind compiles `className` into a
  `style` through **babel**, so a sentinel class is unobservable in the jest-expo tree
  *and* in the react-native-web DOM;
- anything asserting a specific style token, for the reason the DOM emitter refuses to
  assert a Tailwind class.

## No emitted spec touches the network

A module that resolves project-locally and performs `fetch()` is `jest.mock`ed. Before
this existed the fixture suite made live HTTP calls and crashed a jest worker with
`api_error 405` from a real server.

Each stub's shape comes from the mocked function's own `Promise<T>` annotation, resolved
through workspace barrels and zod schemas. `Promise<void>` mocks to `undefined` with no
marker — that IS its realistic return value. Only an unresolvable shape falls back to
`{}`, and only that one keeps a `TODO(flawless)`. The fallback matters: `const { items }
= await listBuildings()` against `{}` binds `items` to undefined, and the next
`buildings.length` throws into the app's own ErrorBoundary, so the screen renders
"Something went wrong" and the failure looks like the component.

Collections are emptied for the default mock, so assertions derived from the initial
render hold. The loaded state gets its own test — see below.

The mock specifier is relativised to the **spec**, not the component — `app/login.tsx`
writes `"../lib/api"`, which from `flawless/unit/` names `flawless/lib/api`.

## The loaded state gets its own test, where that is fair

A separate test re-mocks ONE function to return a single row and asserts a synthesised
witness appears. Emitted only where three things hold, each checked against the AST:

1. **Mounting calls it** — reachable from a `useEffect`/`useFocusEffect` callback or the
   component body, and not inside a branch, a `catch`, or a JSX event handler. A mutation
   called from a submit handler is not a loader; a call behind `if (isTrustee)` does not run.
2. **What it returns is rendered as a list** — the result reaches a `useState` setter whose
   state variable is mapped in JSX or handed to a list as `data`. A collection read to decide
   a permission flag changes a boolean, not the screen.
3. **The row has a witness** — a string field THIS list's row renders as a JSX child. Not an
   attribute value (`key={r.id}` is not displayed), and not a field rendered elsewhere in the
   file over different data.

Where any fails, the emitter writes a `test.skip` naming which. On the dogfood app 14 of 31
screens qualify and all 14 pass.

An earlier version shipped this as a blanket skip, blaming "an external store the harness
does not reach". That was a guess and it was wrong — every cause was visible in the AST.

## `router.back()` needs a history entry

`renderRouter` mounts one screen at one URL with nothing behind it, so `GO_BACK` into an
empty stack fails with *The action 'GO_BACK' was not handled by any navigator*. A route
spec pushes its own URL once before the press. A component spec has no router to push into,
so the handler is a skip that says so.

## Colocation is impossible under `app/`

expo-router's `require.context` matches every `.[tj]sx?` under the router root, so a
colocated `app/login.flawless.test.tsx` would **register as a route**. Native specs for
route files always go to the out dir.

Related: check the app's own `test` script. A bare runner with no path filter — the
dogfood app's was `bun test --preload ./tests/setup.ts` — sweeps the generated specs
into the project suite and runs them under a runner they were not written for. The tool
warns; scope the script (`bun test tests`).

## The native a11y analyser (wave 5)

`a11y` runs under `--expo` since wave 5, through the tool's OWN analyser
(`src/tasks/a11yNative.ts`) rather than biome — biome structurally cannot judge RN:
all 29 of its a11y rules are HTML/ARIA, and over 31 real RN files with 82 unlabelled
`<Pressable>`s they returned zero while scoring 3/3 on the DOM `A11yOffender.tsx`.

Six rules: `a11y/unnamed-control` (provably-textless press target with no label —
fires only on icon-only or childless elements, never on dynamic children, which DO
announce at runtime), `a11y/missing-role`, `a11y/textinput-unlabelled` (a placeholder
is not a label), `a11y/icon-unhidden` (warn; a render-prop icon such as `tabBarIcon`
stands down — its owner is invisible to the file, and React Navigation's tab button
announces the title over it), `a11y/label-text-mismatch` (WCAG 2.5.3),
`a11y/invalid-role` (each role attr validated against ITS OWN union — "header" is an
accessibilityRole, "heading" is a role).

Three contracts to rely on:

- **The denominator.** The summary and `reports/a11y.json` always say how many press
  targets / text inputs / icons were examined and how many rules ran. A zero without a
  denominator is a bug, not a clean bill.
- **Presence-not-value stands rules down.** `accessibilityLabel={t("back")}` is recorded
  as dynamic and never flagged. A missing finding on a dynamic attr is the design.
- **Skip ⇔ finding agreement.** An icon-only control with no handle is BOTH the unit
  plane's `test.skip` and an `a11y/unnamed-control` finding — same retained element,
  one `accessibilityLabel` retires both. Deliberate asymmetries: a `testID`-only
  control is addressable to a spec but still flagged (a testID is not a name), and a
  dynamic-text control is a ladder skip but NOT flagged.

## Route e2e against Expo web (wave 6)

`e2e` runs under `--expo` since wave 6: one Playwright spec per expo-router route,
against `expo start --web`. The Next.js flavour's machinery carries over
(params.json ids, write-once global-setup with the hand-work tally, `landing`
overrides, `GET <route>` describe titles for `--changed` narrowing); the Expo facts
baked in, each measured first (`docs/reviews/2026-09-expo-probes.md`):

- Metro's statuses are REAL — unknown routes 404, per-route rendered HTML — so the
  status assertion keeps teeth on a dev server.
- Auth is a **cookie on the API origin** (the app stores no token on web); the setup
  stub's request-context login + storageState example is the whole job. Set
  `EXPO_PUBLIC_API_URL` first — Metro inlines it, and the unset fallback is whatever
  the source hardcodes.
- **Two auth-wall faces, three assertions.** A client redirect fails the landing
  assertion; a wall rendered IN PLACE fails the console assertion (the API's 401s)
  and the **copy witness** — a third test asserting the screen's longest
  analysis-proven literal renders, the claim that cannot be true of a wall.
- An app whose cold start always lands on `/login` (no session hydration) is a
  `landing` override in params.json — recorded truth, never a spec edit.

## Tasks that refuse, and why that is the design

`load` refuses under `--expo`, naming wave 7 (API-only pipes). `perf-harness`
refuses as **measured-and-declined, not deferred**: on an expo-router app the
population is route screens, which the browser host cannot mount (navigator hooks;
renderRouter is jest-bound), so the measured ceiling on the dogfood app was ~0 of
32 components — the refusal points at `docs/reviews/backlog.md` B-16 and the probes
ledger, and the revisit condition is an adopter with a real `components/` directory
of non-route components. And one runner reads differently rather than refusing:

- **`perf-static` runs but reads differently under the React Compiler.** On a project
  with `experiments.reactCompiler: true`, 136 of 168 findings were
  `perf/unstable-child-prop`, `perf/missing-memo-leaf` and
  `perf/no-memoisation-with-children` — work the compiler already performs.

## Never

- Never drop `--expo` to make a task run. It will emit DOM artefacts for a React Native
  project: a suite that runs, passes and tests nothing.
- Never mock `react-native`. That is exactly why an app whose own setup does it cannot
  test screens; jest-expo exists so you do not have to.
- Never add a row to `NATIVE_TAG_TO_ROLE` unless the element's own React Native source
  sets the role unconditionally. A fuller table means queries that match nothing.
- Never satisfy a skip by relaxing the selector ladder. Add the `accessibilityLabel`.
