---
name: flawless-regen
description: Regenerate a flawless-react suite safely — the generated/refreshed/kept lifecycle, what a re-run rewrites vs keeps, --force's merge semantics and the colocated-spec provenance stamp, --changed's affected-test narrowing, and proving a run happened via result JSON + REPORT.md rather than stdout. Use before any regeneration over an adopted suite, after upgrading the tool, or when a --changed run appears to have done nothing.
---

# Regenerating a flawless suite

> **Expo mode adds one write-once file.** `<outDir>/jest.setup.ts` is where
> hand-written module mocks live and nothing can rebuild them from the analysis, so a
> re-run never overwrites it — delete it to regenerate. `jest.config.cjs` and every
> native spec under `unit/` ARE regenerated on each run, like the rest of the derived
> suite.

The model is regenerate-by-default: derived files track the tool and your
sources, and only what the tool cannot rebuild is protected. Know the table
before touching an adopted suite:

| Category | Files | On re-run | Under `--force` |
| --- | --- | --- | --- |
| Write-once | `budgets.json`, `host/main.tsx` (wrapper only — the `host/registry.ts` beside it regenerates), `provider.fixtures.ts`, `e2e/global-setup.ts`, `mock/routes.ts` | kept | **kept** |
| Merge-kept | `e2e/params.json`, `load/routes.pipes` | kept | **merged** — your edits, rates, commented pipes survive |
| Provenance-stamped | `mocks/handlers.ts` | kept; regenerated only when the spec digest moved and the stamp is untouched | **regenerated** — even hand-edited; it is the escape hatch the kept-reports name |
| Colocated specs | `src/**/*.flawless.test.tsx` | kept | **stamp-checked** — untouched refreshed; edited or pre-stamp kept and listed |
| Everything else | out-dir specs, configs, generated prose, REPORT.md, sidecars | rewritten | rewritten |

## The no-force run over an existing suite

**Exits 0.** Every task — `perf-harness` included — refreshes its derived
files, rewriting them as a fresh scaffold would (the standalone suite's
package.json is MERGED — your fields win, and in Next.js mode a
`flawless:*` script you customised is kept unless its value is one of the
tool's own spellings — kept keys are listed in REPORT.md as
`> Kept script(s): ...`, and deleting the key takes the tool's current
command); write-once files are
untouched (delete one to get a fresh copy). The perf-harness TaskResult and
REPORT.md's task row carry a status word: `generated` (fresh out dir),
`refreshed` (this case), or `kept` (`--changed`, below). Emission is
deterministic, so a same-version refresh usually diffs nothing; after a tool
upgrade expect the derived files — and the version banner on the suite's
`playwright.config.ts` first line — to move. An exit 1 means a real
failure, never the old harness refusal (that was findings FR-028, fixed).

A regeneration with a wave-3 tool also BURNS DOWN hand-work: the three
biggest `TODO(flawless)` clusters are now auto-filled where the source
supports inference — server-action stubs from the action's own literal
returns, data-dep fixtures from `Promise<T>` annotations or OpenAPI
examples, and compound parts mounted through their own file's family.
REPORT.md's hand-work table shows the drop; the exact count depends on how
much of the app's surface is inferable, so never promise a number —
markers that remain are exactly the cases inference honestly refused.

## `--force` and the colocated stamp

Every colocated spec opens with a provenance stamp —
`// @flawless-generated sha256:<hex16> flawless-react@<version>` — hashing
everything below the line (recomputed after the run's style pass, so a
formatted spec still reads as untouched). `--force` uses it as the verdict:

- stamp matches body → **rewritten** (this is the refresh you asked for);
- stamp mismatch → you edited or reformatted it: **kept**, listed in the
  summary as hand-edited;
- no stamp (generated pre-stamp, or the line was deleted) → **kept**, listed
  as pre-stamp.

The escape hatch for both kept cases is the same: delete the file and re-run.
Kept files also drop out of `handWork` tallies — their discarded render's
TODOs are not your debt. Still commit (or stash) before forcing: the stamp
protects hand-edited specs, but the rewrite of untouched ones is exactly what
you're asking for, and a diff you can read beats trusting any tool.

Expect new spec files for components the analyser newly detected — their
browser specs mount through `host/registry.ts`, which the same run refreshed;
hand registrations live in `main.tsx`'s `ALL` spread and survive (see
flawless-unit-browser). A pre-split `main.tsx` (no `./registry` import)
triggers the run's migration warning instead.

## `--changed`

`--changed` narrows only the RUN: vitest `related` walks the module graph for
unit specs, playwright gets an anchored `--grep`, e2e runs when an affected
component renders on a route. Over an existing suite the perf harness is
**kept** — the scaffold writes nothing (`status: "kept"`, summary `harness
kept (generated by flawless-react <X>, tool is <Y>)`, with X read from the
suite's own banner; pre-banner suites report "unknown version"). The affected
run is still gated on no task having failed, but a kept harness is a success,
so any task selection — the full seven included — reaches the affected tests:

```bash
flawless-react "src/**/*.tsx" --nextjs . --tasks perf-harness,unit-browser,perf-static,a11y,react-rules,e2e,load --changed --no-interactive
# --tasks matters: bare --no-interactive defaults to perf-harness ALONE, and
# a harness-only selection has no unit/e2e suites for the affected run to run.
```

`--changed --force` regenerates: an explicit force outranks the keep. Suite
failures reach the exit code (a failed affected suite exits 1), so
`--ci --changed` in a hook is honest.

## Proving a run happened

Never take stdout as evidence — write evidence to files and check the disk:

- **Programmatic runs** (sandboxes, scripts): call `runFlawless`/`runCore` and
  write `{ exitCode, outDir, results }` to a result file. Pass `nextjs`
  relative to a cwd you set explicitly, or pass an explicit out dir — in
  Next.js mode the default resolves against the target root, and a scratch
  run from the wrong cwd rewrites the target's `package.json` scripts.
- REPORT.md is rewritten every run — a missing REPORT.md diff means the run
  did not happen or ran somewhere else.
- `git status --porcelain` in the target must match the expected touch surface
  for the run kind (tiny for no-force; `--force` touches the untouched
  colocated specs, while the ones you hardened stay out of the diff).
- Another session may be working the same repos: check `git log -1` against
  what you last saw before attributing a surprise diff to the tool.

## Style adoption

Generated files are reformatted with the host project's biome or prettier
(including `.mts`/`.cts` configs), and JSON merges preserve the file's
indentation — a regeneration should produce a semantic diff, never a reformat.
If `biome ci` errors on a generated file after a regen, that is a tool bug;
report it rather than hand-formatting generated output.

## Never

- Never `--force` an adopted suite with uncommitted work — the stamp keeps
  hand-edited colocated specs, but e2e route specs and the provider wrapper
  have no such guard, and a committed baseline is what makes any rewrite
  reviewable.
- Never hand-delete a spec's stamp line to "claim" it — that demotes the file
  to pre-stamp (kept but nagged about); the file is already yours the moment
  you edit the body.
- Never read a mid-session change to the target app as proof your run
  executed — only your own result file plus the REPORT.md diff counts.
- Never reach for `--force` on a plain refresh — a no-force re-run already
  rewrites every derived file, and `--force` adds only the untouched-colocated
  /e2e-spec rewrite. Decide whether you want that before asking for it.
