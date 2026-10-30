---
name: flawless-findings
description: Triage the findings flawless-react reports — REPORT.md's accounting, the reports/ JSON and sidecars, which findings are worth a commit versus a suppression, the cross-config trap that makes a `biome-ignore` read as unused, and the counts ledger across runs. Use after a run when working through a findings list, when a suppression shows up as "unused" in the project's own biome, or before quoting any coverage number from REPORT.md. For the rules themselves see flawless-perf-static, flawless-a11y and flawless-react-rules; for runtime numbers see flawless-perf-harness.
---

# triaging flawless findings

```bash
bunx @lariocpt/flawless-react "src/**/*.tsx" --tasks perf-static,a11y,react-rules
```

Three tasks scaffold nothing to run and only report: `perf-static` (the tool's own
rules), `a11y` (a biome sweep on web, the tool's native analyser under `--expo`) and
`react-rules` (a biome sweep with a curated rule set). Each has its own skill for the
rule-level detail — flawless-perf-static, flawless-a11y, flawless-react-rules. This
one is for reading a run and spending effort in the right order.

## Where a finding lives

Findings print as `file:line:col rule message` and land in `flawless/reports/*.json`:
the two biome sweeps write **one aggregate each** (`react-rules.json`,
`a11y.json`), while `perf-static` writes **one file per component that owns
findings** (`<Component>.perf-static.json`). A `<Component>.flawless.json` sidecar
lands beside each analysed source unless `--no-inline-summary`; its paths are
relative to the sidecar, and its `a11y` and `reactRules` entries name the run's
single aggregate rather than a per-component file.

Per-component files only appear for components with findings, so **stale
per-component reports from earlier runs linger in `reports/`.** Count from the task
summary or REPORT.md, never from a glob over the directory.

## Reading REPORT.md

Regenerated every run: it describes the **last run**, not the suite on disk.

- The components table accounts for every component in exactly one render-mode row
  (client / rsc / compound-part / document-root / null), split by mountable or not.
- "Not covered, and why" names each gap. **A file count is not coverage.**
- "Imports that will not resolve" appears only on a run that wrote specs, and only
  when an analysed import names a package nothing on disk answers for. It is why
  those files fail at collect: **a file that never collected reports no tests.**
- The task table records what that run wrote, with a Status column saying where
  perf-harness sat in the suite lifecycle (generated / refreshed / kept).
- Its hand-work table names the files only you can finish — `e2e/global-setup.ts`
  while still the emitted stub, `e2e/params.json` while an id is blank.

## Triage order

Ordered by how much the tool trusts its own finding, not by count.

1. **`perf/set-state-in-render`** (error) — always real, fix first.
2. **`useHookAtTopLevel`** — a hook behind an early return breaks hook order at
   runtime. Same class of defect.
3. **Hook-dependency findings** — see flawless-perf-static: `hook-extraneous-dependency`
   usually means the dep is never read (remove it, or make the read real);
   `hook-missing-dependency` wants `useCallback` plus the dep, not a suppression.
4. **a11y errors** — a control that is silent to a screen reader. `useAltText`,
   `useButtonType`, `missing-role`, `unnamed-control`, `textinput-unlabelled`: each
   message names the one attribute that retires it.
5. **`perf/unstable-child-prop`** — a real win when the receiving child is memoised
   or heavy; leave inline arrows to plain DOM elements alone.
6. **`noArrayIndexKey`** — real for editable lists (a client-side id at creation,
   stripped at submit); a reasoned suppression for server-static lists or where the
   index *is* the domain identity.
7. **The advisory tail** — `no-memoisation-with-children`, `missing-memo-leaf`,
   `noExplicitAny`, `noDoubleEquals`. Fix where profiling agrees
   (`flawless-perf-harness`), or where the value is obvious. Do not chase to zero.
8. **`perf/unresolved-prop` is not on this ladder at all** — it is not a finding and
   nothing here suppresses it. It is bucketed per component under REPORT.md's
   `## Spec quality`, and its fix is `--props '{"name":1}'` or that spec's `DEFAULTS`,
   never a suppression.

On a project with the React Compiler on, item 5 and both memo rules in item 7 are
suppressed by `perf-static` itself: the compiler memoises props and JSX at the call
site, and REPORT.md names the config that proved the flag. That ladder then starts at
item 6 for those rules — and a zero from them is the compiler's doing, not a clean
bill. See flawless-perf-static for the three states and what each prints.

## Suppressing honestly

A suppression is an **answer**, so it carries its reason:

```tsx
// biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper — every call site associates the control
```

Placement matters: biome attaches the comment to the next line's diagnostic. For a
multi-line JSX element whose finding anchors on the `key=` attribute, put the comment
inside the tag directly above that attribute, not above the element.

**The cross-config trap.** The tool's sweeps run a scratch config containing only
their own rules, and your project's biome has a different set. A rule enabled in only
one of the two makes the suppression "unused" in the other. The tool's side is
handled — its sweeps drop `suppressions/*` diagnostics entirely, since reporting them
would punish you for answering another config's finding. **Your side is not:** if the
project config doesn't enable the rule you're suppressing, the project's own `biome
ci` flags the comment. The clean resolution is to enable the rule in the project
config — usually free, because the suppressed site was the only finding — so both
runs agree the suppression is legitimate, and to say that in the commit.

## Counts, not colors

Keep a ledger across runs (e.g. perf-static 246 / a11y 1 / react-rules 10) and
explain every delta. A burn-down commit should be able to say "a11y 1→0, react-rules
10→0" with one cause per line. **New findings after a regen are usually the analyser
seeing new components, not regressions** — check the components count in REPORT.md
before treating a rising total as a fall.

## Never

- Never suppress without a reason clause, and never to make a batch green.
- Never chase the advisory clusters to zero — that is churn, not performance.
- Never diff the reports/ directory to count findings; stale per-component files from
  earlier runs survive. Use the task summaries or REPORT.md.
- Never quote REPORT.md's file counts as coverage of a suite you have not run since
  the last change — the report is the last run's.
