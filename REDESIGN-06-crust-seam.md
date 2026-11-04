# M6 — crust seam consolidation

## Scope

`src/tasks/loadPipes.ts` (baseline dir, pipe emission), `src/scaffold-tests/` (mock/
suppression when the host runs crust), the emitted `load/` files, suite README.
Surface declared: load emission, mock emission, docs.

## Receipts, corrected by the v0.3.2 re-audit

- **Pipes: 23 of 33 commented, not 22** (audit C14). The committed
  `apps/web/flawless/load/routes.pipes` @ `c00697f` has 23 pipes carrying
  `TODO(flawless): no value for LOAD_<PARAM>` and 10 active; the "22" in the 0.3.1
  doc is `load/env.sh` line 16's own comment ("22 of 33 measured the 404 handler"),
  a measurement about the 404-handler subset.
- **The emitter is unchanged**: `git diff v0.3.1 v0.3.2 -- src/tasks/loadPipes.ts` is
  **empty** — the seam's emitter side is identical, so all of M6's load work is still
  open in 0.3.2. The regen's 33-active / 0-TODO state comes from the committed,
  human-filled `e2e/params.json`, not from a new pipe.
- **Baseline referent**: the inline assert lambda is crust's *documented* pattern —
  the local crust repo `docs/USAGE.md` lines 743–749 ("Baselines") document exactly
  the async-assert-reading-`Bun.file` shape (`test-pipes` has no native baseline
  flag). The lambda's actual text carries an `!exists()` guard the 0.3.1 doc elided
  (audit C32): `assert (async s => { const b = Bun.file("<baseline>"); return
  !(await b.exists()) || s.p95 < 2 * (await b.json()).summary.p95 })`.
- **Crust-host referent**: the ":4000 mock-server" receipt is the **root**
  `AGENTS.md` of the target (line 80; section lines 112–119; "Response examples are
  load-bearing" at lines 63–64) — `apps/web/AGENTS.md` does not exist at `c00697f`
  (audit C33). Detection reads the root file.

## What it ships

1. **Baseline committed dir with a deliberate-bump convention**: `load/baselines/`
   committed; a baseline change shows in the PR diff (the review surface).
   `last-*.json` stays gitignored evidence. The inline lambda stays — it is crust's
   documented pattern, not a defect. Optional upstream: a crust-side
   `test-pipes -b <dir>` reading the same dir (one small upstream change, not a
   dependency).
2. **`mock/` suppressed when the host runs crust** (root-`AGENTS.md` :4000 detection):
   the suite's MSW handlers point at the same openapi.json examples crust serves;
   non-crust apps keep emitting `mock/` (61,899 B at the pinned tree).
3. **Evidence consolidation**: `stats --out` JSONs + JUnit are the evidence;
   `scripts/report.mjs` (2,277 B, a legacy playwright-stdout→markdown bridge,
   scaffold-time-only in 0.3.2) is retired from emission when the verdict doc (M1)
   ships.

## Acceptance (measured on the merge commit)

1. On a target declaring the :4000 crust host in its **root** `AGENTS.md`: no
   `mock/` emitted; handler sources point at the shared openapi.json examples. On a
   non-crust target: `mock/` emitted byte-identical to the 0.3.2 baseline.
2. `load/baselines/` committed; a deliberate bump appears in the PR `--stat`;
   `last-*.json` in the .gitignore block; the pipe-tail lambda byte-identical to the
   crust-documented pattern (guard included).
3. Commented-pipe count on the pinned tree after the human `params.json` values are
   applied: 0 TODO pipes, 33 active (the regen's measured state, C14) — the TODO
   mechanism still emits for genuinely missing values (probe: blank one param → pipe
   re-comments with the named reason).
4. `report.mjs` absent from emission; evidence files (stats JSON, JUnit) present and
   pointer-referenced from the verdict.

## Moot vs required

- Moot: re-implementing crust's baseline lambda (it *is* the documented pattern).
- Required: all four items; fix-plan chunk 7 (MCP exit) and chunk 6 (bound workers)
  are unaffected and remain separate.

## Dependencies

M1 (verdict carries the load plane's entry), M5 (the pre-step must ignore the
committed baseline dir). Order slot 6.
