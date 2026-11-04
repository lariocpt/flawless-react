# M1 — verdict doc + name-level coverage ledger

## Scope

`src/reporters/` (new verdict writer), `src/tasks/*` result plumbing, `src/core.ts`
(`testRun`), the emitted `flawless/VERDICT.json` + rendered `VERDICT.md`, and
`REPORT.md`'s coverage section. Surface declared for the hygiene gate: reporters,
tasks result hooks, core, templates (verdict emission), plus the two in-repo doc
records. Nothing else moves.

## What it ships

- `VERDICT.json`/`VERDICT.md` updated by **each** plane's result: pass/fail/skip tallies,
  per-finding evidence pointers (`reports/*.json`, `heaps/`, `load/last-*.json`), keyed
  by (task, target-hash) so the last run of every plane is always on record.
- The per-invocation `REPORT.md` "1 of 7 tasks" class dies (audit C16/C31 — still
  emitted in 0.3.2, emitter `reporters/report.ts:241–242`): REPORT.md keeps its coverage
  role and gains a pointer to the verdict.
- The coverage ledger is **name-level** (audit C19 sharpening): every exported symbol
  without a spec carries a named reason — `covered-through: <parent>` or
  `not-analysed: <reason>`. The old REPORT.md ledger tracked 38 of the 55 dropped
  subcomponents by count only (17 by name: 9 `select.*` + 8 `dropdown-menu.*` +
  `AvatarImage`); a count table is what let the 54 vanish silently.

## Acceptance (measured on the merge commit)

1. Full 7-plane run on the pinned `c00697f` tree → committed `VERDICT.md` names all
   **7** task ids with tallies (string check: all of `perf-harness, unit-browser,
   perf-static, a11y, react-rules, e2e, load` present); no committed report on disk
   says "N of 7 tasks … Not run" for a plane that has a verdict entry.
2. `VERDICT.md` skip block aggregates by reason-string (extending the `TodoCounter`
   pipe at `templates.ts:169–174`), totals equal the per-plane skip tallies.
3. Ledger on the `c00697f` tree: the 54 zero-hit subcomponents (derivation 58 lost
   ui-specs − 3 renamed primaries − 1 `SelectGroup` one-hit) appear **by name**, each
   with a reason; the 17 old-ledger names are a subset.
4. Two consecutive 7-plane runs: the second adds no verdict entries for unchanged
   targets (keyed by target-hash) and tallies are byte-stable.

## Gates

Plan-level criteria 1–4 (receipts, five gates, regen idempotence, operator merge).
M1-specific: criterion 3's idempotence probe must show the verdict files as the *only*
plausible M-files between runs on an unchanged tree (stable keys).

## Moot vs required

- Moot (already in 0.3.2, do not re-plan): the per-invocation report's *accuracy* for
  the planes it selected; skip counting in specs.
- Required: the accumulated cross-plane document, the name-level ledger, the
  reason-string aggregation.

## Dependencies

None — first in the order. Every later step's "no unexplained red / no drift" claim is
*checked* by this step's doc, which is why M1 goes first.
