# Extending a generated suite

The output of `flawless-react` is **your test code**, not a black box. There is no regeneration step that overwrites you — running the CLI again with the same `--out` is rejected unless you pass `--force`, and a handful of files stay yours even then (see below). The whole point of the tool is to skip the boilerplate, then hand you something you can shape to your project.

This document covers the patterns we've found work well.

## Treat the suite as a fresh project

Commit it. Run linters and formatters over it. Add it to CI. Pin its dependencies the way you pin any other project's. The generator deliberately doesn't try to be "framework-aware" beyond the React + Playwright basics — once you've generated the suite, it's just files.

## Mount components inside a provider

A component that depends on a context provider (theme, router, query client, store) won't render correctly when mounted bare. Edit `host/main.tsx` to wrap the registry render site:

```tsx
import { ThemeProvider } from "your-theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

// in window.__profile.mount:
ensureRoot().render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      {createElement(Comp as never, props)}
    </ThemeProvider>
  </QueryClientProvider>
);
```

If different components need different providers, factor the wrapping into a `wrap(name, element)` helper and let the registry entries declare which wrapper they need.

## Mock data sources

For a component that calls `fetch`, install MSW in the suite (`bun add msw`) and start a worker in `host/main.tsx` before the first render:

```tsx
import { setupWorker } from "msw/browser";
import { handlers } from "./mocks/handlers.ts";

await setupWorker(...handlers).start({ quiet: true });
```

Then write `mocks/handlers.ts` with whatever endpoints your component expects. The handlers file is yours — it is never regenerated, under any flag.

## Tighten the budgets into hard failures

By default, every spec **warns** when a measurement exceeds its budget but does not fail. This is intentional for first runs — you don't yet know what "fast enough" means for your component.

Once you have a baseline (say, three green runs in CI), turn warnings into assertions:

```diff
-  if (mountMs > budget) {
-    console.warn(`[budget] ${NAME} mount ${mountMs.toFixed(2)}ms > ${budget}ms`);
-  }
+  expect(mountMs, `${NAME} mount budget`).toBeLessThan(budget);
```

Same for the variant-matrix p95 warning. Now a perf regression breaks CI.

## Answer a skip

Most of what you will want to change is a `test.skip` whose title states why the analyser stopped. They are written to be actionable — the fix is nearly always one attribute in your component, after which regenerating turns the skip into a test:

| Skip reason | What to change |
| --- | --- |
| `nothing in the source identifies the <Button> it is bound to` | give it a `data-testid`, an `aria-label`, or literal text |
| `more than one <button> renders here and nothing distinguishes this one` | as above — the tag alone cannot name it when there are several |
| `no submit control in the markup` | the form declares no `<button type="submit">`; a component tag needs the `type` explicitly, since shadcn and base-ui default to `type="button"` |
| `its submit control is disabled at these props` | supply props that enable it, or drive the UI that does |
| `<form> holds no value to change` | nothing to do — the handler is delegation, and the form test covers the fields |
| `an early return the analyser could not decide left nothing to drive` | pass the prop the guard reads, or fill the store fixture the hook uses |
| `no id fixture for /route — fill flawless/e2e/params.json` | put a seeded id in `params.json`; the load pipes read the same file |

## Files the tool will not overwrite

`--force` regenerates the derived output, but a few files are yours the moment they exist, because their contents cannot be recovered if lost:

Protected under every flag, including `--force`:

- `flawless/budgets.json` — thresholds you tightened to an observed p95. A regenerated default silently un-tightens the gate.
- `flawless/host/main.tsx` — the providers and MSW wiring you added by hand (see above). Nothing can rebuild it from the analysis.
- `flawless/provider.fixtures.ts` — the typed holes for your store's initial state.
- `flawless/e2e/global-setup.ts` — where you wire up login.
- `flawless/mocks/handlers.ts` — the response bodies are yours to fill in.

Merge-preserving under `--force` — regenerated, but never at the cost of what you put there:

- `flawless/e2e/params.json` — seeded record ids. Additive: nothing you have typed is ever removed, and neither is a blank slot another task added — the load task's API-route ids live here too and the run that needs them happens after the run that writes them. A route whose page this run did not analyse keeps its ids, so a narrower glob is not a decision to discard the rest. `--force` prunes entries that hold nothing; it never prunes a value.
- `flawless/load/routes.pipes` — a rate you tuned, a pipe you commented out and a POST flow you added by hand all survive; only the header above them is regenerated, and only when it is still the one this tool wrote.

Kept without `--force`, regenerated with it:

- `flawless/e2e/<route>.spec.ts` — route specs.
- Colocated `*.flawless.test.tsx` specs written by `--colocate`.

**Everything else is regenerated, and that is deliberate.** A frozen file never receives a later version's improvement — which is exactly what happened to `flawless/load/README.md`, stranded without the rule that `LOAD_BASE` must point at a production build. Generated prose (`load/README.md`, `e2e/README.md`, `mocks/README.md`), boilerplate (`mocks/browser.ts`, `mocks/node.ts`), every config, and the component specs inside the out dir are all refreshed. To keep a hand-hardened component spec, use `--colocate`.

A re-run over an existing suite is refused unless you pass `--force`; the check keys on the suite's own `playwright.config.ts`, not on the directory existing.

## Run only what an edit affects

A full suite is the wrong unit of work when three components changed. Analysing
a whole app costs about half a second, so `--changed` keeps the analysis and the
generation complete and narrows only the **run**:

```bash
bunx flawless-react "src/**/*.tsx" --nextjs . --tasks perf-harness,unit-browser --changed
```

It selects unit specs through vitest's module graph (`vitest related`, so it is
transitively correct), profile and browser specs by the component names, and any
e2e route whose page tree renders a changed component — that last one is the
relationship a path filter cannot see, since editing a leaf `<StatusPill>`
changes what every page rendering it produces without changing those pages'
files.

Generation is deliberately not narrowed: the profiling host is a single bundle
of every component, so a partial regeneration would leave a host that no longer
matches its specs.

## Turn heap snapshots off

The profile suite takes a V8 heap snapshot either side of every scenario. On a real app each is tens of megabytes, and a whole-app sweep leaves hundreds on disk — plus two heap walks inside every measurement they bracket. `--heaps off` skips the capture entirely; `--heaps all` persists every scenario rather than only the stress ones. The default keeps the stress pairs, which is what leak-hunting needs.

## Add more interactions to `click rerender`

`click rerender` drives the target the analyser derived from your source — a test id, an aria-label, a role plus its accessible name, or literal copy — and opens the disclosure it lives behind first. When nothing names a target the scenario is a skip carrying the reason, not a click on whichever button happens to be first.

Real components have more nuanced interactions — typing into inputs, dragging, multi-step flows. Replace the body of that test with whatever sequence exercises the component:

```ts
test(`${NAME}: form submit cycle`, async ({ page }) => {
  await mountComponent(page, NAME, DEFAULTS);
  await page.getByLabel("Email").fill("test@example.com");
  await page.getByRole("button", { name: "Submit" }).click();
  await page.waitForFunction(() => /* some completion signal */);
  const events = await getScanEvents(page);
  expect(events.filter(e => e.name === "Header")).toHaveLength(0); // header is prop-stable
});
```

`getScanEvents()` lets you assert on what `react-scan` flagged. The most valuable assertion is *negative*: "component X should NOT have rerendered during this interaction".

## Add custom variants programmatically

The static-parse variants only cover unions-of-literals. For more interesting variants (large data sets, edge-case shapes), append to the `VARIANTS` array in a spec by hand:

```ts
const VARIANTS = [
  ...EXTRACTED_VARIANTS,
  { items: Array.from({ length: 1000 }, (_, i) => ({ id: i, label: `item ${i}` })) },
  { items: [] }, // empty state
  { items: undefined as never }, // missing
] as Array<Record<string, unknown>>;
```

Edit-time concern: a spec inside the out dir is rewritten on every regeneration, `--force` or not — the tool is the source of *initial* truth and keeps improving what it emits. If you want a spec to survive, pass `--colocate`: those are written beside your source and kept unless you `--force`. (Earlier advice here said "don't `--force` after you've started editing"; that protected nothing, because the perf harness regenerated regardless.)

## Run a specific spec or test

```bash
bun run test profile/Dashboard.profile.spec.ts
bun run test -g "click rerender"
```

Standard Playwright args. The `-g` flag filters by test title regex.

## Capture a longer profile run

For deeper measurement, bump iterations in the forced-rerender test and pipe the JSON output to a file:

```ts
const forcedIterations = 1000; // up from the default

// at the end of the test:
const blob = JSON.stringify({ stats, samples: updates });
console.log(`PROFILE_DATA ${blob}`);
```

Then in CI:

```bash
bun run test 2>&1 | grep '^PROFILE_DATA ' | sed 's/^PROFILE_DATA //' > profile.json
```

`profile.json` is now consumable by whatever dashboard you want to point at it.

## Headed debugging

```bash
bun run test:headed
```

Opens visible Chromium. Combine with Playwright's `await page.pause()` inside a test to step through interactively — useful when `click rerender` doesn't behave as you expect.

`react-scan` itself can highlight rerenders visually in headed mode if you flip `log: false` to `log: true` in `host/main.tsx`. The browser console will then show the rerender heatmap in real time.

## Run against a hot-reloaded host

Right now the host bundle is built once when `bun host/server.ts` starts. For inner-loop iteration on `host/main.tsx` itself:

```ts
// host/server.ts — replace one-shot build with a watcher
import { watch } from "node:fs";
let bundleText = await build();
watch("./host/main.tsx", async () => {
  bundleText = await build();
  console.log("rebuilt");
});
```

Not generated by default because Playwright already restarts the webServer between runs in CI; this is only useful for local dev.

## When you've outgrown the generated suite

If you've heavily customised the suite — multiple providers, MSW, custom drivers, custom reporting — you're past the value of regeneration. At that point:

- Stop running `flawless-react` against this `outDir`.
- Drop the suite into your monorepo's regular test directory if it isn't already.
- Treat it as a normal Playwright project. The fact that it started as scaffold is incidental.

The tool's job is to skip the boring first hour. After that, your suite earns its keep on its own.
