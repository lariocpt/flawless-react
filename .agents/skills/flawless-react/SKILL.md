---
name: flawless-react
description: Generate and maintain React/Next.js/Expo test suites with flawless-react — task selection, Next.js and Expo modes, provider wrappers, MSW fixtures from an OpenAPI spec, colocated specs, route e2e, crust load pipes, the programmatic API, and how to read its findings. Use when adding component/e2e/load tests to a React codebase, when a generated flawless suite is red, or for "scaffold tests for this component" work. Deeper guidance lives in the sibling skills flawless-nextjs, flawless-unit-browser, flawless-perf-harness, flawless-perf-static, flawless-a11y, flawless-react-rules, flawless-findings, flawless-e2e, flawless-load, flawless-api-fixtures, flawless-regen, flawless-api, and flawless-expo.
---

# flawless-react

Point it at a `.tsx` file or glob and it reads the component's props, state,
hooks, children and fetches, then writes a runnable suite. Everything it emits
is yours to edit, but most of it is REGENERATED — the suite improves, and a
frozen file never receives the improvement. Only what the tool cannot rebuild is
protected: `budgets.json`, `host/main.tsx`, `provider.fixtures.ts`,
`e2e/global-setup.ts`, `e2e/params.json`, `mocks/handlers.ts`, and colocated
specs. To keep a hand-hardened component spec, use `--colocate`; specs written
inside the out dir are rewritten.

```bash
# one component, unit specs only
bunx @lariocpt/flawless-react src/components/Widget.tsx --tasks unit-browser --no-interactive

# a Next.js app: real fixtures, colocated specs, route e2e and load pipes
cd apps/web
bunx @lariocpt/flawless-react "src/app/dashboard/page.tsx" \
  --nextjs . --api openapi.json --swagger-url=off \
  --tasks unit-browser,perf-static,a11y,react-rules,e2e,load \
  --colocate --no-interactive
```

## Which skill to load

This skill is the map. Each plane's traps live in its own skill.

| situation | skill |
| --- | --- |
| `--nextjs`: provider derivation and drops, module stubs, React pins, `package.json` merge, `.env` order | flawless-nextjs |
| unit + browser spec shapes, provider wrapper, `TODO(flawless)`, registered mocks | flawless-unit-browser |
| the runtime perf plane: `host/`, `profile/`, budgets, `--heaps`, port 5173 | flawless-perf-harness |
| the static analyser's nine `perf/*` rules, sidecars, what a clean report means | flawless-perf-static |
| accessibility findings (biome a11y on web, the six native rules) | flawless-a11y |
| the curated biome correctness/suspicious sweep | flawless-react-rules |
| triaging a findings list, REPORT.md accounting, suppressions, the counts ledger | flawless-findings |
| route e2e against a real app: login, `params.json`, the auth wall | flawless-e2e |
| crust load pipes, `LOAD_BASE`/`LOAD_AUTH`, baselines, anti-vacuous probes | flawless-load |
| `--api` / `--swagger-url`, MSW handlers, synthesised fixture bodies | flawless-api-fixtures |
| re-running over an existing suite: `--force`, `--changed`, kept vs refreshed | flawless-regen |
| `runFlawless()` / `analyse()` from a script | flawless-api |
| `--expo`: what runs, what refuses, native specs and selectors | flawless-expo |

## Tasks

| id | what it writes | needs |
| --- | --- | --- |
| `unit-browser` | Vitest + Testing Library specs (+ Playwright browser specs when `perf-harness` is also selected) | — |
| `perf-harness` | `host/` bundle + Profiler/react-scan Playwright suite + heap snapshots | — |
| `perf-static` | `reports/<C>.perf-static.json` findings, no files to run | — |
| `a11y` | web: biome's a11y rule group; `--expo`: the tool's six native `a11y/*` rules | biome in the target project (web path only) |
| `react-rules` | biome `correctness` + `suspicious`, curated; scratch config, local `biome.json` bypassed | biome |
| `e2e` | `flawless/e2e/` route specs against a real dev server | running app + seeded data |
| `load` | `flawless/load/routes.pipes` crust load pipelines | crust to run them |

Pick tasks explicitly with `--tasks a,b`; with no args in a TTY you get a
checkbox menu.

Over an EXISTING suite, a re-run exits 0: `perf-harness` refreshes its derived
files exactly as a fresh scaffold would (write-once files untouched; TaskResult
and REPORT.md carry `status: "refreshed"`), and under `--changed` it keeps the
harness entirely — nothing written, `status: "kept"` — so the affected-test run
happens with any task selection. `--force` is only for regenerating what a
plain re-run keeps (colocated specs, e2e route specs, the provider wrapper).
See the flawless-regen skill for the full regeneration contract.

## Next.js mode

`--nextjs [path]` detects the router, auto-selects a provider, writes
everything under `<root>/flawless/`, merges devDeps + `flawless:*` scripts into
the project's `package.json`, and appends gitignore entries.

Ignore entries are appended in **every** mode, not only under `--nextjs`. Outside
Next.js mode they go to the git root (then the nearest `package.json`, then the
out dir's parent). Until that was fixed a plain run ignored nothing it
generated, including `<out>/e2e/.auth.json` — the file the emitted global-setup
tells you to persist a logged-in storageState into.

**Providers.** App-router `layout.tsx` is usually an async server component
importing `next/font` or `next/headers` — unusable under jsdom. flawless
detects that and derives `flawless/provider.tsx` from the JSX chain that
encloses `{children}`, keeping only `"use client"` components and literal
attributes. What it leaves out is named where you will read it: a dropped
attribute as a `TODO(flawless)` comment beside the wrapper, a dropped provider
layer in a block at the top of the file with the reason and the fix. A provider
layer whose module directly imports an auth library (`@clerk/*`, `next-auth`)
is skipped rather than mounted: the unit and browser planes replace those
libraries with a signed-out stub, so a provider gating its children on a
session renders *nothing* and every spec inherits the blank screen — while the
stub already satisfies the context reads auth-consuming components make. Expect
the components under it to fail on "Could not find Convex client" or "could not
find … in the context" — that is the drop, not the component. `--force`
regenerates it, so a change to the layout's provider chain reaches an existing
suite — put the values you supply (a seeded auth state, a theme) in
`provider.fixtures.ts` beside it, which is never regenerated under any flag.
Pass `--provider <file>` to override — that is also the way to supply a context
the derived wrapper dropped, since editing `provider.tsx` does not survive
`--force`. In plain (non-Next) mode there is no derived `provider.tsx` at all:
every render is wrapped in a per-component nest derived from hook-call,
namespace-compound, transitive-requirement and dynamic-render evidence (a
dynamic `<Tag />` bound from a project hook's return owes what that hook's
values can hand out) — the app's own providers,
convention matches for bare-module hooks, and generated shims for library
contexts — and `--provider` sits outside that nest.

**API fixtures.** Static route walking only sees `app/api/**/route.ts`, which
is useless for catch-all APIs (Hono, tRPC). Pass `--api openapi.json` (or
`--swagger-url http://localhost:3000/api/docs`) and real example bodies flow
into `flawless/mocks/handlers.ts` and into each generated fetch spec. Use
`--swagger-url=off` to skip the live-spec probe.

Everything below that summary is in flawless-nextjs — module stubs and the rule
that a named one outranks a pattern one, the Testing Library pins and how a stale
range is repaired, the `package.json` merge with `pnpm.ignoredBuiltDependencies`,
the two `.env` load orders, and where gitignore entries land.

## React 17 / 18 / 19

The app's React major (`detectAppReact` in the root `package.json`) is the
single switch. At or above 18 the host mounts through `createRoot`; below 18
it falls back to legacy `ReactDOM.render`, document roots render with
`renderToStaticMarkup`, and promise-valued props are not passed. The suite's
`react`/`react-dom` are pinned to the version the app has INSTALLED, exactly:
`detectAppReact` reads `node_modules/react` before the declared range, because a
caret is a floor and `^19.2.0` installs whatever is newest. Where the analysed
sources resolve a different copy than that walk finds — a workspace whose root
declares no react while a sibling package holds one — `appReactPin` reads the
pin off the copy the emitted `react` aliases anchor on instead, because the pin
and the alias have to name the same physical copy or one plane ends up with two
React copies. Where no manifest declares a version at all — a library whose
react is a peer, `"^18.0.0 || ^19.0.0"`, declares no version — the nearest
installed pair is used instead,
scoped so an ancestor's tooling react never out-votes a real declaration. Two
React copies is the classic red-suite cause, and a pair that merely drifts is
just as fatal — one patch off dies at load on react-dom's guard
(`Incompatible React versions`), one major off on `Cannot read properties of
undefined (reading 'ReactCurrentOwner')`. A stale or loose pin left in an
existing suite manifest is rewritten by the next run (`repairReactPin`).
Testing Library follows the app: React ≤17 gets
`@testing-library/react@^12.1.5` + `@testing-library/dom@^8.20.1` — 13/14
peer-require react ^18 and 14 hard-requires the `react-dom/client` entry that
does not exist in 17. A stale 13+ range left by an older run is repaired by
the next one (`repairRtlPin`).

Two footprints complete the merge: for pnpm apps the `package.json` merge
records `pnpm.ignoredBuiltDependencies` for the deps it introduces
(`@playwright/test`, `msw`) — pnpm ≥10 errors on an unrecorded build-script
decision, and `ERR_PNPM_IGNORED_BUILDS` killed the app's own `pnpm run dev`
before Next could boot; and the suite's Vitest config reads the app's
`.env.test.local` → `.env.example` (first value wins, env vars beat them) —
`.env.example` last because template repos ship only the example, and its
placeholders exist to satisfy module-scope construction.

## Expo / React Native mode

`--expo [<path>]`, mutually exclusive with `--nextjs`. Reads the project's SDK major, expo-router root, React Compiler and NativeWind settings off disk, defaults the entry glob to the router root, and writes to `<expoRoot>/flawless/`.

**Every task runs under `--expo` except one, which refuses by a measured decision — and the tool says which.**

| task | under `--expo` |
|---|---|
| `unit-browser` | **runs** — jest-expo + @testing-library/react-native |
| `perf-static` | **runs** |
| `react-rules` | **runs** |
| `a11y` | **runs** — the native analyser: six `a11y/*` rules, no biome involved |
| `e2e` | **runs** — route specs against `expo start --web`; cookie auth via storageState, copy-witness anti-vacuity |
| `load` | **runs** — API-only crust pipes, harvested one hop through the app's fetch wrapper (screen → api fn → apiFetch); a 401 auth probe, not a redirect check |
| `perf-harness` | **refuses** — measured-and-declined (~0 host-mountable components on an all-route-screens app); the refusal names the recorded evidence |

A refusal is a failed `TaskResult`, not a throw: it lands in `results[]`, the `--ci` blob and `REPORT.md`. A mixed selection still runs what it can.

**Do not work around a refusal by dropping `--expo`.** The DOM suite pointed at React Native emits specs that run, pass, and touch nothing — `container.querySelector("Pressable")` matches no element, and `getByRole("button")` finds nothing because React Native has no implicit roles.

Two things worth knowing before reading a native run's output, both measured (`docs/archive/2026-08-expo-probes.md`):

- **`a11y` on native is the tool's own analyser, and its zero carries a denominator.** Biome's 29 rules are HTML/ARIA and returned zero over 31 RN files with 82 unlabelled `<Pressable>`s (3/3 on the DOM offender fixture), so the task refused until wave 5 shipped the native engine. Its summary always says how many press targets / text inputs / icons were examined — a native zero WITHOUT that denominator is a bug, not a clean bill.
- **The React Compiler changes what `perf-static` means.** On a project with `experiments.reactCompiler: true`, 136 of 168 findings were the three memoisation rules — work the compiler already does. `--expo` reads the flag and surfaces the findings for you to weigh; the tool deliberately does not suppress them.

See the `flawless-expo` skill for the native spec shapes, the selector ladder, and what a skip means.

## What the generated unit specs contain

Driven by static analysis, so they only assert what can be derived:

- the rendered root tag, when the analyser could pin it down;
- `children` and `className` passthrough, but only when the value provably
  reaches the DOM — accepting a prop is not rendering it;
- for a cva/`tv` component, that every option of every key renders a **distinct**
  class list. Never a specific Tailwind token: `cn()` is usually tailwind-merge,
  which drops base classes a later variant conflicts with;
- literal copy the component renders unconditionally;
- one test per detected interaction, with negative assertions on every other
  handler prop (a click that fires two callbacks fails);
- disclosures opened first: a control behind a closed `Dialog`/`Menu`/`Popover`
  is not in the DOM, so the spec clicks its trigger — by prop label, literal
  text, or its fixture child — clears the spies, then queries with `findBy*`;
  static-copy assertions skip closed content outright. A root written `open`,
  `defaultOpen` or `open={true}` is never gated;
- a named local handler read through: `onClick={handleConfirm}` whose
  declaration calls exactly ONE prop handler directly is asserted as that prop.
  Two props means the handler claims neither — canary;
- `children` handed to an `asChild`/`Slot`/`Slottable` site mounted as a
  `<span>`, never bare text — Slot clones elements and a text child throws;
- id-typed props never default to `""` (`flawless-<prop>` instead) — providers
  validate ids, they do not render them;
- state-derived tests: initial-state witnesses and handler→setter tests;
- one `describe` per `useEffect` fetch with **success / loading / error /
  empty** cases via `server.use(...)` overrides;
- async server components get `await Component(props)` plus `vi.mock` stubs
  for their non-component imports (no browser spec — they cannot mount).

Everything above describes the render the component produces **at the props the
spec passes**, not the last `return` in its body. A guard the analyser can decide
is followed; one it cannot that returns nothing falls through to the tail; one it
cannot that returns content produces no description at all.

Client specs mock an **allowlist only** — `next/navigation`, `next/headers`,
`server-only`, `next/link`, `next/font/*` and any `"use server"` module. Mocking
a `cn` util would strip every className off the markup, and mocking a UI
component would replace the element the interaction tests click.

When nothing is derivable the spec emits `test.skip` naming which preconditions
failed. **A skip with a reason is the intended output there — do not "fix" it by
deleting the assertion or by hand-writing one.** Fix the generator, or give the
component the `data-testid` / fixture the skip asks for.

Anything the analyser could not derive is a `TODO(flawless)` marker, never a
silently passing assertion. **The hardening loop is: run the suite, fill the
TODOs with real fixtures, rerun.** Regenerating later will not clobber your
work if the specs are colocated (see below).

## Spec placement

Default is `flawless/unit/<Name>.test.tsx`. Same-named components from
different files get `<Parent>__<Name>`.

`--colocate` writes `<source-dir>/<file>.flawless.test.tsx` beside the
component instead (multi-component files get `<file>.<Component>.flawless...`).
Colocated specs are **never overwritten without `--force`** — they are the ones
you hand-harden. Run them with `bun run flawless:unit`.

If the project's own test script is a bare `bun test`, it will also collect
`*.flawless.test.tsx` and fail on vitest globals. Scope it: `"test": "bun test tests"`.

## e2e and load

Route specs, the global-setup login and the auth wall are flawless-e2e; crust
pipes, `LOAD_BASE`/`LOAD_AUTH` and their baselines are flawless-load. The short
version:

e2e runs against the app's **real dev server** — MSW cannot intercept a server
component's direct database access, so mocking it would be a lie. Seed the
database first, fill in `flawless/e2e/global-setup.ts` (it ships a worked login
example that persists `storageState`), and pass ids for dynamic segments:

```bash
bun run db:reset
FLAWLESS_E2E_ID=<seeded-id> bun run flawless:e2e
```

For contract-checked runs, put crust's validation proxy in front and assert no
response violated the spec:

```bash
crust -c 'mock-server --swagger openapi.json --port 4747 --proxy http://localhost:3001' &
FLAWLESS_E2E_BASEURL=http://localhost:4747 bun run flawless:e2e
crust -c 'GET :4747/__crust/violations | (v => v.violations.filter(x => x.direction === "response")) | assert (a => a.length === 0)'
```

Load pipes target the analysed page routes plus the GET endpoints its
components actually fetch (mutations are excluded on purpose). Each line gates
p95 against a baseline: copy a good `last-<name>.json` to `baseline-<name>.json`
and later runs fail when p95 doubles.

Two things decide whether the numbers mean anything, and both are easy to get
wrong:

- **`LOAD_BASE` must be a production build** (`bun run build && bun run start`),
  not `next dev` — the dev server compiles routes on demand, so the first
  request to each measures the compiler.
- **`LOAD_AUTH` is a header line**, and for a cookie-session app that is
  `cookie: session=<value>`, not a Bearer token. Prove it authenticates first:
  an unauthenticated request to a dashboard route redirects to the login page,
  which answers 200, so every pipe passes while measuring the login screen.

A pipe whose ids are unfilled is emitted **commented out**, above a line naming
which key in `flawless/e2e/params.json` to fill — a blank segment measures the
app's 404 handler, not the route. Fill the id and regenerate with `--force`,
which merges rather than overwrites: edited rates, hand-added flows and pipes
you commented out yourself all survive. The task summary reports live versus
commented counts, so REPORT.md does not call a gated pipe covered.

## Reading findings

`perf-static` and the biome tasks print `file:line:col rule message` and write
`flawless/reports/*.json`; a `<Component>.flawless.json` sidecar lands next to
each analysed source (`--no-inline-summary` to disable). Its paths are relative
to the sidecar — resolve against its own directory — and its `a11y` and
`reactRules` entries name the run's single aggregate, not a per-component file.
Rules worth knowing:

- `perf/hook-missing-dependency` / `hook-extraneous-dependency` — stale-closure
  and over-firing effects, deliberately conservative (skipped when deps contain
  member access or spreads, so a clean report is not proof).
- `perf/unstable-child-prop` — inline object/array/arrow passed to a component
  child; flagged harder when that child is `React.memo`-wrapped.
- `perf/set-state-in-render` (error) — unguarded setState during render.
- `perf/unresolved-prop` — the analyser could not synthesise a default, so the
  generated spec passes `undefined`. Fix with `--props '{"x":1}'` or by editing
  the spec's `DEFAULTS`.

Triage order, what a suppression costs, and which rule belongs to which task are
the three skills flawless-perf-static, flawless-a11y and flawless-react-rules;
flawless-findings keeps the REPORT.md accounting and the counts ledger.

## Programmatic use

```ts
import { runFlawless } from "flawless-react";

const { results, trees, outDir } = await runFlawless({
  entry: "src/components/Widget.tsx",
  nextjs: ".",
  tasks: ["unit-browser", "perf-static"],
  colocate: true,
});
```

It never calls `process.exit`; bad input throws `UsageError`. `analyse()`,
`analyseTree()` (the perf rules) and the scaffolders are exported too, so you
can build your own reporting on `ComponentTree` without the CLI. `--ci` is
shorthand for `--no-interactive --json`.

## Style

Generated files are reformatted with the **host project's** biome or prettier
before the run finishes, and JSON merges preserve the file's existing
indentation — generation should produce a clean `git diff`, not a reformat of
your `package.json`.

## Troubleshooting

- **`Cannot read properties of null (reading 'useState')`** — two React copies.
  The generated vitest config pins react/react-dom to the `node_modules` that
  also holds `@testing-library/react`; if you moved things, fix the alias block.
- **`window.matchMedia is not a function`** — `flawless/setup.ts` ships jsdom
  polyfills; make sure your config still lists it in `setupFiles`.
- **Browser specs missing** — they need the `perf-harness` host; add that task.
- **RSC spec renders nothing** — its `vi.mock` stubs return `vi.fn()`; give
  them real return values (that is the TODO).
- **Playwright has no browser** — `bunx playwright install chromium`. The
  runner attempts this automatically; `FLAWLESS_SKIP_BROWSER_INSTALL=1` opts out.
- **Spec fails `ReferenceError: <name> is not defined`, host build printed
  nothing** — a host resolve-plugin fall-through dropped a bare specifier's
  module onto a variant without that export (`msw` named imports were the
  casualty). Run `bun host/server.ts` from the suite dir to see the build;
  check the plugin's `args.path` gates, not the spec.
- **Every e2e route 404s while `/` loads in a browser** — the app's own
  middleware is an auth wall (`auth.protect()`); with placeholder keys every
  route behind it 404s. Real credentials in `e2e/global-setup.ts`, or do not
  claim those routes.
- **e2e dies on "Timed out waiting …ms from config.webServer", no spec run** —
  the same wall one stage earlier. Playwright calls the server up only on a
  2xx/3xx from the readiness url, which is the app root, and retries a 404
  forever (`[WebServer] GET / 404` repeating in the log). Fill the credentials,
  or set `FLAWLESS_E2E_BASEURL` to a server you started yourself — the emitted
  config drops its own `webServer` block for that.
- **Both Playwright configs collide** (`test.describe() called here` /
  `No tests found`) — two `@playwright/test` copies (app root + suite). Run the
  plane from the suite dir with its own config:
  `node node_modules/@playwright/test/cli.js test --config e2e/playwright.config.ts`.
  Same for vitest: `node ../node_modules/vitest/vitest.mjs run --config vitest.config.mts`.

## Limits worth stating up front

Static analysis only, no type checker. Imported prop types resolve two hops —
including types from the repo's own **workspace packages** (`@scope/shared`,
resolved through the workspace map into the package's source, barrel
re-exports chased to the declaring file); intersections, host-element props
(`ComponentProps<"div">`), `ComponentProps<typeof LocalX>` and cva tables all
resolve. `z.infer`/`z.input` aliases resolve too, by reading the zod schema
syntactically (object/enum/primitive/array/coerce, `.optional`/`.nullable`/
`.default`/`.partial`/`.extend`; `.transform`, unions, records and dates
bail). Non-literal unions, `Omit`/`Pick`/`Partial` and anything in
`node_modules` do not — the prop lands in `unresolvedProps` and the type that
defeated it in `unresolvedTypes`.

Mocks come from a component's **own** imports, so one that renders `<Link>` only
through a child gets no `next/link` mock in its own spec.

Every run writes `flawless/REPORT.md`, which accounts for every component found:
how many can mount in the browser profiling host, how many cannot and why, and
which files yielded no component at all. Read it before quoting a coverage
number — a file count is not coverage.

A green generated suite means "nothing obviously broken", not "covered" — the
value is in the scaffolding you harden, and in the findings.
