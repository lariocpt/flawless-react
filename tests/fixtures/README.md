# tests/fixtures

`aliased-next-app/` — the Chunk 0 baseline harness from `DOGFOOD-0.3.1-FIX-PLAN.md`.
`tests/dogfood-baseline.test.ts` generates a suite against a copy of it and asserts
the current (wrong) behaviour of each dogfood defect, one `// FIX-PLAN: chunk N`
marker per fix. Read that file for what each shape is for.

`vitest5-app/` — the host of chunk #10's execution test
(`tests/vitest5AppExecution.test.ts`): a minimal non-Next app whose tsconfig says
`jsx: "preserve"` — the shape that killed every colocated spec at parse under the
old always-esbuild emission — and whose own package.json declares vitest `^5.0.0`
(a fresh install lands vitest 5.x + vite 8.x). The test installs that stack before
running the tool, asserts the emitted config declares the oxc mechanism for the
vite that will actually run, and runs the colocated specs green from the app root
and from the suite's own `test:unit` entry point.

`depthapp/` — the depth-surface fixture from
`docs/plans/PLAN-01-depth-free-derivation.md` (chunk 5): one component per
D1/D2/D3/D4 pattern (P1–P10) plus the two refusal controls (N1 conditional
disabled, N2 computed aria-label). `tests/depthSurface.test.ts` generates a
suite against a copy of it and checks, per pattern, which assertion is — or
must not be — in the emitted spec; the census of that suite is
`docs/plans/baselines/depth-surface.json`. Unlike `aliased-next-app` (whose
files carry `// @ts-nocheck` over `@/…` imports the repo's tsconfig cannot
resolve), every source file here uses relative imports, so the repo's own
`bunx tsc --noEmit` typechecks the fixture for real; `react-shims.d.ts`
stands in only for `useActionState`, which the repo's @types/react 18.3
predates (the fixture's package.json declares react 19, where it is stable).

## Why each file exists

| file | shape it carries | defect |
| --- | --- | --- |
| `tsconfig.json` | `paths: { "@/*": ["./src/*"] }`, **no** `baseUrl`, `exclude` without the suite dir | #1, #2 |
| `package.json` | react/react-dom pinned to **19.1.0** — the version whose `react-dom/server` (node build) does NOT export `renderToReadableStream`; 19.2+ added it, so a floating pin hides defect #3 | #3 |
| `biome.json` | `noExplicitAny: error` — a host lint gate | #9 |
| `src/app/layout.tsx` | async root layout returning `<html>`, wrapping children in a client provider imported via `@/` — the derived `flawless/provider.tsx` carries that `@/` import | #1, #3, #4 |
| `src/app/page.tsx` | async RSC page awaiting a data function, rendering a client child | #4, #7 |
| `src/app/promise-child/page.tsx` | async page with a PROMISE as a child (React 19 suspense-data) and two children so the flattening key-warning fires | #7 shape (a) |
| `src/app/promise-prop/page.tsx` + `src/components/ReportTitle.tsx` | async page passing a PROMISE-VALUED PROP into a client child that renders it directly — the shape `resolveAsyncUi` ignored | #7 shape (b) |
| `src/app/nested/page.tsx` + `src/components/Outer.tsx` + `src/components/Inner.tsx` | async component rendered by an async page, itself rendering an async component | #7 shape (c) |
| `src/lib/data.ts` | `loadHeading()` — a promise handed to JSX UNAWAITED, resolving on a macrotask so a late resolution can land outside act(); `signOff()` — the export only the non-analysed `labels.ts` names, which the page's evidenced import forces the mock to cover anyway | #7, #13 |
| `src/lib/labels.ts` | plain (non-component) lib the analysis never opens (entry pattern `*.tsx`, never tagged); its module-scope import of `signOff` from `./data` makes the mocked data module load through a file the analysis never read | #13 |
| `src/components/InboxList.tsx` | client component calling a synchronous zustand selector and `.map`ping its result; imports `signatureLine` from `@/lib/labels` — type FIRST, value second, the load-bearing order — and renders its output in a `.sig` span | #4, #13 |
| `src/components/providers/store-provider.tsx` | real zustand store (sync `useStore` hooks) | #4 |
| `src/app/api/[[...route]]/route.ts` | hono-style catch-all API router | #5 |

## Generation run (measured 1 Nov 2026)

`runCore` with all seven tasks against a copy of the fixture exits 0 and every
task reports ok. Files emitted under `flawless/` (45):

```
README.md  REPORT.md  budgets.json  package.json  playwright.config.ts
pnpm-workspace.yaml  provider.tsx  server-only-stub.ts  setup.ts  swagger.json
tsconfig.json  vitest.config.mts
browser/InboxList.spec.ts  browser/StoreProvider.spec.ts  browser/playwright.config.ts
e2e/{README.md,global-setup.ts,index.spec.ts,params.json,params.ts,playwright.config.ts}
host/{_polyfill.ts,index.html,main.tsx,registry.ts,server.ts}
load/{README.md,env.sh,routes.pipes,routes.setup.ts}
mocks/{README.md,browser.ts,handlers.ts,node.ts}
profile/InboxList.profile.spec.ts  profile/StoreProvider.profile.spec.ts
profile/_heap.ts  profile/_helpers.ts
reports/*.json  (perf-static x4, a11y, react-rules, summary)
```

Plus colocated specs (with `colocate: true`): `src/app/layout.flawless.test.tsx`,
`src/app/page.flawless.test.tsx`, `src/components/InboxList.flawless.test.tsx`,
`src/components/providers/store-provider.flawless.test.tsx`.

## Which planes start (measured 1 Nov 2026, before the Chunk 1 fix)

Measured in a scratch copy with `react@19.1.0 react-dom@19.1.0 zustand hono next`
installed **before** generation (the react pins only reach the vitest config when
node_modules exists at generation time), plus
`@playwright/test@1.64.1 vitest@^2.1.0 jsdom@^25 @testing-library/react
@testing-library/jest-dom` as dev deps:

| plane | before the fix | after giving `flawless/tsconfig.json` `baseUrl: ".."` + `paths` |
| --- | --- | --- |
| unit (vitest) | starts: 3 failed / 3 passed / 1 skipped (4 files) — failures are defects #3 (`renderToReadableStream is not a function`) and #4 (`toasts.map is not a function`) | unchanged by the tsconfig fix |
| browser (playwright) | **webServer exit 1**: `Could not resolve: "@/components/providers/store-provider"` at `flawless/provider.tsx` | **4 specs executed, 4 passed** |
| perf (playwright) | **webServer exit 1** (same host bundle, same failure) | **4 passed, 6 skipped** |
| e2e / load | generated; need a running app + params, not exercised here | — |

Deleting `flawless/tsconfig.json` instead of fixing it also starts both planes
(4 passed) — proof that Bun's bundler consults the nearest tsconfig per file and
the harness file is what shadows the app's own `paths`.

## Reproducing the plane measurements

```sh
cp -r tests/fixtures/aliased-next-app /tmp/app && cd /tmp/app
bun install   # BEFORE generating — the react pins in the vitest config need it
bun add -d @playwright/test@1.64.1 'vitest@^2.1.0' 'jsdom@^25.0.0' \
  @testing-library/react @testing-library/jest-dom
# generate with runCore (see tests/dogfood-baseline.test.ts), then:
bunx vitest run --config flawless/vitest.config.mts
bunx playwright test --config flawless/browser/playwright.config.ts
```

The emitted config's JSX mechanism follows the vite the suite will actually run,
not the vitest its manifest pins: vitest 2/3 pull vite 5/7, where the transformer
is esbuild, so the config carries `esbuild: { jsx: "automatic" }` — green on this
fixture's `jsx: "preserve"` host (Next's own, not a fixture bug). Vitest 4/5 pull
vite 8, where vitest always injects its own `oxc: { target }` default and vite
discards a second `esbuild` key with a warning, leaving jsx to the host tsconfig —
so the config carries `oxc: { jsx: { runtime: "automatic" } }` instead, green on
every host `jsx` shape, preserve included. This fixture's reproduction pins
vitest 2, its frozen path; a vitest 5 host is covered by `vitest5-app/` and
`tests/vitest5AppExecution.test.ts`.

## Unit plane after chunk 3 (measured 1 Nov, react-dom pinned 19.1.0)

The document-root spec now streams through `react-dom/server.browser` — the specifier
the pinned react-dom actually exports `renderToReadableStream` from, measured at
generation time (`src/reactDomServerStream.ts`). Per spec: `layout.flawless.test.tsx`
no longer fails `renderToReadableStream is not a function` (defect 3 gone); it now
fails `createStore(...) is not a function` — defect 4's `vi.fn(async () => ({}))`
guess at `zustand/vanilla`'s curried factory. `page.flawless.test.tsx`'s two
`toasts.map` reds are defect 4's too. Tally: 3 failed / 3 passed / 1 skipped —
same count, different reasons; the layout goes green only with chunk 4.

## Unit plane after chunk 4 (measured 1 Nov, vitest 2.1.9, react-dom pinned 19.1.0)

The whole unit plane is green: **4 files, 6 passed / 1 skipped / 0 failed**, executed from the
app root with `vitest run --config flawless/vitest.config.mts` (candidate defect #12: running
from inside `flawless/` instead reddens every colocated spec on vite's `fs.allow`). The layout
spec now emits no `vi.mock` at all — the zustand family is left real, so `createStore<AppState>()
((set) => …)` runs for real and `createStore(...) is not a function` is gone. The page spec's
`useToasts` gets a sync one-element array fixture from its `.map` use site
(`vi.fn(() => [{ id: "flawless-id", text: "flawless-text" }])`), so both `toasts.map` reds are
gone. `store-provider.flawless.test.tsx` mounts the real store (2 passed / 1 skipped — the
interaction skip is the guard-path contract, not a defect). InboxList stays green.

## Unit plane after chunk 9 (measured 2 Nov, vitest 2.1.9, react-dom pinned 19.1.0)

The three defect-#7 shapes, generated from this fixture and executed with
`vitest run --config flawless/vitest.config.mts` from the app root. **Before** the fix:
**2 failed / 14 passed / 1 skipped (10 files)** — the promise-prop page reproduced the dogfood
symptom exactly:

```
× PromisePropPage (RSC): resolves, or takes one of its declared guard paths
  → expected 0 to be greater than 0            (container.innerHTML — the empty <div />)
× PromisePropPage static content > renders "below the slot"
  → Unable to find an element with the text: below the slot … <body><div /></body>
stderr: A suspended resource finished loading inside a test, but the event was not wrapped in act(...).
stderr: A component suspended inside an `act` scope, but the `act` call was not awaited.
stderr: Each child in a list should have a unique "key" prop.
        Check the top-level render call using <main>.
```

The key warning came from any page with ≥2 children (promise-child and the original page included):
`resolveAsyncUi` rebuilt the children array through `cloneElement`, which cannot reproduce the
"static children" mark the jsx runtime attaches internally. The promise-CHILD shape rendered content
even before the fix — `await` unwrapped the thenable by accident — the plan's "children never
awaited" half was wrong; only promise-valued PROPS reproduced the empty container.

**After** the fix (props walked, explicit `isThenable` await, deliberate positional keys on rebuilt
arrays, render through `Suspense` + awaited `act` + `waitFor` settle): **10 files, 16 passed /
1 skipped / 0 failed, zero stderr** — no key warning, no act warning, the skipped test is the
store-provider interaction guard (named, counted in REPORT.md's "Named skips").

## Unit plane after chunk 13 (defect #13's standing shape)

`src/lib/labels.ts` + the re-wired `src/components/InboxList.tsx` carry defect
#13: `InboxList` imports `signatureLine` from a lib the analysis never opens
(the entry pattern is `*.tsx`, and nothing is tagged from `labels.ts`), and
that lib imports `signOff` from the same `@/lib/data` module the page's
evidenced `getInboxItems` import forces to mock. Before the fix the page
spec's data factory covered only the evidenced importers, and the real
`labels.ts` died at import time on the missing export — the 2 Nov triage
measured **2 failed** with
`Error: [vitest] No "signOff" export is defined on the "@/lib/data" mock`.

The import statement order in `InboxList` (type FIRST, value second) is
load-bearing: it is the merge order, and only a type-only merge base keeps
the `@/lib/labels` view type-only, which is what keeps the module REAL and
lets its own `./data` import run against the mock. A value-first order mocks
labels and hides the hazard. The plan's #13 section carries the receipts and
says which seam shipped.

The fix folds the non-analysed importer's own import lines into the per-module
mock view (analysis-side, one hop, through the shared source cache), so the
factory covers `signOff` (graph-only: the honest `{}` stub plus the "guessed"
note) while `@/lib/labels` stays real. `tests/mockFactoryExtension.test.ts`
renders the real page and asserts the signOff output in the DOM. The
after-tallies of the full unit-plane run are recorded once the deferred gate
runs land on the verification host — nothing here is quoted before it is
measured.
