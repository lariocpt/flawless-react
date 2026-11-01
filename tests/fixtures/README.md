# tests/fixtures

`aliased-next-app/` — the Chunk 0 baseline harness from `DOGFOOD-0.3.1-FIX-PLAN.md`.
`tests/dogfood-baseline.test.ts` generates a suite against a copy of it and asserts
the current (wrong) behaviour of each dogfood defect, one `// FIX-PLAN: chunk N`
marker per fix. Read that file for what each shape is for.

## Why each file exists

| file | shape it carries | defect |
| --- | --- | --- |
| `tsconfig.json` | `paths: { "@/*": ["./src/*"] }`, **no** `baseUrl`, `exclude` without the suite dir | #1, #2 |
| `package.json` | react/react-dom pinned to **19.1.0** — the version whose `react-dom/server` (node build) does NOT export `renderToReadableStream`; 19.2+ added it, so a floating pin hides defect #3 | #3 |
| `biome.json` | `noExplicitAny: error` — a host lint gate | #9 |
| `src/app/layout.tsx` | async root layout returning `<html>`, wrapping children in a client provider imported via `@/` — the derived `flawless/provider.tsx` carries that `@/` import | #1, #3, #4 |
| `src/app/page.tsx` | async RSC page awaiting a data function, rendering a client child | #4, #7 |
| `src/components/InboxList.tsx` | client component calling a synchronous zustand selector and `.map`ping its result | #4 |
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

vitest must be 2.x: vitest 5 + vite 7 ignores the emitted `esbuild.jsx` override
and dies collecting every spec ("make sure to not set jsx to preserve" — the
fixture's `jsx: "preserve"` is Next's own, not a fixture bug).
