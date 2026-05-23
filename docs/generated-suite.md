# The generated suite

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

Scripts: `test`, `test:headed`, and (if you used `--report`) `report`. The suite's package name is `<component-name>-profile`.

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

Workers are pinned to 1 because the host serves one component at a time and we don't want parallel mounts fighting over the singleton `activeRoot`.

**Edit when**: you need a different port, you want to add a `firefox` or `webkit` project, or you want to run tests in parallel (which requires reworking the host to scope state per-page).

## `host/server.ts`

A tiny `Bun.serve` that builds `host/main.tsx` once via `Bun.build({ target: "browser" })` and serves three routes: `/` (the HTML shell), `/bundle.js` (the built ESM), and `404` for everything else.

The build runs **at startup**, not per request, so test runs hit a hot bundle. If you're iterating on `main.tsx` you can either restart the server manually or replace the one-shot build with a `Bun.build` watcher.

**Edit when**: you want to inject env vars into the bundle, add CSS, or serve additional static assets (mock JSON fixtures, etc.).

## `host/index.html`

Two lines that matter: a `<div id="root">` and a `<script type="module" src="/bundle.js">`. The rest is boilerplate.

**Edit when**: you need a different root element ID, a CSS reset, or extra DOM your component depends on (e.g. a portal target).

## `host/main.tsx`

This is the heart of the runtime. Three things happen here:

1. **react-scan is initialised once at module load**. It buffers any `unnecessary: true` render events into a `scanEvents` array.
2. A **`REGISTRY`** maps component names to imported components. The CLI populates this from the analysed `ComponentTree`.
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

**Edit when**: you want to wrap components in a provider (React Router, theme, query client, store) — prefer the `--provider <file>` flag at scaffold time, which threads your wrapper through `mount` / `rerender` for you. You can also expose additional helpers on `window.__profile` if your tests need them.

## `tests/_helpers.ts`

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

## `tests/_heap.ts`

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

## `tests/<Component>.profile.spec.ts`

One spec per analysed component. Each spec is **fully self-contained** — its `DEFAULTS`, `VARIANTS`, and `HOOKS` are baked in as literals at the top. There is no shared fixture file, no implicit dependency between specs.

The four tests:

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

Looks for a `<button>` in the mounted DOM. If none, the test skips. If one exists:

- Capture the current render count.
- Click the button.
- Wait for the render count to increment.
- Check `getScanEvents()`: any unnecessary rerenders from `react-scan` become a console warning.

This test is the most "exploratory" — it works for components with a single primary action button. If your component has more nuanced interactions (form fields, drag handles, keyboard shortcuts), this is the test you'll most often replace by hand.

### `forced rerender × N`

Cycles `--variants × 10` renders through the variant pool (or `[DEFAULTS]` if none) and prints a `{min, avg, p50, p95, max, n}` summary. The HOOKS list is logged at the end for context.

**Edit when**: you want to assert hard ceilings on p95; you want a different N; you want to drive prop changes through your own data fixtures rather than the synthesised ones.

### `stress-click-rerender × 50`

A leak-detection scenario. Mounts the component, takes a baseline heap snapshot, clicks the primary `<button>` fifty times in a tight loop, then takes a final heap snapshot. Both snapshots are **always attached** to the Playwright report (artifact size budget is small — a snapshot of a tiny component is typically <500 KB).

There is no assertion on byte delta — it's too noisy across machines and React versions. The value is the saved snapshots: open them in Chrome DevTools' Memory tab → Comparison view and look for unexpected retained objects (detached DOM nodes, growing arrays of listener closures).

The other three scenarios (`variant matrix`, `click rerender`, `forced rerender × N`) are wrapped by `bracketScenario(...)` from `tests/_heap.ts`. They take before/after snapshots too, but **only attach them on failure** — keeping passing-run artifacts small.

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

Reads `playwright-report/index.html` from the last run and writes a `report.md` summarising the per-component variant and forced-rerender stats. Plain Node script — no Playwright runtime needed.

**Edit when**: you want HTML output, or to push the summary to a metrics endpoint, or to diff against a baseline JSON.

## `README.md`

A short user-facing README for the *generated* suite, separate from this repo's README. It documents how to run, what's measured, and how to customise. It is also editable by you and never overwritten by the tool unless you re-run with `--force`.
