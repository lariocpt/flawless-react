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

- **`vitest.config.mts`** — jsdom environment, the project's tsconfig `paths` as
  `resolve.alias`, and `resolve.dedupe: ["react", "react-dom"]`. The dedupe is
  not cosmetic: in a workspace where `react` resolves to the repo root and
  `react-dom` to the package, `react-dom/server` sets its hook dispatcher on a
  different React instance than the component reads from, and every hook call
  fails with `Cannot read properties of null (reading 'useEffect')`.
- **`setup.ts`** — `@testing-library/jest-dom`, the jsdom gaps real component
  stacks hit (`matchMedia`, `ResizeObserver`, `IntersectionObserver`,
  `scrollIntoView`), MSW wiring when `--api` was used, and an in-memory `Storage`
  fallback. That last one matters on Node ≥ 22, which defines a `localStorage`
  global that is inert without `--localstorage-file`; persistence middleware
  (zustand `persist`, redux-persist) is otherwise handed `undefined` and throws
  on its first write.
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
  | none of the above | `test.skip` naming which preconditions failed |

  A component behind an undecidable early return gets `expect(() =>
  renderTarget()).not.toThrow()` instead of a claim that something appeared —
  `if (toasts.length === 0) return null` backed by a store hook may legitimately
  render nothing.

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
    whole value; generics bail; `T[]` yields a one-element array).
  - `/* inferred from the OpenAPI example for GET /api/… */` — the dep is an
    unannotated wrapper around exactly one `fetch()`, joined to the API spec's
    response example at emit time.

  Deps with neither keep the `{}` stub, the
  `TODO(flawless): some return shapes could not be inferred` marker, and the
  RSC spec's fixture-missing skip escape. An **enriched** dep is real
  coverage: its spec has no skip escape, so a wrong inferred fixture fails
  red instead of hiding. Usage-derived shapes always outrank declarations —
  the component's own reads are better testimony than a type annotation.
- Components that cannot mount standalone — a `<Dialog.Content>` outside its
  Root, a layout returning `<html>` — get a spec that asserts what IS true and
  states the reason in the file. **Compound parts whose own file exports the
  family** (the shadcn shape: a sibling rendering `<X.Root>` plus a Content
  sibling) do better: the spec mounts the part the way call sites do — the
  Trigger inside a closed Root, everything else inside
  `<Root open><Content>…</Content></Root>` — with portal-aware assertions
  reading `baseElement`. Only open-state families are wrapped (dialog,
  alert-dialog, popover, dropdown-menu, select, tooltip, hover-card,
  context-menu, menubar, collapsible); value-driven families (accordion,
  tabs) and parts without a same-file Root keep the honest skip and its
  TODO. The browser host mounts wrapped parts too: the regenerated
  `host/registry.ts` composes the wrapper per entry and records it in a
  `COMPOUND_WRAP` table, so a kept `main.tsx` benefits from a plain refresh.

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
`TODO(flawless)` comments rather than guessed at. Written once and never
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
