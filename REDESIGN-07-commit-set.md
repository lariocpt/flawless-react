# M7 — commit-set re-shape (shrunk)

## Scope

The default commit set a first run produces (scaffold + emission), the appended
`.gitignore` block, the suite README. Surface declared: emission/commit selection,
gitignore block, docs. This step moves files out from under everything else — last in
the order.

## Starting point, corrected

The residue is **405 files / 1,794,563 B** committed, not 437 / 2,009,934 (audit
C7/C45): the 0.3.1 doc's 437 double-counts the 32 mobile unit specs that live inside
the mobile suite's 74 (and were mislabeled "colocated" — they are
`apps/mobile/flawless/unit/`, zero test files under `apps/mobile/src` at any pinned
SHA). Breakdown: 212 web suite (9 buckets, 945,938 B) + 74 mobile suite (389,937 B) +
119 colocated web specs (458,688 B).

## What it ships (the §2-D set, as amended)

- **Committed by default:** spec files (colocated unit, browser `.spec.ts`, profile
  `.spec.ts`, e2e `.spec.ts`), the write-once layers (5 files — 5 of 5 behavioral under
  0.3.2 `--force`, 3 of 5 carrying the literal marker, audit C11), the configs a
  runner must read to start (vitest, playwright ×2, package.json, tsconfig), and the
  verdict doc (M1).
- **Ephemeral (regenerated in a pre-step, not committed):** `host/` (51,854 B),
  `mocks/` (60,771 B), `mock/server.ts`, stubs, `provider.tsx`. The pre-step is M5's
  emit-diff; it is safe because **0.3.2 `--force` refuses to clobber** — divergent
  specs are kept and flagged, scaffold-time files and write-once layers are
  never rewritten (measured: 126 M / 0 A / 0 D on the second regen, audit C22/C43).
- **`.gitignore` block** shrinks to the runtime-evidence entries (`reports/`,
  `heaps/`, `test-results/`, `playwright-report/`, `load/last-*.json`, the sidecars,
  node_modules) — the on-disk residue is session evidence, not owned files (audit
  C1/C8: 8,756 ignored files on the current checkout, 0 untracked, 0 committed).
- **The §6 Q3 edge, decided and recorded here**: committed browser specs import only
  `@playwright/test` (72/72, stands) while the committed `browser/playwright.config.ts`
  carries `webServer: { command: "bun ../host/server.ts" }` — a committed file that
  depends on an ephemeral one. The step ships the chosen resolution (a documented
  `flawless sync`-style pre-step, or the config invoking the pinned generator) and the
  suite README states **in one line** how committed specs run locally without a full
  regenerate. CI is unaffected (the pre-step regenerates first).

## Acceptance (measured on the merge commit)

1. First run on a fresh app: `git status` after the run lists only the committed set
   of the chosen shape; the harness paths are absent from the index (0 committed).
2. On the pinned `c00697f` tree: the re-shaped first PR's size is measured and
   recorded (`--numstat` files/insertions against the 405-file residue); steady-state
   (one mutated source component, two `--ci` runs, committed-tree diff between runs)
   is measured and recorded, with the < 5%-of-first-run accept line from §6 Q1.
3. Second run on the same tree: 0 new files committed (write-once + specs stable);
   the .gitignore block diff between 0.3.2 and this step lists exactly the removed
   owned-file entries.
4. Local story: on a fresh checkout with the harness absent, one browser spec runs
   via the documented path (the README line names the command); the idempotence
   probe (plan criterion 3) passes.

## Moot vs required

- Moot: "harness clobbering on `--force`" as a risk (0.3.2 keep-and-flag, C22).
- Required: the commit-set selection itself, the gitignore shrink, the Q3 decision;
  fix-plan chunk 5 (sync mock shapes) stays required — the design changes where the
  MSW handlers live, not whether they are right.

## Dependencies

M1 (verdict in the committed set), M5 (the pre-step the ephemeral set relies on),
M6 (baseline dir committed). Last in the order.
