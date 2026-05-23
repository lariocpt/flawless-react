# flawless-react

A multi-task quality kit for React components. Point it at a `.tsx` file (or a glob), pick which checks to run, and get back a runnable Playwright + Vitest suite, an accessibility scan, and a Biome-driven correctness report — with file:line findings for every issue.

Run it with no args for an interactive checkbox menu of five tasks:

1. Generate the **performance testing harness** (Playwright + React `<Profiler>` + react-scan).
2. Generate **extensive unit + browser tests** (Vitest + @testing-library/react + Playwright functional).
3. **Static React perf analysis** (rerender storms, missing memoisation, unresolved props).
4. **Accessibility / web standards scan** (ESLint + eslint-plugin-jsx-a11y, file:line findings).
5. **Functionally important React rules** (Biome — useExhaustiveDependencies, useHookAtTopLevel, useJsxKeyInIterable, and friends).

Pass a single positional that resolves to a file or a glob (e.g. `src/**/*.tsx`) — each match becomes an entry component and runs against every selected task. A small `<Component>.flawless.json` is dropped next to every source file so issues surface where the code lives.

The tool itself is a thin scaffolder. The intelligence is the static analysis that decides what to import, what props to vary, and which children to walk into. The runtime measurement is done by React's built-in [`<Profiler>`](https://react.dev/reference/react/Profiler) for per-component `renderCount` / `renderTime` and [`react-scan`](https://github.com/aidenybai/react-scan) for detecting unnecessary rerenders. Memory profiling uses Chrome DevTools Protocol's `HeapProfiler.takeHeapSnapshot` and writes `.heapsnapshot` files to a clean `./heaps/` directory.

Optional flags let you `--provider <file>` to wrap mounted components in your Redux / React Query / theme provider, and `--api <openapi.json>` to scaffold a standalone Bun mock server alongside the host so the component's `fetch('/api/…')` calls hit deterministic example responses.

Once the suite is generated, it belongs to you — there is no regeneration step that overwrites your edits.

## Contents

- [Why](#why)
- [Install](#install)
- [Quickstart](#quickstart)
- [CLI reference](#cli-reference)
- [What gets generated](#what-gets-generated)
- [Worked example](#worked-example)
- [Working with stores and APIs](#working-with-stores-and-apis)
- [Limits & assumptions](#limits--assumptions)
- [Troubleshooting](#troubleshooting)
- [Further reading](#further-reading)
- [Development](#development)

## Why

Manually wiring up a Playwright + `<Profiler>` + `react-scan` harness for a non-trivial component takes a couple of hours of fiddly boilerplate: bundle the component for the browser, host it, expose a JS API to drive renders, write the test scaffolding, define budgets, hand-pick prop variations, polyfill Node globals for CJS deps, set up Provider context, mock the backend. None of that work is interesting.

`flawless-react` reads the component's type signature, discovers its child components by walking the JSX, and produces all of that scaffolding mechanically. You get a runnable suite in seconds, and you can then **edit it like normal test code** — tighten budgets, add scenarios, mock data sources, swap in real fixtures.

## Install

```bash
bun add -g flawless-react
# or one-shot, no install
bunx flawless-react ./src/Dashboard.tsx
```

Requires Bun >= 1.1.

## Quickstart

```bash
bunx flawless-react ./src/Dashboard.tsx --out .profile/dashboard
cd .profile/dashboard
bun install
bun run test           # headless Chromium
bun run test:headed    # visible Chromium
```

You should see Playwright report five tests per analysed component (`mounts at defaults`, `variant matrix`, `click rerender`, `forced rerender × N`, `stress-click-rerender × 50`) and console lines with timing summaries. After the run, `./heaps/` contains `.heapsnapshot` artefacts for every stress scenario, loadable in Chrome DevTools' Memory tab.

## CLI reference

```text
flawless-react <entry.tsx> [options]
```

| Flag | Default | Effect |
| --- | --- | --- |
| `<entry.tsx>` | required | Path to the root component file. |
| `--out <dir>` | `<cwd>/<ComponentName>.profile/` | Output directory for the generated suite. |
| `--depth N` | `3` | Levels of locally-imported child components to follow (`0` = leaf only). |
| `--variants N` | `5` | Prop-variant rows in the generated test matrix. |
| `--include-children` | `true` | Walk transitive child components. Pass `--include-children=false` to skip. |
| `--props '<json>'` | none | Override the synthesized default props. Merged on top of the static-parse result. |
| `--provider <file>` | none | Path to a `.tsx` file that default-exports a wrapper component. The host renders every mounted component inside it — use this for Redux, React Query, theming, or any other context-based store. |
| `--api <spec>` | none | Path to an OpenAPI / Swagger JSON or YAML file. Scaffolds a standalone Bun mock server (`mock/server.ts`) with static route handlers generated from the spec's first example responses; the host server transparently proxies all non-asset requests to it. |
| `--force` | off | Overwrite an existing output directory. |
| `--report` | off | Emit `scripts/report.mjs` so `bun run report` aggregates run output into a markdown summary. |
| `-h, --help` | — | Show help. |
| `-V, --version` | — | Show version. |

The CLI prints a JSON summary on success: the chosen `outDir`, the detected component name, its children, hooks, props, and a `nextSteps` array you can copy-paste.

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
│   └── main.tsx          # createRoot + <Profiler> + react-scan + window.__profile driver
├── tests/
│   ├── _helpers.ts       # render-info / scan-event harvesters, summarize() stats
│   ├── _heap.ts          # CDP-driven heap-snapshot helpers (write to ./heaps/)
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
  "outDir": "/your/cwd/Dashboard.profile",
  "componentName": "Dashboard",
  "children": ["Hello", "Card"],
  "hooks": ["useMemo"],
  "props": { "title": "", "count": 0 },
  "filesWritten": 12,
  "nextSteps": ["cd /your/cwd/Dashboard.profile", "bun install", "bun run test"]
}
```

Inside `Dashboard.profile/` you get three spec files (`Dashboard.profile.spec.ts`, `Hello.profile.spec.ts`, `Card.profile.spec.ts`). Each spec contains:

- **`mounts at defaults`** — baseline mount; asserts `renderCount >= 1`; warns if `mountMs` (from `React.Profiler`'s `onRender` `actualDuration`) exceeds `budgets.json[name].mountMs`.
- **`variant matrix`** — for `Hello.variant: "primary" | "secondary"`, the analyser produces two variants; the test rerenders with each and warns on the p95 over `updateMs` budget.
- **`click rerender`** — locates the first `<button>` rendered by the component, clicks it, and asserts the render count incremented; if `react-scan` flagged any unnecessary rerender on a prop-stable child, the spec logs a warning.
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

## Limits & assumptions

The static analyser is deliberately narrow — it favours predictability over cleverness.

- **Component shape**: a `const X: React.FC<Props> = (props) => …` declaration, or an `export default function X(props: Props) { … }`. Other forms (HOCs, decorators, dynamic component factories) are not detected.
- **Props type**: only types declared *in the same file* are resolved. Imported types push the prop into `unresolvedProps`; you'll need to pass `--props '{…}'` or edit the generated spec's `DEFAULTS` constant.
- **Type → default value**: primitives, arrays (always `[]`), inline object types (recursive), literals. **Unions of non-literals**, intersections, and generics fall into `unresolvedProps`.
- **Variant matrix**: only union-of-literal props produce variants. The matrix is "pairwise" — vary one prop at a time around the defaults, not the full cartesian product.
- **Children**: only locally-imported components (relative paths) are walked. Anything from `node_modules` (or a TS path alias resolving to one) is skipped. Depth defaults to 3, cycle-guarded.
- **Hooks**: detected by name pattern `/^use[A-Z]/`. Custom hooks show up too. Hook detection is informational — it appears in spec output but does not yet drive different rerender strategies.

## Troubleshooting

**"could not locate a React component in …"**
The analyser didn't recognise the export shape. Refactor to a `const X: React.FC<Props> = …` declaration, or pass `--include-children=false --depth=0` and run the tool against the actual component file directly.

**`unresolvedProps` warning**
One or more props use an imported type, a generic, or a non-literal union. Either:

- Re-run with `--props '{"propName": "value", …}'`, or
- Edit the generated `tests/<Component>.profile.spec.ts` and add the missing fields to the `DEFAULTS` constant.

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

## Development

```bash
bun install
bun test           # 22 unit tests across analyse / scaffold / cli / openapi
bun run check      # biome lint + format check
bunx tsc --noEmit  # type-check
```

The repo layout:

```text
src/
├── analyse/         # ts.createSourceFile-driven AST walk; props, hooks, children
├── scaffold/
│   ├── index.ts     # scaffold orchestration
│   ├── templates.ts # all generated-file string templates
│   └── openapi.ts   # OpenAPI/Swagger loader + route extractor (used by --api)
├── cli.ts           # argparse + orchestration
└── types.ts
tests/
├── fixtures/        # Hello.tsx, Card.tsx, Dashboard.tsx, _AppProvider.tsx, _api.json
├── analyse.test.ts
├── scaffold.test.ts
└── cli.test.ts
```

## Licence

MIT — see [LICENSE](LICENSE) if present, otherwise treat as MIT.
