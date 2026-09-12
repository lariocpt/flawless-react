# flawless-react

A multi-task quality kit for React components. Point it at a `.tsx` file (or a glob), pick which checks to run, and get back a runnable Playwright + Vitest suite, an accessibility scan, and a Biome-driven correctness report — with file:line findings for every issue.

Run it with no args for an interactive checkbox menu of seven tasks:

1. Generate the **performance testing harness** (Playwright + React `<Profiler>` + react-scan).
2. Generate **extensive unit + browser tests** (Vitest + @testing-library/react + Playwright functional).
3. **Static React perf analysis** (rerender storms, missing memoisation, stale/extraneous hook deps, setState-in-render).
4. **Accessibility scan** (web: Biome jsx-a11y rules; `--expo`: the native a11y analyser — file:line findings either way).
5. **Functionally important React rules** (Biome — useExhaustiveDependencies, useHookAtTopLevel, useJsxKeyInIterable, and friends).
6. **Route-level Playwright e2e** for Next.js pages, against the app's real dev server.
7. **crust load pipes** for those routes and the GET APIs their components fetch.

Pass a single positional that resolves to a file or a glob (e.g. `src/**/*.tsx`) — each match becomes an entry component and runs against every selected task. A small `<Component>.flawless.json` is dropped next to every source file so issues surface where the code lives.

The tool itself is a thin scaffolder. The intelligence is the static analysis that decides what to import, what props to vary, and which children to walk into. The runtime measurement is done by React's built-in [`<Profiler>`](https://react.dev/reference/react/Profiler) for per-component `renderCount` / `renderTime` and [`react-scan`](https://github.com/aidenybai/react-scan) for detecting unnecessary rerenders. Memory profiling uses Chrome DevTools Protocol's `HeapProfiler.takeHeapSnapshot` and writes `.heapsnapshot` files to `<outDir>/heaps/`. They are large — tens of MB each — and one is taken either side of every scenario, so `--heaps off` turns the capture off entirely.

Optional flags let you `--provider <file>` to wrap mounted components in your Redux / React Query / theme provider, and `--api <openapi.json>` to scaffold a standalone Bun mock server alongside the host so the component's `fetch('/api/…')` calls hit deterministic example responses.

Once the suite is generated, it belongs to you. A re-run regenerates derived files (specs inside the out dir, configs, generated prose) so they track your source; the files meant to hold your work — `budgets.json`, `host/main.tsx`, `provider.fixtures.ts`, `mocks/handlers.ts`, `e2e/global-setup.ts`, and colocated specs — are write-once or kept unless you ask otherwise.

## Contents

- [Why](#why)
- [Install](#install)
- [Quickstart](#quickstart)
- [CLI reference](#cli-reference)
- [What gets generated](#what-gets-generated)
- [Worked example](#worked-example)
- [Working with stores and APIs](#working-with-stores-and-apis)
- [Programmatic API](#programmatic-api)
- [Limits & assumptions](#limits--assumptions)
- [Troubleshooting](#troubleshooting)
- [Further reading](#further-reading)
- [Development](#development)

## Why

Manually wiring up a Playwright + `<Profiler>` + `react-scan` harness for a non-trivial component takes a couple of hours of fiddly boilerplate: bundle the component for the browser, host it, expose a JS API to drive renders, write the test scaffolding, define budgets, hand-pick prop variations, polyfill Node globals for CJS deps, set up Provider context, mock the backend. None of that work is interesting.

`flawless-react` reads the component's type signature, discovers its child components by walking the JSX, and produces all of that scaffolding mechanically. You get a runnable suite in seconds, and you can then **edit it like normal test code** — tighten budgets, add scenarios, mock data sources, swap in real fixtures.

## Install

Two channels, both served from the LAN on big-cachy. They ship different things, so pick by
whether the target machine has Bun.

**Source package** — every task works with no further setup, because `@biomejs/biome` comes
along as a real dependency. Requires Bun >= 1.1 at runtime.

```bash
bun add -g flawless-react --registry https://npm.in.drlario.org
# or one-shot, no install
bunx flawless-react ./src/Dashboard.tsx
```

**Standalone binary** — no Bun needed, nothing to install alongside it.

```bash
curl -fsSL https://apps.in.drlario.org/install.sh | bash -s -- flawless-react
```

One caveat worth knowing before you pick it: the binary is self-contained Bun, but it cannot
carry biome inside itself. `perf-harness`, `unit-browser` and `perf-static` work anywhere;
`react-rules` — and `a11y` on the web path — shell out to biome and will look for it in the
project you are scanning (`node_modules/.bin/biome`) and then on `PATH`. (`a11y` under
`--expo` is the tool's own native analyser and needs no biome.) Any React codebase that already
lints with biome satisfies that for free — otherwise `bun add -d @biomejs/biome` in that
project, or use the source package.

## Quickstart

```bash
bunx flawless-react ./src/Dashboard.tsx --out .profile/dashboard
cd .profile/dashboard
bun install
bun run test           # headless Chromium
bun run test:headed    # visible Chromium
```

You should see Playwright report five tests per analysed component (`mounts at defaults`, `variant matrix`, `click rerender`, `forced rerender × N`, `stress-click-rerender × 50`) and console lines with timing summaries. After the run, `<outDir>/heaps/` contains `.heapsnapshot` artefacts for every stress scenario, loadable in Chrome DevTools' Memory tab. Pass `--heaps off` to skip them.

## Next.js mode

Pass `--nextjs [<path>]` to target an existing Next.js project. Pass nothing — or `--nextjs .` — to use the current directory.

```bash
cd my-next-app
bunx flawless-react app/page.tsx --nextjs
```

In this mode flawless:

- detects whether you're on the **App Router** (`app/`) or **Pages Router** (`pages/`)
- auto-uses `app/layout.tsx` (or `pages/_app.tsx`) as the test-time provider, so context/css carries through
- walks `app/api/**/route.ts` (or `pages/api/**`) and emits `flawless/swagger.json` + `flawless/mocks/handlers.ts` (MSW)
- wires MSW into the host bundle for Playwright tests **and** into Vitest's setup for jsdom-based unit tests, so the same handlers intercept `fetch` at every layer
- merges its dev deps (`vitest`, `msw`, `@testing-library/*`, `@playwright/test`, …) into your project's `package.json` as `devDependencies`
- adds `flawless:unit` / `flawless:perf` / `flawless:browser` scripts so you can `bun run flawless:unit` etc. from your project root. A `flawless:*` script you have customised survives a re-run: only a value the tool recognises as one of its own past spellings upgrades; anything else is kept and named in the summary and REPORT.md (`> Kept script(s): ...`). Delete the key to take the tool's current command
- writes the runnable harness to **`<project-root>/flawless/`** — no separate npm project, no duplicated deps

Override the auto-detected app resolver with `--app-resolver <file>` if you have a custom wrapper. The generated `flawless/mocks/handlers.ts` is yours to edit — flawless won't overwrite it once it exists, so swap the empty `HttpResponse.json({})` bodies for realistic fixtures.

Three behaviours worth knowing before the first run:

- **The layout is usually unusable as a test provider.** An app-router `layout.tsx` is typically an async server component importing `next/font` or `next/headers`, none of which run under jsdom. flawless detects that and derives `flawless/provider.tsx` from the JSX chain enclosing `{children}`, keeping only `"use client"` components and literal attributes (everything dropped becomes a `TODO(flawless)` comment). `--force` regenerates it, so a change to the layout's provider chain reaches an existing suite — the values you supply live in `flawless/provider.fixtures.ts` beside it, which is never regenerated under any flag.
- **Point `--api` at a real spec.** Walking `app/api/**/route.ts` finds nothing useful when the API is a catch-all (Hono, tRPC). `--api openapi.json` (or `--swagger-url <url>`) puts real example bodies into both the MSW handlers and each generated fetch spec.
- **Generated files adopt your formatter.** Everything written is reformatted with the target project's own biome or prettier, and JSON merges preserve the file's existing indentation — generation produces an additive diff, not a reformat of your `package.json`.

## Expo / React Native mode

Pass `--expo [<path>]` to target an Expo project. Pass nothing — or `--expo .` — to use the current directory.

```bash
cd my-expo-app
bunx flawless-react --expo
```

flawless reads the project off disk — Expo SDK major, the expo-router `app/` root, whether the React Compiler is on (`app.json`'s `experiments.reactCompiler`, or `babel-plugin-react-compiler`), whether NativeWind is wired through babel, and the port `expo start --web` serves on — then defaults the entry glob to the router root and writes to `<expoRoot>/flawless/`.

**This mode is being built one task at a time, and it says so rather than pretending.** Today:

| task | under `--expo` |
|---|---|
| `unit-browser` | **runs** — jest-expo + `@testing-library/react-native` specs |
| `perf-static` | **runs** — pure AST analysis, and nothing in it is DOM-specific |
| `react-rules` | **runs** |
| `a11y` | **runs** — the native accessibility analyser (six rules over the parsed tree; see below) |
| `e2e` | **runs** — route specs against `expo start --web` (see below) |
| `load` | **refuses**, naming the wave that will implement it (wave 7, API-only pipes) |
| `perf-harness` | **refuses** — measured and declined, not deferred: on an expo-router app the population is route screens, which the browser host cannot mount (they need a navigator), so the measured ceiling on the dogfood app was ~0 of 32 components. The refusal points at the recorded evidence ([`docs/reviews/2026-09-expo-probes.md`](docs/reviews/2026-09-expo-probes.md)); the revisit condition is an adopter with a real `components/` directory of non-route components |

### The native unit plane

`--expo --tasks unit-browser` writes `jest.config.cjs`, a write-once `jest.setup.ts`, and one spec per exported component under `<outDir>/unit/`, then merges the runner into the app's `package.json` as `flawless:unit`.

The version pairing is derived, not guessed. `jest-expo` is pinned to the project's **own** SDK major — `jest-expo@54` pairs with Expo SDK 54, and a fixed range breaks every other adopter. `jest` is pinned to `^29` because that is what jest-expo's own tooling uses; a bare `jest` resolves to 30 and the mismatch surfaces as `this._moduleMocker.clearMocksOnScope is not a function` from inside jest-runtime, which names nothing you could act on. `@testing-library/react-native` is **13**, not 14, because expo-router 6's testing-library is built against `react-test-renderer` and RNTL 14 replaced it.

Two spec shapes, chosen from the file:

- **A route screen** mounts through `renderRouter` from `expo-router/testing-library`, at its own URL. Not a preference: `useFocusEffect` reaches `useNavigation()`, which throws `Couldn't find a navigation object` outside a navigator, and `useLocalSearchParams` is empty. Mounted inside a real navigator the screen is *focused*, so focus effects actually run — and the spec can assert the loaded state instead of the loading skeleton.
- **Everything else** mounts through RNTL's `render()`. A `_layout` is a third case: `<Tabs>` and `<Stack>` call `useContextKey` and throw `No filename found` on their own, so a layout is mounted through its own navigator with one synthesised child.

Where the source names a literal route — `onPress={() => router.push("/items/new")}` — the spec asserts the resulting pathname. That is the React Native analogue of asserting a link's `href`, and the emitted `renderRouter` context carries a stub for every such target, because a push to a route the context does not know lands on expo-router's injected `+not-found` and would fail for the wrong reason.

**No emitted spec touches the network.** A module that resolves project-locally and performs `fetch()` is `jest.mock`ed with stubs. That is not a nicety: before it existed, the fixture suite made live HTTP calls and crashed a jest worker with `api_error 405` from a real server.

**An unaddressable control becomes a named skip, never a pass.** React Native has no implicit roles — `getByRole("button")` matches nothing on a bare `<Pressable>` — and there is no last-resort locator, so a control with no `testID`, no `accessibilityLabel` and no text under it is skipped with the reason and the fix. On the dogfood app this used to be 28 of 48 press targets, 12 of them icon-only. Because each is *also* an accessibility finding, the app answered them — 48 `accessibilityLabel` and 28 `accessibilityRole` props — and the count is now **3 of 70**. That is the mechanism working: the skip named the fix, the fix was worth making on its own merits, and the test came back for free.

### The native a11y analyser

`--expo --tasks a11y` runs the tool's own analyser instead of biome, because biome structurally cannot say anything about React Native: all 29 of its a11y rules are HTML/ARIA, and over 31 real RN files carrying 82 unlabelled `<Pressable>`s they returned **zero** findings while scoring 3/3 on this repo's DOM offender fixture. A clean report that means "these rules do not apply" is worse than no report.

Six rules, each judged from the same parsed tree the rest of the analysis uses:

| rule | what it catches |
|---|---|
| `a11y/unnamed-control` | a press target that PROVABLY renders no text (icon-only or childless) and has no `accessibilityLabel` — silent to a screen reader and unaddressable to a spec; one label retires both |
| `a11y/missing-role` | a press target with no `accessibilityRole` — RN has no implicit roles, so its text is announced without "button" |
| `a11y/textinput-unlabelled` | a `TextInput` whose only name is a placeholder, which vanishes on input and is not a label |
| `a11y/icon-unhidden` | a free-standing vector icon exposed to the accessibility tree with nothing to announce (warn) — a render-prop icon (`tabBarIcon: () => <Ionicons/>`) stands down, because its owner is invisible to the file |
| `a11y/label-text-mismatch` | an `accessibilityLabel` that does not contain the visible text — voice-control users say what they see (WCAG 2.5.3) |
| `a11y/invalid-role` | a role value RN does not recognise — the union widens with `\| string`, so tsc never catches the typo |

Two structural properties matter more than the rule list. **The denominator**: the summary and `reports/a11y.json` always carry how many press targets, text inputs and icons were examined and how many rules ran, so a zero can never again be confused with "the rules do not apply". **Zero false positives over completeness**: every rule stands down where the source is not readable — `accessibilityLabel={t("back")}` is presence the analyser records and refuses to judge, and a pressable rendering `{item.name}` is never called unnamed, because it does announce at runtime.

### Route e2e against Expo web

`--expo --tasks e2e` emits one Playwright spec per expo-router route, run against `expo start --web` — Metro under SDK 54's static output serves **per-route rendered HTML with real status semantics** (an unknown path answers 404), all of it measured before the wave was built ([`docs/reviews/2026-09-expo-probes.md`](docs/reviews/2026-09-expo-probes.md)).

The machinery is the Next.js flavour's — the same `params.json` id fixture (expo-router's `[param]` templates are byte-compatible), the same write-once `global-setup.ts` with the hand-work tally, the same `--grep`-able `GET <route>` titles for `--changed` narrowing — plus three Expo-specific facts baked in:

- **Auth is a cookie on the API origin.** On web the app calls its API with `credentials: "include"`, so the setup stub's worked example is a request-context login + `storageState`, verbatim. No token injection.
- **An auth wall has two faces, and the specs catch both.** A client-side redirect fails the landing assertion; a wall rendered *in place* keeps the URL and answers 200 — but the API's 401s land in the console assertion, and the **copy witness** (a third test asserting the screen's longest analysis-proven literal is visible) fails on any screen that is not the one the analysis described.
- **Two servers.** The emitted config boots Metro; your API is a prerequisite it cannot know how to start. Set `EXPO_PUBLIC_API_URL` before running — Metro inlines it into the bundle, and an unset value silently falls back to whatever the source hardcodes (on one dogfooded LAN, a production container).

A refusal is a failed `TaskResult`, not a thrown error: it lands in `results[]`, in the `--ci` blob and in `REPORT.md`, so a machine can read it. A mixed selection still runs what it can — asking for one unported task does not cost you the ones that work.

Refusing is deliberate. Emitting the DOM suite for a React Native project would produce specs that run, pass, and touch nothing: `container.querySelector("Pressable")` matches no element, and `getByRole("button")` finds nothing because React Native has no implicit roles. A green suite that tested nothing is the one outcome this tool must never produce.

Two things measured on a real Expo app before any of this was written, both recorded in [`docs/reviews/2026-08-expo-probes.md`](docs/reviews/2026-08-expo-probes.md):

- **The `a11y` task was vacuously green on React Native.** Zero findings across 31 files carrying 82 `<Pressable>` elements with no `testID`, `accessibilityLabel` or `accessibilityRole` between them — while the same sweep found 3/3 on this repo's own offender fixture. All 29 rules are HTML/ARIA rules, and React Native has no `<img>`, `<a>` or `<button>`. It needed a different engine, not a different config — the native analyser above is that engine.
- **The React Compiler changes what `perf-static` should say.** On a project with `experiments.reactCompiler: true`, 136 of 168 findings were the three memoisation rules — work the compiler already does. `--expo` reads the flag today; acting on it is a later wave.

## CLI reference

```text
flawless-react <entry.tsx> [options]
```

| Flag | Default | Effect |
| --- | --- | --- |
| `<entry.tsx>` | required | Path to the root component file. |
| `--out <dir>` | `<cwd>/.flawless` (`<project>/flawless` under `--nextjs`) | Output directory for the generated suite. |
| `--depth N` | `3` | Levels of locally-imported child components to follow (`0` = leaf only). |
| `--variants N` | `5` | Prop-variant rows in the generated test matrix. |
| `--changed [REF]` | off | After generating, run only the specs an edit affects — the changed components' unit/browser/profile specs, plus any e2e route whose page *renders* one of them. Defaults to comparing the worktree against `HEAD`. |
| `--heaps MODE` | `stress` | V8 heap snapshots in the profile suite: `off`, `stress`, `all`. Each snapshot is tens of MB and one is taken either side of every scenario, so `off` also removes an observer from inside the measurement. |
| `--include-children` | `true` | Walk transitive child components. Pass `--include-children=false` to skip. |
| `--props '<json>'` | none | Override the synthesized default props. Merged on top of the static-parse result. |
| `--provider <file>` | none | Path to a `.tsx` file that default-exports a wrapper component. The host renders every mounted component inside it — use this for Redux, React Query, theming, or any other context-based store. |
| `--expo [<path>]` | Treat `<path>` (or cwd) as an Expo project: read its SDK major, expo-router root, React Compiler and NativeWind settings, and place everything under `<expoRoot>/flawless/`. Mutually exclusive with `--nextjs`. |
| `--app-resolver <file>` | auto-detected under `--nextjs` | Alias for `--provider` in Next.js mode. Overrides the wrapper derived from `app/layout.tsx` or `pages/_app.tsx`; the file must default-export a wrapper component. |
| `--api <spec>` | none | Path to an OpenAPI / Swagger JSON or YAML file. Scaffolds a standalone Bun mock server (`mock/server.ts`) with static route handlers generated from the spec's first example responses; the host server transparently proxies all non-asset requests to it. Read by `perf-harness`, and by the MSW emit under `--nextjs` — it does nothing for a `--tasks unit-browser` run outside Next.js mode. |
| `--colocate` | off | Write unit specs beside their source as `<name>.flawless.test.tsx`. Existing colocated specs are kept unless `--force` — they're the ones you hand-harden. Each opens with a `// @flawless-generated sha256:…` stamp so `--force` can tell an untouched spec from one you edited. |
| `--ci` | off | Shorthand for `--no-interactive --json`. |
| `--force` | off | Regenerate the files a plain re-run keeps: colocated specs, e2e route specs, the derived provider wrapper. A colocated spec is only rewritten while its provenance stamp still matches — hand-edited (or pre-stamp) specs are kept and listed; delete one to regenerate it. A re-run already refreshes the out-dir harness; write-once files are never touched under any flag. |
| `--report` | off | Emit `scripts/report.mjs` so `bun run report` aggregates run output into a markdown summary. |
| `--tasks <ids>` | `perf-harness` | Comma-separated subset of `perf-harness,unit-browser,perf-static,a11y,react-rules,e2e,load`. Omitting it does **not** run all seven — a non-interactive run with no `--tasks` runs `perf-harness` alone. In a TTY you get the checkbox menu instead, with `perf-harness` and `perf-static` preselected. |
| `--roots <mode>` | `primary` | `exported` emits one tree per *exported* component — what a whole-app sweep needs, since a shadcn `card.tsx` exports seven of them. |
| `--exclude <glob>` | see below | Repeatable. Added to the defaults, which already skip `*.flawless.test.*`, `*.test.*`, `*.spec.*`, `*.stories.*`, `*.d.ts`, `node_modules`, `.next`, `dist`, `build`, `coverage` and `flawless/`. A non-default `--out` is not excluded automatically — add it yourself, or a second sweep analyses the suite it just wrote. |
| `--no-default-excludes` | off | Drop those defaults and use only what `--exclude` names. |
| `--no-interactive` | off | Never prompt. Required in CI and by any script. |
| `--run-tests` | off | Run the generated suites after writing them. Only `perf-harness`, `unit-browser` and `e2e` generate a runnable suite — ask for it with none of those selected and the run says so on stderr and records `testRun.mode: "none"`, rather than exiting 0 as if suites had passed. |
| `--json` | off | Print the machine-readable run result to stdout. |
| `--no-inline-summary` | off | Skip the per-component `<Component>.flawless.json` sidecars. |
| `--swagger-url <url>` | auto-probe under `--nextjs` | Fetch the OpenAPI spec over HTTP instead of reading a file. `off` disables the probe entirely. Only consulted in `--nextjs` mode; outside it the value is parsed and never read. |
| `-h, --help` | — | Print the flag reference above and exit 0. |
| `-V, --version` | — | Print the version and exit 0. |
| `-h, --help` | — | Show help. |
| `-V, --version` | — | Show version. |

With `--json` (or `--ci`) the CLI prints `{ exitCode, outDir, results, keptScripts, testRun?, errors? }` and nothing else on stdout — the human summary table is suppressed, and everything `--run-tests`/`--changed` suites say (banners, verdicts, the runners' own reporters) goes to stderr, so stdout always parses. `exitCode` mirrors the process exit code, suite failures included. Without the flag you get the table and no JSON.

Two of those fields exist so the exit code is *explicable*, not merely correct:

- **`testRun`** — what the test-run phase did. `{ mode: "generated" | "affected", green }` means suites **actually ran**, and `green` is what folded into the exit code; `{ mode: "none", reason }` means **zero suites ran** and says why — nothing selected generates a suite `--run-tests` executes, nothing was affected, or the selected tasks plan no run for the work that was. The invariant to rely on: `mode: "none"` if and only if nothing executed, so a `green` field never appears on a phase that ran nothing. Absent means the run never *reached* the phase — including a request blocked by a failed task, so read absent as "look at `results`", never as "no run was asked for". Without this field, exit 0 conflates *"the suites passed"* with *"no suite ran"*.
- **`errors`** — failures that belong to no task and so appear nowhere in `results`, such as a Next.js emit that threw. Omitted entirely on a clean run.

Suppressing stdout is not a vow of silence: **diagnostics still reach stderr under `--ci`** — a file the sweep skipped, an unparseable OpenAPI spec, a test-script collision, a failed Next.js emit. Those are the lines an unattended caller most needs, and they used to share the flag that silenced the table.

## What gets generated

```text
<outDir>/
├── package.json          # standalone deps: react, react-dom, react-scan, @playwright/test
├── tsconfig.json
├── playwright.config.ts  # auto-boots host/server.ts (and mock/server.ts if --api)
├── host/
│   ├── server.ts         # Bun.serve over a Bun.build bundle of your component(s)
│   ├── _polyfill.ts      # browser polyfills for process/global/setImmediate
│   ├── index.html        # mounts the host bundle
│   ├── registry.ts       # REGISTRY/FN_PROPS/WRAP_IN mount tables — regenerated every run
│   └── main.tsx          # write-once wrapper: createRoot + <Profiler> + react-scan + window.__profile driver
├── profile/
│   ├── _helpers.ts       # render-info / scan-event harvesters, summarize() stats
│   ├── _heap.ts          # CDP-driven heap-snapshot helpers (write to <outDir>/heaps/)
│   └── <Component>.profile.spec.ts   # one per analysed component
├── mock/                 # only if --api was passed
│   ├── server.ts         # Bun.serve on :5174, host proxies /api/* requests to it
│   └── routes.ts         # static route handlers derived from the OpenAPI spec
├── budgets.json          # per-component mount/update budgets (warn-only by default)
├── scripts/report.mjs    # only if --report
├── heaps/                # populated at test time — V8 .heapsnapshot files
└── README.md             # how to run + customise the suite
```

For a deeper walkthrough of each file's role, see [docs/generated-suite.md](docs/generated-suite.md).

## Worked example

Take a small dashboard:

```tsx
// src/Dashboard.tsx
import type { FC } from "react";
import { useMemo } from "react";
import { Hello } from "./Hello.tsx";
import { Card } from "./Card.tsx";

interface DashboardProps {
  title: string;
  count: number;
}

export const Dashboard: FC<DashboardProps> = ({ title, count }) => {
  const items = useMemo(() => Array.from({ length: count }, (_, i) => i), [count]);
  return (
    <main>
      <h1>{title}</h1>
      <Hello name="alice" count={count} active variant="primary" />
      {items.map((i) => <Card key={i} title={`card ${i}`} body="hi" />)}
    </main>
  );
};
```

Run:

```bash
bunx flawless-react ./src/Dashboard.tsx
```

The CLI prints something like:

```json
{
  "outDir": "/your/cwd/.flawless",
  "results": [
    { "id": "perf-harness", "ok": true, "outputs": ["…"], "findings": [], "summary": "scaffolded perf suite for 3 of 3 component(s): Dashboard, Hello, Card" }
  ]
}
```

Inside `.flawless/profile/` you get three spec files (`Dashboard.profile.spec.ts`, `Hello.profile.spec.ts`, `Card.profile.spec.ts`). Each spec contains:

- **`mounts at defaults`** — baseline mount; asserts `renderCount >= 1`; warns if `mountMs` (from `React.Profiler`'s `onRender` `actualDuration`) exceeds `budgets.json[name].mountMs`.
- **`variant matrix`** — for `Hello.variant: "primary" | "secondary"`, the analyser produces two variants; the test rerenders with each and warns on the p95 over `updateMs` budget.
- **`click rerender`** — clicks the target the analyser derived from your source (a test id, an `aria-label`, a role plus its accessible name, an `id`, or literal copy), opening any disclosure it sits behind first, and asserts the render count incremented; if `react-scan` flagged any unnecessary rerender on a prop-stable child, the spec logs a warning. When nothing in the source names a target, the scenario is a skip carrying the reason — never a click on whichever button happens to be first.
- **`forced rerender × N`** — cycles `--variants × 10` rerenders through the variant pool and prints `min / avg / p50 / p95 / max` from the `Profiler`-fed `renderTime.updates` array.
- **`stress-click-rerender × 50`** — clicks the primary button 50 times between a baseline and a final V8 heap snapshot (via Playwright's CDP `HeapProfiler.takeHeapSnapshot`). Both `.heapsnapshot` files land at `./heaps/<spec>__<test>__<label>.heapsnapshot` — deterministic names you can `open` straight from the terminal and drop into Chrome DevTools' Memory tab → Comparison view to spot retained objects. The other three scenarios are also bracketed by snapshots, but those are only persisted on failure to keep CI artefacts small.

After `bun install && bun run test`, the console shows lines like:

```text
[Hello variants] {"min":0.4,"avg":1.1,"p50":0.9,"p95":1.8,"max":2.3,"n":2}
[Hello forced] {"min":0.3,"avg":0.7,"p50":0.6,"p95":1.1,"max":1.6,"n":10}
[Hello hooks] useState
[heap] stress-click-rerender: 11896752 -> 12595549 bytes (delta +698797) -> heaps/Hello-profile__Hello-stress-click-rerender-x-50__stress-click-rerender-after.heapsnapshot
```

## Working with stores and APIs

If your component reads from a Redux/Jotai/React Query/Context store, wrap it once and pass the wrapper to `--provider`:

```tsx
// src/providers/AppProvider.tsx
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { QueryClientProvider } from "@tanstack/react-query";
import { store } from "../store";
import { queryClient } from "../query";

export default function AppProvider({ children }: { children: ReactNode }) {
  return (
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </Provider>
  );
}
```

```bash
bunx flawless-react ./src/Dashboard.tsx --provider ./src/providers/AppProvider.tsx
```

If the component fetches data, point `--api` at your OpenAPI / Swagger spec:

```bash
bunx flawless-react ./src/Dashboard.tsx --api ./docs/api.yaml
```

The scaffolder reads the spec at generation time, walks every `paths.<route>.<method>.responses` and emits static handlers in `mock/routes.ts` (priority: first `examples` → `example` → schema-synthesised default). The mock listens on port 5174; the host server (5173) transparently proxies every non-asset request to it, so `fetch('/api/users')` from your component hits the mock without any code changes. Edit `mock/routes.ts` freely after generation to add stateful logic or per-test overrides.

## Programmatic API

```ts
import { runFlawless, analyse, analyseTree } from "flawless-react";

const { results, trees, outDir } = await runFlawless({
  entry: "src/components/Widget.tsx",
  nextjs: ".",
  tasks: ["unit-browser", "perf-static"],
  apiSpec: "openapi.json",
  colocate: true,
});
```

It never calls `process.exit`; bad input throws `UsageError`. `analyse()` (entry → `ComponentTree`), `analyseTree()` (the static perf rules as a pure function), the scaffolders and `detectNextjs` are exported too, so custom reporting is a tree walk rather than CLI-output parsing. See [docs/e2e-and-api.md](docs/e2e-and-api.md).

## What the generated unit specs actually assert

Everything is derived from static analysis, so the specs only claim what can be proven from the source:

- render at defaults, plus a variant matrix for literal-union props;
- one test per detected interaction, each asserting the **other** handler props were *not* called;
- initial-state witnesses and handler→setter tests from the `useState`/`useReducer` map;
- one `describe` per `useEffect` fetch covering **success / loading / error / empty** through MSW overrides, with fixture bodies pulled from your OpenAPI spec;
- async server components get `await Component(props)` plus `vi.mock` stubs for their data imports (and no browser spec — they can't mount).

Anything that could not be derived is left as a `TODO(flawless)` marker rather than a silently-passing assertion. The workflow is: generate, run, fill the TODOs with real fixtures, rerun. With `--colocate`, regeneration won't touch specs you've hardened.

## Limits & assumptions

The static analyser is deliberately narrow — it favours predictability over cleverness.

- **Component shape**: `const X: React.FC<Props> = …`, exported function declarations, JSX-returning arrows, anonymous `export default (…) => …` (named after the file), and `memo()` / `forwardRef()` wrappers. HOCs, decorators and dynamic component factories are still not detected.
- **Props type**: same-file types resolve directly; imported types are chased **two hops** — including types from the repo's own **workspace packages** (`@scope/shared`, resolved through the workspace map into the package's source, with barrel re-exports chased to the declaring file). Intersections (`A & B`), host-element props (`ComponentProps<"div">`), `ComponentProps<typeof LocalX>` and cva tables (`VariantProps<typeof buttonVariants>`) all resolve. `z.infer`/`z.input` aliases resolve by reading the zod schema **syntactically** (object/enum/primitive/array/coerce subset with `.optional`/`.nullable`/`.default`/`.partial`/`.extend`; type-invariant refinements like `.min`/`.email` are ignored; `.transform`, unions, records and dates bail). **Unions of non-literals**, `Omit`/`Pick`/`Partial` and anything in `node_modules` do not resolve — they land in `unresolvedProps` (the prop) and `unresolvedTypes` (the type that defeated it). Pass `--props '{…}'` or edit the spec's `DEFAULTS`.
- **What the specs assert**: literal copy the component renders unconditionally, the root tag, children and `className` passthrough when the value provably reaches the DOM, and that every cva option renders a *distinct* class list. Never a specific Tailwind token — `cn()` is usually tailwind-merge, which drops base classes a later variant conflicts with.
- **Which render is described**: the JSX the component produces at the props the spec passes, not the last `return` in the body. A guard the analyser can decide is followed; one it cannot, that returns nothing, falls through to the tail and is flagged; one it cannot, that returns content, produces no description at all.
- **Mocks**: emitted from a component's OWN imports. Client specs mock an allowlist only (`next/navigation`, `next/headers`, `server-only`, `next/link`, `next/font/*`, and any `"use server"` module) — mocking a `cn` util would strip every className off the markup. A component that renders `<Link>` only through a child gets no `next/link` mock in its own spec. A server action whose source returns a single literal value is stubbed with that value rather than `{}`, and its TODO marker is dropped once every export of the module resolves. Data deps get the same courtesy from their declarations: a `Promise<T>` return annotation (or a single-`fetch` body joined to the OpenAPI example) becomes the mock's fixture, marked with an `/* inferred from … */` provenance comment — and the declaration may live in another workspace package, behind its barrel. An `interface X extends Y` merges its bases, own members last, and bails whole if any base does not resolve. An export wrapped in `cache()` or `unstable_cache()` is unwrapped — those hand back the same call signature, so the inner annotation is the effective return type; any other wrapper still bails, because it may not. A type re-exported from an import (`import type { User } …; export type { User };`) is chased through, which is how a package republishes a type it does not own. A helper that is called but never awaited into a variable — a formatter used inside JSX — is read from its declaration too, and stubbed **synchronously** when it is synchronous: `formatZAR(cents: number): string` mocked as `async () => ({})` renders every money value as an object.
- **How an element is addressed**: test id, then `aria-label`, then role + accessible name, then `id`, then literal copy. The last resort is the bare host tag — and only when it is the only element of its kind in that render, counting `<Button>` towards `button`. A tag that has competition names nothing, so the test becomes a skip that says so rather than a click on whichever element happened to be first.
- **How a form is submitted**: from the markup, never from likely wording. A host `<button>` inside a form submits it unless its `type` says otherwise; a component tag counts only with an explicit `type="submit"`, because shadcn and base-ui both render `type="button"` by default. No submit control in the source means no submit test.
- **How a field is filled**: from its `tag` and `type`. Checkboxes and radios are checked, `<select>`s selected, and hidden/file/range/color inputs skipped — a value typed into them asserts nothing. A change handler on a `<form>` is treated as the event delegation it is, not as a text box.
- **What a mount spec may assert about the console**: a component that calls `console.error`, or `.error()` on an imported binding, reports errors by design. Its browser spec keeps the uncaught-exception and rendered-output assertions and drops the console one, naming the call it saw.
- **Where a compound part is mounted**: a root tag HTML confines to a particular parent (`<tbody>`, `<tr>`, `<option>`, `<li>`…) is mounted inside that chain in the browser host. That is the specification, not an inference about your app; without it React logs a nesting warning the harness itself provoked.
- **Type → default value**: primitives, arrays (always `[]`), inline object types (recursive), literals, and `Promise<T>` (synthesised unwrapped, re-wrapped at render time for Next.js `params`). A string prop defaults to `""` — except under a Next page's `params`, where an empty segment is a request Next cannot route, so it is filled with `flawless-<key>` instead.
- **Fixtures satisfy the component's own predicates.** A field the source compares with `===` to a literal takes that literal, and a field compared to one of the component's props takes that prop's value, read from the same fixture the spec's `DEFAULTS` carries. Without this a page that filters `m.status === "active"` rejects every synthesised row, calls `notFound()`, and its spec passes having rendered nothing — which is what 22 of 32 page specs did on the dogfood app. `!==` is not used: it says what a value must not be, which does not pick one out.
- **Variant matrix**: only union-of-literal props produce variants. The matrix is "pairwise" — vary one prop at a time around the defaults, not the full cartesian product.
- **Children**: relative imports, tsconfig `paths` aliases (with `extends` chains), **and** the repo's own workspace packages; member tags like `<UI.Badge/>`, namespace imports, and same-file components. Anything in `node_modules` is skipped. Depth defaults to 3, cycle-guarded.
- **Hooks**: matched by name pattern `/^use[A-Z]/`, with per-call-site detail — dependency arrays, callback reads, and effect features (fetch/timers/listeners/cleanup) — feeding the dependency findings and the generated fetch specs.
- **Everything bails rather than guesses.** Dependency findings skip hooks whose deps contain member access or spreads, or whose callback isn't inline; memoisation findings skip children with spread props or identifiers the analyser can't resolve. There is no type checker, so a clean report means "nothing this analysis can prove", not "nothing wrong".

## Troubleshooting

**"could not locate a React component in …"**
The analyser didn't recognise the export shape. Refactor to a `const X: React.FC<Props> = …` declaration, or pass `--include-children=false --depth=0` and run the tool against the actual component file directly.

**`unresolvedProps` warning**
One or more props use an imported type, a generic, or a non-literal union. Either:

- Re-run with `--props '{"propName": "value", …}'`, or
- Edit the generated `profile/<Component>.profile.spec.ts` and add the missing fields to the `DEFAULTS` constant.

**Generated suite fails on `bun install` with a peer-dep mismatch**
The suite pins `react` / `react-dom` to `^18.3.0`. If your parent project is on React 17 or React 19, edit the generated `package.json` to match before `bun install`, then re-`bun install`.

**Playwright can't find a browser**
First time you run a generated suite, you may need `bunx playwright install chromium`. If a Playwright upgrade pulled in a new browser version, run the same command again.

**`window.__profile` is undefined inside tests**
The host bundle didn't load. Check the Playwright stderr — `bun host/server.ts` should print `host listening on http://127.0.0.1:5173`. If it doesn't, `cd` into the suite and run `bun host/server.ts` directly to surface the build error.

**Component reads `useSelector` / `useContext` / etc. and throws "could not find … in the context"**
Pass `--provider <file>` pointing at a `.tsx` that default-exports a wrapper component including your Redux Provider, QueryClientProvider, ThemeProvider, etc. The host will wrap every mounted component in it.

**Component fetches `/api/...` and gets a 404**
Either pass `--api <openapi.json|yaml>` to scaffold a mock server, or edit the generated `mock/routes.ts` after the fact (when `--api` was passed) to add the missing route. Without `--api`, no mock server is generated and `/api/*` requests return 404 from the host server.

**Mock server says `YAML parsing requires Bun >= 1.2`**
Either upgrade Bun, or convert your spec to JSON: `bunx js-yaml api.yaml > api.json` and pass the JSON file to `--api`.

## Further reading

- [docs/architecture.md](docs/architecture.md) — how the analyser and scaffolder fit together.
- [docs/generated-suite.md](docs/generated-suite.md) — anatomy of the emitted suite, file by file.
- [docs/extending.md](docs/extending.md) — patterns for editing generated specs without regretting it.
- [docs/e2e-and-api.md](docs/e2e-and-api.md) — route e2e, crust load pipes, and the programmatic API.

## Development

```bash
bun install
bun test           # the full suite across analyse / scaffold / tasks / nextjs / core / cli
bun run check      # biome lint + format check
bunx tsc --noEmit  # type-check
```

The repo layout:

```text
src/
├── analyse/         # ts.createSourceFile AST walk — no type checker
│   ├── parseFile.ts        # every component in a file; export kind, async, "use client"
│   ├── resolveModule.ts    # tsconfig paths + extends chains
│   ├── extractProps.ts     # defaults, variants, positions, promise props
│   ├── extractState.ts     # useState/useReducer/useRef map + setter call sites
│   ├── extractHooks.ts     # hook names + per-call-site detail (deps, effects)
│   ├── extractPropUsage.ts # where each prop is used, classified
│   ├── extractChildAttrs.ts# value shapes passed to component children
│   ├── extractFetchCalls.ts# fetch URLs as :hole templates
│   ├── extractInteractions.ts
│   ├── refs.ts             # shared ComponentScope + reference collection
│   └── walkChildren.ts     # recursive tree, alias- and member-tag aware
├── scaffold/        # perf harness templates + host-style adoption
├── scaffold-tests/  # unit + browser spec templates
├── nextjs/          # detection, api routes, mocks, provider wrapper, routes
├── tasks/           # one module per TaskId (7)
├── reporters/, runner/
├── core.ts          # runCore — the CLI's engine, no process.exit
├── cli.ts           # argparse + interactive menu
├── index.ts         # public programmatic API
└── types.ts
tests/               # fixtures/ includes a static Next.js app
```

## Licence

MIT — see [LICENSE](LICENSE) if present, otherwise treat as MIT.
