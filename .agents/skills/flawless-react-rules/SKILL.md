---
name: flawless-react-rules
description: Run and act on flawless-react's react-rules task — a curated set of Biome correctness and suspicious rules (render-return, children-prop, hook order, exhaustive deps, iterable keys, duplicate JSX props, `==`, `any`) swept with a scratch config that bypasses the project's biome.json. Use when triaging `reports/react-rules.json`, when deciding whether an index key is a real bug, when the same effect is reported by both biome and `perf-static`, or when a file produces a `parse` diagnostic instead of findings. For a11y rules see flawless-a11y; for the suppression rules shared by both sweeps see flawless-findings.
---

# flawless react-rules

```bash
bunx flawless-react "src/**/*.tsx" --tasks react-rules
```

`react-rules` is one biome sweep with a hand-picked rule set and nothing else:
`recommended: false`, then `correctness` and `suspicious` blocks enumerated rule by
rule. The report's own note says it — *"Curated React correctness rules via Biome.
Local biome.json is bypassed."* — because the point is to answer "does this React
code have a known defect", not "does this repo agree with its own lint config".

Findings print as `file:line:col lint/<group>/<rule> message` and land in the single
aggregate `flawless/reports/react-rules.json`. biome must be resolvable (the target
package's `node_modules`, any ancestor, or `PATH`); when it is not, the task fails
naming every place it looked.

## What is enabled, and what to do about it

Errors unless marked otherwise.

**`correctness`** — `noChildrenProp`, `noConstAssign`, `noConstantCondition`,
`noEmptyPattern`, `noInvalidUseBeforeDeclaration`, `noPrecisionLoss`,
`noRenderReturnValue`, `noVoidElementsWithChildren`, `noVoidTypeReturn`,
`useExhaustiveDependencies`, `useHookAtTopLevel`, `useIsNan`, `useJsxKeyInIterable`,
`useValidForDirection`.

**`suspicious`** — `noAssignInExpressions`, `noAsyncPromiseExecutor`,
`noCompareNegZero`, `noControlCharactersInRegex`, `noDuplicateCase`,
`noDuplicateClassMembers`, `noDuplicateJsxProps`, `noDuplicateObjectKeys`,
`noDuplicateParameters`, `noFallthroughSwitchClause`, `noGlobalIsFinite`,
`noGlobalIsNan`, `noLabelVar`, `noMisleadingCharacterClass`,
`noMisleadingInstantiator`; and as **warnings**: `noArrayIndexKey`,
`noConfusingVoidType`, `noEmptyBlockStatements`, `noExplicitAny`,
`noExtraNonNullAssertion`, `noDoubleEquals`, `noImplicitAnyLet`.

The ones that recur on a real codebase, in the order worth spending time on:

- **`useHookAtTopLevel`** — a hook behind an early return is a genuine bug: the hook
  order changes between renders and React throws on the state update after. Fix by
  moving the guard below the hooks or returning the placeholder from the same render
  path.
- **`useExhaustiveDependencies`** — biome's resolution of the same question
  `perf-static` asks as `perf/hook-missing-dependency`. The two engines do not share
  an implementation, so a fix that silences one should be checked against the other
  rather than assumed to cover it.
- **`noArrayIndexKey`** — real for an editable list: add a client-side id at
  creation, key on it, strip the id at submit. A reasoned suppression is right for a
  server-static list, and for anything where the index *is* the domain identity.
  "It's only a list of labels" is not that reason.
- **`noRenderReturnValue` / `noChildrenProp` / `noVoidElementsWithChildren`** —
  defects that break at runtime, not style.
- **`noDuplicateJsxProps`** — the later literal silently wins; the fix is usually
  deleting the first, and reading why both were there.
- **`noExplicitAny` / `noDoubleEquals` / `noEmptyBlockStatements`** (warnings) — the
  honest options are fix, or suppress with a reason, or leave it and let the ledger
  count stay flat. Quietly adding `// biome-ignore` to reach zero is the one option
  that makes the codebase worse.

## A parse failure is not a clean file

Biome reports `parse/*` diagnostics for a file it cannot read, and a category filter
would drop them — so every sweep would call an unreadable file clean. The runner
lets a parse diagnostic through the filter on purpose: **a file the analyser could
not read is never a pass.** Triage one like a finding: usually syntax biome's version
does not know, sometimes a file that should not have been in the sweep at all.

Diagnostics for files outside the swept set are dropped, so a sweep never claims
findings in code it was not asked about.

## Suppression hygiene

`suppressions/*` diagnostics — biome's own "this suppression is unused" complaints —
are **dropped from both sweeps**, because the sweep runs a scratch config with only
its own rules and would otherwise punish you for answering a finding belonging to
your project's config. Your project's `biome ci` does not drop them. How to make the
two agree is in flawless-findings.

## Under `--expo`

`react-rules` runs on React Native — same rules, same aggregate file. Rules that only
exist for DOM elements (`noVoidElementsWithChildren`) cannot match native JSX, so a
lower count there is expected and is not a coverage loss. See flawless-expo.

## Never

- Never treat "not enabled in my project's biome.json" as a reason to dismiss a
  finding: this sweep bypasses that config by design.
- Never bulk-suppress `noExplicitAny` to make the number move.
- Never count findings from the reports directory — use the task summary or
  REPORT.md (flawless-findings).
