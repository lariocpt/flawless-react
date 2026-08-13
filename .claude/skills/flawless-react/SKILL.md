---
name: flawless-react
description: Generate and maintain React/Next.js test suites with flawless-react — task selection, Next.js mode, provider wrappers, MSW fixtures from an OpenAPI spec, colocated specs, route e2e, crust load pipes, the programmatic API, and how to read its findings. Use when adding component/e2e/load tests to a React codebase, when a generated flawless suite is red, or for "scaffold tests for this component" work.
---

# flawless-react

Point it at a `.tsx` file or glob and it reads the component's props, state,
hooks, children and fetches, then writes a runnable suite. Everything it emits
is yours to edit — it never regenerates over your edits unless you pass
`--force`.

```bash
# one component, unit specs only
bunx flawless-react src/components/Widget.tsx --tasks unit-browser --no-interactive

# a Next.js app: real fixtures, colocated specs, route e2e and load pipes
cd apps/web
bunx flawless-react "src/app/dashboard/page.tsx" \
  --nextjs . --api openapi.json --swagger-url=off \
  --tasks unit-browser,perf-static,a11y,react-rules,e2e,load \
  --colocate --no-interactive
```

## Tasks

| id | what it writes | needs |
| --- | --- | --- |
| `unit-browser` | Vitest + Testing Library specs (+ Playwright browser specs when `perf-harness` is also selected) | — |
| `perf-harness` | `host/` bundle + Profiler/react-scan Playwright suite + heap snapshots | — |
| `perf-static` | `reports/<C>.perf-static.json` findings, no files to run | — |
| `a11y` | biome jsx-a11y findings | biome in the target project |
| `react-rules` | biome correctness rules (exhaustive deps, hook order, keys) | biome |
| `e2e` | `flawless/e2e/` route specs against a real dev server | running app + seeded data |
| `load` | `flawless/load/routes.pipes` crust load pipelines | crust to run them |

Pick tasks explicitly with `--tasks a,b`; with no args in a TTY you get a
checkbox menu.

## Next.js mode

`--nextjs [path]` detects the router, auto-selects a provider, writes
everything under `<root>/flawless/`, merges devDeps + `flawless:*` scripts into
the project's `package.json`, and appends gitignore entries.

**Providers.** App-router `layout.tsx` is usually an async server component
importing `next/font` or `next/headers` — unusable under jsdom. flawless
detects that and derives `flawless/provider.tsx` from the JSX chain that
encloses `{children}`, keeping only `"use client"` components and literal
attributes; anything it drops becomes a `TODO(flawless)` comment. It is written
once and never overwritten — edit it freely (that is where you add a seeded
auth state or a theme). Pass `--provider <file>` to override.

**API fixtures.** Static route walking only sees `app/api/**/route.ts`, which
is useless for catch-all APIs (Hono, tRPC). Pass `--api openapi.json` (or
`--swagger-url http://localhost:3000/api/docs`) and real example bodies flow
into `flawless/mocks/handlers.ts` and into each generated fetch spec. Use
`--swagger-url=off` to skip the live-spec probe.

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

## Reading findings

`perf-static` and the biome tasks print `file:line:col rule message` and write
`flawless/reports/*.json`; a `<Component>.flawless.json` sidecar lands next to
each analysed source (`--no-inline-summary` to disable). Rules worth knowing:

- `perf/hook-missing-dependency` / `hook-extraneous-dependency` — stale-closure
  and over-firing effects, deliberately conservative (skipped when deps contain
  member access or spreads, so a clean report is not proof).
- `perf/unstable-child-prop` — inline object/array/arrow passed to a component
  child; flagged harder when that child is `React.memo`-wrapped.
- `perf/set-state-in-render` (error) — unguarded setState during render.
- `perf/unresolved-prop` — the analyser could not synthesise a default, so the
  generated spec passes `undefined`. Fix with `--props '{"x":1}'` or by editing
  the spec's `DEFAULTS`.

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

## Limits worth stating up front

Static analysis only, no type checker. Imported prop types resolve two hops;
intersections, host-element props (`ComponentProps<"div">`),
`ComponentProps<typeof LocalX>` and cva tables all resolve. Non-literal unions,
`Omit`/`Pick`/`Partial`, `z.infer` aliases and anything in `node_modules` do not
— the prop lands in `unresolvedProps` and the type that defeated it in
`unresolvedTypes`.

Mocks come from a component's **own** imports, so one that renders `<Link>` only
through a child gets no `next/link` mock in its own spec.

Every run writes `flawless/REPORT.md`, which accounts for every component found:
how many can mount in the browser profiling host, how many cannot and why, and
which files yielded no component at all. Read it before quoting a coverage
number — a file count is not coverage.

A green generated suite means "nothing obviously broken", not "covered" — the
value is in the scaffolding you harden, and in the findings.
