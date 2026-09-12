# Wave 4 revisited — a Metro-driven `--expo` perf lane (plan, not built)

`perf-harness` is the one `--expo` task that refuses, measured-and-declined
2026-09-12 (`src/tasks/perfHarness.ts:24`, `docs/reviews/backlog.md` B-16). This
records the plan for the ONE opening that could change that verdict — the
Metro-served real-app host wave 6 proved out — and why it stays declined for the
dogfood app anyway. Written after B-16 completed; nothing here is built.

## The decline still stands, and why

The web `perf-harness` is a **Bun-bundle host**: one `Bun.build` bundle, one
`#root`, components mounted by `page.evaluate` with JSON props and one static
provider wrap. It cannot mount an expo-router route screen: the screen needs a
navigator (`useNavigation`/`useLocalSearchParams`/`useFocusEffect`), the only
navigator machinery the tool owns (`renderRouter`) is jest-bound, and the host's
registry/props/provider model cannot carry a router context. Ceiling on the
dogfood app: **~0 of 32 components mountable.** That refusal is correct and
unchanged.

## The opening: a Metro-driven host is a different host

Wave 6 proved `expo start --web` mounts the **real screens with a real
navigator**, authed via storageState cookie, styled (NativeWind reaches the RNW
DOM), **0 console errors on healthy screens**, driven by Playwright. That is a
host the Bun bundle can never be — it could measure render/interaction
performance on the actual screens.

## What it would emit and measure — the honest/dishonest line

A perf **sibling of `e2eExpo.ts`**, not a variant of the Bun host. Playwright
drives real routes (reusing wave 6's Metro boot + storageState). Instrumentation:
inject via `addInitScript` before app boot a shim on
`__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot` (what react-scan uses) to
capture per-commit `actualDuration` and wasted-render attribution — we do not own
the React root (expo-router does), so `<Profiler>` wrapping is not available.

| Signal | Honest? | Why |
|---|---|---|
| **Wasted / unnecessary re-renders** (commit that shouldn't have happened) | **HONEST — flagship** | Structural (missing memo, unstable prop identity); invariant to dev-vs-prod timing; a mutation reddens it cleanly. |
| **Interaction → next-commit latency**, as a **baseline regression** | **HONEST only as regression** | The delta is real end-to-end, but absolute ms is dev-server-inflated; honest only vs a baseline on the same machine + dev server. |
| **Heap growth across a repeated loop** (CDP `HeapProfiler`, bracketed) | **HONEST** | Leak detection is dev/prod-invariant enough. |
| **Commit count per interaction** | **HONEST** | Structural, like wasted renders. |

Must NOT emit (matching the tool's ethic): **absolute mount/render ms as a fixed
budget** (dev React inflates `actualDuration` 2–5×, StrictMode double-invokes) —
copying the web host's `mountMs: 50` would be a fabricated number; **paint/layout**
(ruled out in the 2026-08 probes); **cold-Metro-bundle time** (that is Metro
compilation, not app perf); any number from a screen that is not the real screen.

## Anti-vacuity (every assertion reddens; no invented numbers)

- **Wasted-render assertion** `expect(unnecessary).toBe(0)` — reddens when a
  `React.memo`/`useCallback` is dropped or an inline object prop is passed.
- **Commit-count-per-interaction** — reddens on setState-in-render or a
  re-triggering effect.
- **Interaction-latency regression** `expect(p95).toBeLessThan(baseline * TOL)`
  — honest only relative to `perf-baselines.json`, which is **write-once, empty
  on generation, seeded by the first green run on the target machine** (record
  mode until seeded — the same honesty as the e2e global-setup that refuses to
  assert until a human fills auth). The tool never emits a latency threshold it
  invented.
- **Dead-session / wrong-screen guard**: every perf spec first runs
  `assertOnRoute` + the copy witness + `expect(consoleErrors).toEqual([])` — a
  latency for the login wall is never recorded as the profile screen's.

Reuses wholesale from wave 6: the Metro `webServer` boot, cookie `global-setup`,
`params.json`/`landing`, `expoFileToRoute`, `assertOnRoute`+witness, and
`collectPressClicks` (onPress — which alone fixes the Bun host's onClick-only,
wrong-reason skip). New: the commit-observer shim, the baseline model, the
wasted-render/commit-count assertions, a `perfExpo.ts` task/emitter.

## Ceiling on the dogfood app — still ~0 biting assertions

Many screens become **measurable** (28–31 of 32, the opposite of the Bun host).
But the assertions that can **redden** collapse:

- The dogfood app runs `experiments.reactCompiler: true`. The compiler
  auto-memoizes — precisely the mechanism that eliminates wasted re-renders, the
  one dev-invariant signal. So `expect(unnecessary).toBe(0)` risks being
  **vacuously green by construction**, and the reddening mutation (remove a memo)
  may not redden it because the compiler re-adds the memoization. **Go/no-go, and
  it needs a probe.**
- Latency/heap are baseline-only on a fresh checkout — honest, but assert nothing
  until a baseline is committed.

So the measured ceiling on the dogfood app is **many screens measurable, ~0
assertions that bite today** — a different ~0 from the Bun host's (there: can't
mount; here: mounts, but the honest signal is nulled).

## Probes that must clear before building (decisive: #2, #3)

1. Does `addInitScript` + `onCommitFiberRoot` observe commits with
   `actualDuration` on an `expo start --web` page under the React Compiler?
2. **Is the wasted-render signal biteable with the compiler on** — does removing
   a memo raise `unnecessary`, or does the compiler swallow it? (flagship go/no-go)
3. **Production export** — can `expo export --platform web` (`web.output:
   "static"`) be served statically and Playwright-driven? If yes, absolute render
   timings become far more honest (prod React, minified, no StrictMode) and first
   navigation stops being Metro compilation. This is the lever that could turn
   "keep declined" into "build it."
4. StrictMode double-render under expo web dev — does it confuse commit counts?
5. Interaction-latency signal-to-noise vs dev-server jitter.
6. Baseline stability across machine/CPU variance.

## Verdict

Not "redefine wave 4 as a Metro harness" today, and not a blind "keep declined":

1. **Keep `perf-harness` DECLINED under `--expo`** — the Bun host genuinely cannot
   mount route screens; that refusal is correct and unchanged.
2. **Do NOT auto-enable a Metro perf harness on the dogfood app** — its honest
   signal is nulled by the compiler + dev server; auto-running it would be a green
   suite that tests nothing.
3. **Run probes #2 and #3 before any build.** If #2 shows a biteable wasted-render
   signal on a **compiler-off** app, or #3 shows a servable production export with
   honest absolute timings, build it as a **distinct opt-in `perf-e2e` task** — a
   perf lane over real routes, reusing wave 6 wholesale, gated on a seeded
   baseline and the on-real-screen witness — **not** folded into the declining
   `perf-harness`.

**Sharpened revisit condition** (extends the backlog's "an adopter with a real
`components/` directory of non-route components", which stays for the Bun host):
for the Metro lane — *either a compiler-off app with biteable wasted renders, or a
committed per-machine baseline, or a production-export probe (#3) proving honest
absolute timings.* Until one holds, wave 4 stays declined on the record — the
same measured-and-declined ethic that closed it, now with the Metro door
specified rather than left as an unexamined "what if".
