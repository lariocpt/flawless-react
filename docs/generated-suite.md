# The generated suite

This walks the **perf-harness** output file by file. The other six tasks write
into the same output directory; [what each task writes](#what-the-other-tasks-write)
at the end of this page covers those.

> The profile specs live under `profile/`, not `tests/`. Bun treats a positional
> argument to `bun test` as a path *substring*, so a suite emitted into
> `flawless/tests/` gets collected by any project whose own script reads
> `bun test tests` — which is most of them.

Every file in `<outDir>/` is a string template emitted by [src/scaffold/templates.ts](../src/scaffold/templates.ts). The suite is fully standalone — it knows nothing about `flawless-react` once it's written, and you can commit, edit, fork, or delete it without affecting the generator.

This document walks through each file and what to change in it.

## `package.json`

Declares the suite as its own private package with three runtime deps:

```jsonc
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-scan": "^0.4.3"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.6.0"
  }
}
```

Render timing comes from React's built-in `<Profiler>` — no separate measurement library required.

Scripts: `test`, `test:perf` (the name `--run-tests` looks for), `test:headed`, and (if you used `--report`) `report`. The suite's package name is derived from the out dir's basename — `<out-dir-name>-profile`. `unit-browser` merges its own `test:unit` and `test:browser` into the same file and declares nothing perf-harness declares, so the result does not depend on the order you list the tasks in. Both emitters take their commands from [src/suiteScripts.ts](../src/suiteScripts.ts) and merge through [src/packageJson.ts](../src/packageJson.ts).

**Edit when**: your parent project uses a different React major (17 / 19); pin the suite's `react` and `react-dom` to match before `bun install`.

## `tsconfig.json`

A minimal config tuned for Bun + Playwright. `"jsx": "react-jsx"` and `"allowImportingTsExtensions": true` are the two non-default lines that matter — they let the host file say `import { Foo } from "./Foo.tsx"` without choking the type checker.

**Edit when**: you want stricter type-checking across the suite or you want to add path aliases.

## `playwright.config.ts`

Two projects: `chromium` (default, headless) and `interactive` (headed). The key field is `webServer`, which auto-boots `bun host/server.ts` before any test runs:

```ts
webServer: {
  command: "bun host/server.ts",
  url: "http://127.0.0.1:5173",
  reuseExistingServer: !process.env.CI,
}
```

Workers are pinned to 1 under CI, because the host serves one component at a time and parallel mounts fight over the singleton `activeRoot`. Locally the run is parallel (Playwright's default); set `FLAWLESS_WORKERS` to pin it yourself.

**Edit when**: you need a different port, you want to add a `firefox` or `webkit` project, or you want to run tests in parallel (which requires reworking the host to scope state per-page).

## `host/server.ts`

A tiny `Bun.serve` that builds `host/main.tsx` once via `Bun.build({ target: "browser" })` — the bundle pulls `host/registry.ts` in through main's `./registry` import — and serves three routes: `/` (the HTML shell), `/bundle.js` (the built ESM), and `404` for everything else.

The build runs **at startup**, not per request, so test runs hit a hot bundle. If you're iterating on `main.tsx` you can either restart the server manually or replace the one-shot build with a `Bun.build` watcher.

**Edit when**: you want to inject env vars into the bundle, add CSS, or serve additional static assets (mock JSON fixtures, etc.).

## `host/index.html`

Two lines that matter: a `<div id="root">` and a `<script type="module" src="/bundle.js">`. The rest is boilerplate.

**Edit when**: you need a different root element ID, a CSS reset, or extra DOM your component depends on (e.g. a portal target).

## `host/registry.ts`

The mechanical mount tables, one import line per analysed component plus three exported objects — **regenerated on every run**, which is how a newly analysed component's profile and browser specs find it: a plain no-force re-run refreshes this file even though `main.tsx` beside it is kept.

- **`REGISTRY`** maps component names to imported components, populated from the analysed `ComponentTree`.
- **`FN_PROPS`** — props the component calls. A spec's props reach the page through `page.evaluate`'s structured clone, which drops functions silently, so `mount` supplies a no-op for each named prop the incoming object does not define. Without it a component like `error.tsx`'s `<Button onClick={reset}>` throws the instant the click lands.
- **`WRAP_IN`** — the ancestors HTML requires around a component's root tag. `<TableBody>` renders `<tbody>`, which is only valid inside a `<table>`; mounting it straight into `#root` makes React log *"In HTML, `tbody` cannot be a child of `div`"*, and the browser spec then fails the component for a warning the harness caused. `mount` nests the element through the chain.

**Edit never** — the next run rewrites it byte-for-byte from the analysis. Hand registrations go in `host/main.tsx`'s `ALL` spread, which survives.

## `host/main.tsx`

The write-once wrapper — the user-owned half of the split. Three things happen here:

1. **react-scan is initialised once at module load**. It buffers any `unnecessary: true` render events into a `scanEvents` array.
2. The tables are imported from `./registry` and spread into **`ALL`**, **`ALL_FN_PROPS`** and **`ALL_WRAP_IN`** — e.g. `const ALL: Record<string, Component> = { ...REGISTRY /* hand-registered components ride here */ }`. Every internal lookup goes through the spreads, so an entry you add mounts like a generated one and survives every regeneration — add it as `MyComponent: MyComponent as unknown as Component` (the strict tsconfig requires the cast), with `ALL_FN_PROPS`/`ALL_WRAP_IN` entries when it takes function props or needs a wrapper chain.
3. **`window.__profile`** is exposed for the Playwright driver:

```ts
window.__profile = {
  list(): string[];
  async mount(name, props): Promise<void>;
  async rerender(name, props): Promise<void>;
  async unmount(): Promise<void>;
  getRenderInfo(): { renderCount, renderTime }; // populated by React.Profiler
  getScanEvents(): ScanEvent[];
  clearScanEvents(): void;
};
```

`mount` wraps the user's component in React's built-in `<Profiler id={name} onRender={...}>` and renders it via `activeRoot.render(...)`. Each render fires `onRender`, which appends to the `renderCount[name]` / `renderTime[name]` dictionaries. `rerender` re-issues the render and waits one `requestAnimationFrame` for React to commit.

`mount` also carries the error React swallowed. `createRoot` is given an `onUncaughtError` handler, so a component that throws during render reports *what* it threw rather than the generic "did not render within 5000ms".

**Edit when**: you want to wrap components in a provider (React Router, theme, query client, store) — prefer the `--provider <file>` flag at scaffold time, which threads your wrapper through `mount` / `rerender` for you. You can also hand-register components in the `ALL` spread, or expose additional helpers on `window.__profile` if your tests need them.

**Pre-split suites**: a `main.tsx` generated before the registry split carries the tables baked in and no `./registry` import, so newly analysed components can never mount through it. Write-once is absolute — no flag rewrites it, `--force` included — so the run writes `host/registry.ts` inert beside it and warns. The escape is one-time: delete `host/main.tsx` and re-run (provider wiring regenerates from `--provider`), or port your hand wiring into a wrapper that imports `./registry`.

## `profile/_helpers.ts`

Thin wrappers around `page.evaluate(...)` so the spec files stay readable: `mountComponent`, `rerenderComponent`, `unmount`, `getRenderInfo`, `getScanEvents`, `clearScanEvents`, plus `summarize(samples)` which computes `min / avg / p50 / p95 / max`.

**Edit when**: you want a higher-level helper like `mountWithUser(page, name, props, userFixture)` that sets up a mock auth context first.

## `host/main.tsx` with `--provider`

If you scaffolded with `--provider <file>`, `host/main.tsx` imports the file as `AppProvider` and wraps every render in it:

```ts
import AppProvider from "../../src/providers/AppProvider.tsx"; // your file
// ...
function wrap(tree: ReactNode): ReactNode {
  return createElement(AppProvider as never, null, tree);
}
```

The provider file must default-export a React component that accepts `children`. Anything with a Provider in the React ecosystem fits — Redux's `<Provider store={...}>`, React Query's `<QueryClientProvider client={...}>`, theme providers, etc. — wrap them in your own `AppProvider` and you only have to maintain one file:

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

**The provider import line is tool plumbing.** `import AppProvider from "…"` is the one line in this file the tool owns: when the resolved provider moves — you pass `--provider` on a later run, or Next.js derivation starts or stops producing `flawless/provider.tsx` — the next run re-points that line, keeping its quote style and every other byte of your `main.tsx`, and names the change in the run summary. Delete the line if you want to mount unwrapped permanently; the tool will not put it back.

**Edit when**: you want async setup before each mount (seeding store state, logging in a mock user). Add a `setup`/`teardown` named export and call them from `host/main.tsx`'s `mount`/`unmount`.

## `mock/server.ts` + `mock/routes.ts` (only with `--api`)

If you scaffolded with `--api <openapi.json|yaml>`, the suite ships with a standalone Bun mock server on port 5174. The host server (5173) transparently proxies every non-asset request to it, so the component's relative `fetch('/api/users')` calls reach the mock without any code changes.

`mock/routes.ts` is a flat list of routes, **derived at scaffold time** from the OpenAPI spec:

```ts
export const routes: MockRoute[] = [
  { method: "GET",  path: "/api/users",       status: 200, body: [{ id: 1, name: "Alice" }] },
  { method: "POST", path: "/api/users",       status: 201, body: { id: 0, name: "" } },
  { method: "GET",  path: "/api/users/{id}",  status: 200, body: { id: 1, name: "Alice" } },
];
```

Body extraction priority: first `application/json` example → schema-synthesised default (object → `{}` with property keys, array → 1-element sample, primitives → empty/zero, `enum` → first value). `$ref` chains are resolved one level deep.

`mock/server.ts` compiles each path template (`/users/{id}` → regex with capture groups) at startup, matches incoming requests against the list, and falls through to a JSON `404` body. The root `/` returns `200 {ok:true, routes: N}` so Playwright's `webServer` health check passes.

**Edit when**: you want stateful mocks (a route handler that mutates an in-memory store and the next GET reflects that), conditional responses based on query/body, or delayed responses. The generated file is a starting point — replace any route's static body with a function that inspects the `Request` and returns a `Response`.

## `profile/_heap.ts`

Drives the browser's V8 heap profiler via Playwright's CDP session (`HeapProfiler.takeHeapSnapshot`). Produces `.heapsnapshot` artifacts attached to the Playwright report — the same format Chrome DevTools' Memory tab consumes, so two snapshots can be loaded and diff'd via the Comparison view.

Three exports:

```ts
takeHeapSnapshot(page, label, testInfo): Promise<{ byteSize: number }>;
bracketScenario(page, name, testInfo, fn): Promise<void>;
repeatClick(page, selector, n): Promise<void>;
```

`bracketScenario` wraps a scenario callback with `before` / `after` snapshots. To keep CI artifacts small, snapshots are **persisted only when** (a) the scenario fails, or (b) the scenario name starts with `stress-`. On a clean non-stress pass, the captured buffers are dropped. The byte delta is logged to stdout as a coarse leak indicator (`[heap] click-rerender: 12345 -> 12410 bytes (delta +65) -> heaps/Foo-profile__Foo-click-rerender__click-rerender-after.heapsnapshot`).

Persisted snapshots land in `<suite-root>/heaps/<spec>__<test>__<label>.heapsnapshot`. Filenames are deterministic — no hashed suffixes — so you can `open heaps/...` straight from the terminal and load them in DevTools. They are also attached to the Playwright HTML report so you can navigate from a failed test result to its snapshot.

`HeapProfiler.collectGarbage` is invoked before each snapshot so the result reflects *retained-by-reachability*, not just *not-yet-collected*.

**How to view a snapshot**: open Chrome (any recent build), DevTools → Memory tab → **Load** (folder icon) → pick the `.heapsnapshot` file. Switch to **Comparison** view and load a second snapshot to find objects retained after the scenario.

**Edit when**: you want different snapshot timing (mid-scenario, not just before/after), or you want the byte-delta logged as a hard assertion: `expect(after.byteLength - before.byteLength).toBeLessThan(THRESHOLD)`.

## `profile/<Component>.profile.spec.ts`

One spec per analysed component. Each spec is **fully self-contained** — its `DEFAULTS`, `VARIANTS`, and `HOOKS` are baked in as literals at the top. There is no shared fixture file, no implicit dependency between specs.

The five tests:

### `mounts at defaults`

```ts
await mountComponent(page, NAME, DEFAULTS);
const info = await getRenderInfo(page);
expect(info.renderCount[NAME]?.value).toBeGreaterThanOrEqual(1);
// warns if info.renderTime[NAME].mount > budgets[NAME].mountMs
```

The mount budget warning is intentionally a `console.warn`, not an `expect(...).toBeLessThan(...)`. CI shouldn't fail the first time a component is profiled — you'd never get past the initial measurement run. **To make it hard**, change the `console.warn(…)` line to `expect(mountMs).toBeLessThan(budget)`.

### `variant matrix`

Mounts at defaults, then iterates the `VARIANTS` array, calling `rerenderComponent(page, NAME, v)` for each. Skipped if static parse produced zero variants. After the loop, summarises the `updates` samples and warns on the p95.

### `click rerender`

Clicks the target the analyser derived from your source — a test id, an `aria-label`, a role plus its accessible name, an `id`, or literal copy — opening any disclosure it sits behind first. Then:

- Capture the current render count.
- Click the derived target.
- Wait for the render count to increment.
- Check `getScanEvents()`: any unnecessary rerenders from `react-scan` become a console warning.

There is no blind fallback — in the profile clicks here, and equally in the browser interaction specs: `page.locator("button").first()` (or the browser suite's old `button:not([disabled])`) would claim the first button is the one the analysis found a handler on. When nothing in the source names a target, the scenario is emitted as a skip carrying the reason in its title — decided at scaffold time, never at run time. If your component's real interactions are more nuanced (form flows, drag handles, keyboard shortcuts), this is the test you'll most often extend by hand.

### `forced rerender × N`

Cycles `--variants × 10` renders through the variant pool (or `[DEFAULTS]` if none) and prints a `{min, avg, p50, p95, max, n}` summary. The HOOKS list is logged at the end for context.

**Edit when**: you want to assert hard ceilings on p95; you want a different N; you want to drive prop changes through your own data fixtures rather than the synthesised ones.

### `stress-click-rerender × 50`

A leak-detection scenario. Mounts the component, takes a baseline heap snapshot, clicks the primary `<button>` fifty times in a tight loop, then takes a final heap snapshot. Both snapshots are **always attached** to the Playwright report (artifact size budget is small — a snapshot of a tiny component is typically <500 KB).

There is no assertion on byte delta — it's too noisy across machines and React versions. The value is the saved snapshots: open them in Chrome DevTools' Memory tab → Comparison view and look for unexpected retained objects (detached DOM nodes, growing arrays of listener closures).

The other three scenarios (`variant matrix`, `click rerender`, `forced rerender × N`) are wrapped by `bracketScenario(...)` from `profile/_heap.ts`. They take before/after snapshots too, but **only attach them on failure** — keeping passing-run artifacts small.

**Edit when**: 50 clicks isn't enough to surface a slow leak (bump to 500); you want to assert a hard byte-delta ceiling (replace the `bracketScenario` body with explicit `takeHeapSnapshot` calls and `expect(after - before).toBeLessThan(...)`).

## `budgets.json`

```jsonc
{
  "Dashboard": { "mountMs": 50, "updateMs": 16 },
  "Hello":     { "mountMs": 50, "updateMs": 16 },
  "Card":      { "mountMs": 50, "updateMs": 16 }
}
```

Per-component budgets in milliseconds. The defaults are loose on purpose — first run, you measure; on subsequent runs, tighten them to your observed p95 + 20%.

The numbers are referenced from every spec file but only generate **warnings** by default. See the `variant matrix` and `mounts at defaults` notes above for how to upgrade those to hard assertions.

## `scripts/report.mjs` (optional, `--report` only)

Reads `test-results/results.json` — written by the `json` reporter in `playwright.config.ts` — and writes a `report.md` summarising the per-component variant and forced-rerender stats. Plain Node script — no Playwright runtime needed.

It reads the JSON reporter's output rather than `playwright-report/index.html` because the HTML report stores stdout inside a base64 zip blob, where the stat lines the specs print cannot be found by reading the file. The `report` script in the suite's `package.json` is only declared when this file is emitted.

**Edit when**: you want HTML output, or to push the summary to a metrics endpoint, or to diff against a baseline JSON.

## `README.md`

A short user-facing README for the *generated* suite, separate from this repo's README. It documents how to run, what's measured, and how to customise. It is regenerated whenever the suite is, so it always describes the suite it sits in.


---

## What the other tasks write

`perf-harness` owns everything above. The rest of the output directory:

### `unit-browser` → `unit/` (or beside the source with `--colocate`)

- **`vitest.config.mts`** — jsdom environment, `esbuild.jsx: "automatic"`
  pinned in the config itself (a Next.js host's tsconfig says `jsx:
  "preserve"`, which leaves vitest's esbuild on the classic runtime and every
  render dies with "React is not defined"), the project's tsconfig `paths` as
  `resolve.alias`, and `resolve.dedupe: ["react", "react-dom"]`. The dedupe is
  not cosmetic: in a workspace where `react` resolves to the repo root and
  `react-dom` to the package, `react-dom/server` sets its hook dispatcher on a
  different React instance than the component reads from, and every hook call
  fails with `Cannot read properties of null (reading 'useEffect')`.
- **`setup.ts`** — `@testing-library/jest-dom`, the jsdom gaps real component
  stacks hit (`matchMedia`, `ResizeObserver`, `IntersectionObserver`,
  `scrollIntoView`, the `AbortSignal.any` static jsdom has never implemented
  while Node has had it since 20.3, and `HTMLCanvasElement.getContext`), MSW
  wiring when `--api` was used, and an in-memory `Storage` fallback. That last
  one matters on Node ≥ 22, which defines a `localStorage` global that is inert
  without `--localstorage-file`; persistence middleware (zustand `persist`,
  redux-persist) is otherwise handed `undefined` and throws on its first write.
  `getContext` is answered with a **recording** 2D context, because jsdom logs
  `Not implemented` and throws: a chart, sparkline or signature pad used to take
  its whole spec file down with it (#98 — 27 of one witness app's 50 spec files
  reported zero tests, none of it the app's fault). Every documented 2d method
  exists and counts itself into `canvas.getContext("2d").__flawlessDraws()`, so a
  spec can assert THAT the component drew; nothing here claims WHAT it drew —
  there are no pixels — and `webgl`/`webgl2` answer `null` rather than a fake GPU.
- **`<Component>.test.tsx`** — one per exported component. What it contains
  depends on what the analyser could prove:

  | Signal | Assertion |
  | --- | --- |
  | root tag | `container.querySelector("div")` is not null |
  | `children` provably reaches the DOM | a sentinel child is found by `getByText` |
  | `className` provably lands on a host element | a sentinel class is found in the container |
  | a cva table | every option of every key renders a **distinct** class list |
  | literal copy under the initial render | `getByText` per string |
   | interactions | the element is found, clicked, and the component survives |
   | an effect-driven `fetch()` | four MSW scenarios per call — successful response, delayed response (loading state), 500 (error state), empty payload. When a click is detected it fires first (effects are often launcher-gated); the trigger is rewritten to its non-throwing `query*` twin for every selector shape, so a launcher absent at mount is *skipped*, never thrown |
   | none of the above | `test.skip` naming which preconditions failed |

  A component behind an undecidable early return gets `expect(() =>
  renderTarget()).not.toThrow()` instead of a claim that something appeared —
  `if (toasts.length === 0) return null` backed by a store hook may legitimately
  render nothing.
- **Derived provider wraps.** Under a real layout a component mounts inside its
  theme, router, query and app-context providers; mounted bare it answers
  `useSidebar must be used within a SidebarProvider` instead of findings. So
  every render opens with a derived nest — in the unit specs and in the perf
  host's registry alike — imported under a `__Prov` prefix so it can never
  collide with a spec's own imports. Four derivations, strongest evidence
  first: a **hook call** (`useSidebar` → the `SidebarProvider` exported by the
  file the hook's import resolves to, or by the component's own file — and only
  that file's provider counts, so an unrelated `FooProvider` elsewhere never
  catches an unrelated `useFoo` caller), a **namespace compound**
  (`CommandInput` renders `CommandPrimitive.Input` and needs the same file's
  `<Command>` mounted around it), a **transitive requirement** (`AppSidebar`
  never calls `useSidebar` — its `<Sidebar>` child does, and whatever a
  component renders, it must satisfy too), and a **dynamic render** (the tag
  itself is a value a project hook handed back — `{Component && <Component />}`
  after `const { Component } = useTabs()` — so there is no import for the
  analysis to walk and no child edge to close over). A hook arriving from a
  bare module — node_modules, or a barrel that hands the library itself along
  instead of the project file behind it, the same walk-ending table the dynamic
  hop stops at — has no project file to join on, so it pairs by convention
  instead: an exported component named after the hook (`useTheme` →
  `ThemeProvider`) that renders a binding imported from the hook's own module.
  All three conjuncts or no wrap: a `ThemeProvider` rendering some other kit's
  provider must not catch a hook from a different one.

  The dynamic render is bounded on purpose: the component owes what the walk can
  name, and nothing more. The tag must be an uppercase name bound by shorthand
  or plain destructuring (`const { Component } = useTabs()`, or the whole return
  held as `const Tab = useTabs()`) from a `useX()` call that is not a core
  hook — an alias, a default, or a member-expression tag is declined rather than
  guessed, a prop of the same
  shape stays the spec's business, and a value that is only *read*
  (`pick.Component ? … : null`) is not a tag. The hook resolves to a project
  file or sits beside the component; the renderables are the hook body's own JSX
  tags plus ONE import hop into the top-level definition of each value
  identifier the body holds — the registry it selects from, where an array or
  object member steps in, an arrow body steps into its return, and
  `as const` / `satisfies` / parens unwrap for free, to sixteen components. Two
  ways the walk stops short and the shape stays a hole, in the same family: a
  registry that reaches a barrel which only *re-exports* it ends the hop there
  (a re-export table declares nothing to walk), and past the budget the walk
  simply drops out. The edges merge into the render-edge worklist *before* the
  closure, so ordering, supersedence and cycle handling treat them as what they
  are — renders, not a special case. Which is how devtools' `ContentPanel` comes
  to mount `useTabs()`' chosen tab inside the data router `PageTab` needs, and
  "useMatches must be used within a data router" stops being the last router
  error in the corpus.

  Library contexts the app cannot supply get generated shims:

  | What the component uses | Generated wrap |
  | --- | --- |
  | `@tanstack/react-query` hooks | `FlawlessQueryClientProvider` — a fresh `QueryClient` per mount, `retry: false` |
  | `react-router(-dom)` hooks, `<Link>` / `<NavLink>` / `<Navigate>` / `<Outlet>` | `FlawlessRouterProvider` — a `MemoryRouter` |
  | data-router hooks (`useLoaderData`…), `<Form>`, `<ScrollRestoration>` | `FlawlessDataRouterProvider` — `createMemoryRouter` + `RouterProvider`; supersedes the `MemoryRouter` wrap, needs router ≥ 6.4 |
  | `react-hook-form` (`useController`, `useFieldArray`, `useFormState`, `useWatch`, `useFormContext`) | `FlawlessFormProvider` — an empty form, fresh per mount |
  | `react-intl` hooks, `<FormattedMessage>` / `<FormattedDate>` / … | `FlawlessIntlProvider` — `locale="en"`, nothing fetched |

  The nest opens outermost-first: a provider that itself requires another sits
  outside it, ties keep alphabetical order, and a true requirement cycle —
  which means the app is broken at that mount — falls back to alphabetical and
  fails red rather than guessing. Shim files live at the root of the importing
  package (the only place their own bare library import can resolve) and are
  tool-owned: rewritten every run. Your `--provider` wrapper sits outside the
  whole derived nest; the extending guide covers what to do when a wrap is
  missing or wrong.

- Server components get a different template: the component is awaited rather
  than mounted, `render()` sits inside the same `try` as the call, `notFound()` /
  `redirect()` are recognised as legitimate outcomes, and anything else is
  rethrown as itself. When the analyser admitted it could not infer a data
  dependency's shape, the resulting crash is reported as a skip — the tool
  failing on a fixture it never had is not the application failing.
- `"use server"` modules are mocked with the action's **own return value** when
  it can be read off the source: an action whose every non-exit return (after
  discounting `redirect()`/`notFound()`) collapses to one literal — an object,
  array, string, number or null composed of literals — is stubbed as
  `vi.fn(async () => (<that literal>))`. Anything dynamic keeps the honest `{}`
  stub and its `TODO(flawless): server action stubbed` marker; the marker
  retires only when every export of the module resolved, because the mock
  factory replaces the whole module. The perf host's browser-bundle stubs use
  the same values.
- **Mock provenance.** A data dep whose usage told the analyser nothing gets a
  second chance from its own declaration, and the emitted fixture says where
  it came from:
  - `/* inferred from <fn>'s return annotation */` — the dep declares
    `Promise<T>` and `T` resolved completely (any unresolved member bails the
    whole value; `T[]` yields a one-element array). An `interface X extends Y`
    resolves its bases and merges them, own members last — but if *any* base
    fails to resolve, the whole value still bails, because a fixture missing
    half its fields is worse than none. `Record<K, V>` and `Partial<T>` resolve
    to `{}`, which is a complete inhabitant of both and needs no substitution;
    every other generic instantiation bails, because for those it is not. A
    union is
    resolved from its non-nullish arms: `Promise<Case[] | null>` yields the
    `Case[]` fixture, because `null`/`undefined` arms are values the type
    already admits, not holes. A union of two *shapes* still bails — the
    analyser will not pick a side. The declaration may live in another
    **workspace package** (`@scope/shared`): the specifier resolves through
    the repo's workspace map into that package's *source* tree, and barrel
    re-exports (`export * from`, `export { A as B } from`) are chased to the
    declaring file. Third-party packages still never resolve — `node_modules`
    is not walked. A member typed by a `z.infer` alias resolves by reading
    the zod schema's initializer as **syntax** (enums yield their first
    literal, declared `.default`s are honoured); `.transform` or any
    unrecognised construct bails the whole fixture rather than guess.
  - `/* inferred from the OpenAPI example for GET /api/… */` — the dep is an
    unannotated wrapper around exactly one `fetch()`, joined to the API spec's
    response example at emit time.

  Deps with neither keep the `{}` stub, the
  `TODO(flawless): some return shapes could not be inferred` marker, and the
  RSC spec's fixture-missing skip escape. An **enriched** dep is real
  coverage: its spec has no skip escape, so a wrong inferred fixture fails
  red instead of hiding. Usage-derived shapes always outrank declarations —
  the component's own reads are better testimony than a type annotation.

  A helper that is imported and called but never becomes a dep — a formatter
  invoked inside JSX rather than awaited into a variable — is also read from
  its declaration, and **synchronously when the declaration is synchronous**.
  `formatZAR(cents: number): string` was previously stubbed
  `vi.fn(async () => ({}))`, so every money value on a page rendered as an
  object; it is now `vi.fn(() => ("flawless-value"))`. A sync annotation on an
  *awaited* dep is still refused — that is somebody's refactor in progress,
  not a thing to build a fixture on.
- **The fixture has to satisfy the component's own code.** When it does not, the
  component takes its guard, the spec records that as a legitimate outcome, and a
  green test reports having rendered nothing.

  A page that filters `memberships.find((m) => m.building_id === id && m.status
  === "active")` rejects a row carrying `status: "flawless-status"`. It then
  calls `notFound()`, the RSC template recognises that as a declared guard path,
  and the spec passes having rendered nothing. On the dogfood app that was **22
  of 32 page specs**.

  Four rules close it, all reading the component's own source:
  - A field compared with `===` to a **literal** takes that literal.
    `m.status === "active"` yields `status: "active"`. In render position
    `!==` is not used — it says what a value must not be, which does not pick
    one out.
  - A field compared to one of the component's **props** takes that prop's
    value, resolved from the same fixture the spec's `DEFAULTS` carries — so
    the two agree by construction rather than by both spelling `flawless-id`.
  - Inside a top-level guard condition the polarity inverts: `if (!invoice ||
    invoice.building_id !== id) notFound()` renders only when the field IS the
    route param, so `!==` there captures the way `===` does in render position
    — and a guard's `===` captures nothing, since the value it names would
    fire the very exit the fixture exists to avoid. A comparison inside a
    `find()` callback keeps render polarity even when the call feeds a guard.
  - A field compared to **another dependency's field** — `members.find((m) =>
    m.user_id === user.id)` — takes the value that dep's own fixture holds
    there (one hop; an unreadable note is dropped). Fields read off a `find()`
    **result** (`const mine = members.find(…)` and then `mine.status`) count
    as element fields of the collection, so every rule above reaches them.

  And a Next page's `params` never contains an empty string. `mapType`'s default
  for a string prop is `""`, which is right for a caption and impossible for a
  route segment: Next does not match a dynamic segment against an empty string,
  so `{ params: { id: "" } }` is a request that cannot happen. Empty leaves under
  `params` — and only there — are filled with `flawless-<key>`; a catch-all's
  empty array becomes one segment. A value the analyser actually resolved is
  evidence and is left alone.

  This is not coverage-chasing. A membership row whose status is a placeholder is
  not a valid instance of what the page reads. The `notFound()` path keeps its own
  test, which mocks the lookup to return nothing.
- Components that cannot mount standalone — a `<Dialog.Content>` outside its
  Root, a layout returning `<html>` — get a spec that asserts what IS true and
  states the reason in the file. **Compound parts whose own file exports the
  family** (the shadcn shape: a sibling rendering `<X.Root>` plus a Content
  sibling) do better: the spec mounts the part the way call sites do — the
  Trigger inside a closed Root, everything else inside
  `<Root open><Content>…</Content></Root>` — with portal-aware assertions
  reading the whole document through `screen` and `baseElement`, since portal
  content lands outside the render container. A part that takes no children
  has no text to witness, so its spec asserts the mount put elements in the
  document instead. Only open-state families are wrapped (dialog,
  alert-dialog, popover, dropdown-menu, select, tooltip, hover-card,
  context-menu, menubar, collapsible); value-driven families (accordion,
  tabs) and parts without a same-file Root keep the honest skip and its
  TODO. So do these, all of them cases where a wrapper would be wrong rather
  than merely absent: a part that renders a `Sub`-prefixed member
  (`<Menu.SubTrigger>`, `<Menu.SubContent>`) — the rule reads the member the
  part renders, not the part's own name, and those need a `<Sub>` ancestor this
  wrapper does not build; a part whose Root sibling is declared as a default
  export, since both emitters import the wrappers by name and a named import of
  a default export does not resolve; a part rendering members of two different
  compound packages, where wrapping one leaves the other throwing; and a part
  with no unrooted member of its own, which reaches its family through a local
  hop the analyser does not follow. The browser host mounts wrapped parts too:
  the regenerated `host/registry.ts` composes the wrapper into the part's own
  REGISTRY entry, so a kept `main.tsx` benefits from a plain refresh.

#### Colocated spec stamps

Specs written beside your sources by `--colocate` open with a provenance stamp:

```
// @flawless-generated sha256:<hex16> flawless-react@<version>
```

`<hex16>` is the first 16 hex characters of the sha256 of everything below the
line, computed after the run's style pass — so the stamp names the bytes the
project's own formatter left on disk, not the raw template. It is how `--force`
tells "still exactly what we generated" from "someone worked on this":

| State on disk | plain re-run | `--force` |
| --- | --- | --- |
| no spec yet | written, stamped | written, stamped |
| stamp matches body | kept | **rewritten** (refreshed) |
| stamp mismatch (you edited or reformatted it) | kept | kept, listed as hand-edited |
| no stamp line (pre-stamp, or you deleted it) | kept | kept, listed as pre-stamp |

Both kept-under-`--force` cases are named in the run summary with the same
escape hatch: **delete the file and re-run to regenerate it**. Kept files also
drop out of the run's hand-work tallies — a TODO in a render that was never
written is not your debt. Note that deleting just the stamp line demotes the
spec to pre-stamp rather than making it regenerable; the unit of ownership is
the file.

The same ownership rule covers the `flawless:*` scripts a Next.js-mode run
merges into your project's `package.json`: a value the tool recognises as one
of its own spellings (current or past) upgrades in place, while anything else
is your work — kept, and named in the run summary, REPORT.md
(`> Kept script(s): ...`), and the `--ci` blob's `keptScripts`. The escape
hatch is the same too: delete the key and re-run to take the tool's current
command.

### `unit-browser` → `browser/<Component>.spec.ts`

Playwright specs that drive the perf host rather than jsdom, for the same
interactions. Emitted only for components that mount standalone, and only when
`perf-harness` is in the same run — they need its host.

They share the unit suite's selectors, defaults and skip reasons, plus the
things only a real browser forces you to be exact about:

- **Locators resolve to one element.** Playwright's strict mode makes a locator
  matching two elements an error rather than a choice, so every locator ends in
  `.first()`, and a `text` label asks for `{ exact: true }` (the default text
  match is a case-insensitive *substring*, which matched "Please try again."
  when it wanted a "Try again" button).
- **A bare host tag is a last resort with a precondition.** It is used only when
  the render contains exactly one element of that kind, counting `<Button>`
  towards `button`. Otherwise the test is a skip that says so.
- **Nothing waits on a control that cannot become actionable.** A `disabled`
  expression the analyser can decide becomes `await expect(...).toBeDisabled()`;
  one it cannot becomes a runtime check that skips with the reason. Both replace
  a 30-second Playwright timeout with a fact.
- **A form is submitted through the control its markup declares** — a host
  `<button>` unless its `type` says otherwise, a component tag only with an
  explicit `type="submit"` — and its fields are driven by their type: checkboxes
  checked, `<select>`s selected, hidden/file/range inputs left alone.
- **A component whose guard the analyser could not decide** checks that its
  target is on screen before driving it, and its mount test drops the "rendered
  something" assertion. `if (!user) return null` behind a store hook may
  legitimately produce nothing.
- **A component that logs errors itself** keeps its uncaught-exception and
  rendered-output assertions and drops the console one, naming the call.

### `--api` → `mocks/`

`handlers.ts`, `node.ts`, `browser.ts`: MSW handlers derived from the OpenAPI
spec's example responses, shared by the unit suite (node) and the browser host
(worker), so both layers agree on what `/api/*` returns.

### Next.js mode → `provider.tsx`

The client-safe provider chain, derived from the app-router layout's JSX around
`{children}`. Non-literal props the layout passed are emitted as
`TODO(flawless)` comments rather than guessed at. Derived from the layout, so
`--force` refreshes it when the provider chain changes; `provider.fixtures.ts`
beside it holds values a human typed and is never
overwritten.

### `e2e` → `e2e/`

`playwright.config.ts` (pointed at the target's real dev server, overridable
with `FLAWLESS_E2E_BASEURL`), a `global-setup.ts` stub for login, and one spec
per app-router page asserting the route loads without console or page errors,
plus up to three interactions harvested from the page's component tree.

### `load` → `load/`

crust pipes per route and per API operation. Run with `bun run flawless:load`.

### Every run → `REPORT.md` and `reports/`

`REPORT.md` accounts for every component the analyser found: how many can mount
in the browser host, how many cannot and why, and which files yielded no
component at all. It carries no timestamp and every list is sorted, so a second
identical run leaves `git status` empty.

`reports/summary.json` is the machine-readable per-task result, and
`<Component>.flawless.json` sidecars carry per-component findings unless
`--no-inline-summary`.

Every path inside a sidecar — `file` and each entry of `reports` — is written
**relative to the sidecar itself**, so resolve them with
`path.resolve(dirname(sidecarPath), value)`. They used to be absolute, which
named the machine that ran the tool in a file that gets committed; that is the
invariant `src/emitPaths.ts` exists to hold, and the sidecar was the one emitted
file its sweep did not cover. Note that `reports.a11y` and `reports.reactRules`
point at the run's single aggregate — those two tasks are sweeps — while
`reports.perfStatic` is per component.

---

## The native suite (`--expo`)

A different plane, not a variant of the DOM one. Under `--expo --tasks unit-browser` the run writes:

```
<outDir>/
├── jest.config.cjs        # regenerated every run
├── jest.setup.ts          # WRITE-ONCE — hand-written module mocks live here
├── styleStub.js           # jest cannot parse CSS; app/_layout.tsx imports global.css
└── unit/
    └── <Component>.flawless.test.tsx
```

and merges `flawless:unit` plus the runner into the **app's** `package.json`.

### Why `.cjs`

Jest loads `jest.config.js` through `require`, which is CJS unless the nearest `package.json` says `"type": "module"` — and in Expo mode the nearest one is the target app's, whose type the tool does not control. `.cjs` is unambiguous wherever it sits. Exactly the reasoning behind `vitest.config.mts`.

### Why the specs live in `unit/`

Not a directory of their own, deliberately. `tests/docsLint.test.ts`'s `EMITTED_DIRS` is a **filter**: a prose claim about a path under an unlisted directory is silently skipped rather than checked. A `native/` directory would therefore make every native path claim in the docs unverified *forever* instead of turning something red.

### The version pairing

Derived from the project, never guessed, because every wrong answer here fails somewhere that names nothing:

| package | pin | why |
|---|---|---|
| `jest-expo` | `~<the project's own SDK major>.0.0` | `jest-expo@54` pairs with Expo SDK 54. A fixed range breaks every other adopter; a guessed one fails inside `expo-modules-core`. |
| `jest` | `^29.7.0` | jest-expo's own `babel-jest`/`@jest/globals`/`jest-snapshot` are all `^29.2.1`. A bare `jest` resolves to 30, and the mismatch surfaces as `this._moduleMocker.clearMocksOnScope is not a function` from inside jest-runtime. |
| `@testing-library/react-native` | `^13.3.3` | **13, not 14.** expo-router 6's testing-library is built against `react-test-renderer`, which RNTL 14 replaced with `test-renderer`. |
| `react-test-renderer` | `19.1.0` | what jest-expo 54 itself carries. |

When the SDK major cannot be read from the project's `expo` range *or* from what is installed, `jest-expo` is left undeclared and the run says so. It never substitutes a number.

### Three spec shapes, chosen from the file

**A route screen** — any file under the expo-router root that resolves to a route — mounts through `renderRouter` from `expo-router/testing-library`, at its own URL. This is not a preference. `useFocusEffect` reaches `useNavigation()`, which throws `Couldn't find a navigation object` outside a navigator, and `useLocalSearchParams` is empty. Mounted inside a real navigator the screen is **focused**, so focus effects actually run and the spec can assert loaded state rather than the loading skeleton.

The context is the plain **object** form:

```tsx
const CONTEXT = {
  "_layout": Layout0,
  "login": { default: LoginScreen },
  "signup": { default: () => null },   // a stub for every literal push target
};
```

Never the string or `{ appDir }` forms: expo-router resolves both through `path.resolve(process.cwd(), …)`, so a spec using one breaks the moment jest runs from the monorepo root instead of the app directory.

**A `_layout`** is a third case. `<Tabs>` and `<Stack>` call `useContextKey` and throw `No filename found. This is likely a bug in expo-router` when rendered alone, so a layout is mounted through its own navigator with one synthesised child — the smallest honest way to exercise it.

**Everything else** mounts through RNTL's `render()`.

### What a native spec asserts

- **It mounted.** `expect(screen.toJSON()).not.toBeNull()` — the direct analogue of the DOM spec's `container.firstElementChild` check, and null if and only if the component rendered null.
- **It landed on its route**, for a route screen.
- **Its static copy**, through `getAllByText`. This ports unchanged: RNTL's `getByText` matches a `<Text>`'s composed content, which is where React Native copy lives.
- **Each addressable interaction**, driven by `fireEvent` (route specs) or `userEvent` (component specs — `renderRouter` turns on fake timers internally, and `userEvent`'s press timing under fake timers is not something the emitter can vouch for).
- **The resulting pathname**, where the source names a literal route: `onPress={() => router.push("/items/new")}` is statically knowable, and this is the React Native analogue of asserting a link's `href`.

Three DOM assertions have **no honest native equivalent and are dropped rather than faked**: the root-tag `querySelector`, the `.flawless-cls` className-flow check (NativeWind compiles `className` away through babel, so a sentinel class is unobservable), and anything asserting a specific style token.

### No emitted spec touches the network

A module that resolves project-locally and performs `fetch()` is `jest.mock`ed with stubs. This is not a nicety: before it existed the fixture suite made live HTTP calls and crashed a jest worker with `api_error 405` from a real server. The mock's specifier is relativised to the **spec**, not to the component — `app/login.tsx` writes `"../lib/api"`, which from `flawless/unit/` names `flawless/lib/api` and does not exist.

Each stub's shape comes from the mocked function's own `Promise<T>` return annotation, resolved through workspace barrels and zod schemas. A function that returns `Promise<void>` mocks to `undefined` and carries no marker — undefined *is* its realistic return value. Only a shape that could not be resolved falls back to `{}`, and that one keeps a `TODO(flawless)`.

That fallback is not cosmetic. `const { items } = await listBuildings()` against `{}` binds `items` to undefined, `setBuildings(undefined)` follows, and the next `buildings.length` throws into the app's own ErrorBoundary — so the screen renders "Something went wrong" and every copy assertion fails, looking like a defect in the component. A freshly generated suite was red on 3 of 31 real screens for that reason alone.

Collections in those fixtures are emptied for the default mock, so every assertion derived from the initial render holds. The loaded state gets its own test — see below.

### Unaddressable controls become named skips

React Native has **no implicit roles** — `getByRole("button")` matches nothing on a bare `<Pressable>` — and there is deliberately **no last-resort locator**. The two candidates are both unsound: `UNSAFE_getByType(Pressable)` compares component identity, and under NativeWind's `jsxImportSource` the `Pressable` the source rendered went through `cssInterop`'s wrapper while the one a spec imports is the bare component, so it matches zero elements; and "the first pressable in the tree" is wrong for the same reason the DOM ladder refuses an ambiguous bare tag, only more often.

So a control with no `testID`, no `accessibilityLabel`, no `accessibilityRole` and no text under it is a `test.skip` carrying the reason and the fix. The icon-only wording wins over the ambiguous one when both apply, because one `accessibilityLabel` resolves both — and the same absence is what makes the control silent to a screen reader.

### The loaded state gets its own test, on the screens where that is fair

The default mock returns empty collections, so a list screen renders its empty branch and nothing exercises the row markup. A separate test re-mocks **one** function to return a single row and asserts a synthesised witness value appears.

It is only emitted where three things hold, each checked against the component's AST:

1. **Mounting calls the function.** Reachable from a `useEffect` / `useFocusEffect` callback or evaluated in the component body — and not inside a branch, a `catch`, or a JSX event handler. A mutation called from a submit handler is not a loader, and a call behind `if (isTrustee)` does not run.
2. **What it returns is rendered as a list.** The result reaches a `useState` setter whose state variable is mapped in JSX or handed to a list as `data`. A collection the screen reads to decide a permission flag changes a boolean, not the screen.
3. **The row has a witness.** A string field that *this* list's row renders as a JSX child — not an attribute value, and not a field rendered elsewhere in the file over different data.

Where any of the three fails, the emitter writes a `test.skip` naming which one. On the dogfood app 14 of 31 screens qualify and all 14 pass; the other 17 say why.

`router.back()` gets a history entry pushed before the press. `renderRouter` mounts one screen at one URL with nothing behind it, so `GO_BACK` into an empty stack fails with *The action 'GO_BACK' was not handled by any navigator* — a missing precondition reported as a defect. In a component spec, which has no router, the handler is a skip that says so.

