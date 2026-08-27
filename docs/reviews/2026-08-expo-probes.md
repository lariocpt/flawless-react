# Expo / React Native mode — pre-flight probes

Seven questions answered against the real app before a line of the mode was written, because each
one is cheap now and expensive in wave four. Measured on `mybodycorpai/apps/mobile`
(Expo SDK 54.0.34, expo-router 6.0.23, React Native 0.81.5, React 19.1.0, NativeWind 4.2.3,
`experiments.reactCompiler: true`), against flawless-react `e383338`.

`docs/reviews/` is outside the docs-lint corpus (`tests/helpers/docs.ts:proseFiles`), which is why a
spike ledger belongs here: it records what was true on 2026-08-27, and history does not get rewritten
when a finding is later fixed.

---

## P6 — is the `a11y` task vacuously green on React Native? **Yes. Confirmed.**

```
$ flawless-react "app/**/*.tsx" --expo-shaped --tasks a11y --roots exported
a11y: 0 finding(s) across 31 file(s)          exit 0, ok: true
```

Zero findings on 31 files containing **82 `<Pressable>` elements, none of which carries a
`testID`, an `accessibilityLabel`, an `accessibilityRole`, an `accessibilityHint` or an
`accessible` prop**. A clean report that means "these rules do not apply", presented as coverage.

The control that makes this a finding rather than a guess — the same sweep, same config, over the
tool's own `tests/fixtures/A11yOffender.tsx`:

```
a11y: 3 finding(s) across 1 file(s)
    error lint/a11y/useAltText
    error lint/a11y/useAnchorContent
    error lint/a11y/useValidAriaRole
```

The sweep is alive. All 29 of `a11yScan.ts`'s rules are HTML/ARIA rules — `useAltText`,
`useAnchorContent`, `useHtmlLang`, `useButtonType`, `useValidAnchor` — and React Native source
contains no `<img>`, no `<a>`, no `<html>`, no `<button>`. **Biome cannot be the native a11y
engine.** (Running the same sweep over `apps/web/src/components` also returns 0, but that app was
already dogfooded clean, so it is not the control — the offender fixture is.)

## P4 — the locator-rung census. **46.8% addressable. Below the 60% gate.**

Measured with the tool's **own** render-path evaluator (`initialRenderExpression` + `reachability`),
not a naive AST walk. That distinction is load-bearing: a naive walk marks `login.tsx`'s Sign-in
button unaddressable because its child is `{busy ? <ActivityIndicator/> : <Text>Sign in</Text>}`,
while the real pipeline knows `busy` starts `false`, reduces the ternary, and finds `"Sign in"`.

Over the 47 press targets reachable at the render a generated spec actually produces:

| rung | count |
|---|---|
| `testID` | **0** |
| `accessibilityLabel` | **0** |
| `accessibilityRole` | **0** |
| descendant `<Text>` literal | 17 |
| descendant literal, partial | 5 |
| **nothing** | **25** (13 of them icon-only) |

**Addressable: 22/47 = 46.8%.** Ambiguous tag (more than one of that tag in the component): 27.
Re-run ignoring reachability entirely — the upper bound a fully data-mocked render could reach —
moves it to 46.9%. **The ceiling does not move**: the unaddressable targets are not hidden behind
data branches, they genuinely carry no text.

Across the whole app: **82 `<Pressable>`, every one with an `onPress`, not one with any handle.**

Sample of what *does* emit, so the 46.8% is legible as real output:

```
app/(tabs)/buildings.tsx:92        getByText("Add")
app/(tabs)/settings.tsx:134        getByText("Save profile")
app/(tabs)/settings.tsx:282        getByText("Sign out")
app/buildings/[id]/contractors/new.tsx:202   getByText("Save contractor")
```

**What this decides.** The plan's gate was "≥60% on a non-skip rung, or a testID codemod becomes its
own wave". The gate is missed — but a testID codemod is the wrong fallback. Every one of the 25
unaddressable targets is unaddressable for the *same reason* it is unannounced to a screen reader,
and the fix is one `accessibilityLabel` per element: a real accessibility improvement that is also a
test handle, where a `testID` is test-only scaffolding. **So the native a11y task moves ahead of the
unit interaction plane**, and the mybodycorpai side gets an `accessibilityLabel` PR that is worth
landing on its own merits. After it, the interaction plane approaches 100% rather than 47%.

## P1 — does NativeWind survive a non-babel bundler? **No. But the consequence is smaller than feared.**

`apps/mobile/babel.config.js` is `["babel-preset-expo", { jsxImportSource: "nativewind" }]`, and the
app's `tsconfig.json` sets **no** `jsxImportSource` — so a bundler that does not run babel cannot
pick it up by any route. Confirmed by building a probe component with `Bun.build` and a
`react-native` → `react-native-web` resolve plugin, then rendering it:

```html
<div class="css-view-g5y9jx" data-testid="probe-root">
  <div aria-label="tap me" tabindex="0" class="css-view-g5y9jx r-cursor-1loqt21 r-touchAction-1otgn73">
    <div dir="auto" class="css-text-146c3p1">Sign in</div>
  </div>
</div>
```

Four facts, all of which the host design needs:

1. **NativeWind is entirely absent.** The bundle never mentions `nativewind` or `css-interop`, and
   not one of `p-4`, `bg-red-500`, `rounded-md`, `text-lg` reaches the DOM — react-native-web
   *consumes* `className` and substitutes its own atomic classes. The render is structurally correct
   and visually nothing like the app.
2. **`stderr` is 0 bytes.** No React unknown-prop warning, no console error of any kind. This
   matters because it was the strongest argument against shipping the host at all: the fear was that
   an unstyled render would trip `browserSpec`'s `expect(errors).toEqual([])` and turn the host's own
   limitation into a red spec for a healthy component. **It does not.** The host is viable as a
   documented functional-not-visual host.
3. **`testID` → `data-testid`, `accessibilityLabel` → `aria-label`.** The existing Playwright
   emitters' `getByTestId` / `getByLabel` rungs work unchanged against an Expo-web host.
4. **`Pressable` becomes `<div tabindex="0">` with no `role`.** So `getByRole("button")` finds
   nothing on the web plane either — the same "no implicit role" fact that shapes the RNTL ladder
   applies to the Playwright dialect, and both need the same answer.

What the host still cannot do honestly: report paint or layout performance, because layout cost is a
real part of render cost and this tree has no layout. That is a limitation to publish, not to hide.

## P5 — one React or two under hoisted Bun workspaces? **One.**

```
react            → <root>/node_modules/react/index.js   (from apps/mobile AND from the root)
react-dom        → <root>/node_modules/react-dom/index.js
react-native     → <root>/node_modules/react-native/index.js
react-native-web → <root>/node_modules/react-native-web/dist/cjs/index.js
```

Resolved identically from `apps/mobile` and from the monorepo root — no dual-React hazard, which is
the classic jest-expo-in-a-monorepo failure. Already half-explained by the repo's own
`bunfig.toml`, which pins `linker = "hoisted"` with the comment *"required for Metro / React Native
to resolve packages correctly"*.

## P7 — the finding census. **81% of `perf-static`'s output is work the React Compiler already does.**

```
react-rules: 6 finding(s) across 31 file(s)
      3  lint/suspicious/noEmptyBlockStatements
      2  lint/suspicious/noArrayIndexKey
      1  lint/correctness/useExhaustiveDependencies

perf-static: 168 finding(s) across 31 root(s)
    131  perf/unstable-child-prop
     19  perf/unresolved-prop
     12  perf/hook-missing-dependency
      4  perf/missing-memo-leaf
      1  perf/hook-extraneous-dependency
      1  perf/no-memoisation-with-children
```

Two results, and both were forecast the wrong way round.

**The feared `useExhaustiveDependencies` flood does not exist — the opposite does.** One finding, not
a wall. Biome does not know `useFocusEffect`'s signature, so rather than false-positiving it simply
**says nothing at all** about the hook 19 of the 31 route files depend on. The defect is silence, not
noise, and the fix is biome's `hooks` option rather than a suppression.

**The compiler wall is far worse than estimated.** `apps/mobile/app.json` sets
`experiments.reactCompiler: true` (the web app does not). `perf/unstable-child-prop`,
`perf/missing-memo-leaf` and `perf/no-memoisation-with-children` together are **136 of 168
findings — 81%** — every one of them advising memoisation the React Compiler performs automatically.
Shipping that is the "finding that cannot be acted on" this project refuses to emit, at four fifths
of the task's entire output. Compiler awareness is not a nicety; it is most of what `perf-static`
says on this app.

## Risk that dissolved — the `@/*` alias

`apps/mobile/tsconfig.json` declares `"paths": { "@/*": ["./*"] }` with **no `baseUrl`**, an unusual
shape flagged as the most likely wave-1 breakage. Measured: **the alias is never used.** Zero
`from "@/…"` imports across `app/`, `components/` and `lib/` — every import in the app is relative.
Still worth handling for other adopters; not a blocker here.

## Gap found while probing — the analyser cannot see class components

```
parseFile: could not locate a React component in components/error-boundary.tsx.
Expected an exported function/arrow component or a `const Name: React.FC<...> = ...` declaration.
```

`ErrorBoundary` is a class component, and it is **the only named export in the entire app** — every
other component is a default export or file-local. `parseFile` (`:235`, `:259`) finds function
declarations and variable statements only. Entirely platform-agnostic, nothing to do with React
Native, and it should not ride in on a native PR. Recorded as its own backlog item.

## Not yet run

**P2** (does `useFocusEffect` fire under a plain RNTL `render()` vs `renderRouter`?) and **P3** (the
CI install weight of jest-expo + RNTL + test-renderer) both need a real `jest-expo` install, which
does not exist in the monorepo yet. They are the content of the mybodycorpai `M1` PR, and their
answers land here when it does.

What is already known without installing: `expo-router/testing-library` **ships with expo-router 6
and is present** (`node_modules/expo-router/testing-library.js`), exporting `renderRouter` with a
real navigation context, `testRouter`, `toHavePathname`, and a full re-export of RNTL. Its compiled
source shows it calls `jest.useFakeTimers()` internally and resolves a string context through
`path.resolve(process.cwd(), …)` — so route specs run under fake timers, and only the in-memory
object context form is safe to emit. `react-native-reanimated/mock.js` and
`react-native-safe-area-context/jest` are both installed.
