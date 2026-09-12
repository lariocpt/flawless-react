---
name: flawless-findings
description: Read and burn down flawless-react's reporting tasks — perf-static, a11y, and react-rules findings, REPORT.md's accounting, the reports/ JSON and sidecars, and the suppression rules that keep the project's biome and the tool's sweeps agreeing. Use when triaging a findings list after a run, when deciding fix-vs-suppress, or when a suppression shows up as "unused".
---

# flawless findings

> **`a11y` under `--expo` is the NATIVE analyser (wave 5), not biome.** Biome's 29
> a11y rules are all HTML/ARIA; over 31 React Native files carrying 82 unlabelled
> `<Pressable>`s they returned **zero**, while the same config finds 3/3 on this repo's
> own `A11yOffender.tsx` — so the native path runs six `a11y/*` rules of the tool's own
> (`unnamed-control`, `missing-role`, `textinput-unlabelled`, `icon-unhidden`,
> `label-text-mismatch`, `invalid-role`), and its summary always carries a DENOMINATOR
> ("N press target(s), N text input(s), N icon(s) examined"). A native zero without
> that denominator is a bug, not a clean bill.
> `perf-static` and `react-rules` also run on native — but on a project with
> `experiments.reactCompiler: true`, 136 of 168 perf-static findings were the three
> memoisation rules, which is work the compiler already performs
> (`docs/reviews/2026-08-expo-probes.md`).

Three tasks only report: `perf-static` (the tool's own rules), `a11y` (a biome
sweep on web, the native analyser under `--expo`) and `react-rules` (biome
sweeps with narrowed rule sets). Findings print as `file:line:col rule message`
and land in `flawless/reports/*.json` — one aggregate per task plus
per-component files, but ONLY for components that own findings, so stale
per-component reports from earlier runs linger. Trust the task summary counts,
not a glob over the reports dir.

## Reading REPORT.md

Regenerated every run; it describes the LAST run, not the suite on disk. The
components table accounts for every component in exactly one render-mode row
(client / rsc / compound-part / document-root / null) split by mountable or
not; "Not covered, and why" names each gap; the task table records what that
run wrote, with a Status column saying where perf-harness sat in the suite
lifecycle (generated / refreshed / kept). A file count is not coverage.

## Triage order

1. **`perf/set-state-in-render`** (error) — always real, fix first.
2. **Hook-dependency findings** — `hook-extraneous-dependency` usually means
   the dep is never read: either remove it or, for a scroll-on-change effect,
   make the dependency real by reading it (`if (messages.length === 0)
   return;`). `hook-missing-dependency`: wrap the function in `useCallback`
   and add it, rather than suppressing.
3. **`perf/unstable-child-prop`** — a real win when the receiving child is
   memoised or heavy (a third-party `<Sonner>`, a memo'd list). Hoist static
   objects/arrays to module scope; leave inline arrows to plain DOM elements
   alone.
4. **`noArrayIndexKey`** — real for editable lists (add a client-side id at
   creation and key on it, stripping the id at submit); a reasoned suppression
   for server-static lists or where the index IS the domain identity.
5. **`perf/unresolved-prop` / `no-memoisation-with-children` /
   `missing-memo-leaf`** — advisory scale. Fix where profiling agrees; do not
   chase to zero.

## Suppressing honestly

A suppression is an ANSWER, so it carries its reason:

```tsx
// biome-ignore lint/a11y/noLabelWithoutControl: generic wrapper — every call site associates the control
```

Placement matters: biome attaches the comment to the next line's diagnostic.
For a multi-line JSX element whose finding anchors on the `key=` attribute,
put the comment inside the tag directly above that attribute, not above the
element.

**The cross-config trap:** the tool's sweeps run a scratch config with only
their own rules, and your project's biome has its own set. A rule enabled in
only one of the two makes the suppression "unused" in the other. The tool's
side is handled (sweeps ignore `suppressions/unused`); YOUR side is not — if
the project config doesn't enable the rule you're suppressing, the project's
own `biome ci` flags the comment. The clean resolution is to enable the rule
in the project config (usually free: the suppressed site was the only finding)
so both runs agree the suppression is legitimate.

## Counts, not colors

Track the findings ledger across runs (e.g. perf-static 246 / a11y 1 /
react-rules 10) and explain every delta. A burn-down commit should be able to
say "a11y 1→0, react-rules 10→0" with one cause per line. New findings after a
regen are usually the analyser seeing new components, not regressions — check
the components count first.

## Never

- Never suppress without a reason clause, and never to make a batch green.
- Never chase the advisory clusters to zero — that is churn, not performance.
- Never diff the reports/ directory to count findings; stale per-component
  files from earlier runs survive. Use the task summaries or REPORT.md.
