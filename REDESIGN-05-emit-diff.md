# M5 — emit-diff CI pre-step + doc-root refresh (shrunk)

## Scope

`src/core.ts` / `src/mcp/run.ts` (a `--ci --emit` pre-step: regenerate, diff committed
specs against fresh emission, fail on unexplained drift), `src/scaffold-tests/mocks.ts`
(store-shape decision), suite README. Surface declared: core, mcp, scaffold-tests,
docs.

## What 0.3.2 already did (shrinks this step)

- **Doc-root emission is fixed** (fix-plan chunks 3/4 class, dead for fresh emission —
  audit C43): regenerating `layout.flawless.test.tsx` / `global-error.flawless.test.tsx`
  from scratch on the `c00697f` tree emits `renderToReadableStream` from
  `react-dom/server.browser` with the "do not simplify this back" comment, the
  streaming renderer, and the full thenable-walking resolver. The 0.3.1 hand-edit #5
  is no longer the generator's work.
- **The `--force` refresh lifecycle is measured and safe**: on the regen worktree a
  second full regen is **126 M / 0 A / 0 D** (124 fixed-point + 2 fresh doc-root —
  double-regen idempotence), unit-browser "files:123 … (browser specs skipped — add
  perf-harness…)", load "33 target(s) — 33 live". Divergent existing specs are
  **kept and flagged** ("hand-edited or reformatted … kept — delete to regenerate" —
  observed live on the two doc-root specs carrying 0.3.1 stamps while `app/page` was
  rewritten); scaffold-time files (tsconfig, playwright configs, `host/`, `mock/`,
  `report.mjs`, budgets, load `env.sh`/`routes.setup.ts`) and the write-once layers are
  never rewritten (5 of 5 write-once files byte-stable under `--force`, audit C11).

## What remains

1. **The emit-diff pre-step**: `flawless-react --ci --emit` validates committed specs
   against fresh emission; divergence is a named CI failure with the exact diff,
   acceptance only via explicit `--force`. Because 0.3.2 already keep-and-flags on
   disk, the pre-step's job narrows to what a run cannot see: divergence introduced
   *between* runs (a spec deleted or edited on one machine and committed).
2. **The app-internal store-shape decision** (the one gap the fresh emission still
   leaves vs the human edit): the 0.3.2 leave-real guard
   (`src/scaffold-tests/mocks.ts:370–383`, "defect #4, mechanism 2") applies to
   **packages only** (`group.pkg && !moduleHasEvidence`), so the fresh `layout` spec
   mocks the app-internal `@/lib/store` factory as a flagged guess
   (`vi.fn(async () => ({}))` + `TODO(flawless): createAppStore guessed async {} — no
   call-site evidence`) with synthesized "flawless-*" selector fixtures, where the
   0.3.1 human edit (probe-verified) left the real `zustand/vanilla` store +
   `createAppStore` real, with true-shape plain-function selector fixtures. Decision
   options: (a) extend the leave-real guard past packages when call-site evidence
   exists; (b) emit true-shape fixtures for app-internal module factories; (c) keep
   the flagged guess and require the verdict to surface it. The step ships whichever
   is chosen, with the choice recorded in the suite README.

## Acceptance (measured on the merge commit)

1. Pre-step on the fixed-point tree: exit 0, empty diff. On a deliberately diverged
   spec (one assertion line edited): exit non-zero with the exact line diff named.
2. Store-shape: regenerating the `c00697f` tree, the fresh `layout` spec's store block
   matches the chosen option; under (a)/(b) it is byte-equivalent in shape to the
   0.3.1 human edit (real `createAppStore`, true-shape plain-function fixtures) and the
   `TODO(flawless): … guessed` marker is absent from that block.
3. Idempotence probe (plan criterion 3) passes unchanged: 0 A / 0 D on run two.

## Moot vs required

- Moot: "the generator's RSC/server-module handling still needs its fix" (0.3.2).
- Required: items 1–2; the measured keep-and-flag lifecycle is inherited, not
  re-implemented.

## Dependencies

M1 (drift failures land as verdict entries), M3+M4 (the pre-step diffs the
post-layout tree). Order slot 5.
