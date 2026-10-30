---
name: flawless-perf-static
description: Read and act on the findings from flawless-react's own static performance analyser — the nine `perf/*` rules (set-state-in-render, unstable-child-prop, hook dependency drift, missing-memo-leaf, unresolved-prop), how the analyser's conservatism shapes a clean report, the sidecar and per-component report files, and which findings are worth fixing versus suppressing. Use when triaging `reports/<Component>.perf-static.json`, when a `perf/unresolved-prop` finding means the generated spec passes `undefined`, or when deciding whether a memoisation finding is real. For runtime numbers see flawless-perf-harness; for a11y and React-rule findings see flawless-a11y and flawless-react-rules.
---

# flawless perf-static

```bash
bunx @lariocpt/flawless-react "src/**/*.tsx" --tasks perf-static --no-inline-summary
```

`perf-static` reports; it scaffolds nothing to run. Findings print as
`file:line:col rule message`, land in `flawless/reports/<Component>.perf-static.json`
(one file per component that owns findings), and are summarised in REPORT.md and the
`--ci` blob. A `<Component>.flawless.json` sidecar lands beside each analysed source
unless `--no-inline-summary`; its paths are relative to the sidecar, so resolve them
against the sidecar's own directory.

Per-component report files only appear for components with findings, so **stale
per-component files from earlier runs linger in `reports/`.** Count from the task
summary or REPORT.md, never from a glob over the directory.

## The nine rules

| rule | severity | what it means |
| --- | --- | --- |
| `perf/set-state-in-render` | **error** | unguarded `setState` during render — always real, fix first |
| `perf/hook-missing-dependency` | warn | an effect/callback reads something not in its deps — stale closure |
| `perf/hook-extraneous-dependency` | warn | a dep that is never read — the effect fires for nothing |
| `perf/hook-missing-deps-array` | warn | a hook that takes a dep list is called without one |
| `perf/unstable-child-prop` | warn | inline object/array/arrow handed to a component child |
| `perf/no-memoisation-with-children` | warn | a component taking `children` is memoised where it cannot help |
| `perf/missing-memo-leaf` | warn | a leaf that re-renders on every parent render, not memoised |
| `perf/unresolved-prop` | warn | the analyser could not synthesise a default for a prop |
| `perf/effect-every-render` | warn | an effect that runs on every render |

Triage in that order of trust.

- **`set-state-in-render`** is the only error the analyser emits and the only one
  that is never a style preference.
- **Hook deps.** `hook-extraneous-dependency` usually means the dep is never read:
  remove it, or make it real — a scroll-on-change effect that never touches
  `messages.length` is fixed by reading it (`if (messages.length === 0) return;`),
  not by suppressing. `hook-missing-dependency`: wrap the function in `useCallback`
  and add it.
- **`unstable-child-prop`** is a real win when the receiving child is memoised or
  heavy (a memo'd list, a third-party `<Sonner>`). Hoist static objects and arrays
  to module scope. An inline arrow handed to a plain DOM element costs nothing —
  leave it.
- **The advisory tail** (`no-memoisation-with-children`, `missing-memo-leaf`,
  `effect-every-render`) is a scale, not a bug list. Fix where the runtime harness
  agrees (flawless-perf-harness); do not chase it to zero.
- **`perf/unresolved-prop` is not a performance finding.** It says the analyser could
  not invent a value, so the generated spec passes `undefined` for that prop. Fix it
  with `--props '{"x":1}'` or by editing the spec's `DEFAULTS` — and expect the
  component's own spec to be weak until you do.

## A clean report is not proof

The analyser is deliberately conservative where it would otherwise be wrong: it
**skips hook-dependency findings when the dependency list contains a member access
or a spread**, because it cannot resolve those without a type checker. So a file
using `useEffect(fn, [state.items])` produces nothing at all here — absence of
findings means "not checked", not "correct".

The same conservatism that protects the report shapes the specs: everything
`perf-static` knows comes from the same static read the unit specs are built from
(`analyseTree()`), no type checker, no execution.

## React Compiler changes what these findings mean

On a project the compiler runs on, memoisation is the compiler's job: measured on
one native app, **136 of 168 perf-static findings were the three memoisation
rules** (`docs/archive/2026-08-expo-probes.md`). Telling someone to hand-write a
`memo()` wrapper the build already applied is not advice worth printing, so
`perf-static` reads the state off the project's own configs — in **every** mode,
not only `--expo` — and suppresses `perf/unstable-child-prop`,
`perf/missing-memo-leaf` and `perf/no-memoisation-with-children` when it is on.

| state | read from | what the task does |
| --- | --- | --- |
| **on** | `app.json` `experiments.reactCompiler`; `next.config.*` `reactCompiler`; a babel or recognised bundler config naming `babel-plugin-react-compiler` | the three memo rules are suppressed, the other six run, and REPORT.md names the config that proved it |
| **off** | a config was read, and it does not turn the compiler on | all nine rules run, and nothing is said about the compiler |
| **undetermined** | nothing readable | all nine run, and the summary says the memo findings may be pre-compiled noise |

Three things this deliberately does not do:

- **It does not infer the flag from a dependency.** Next ships
  `babel-plugin-react-compiler` in its own dependency tree, so a lockfile grep
  reports "compiler on" for apps that never enabled it — and would have
  suppressed 127 valid findings on the run that found this bug. Config only.
- **It does not model per-file bail-outs.** A component that violates the Rules of
  React is not compiled, so in principle its memo findings survive. The
  `react-rules` task owns that detection; these flags are global, and perf-static
  treats compiler state as global rather than guessing per file.
- **It does not suppress quietly.** The suppression, its per-rule counts and the
  evidence string are in the task summary, in REPORT.md, in the `--ci` blob and in
  every `<Component>.perf-static.json`. A suppressed zero has to read differently
  from a zero that means nothing was found — same reason the native a11y zero
  carries its denominator.

So on a compiler project the findings you still get are the ones the compiler has
no opinion about: `set-state-in-render`, the three hook-dependency rules,
`effect-every-render` and `unresolved-prop`. On a compiler-off project
`unstable-child-prop` is a real win when the receiving child is memoised or heavy,
and memoising it by hand is still the fix.

## Under `--expo`

`perf-static` runs on React Native the same way it runs on DOM — same rules, same
report files. What changes is the compiler question above, and that "heavy child"
usually means a list row rather than a widget. See flawless-expo.

## Never

- Never suppress a `perf/*` finding without a reason clause, and never to make a
  batch green.
- Never quote a zero for a file whose deps the analyser could not resolve.
- Never diff `reports/` to count findings: per-component files from earlier runs
  survive. Use the task summary.
