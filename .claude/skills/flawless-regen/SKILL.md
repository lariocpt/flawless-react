---
name: flawless-regen
description: Regenerate a flawless-react suite safely — what a re-run rewrites vs keeps, --force's merge and clobber semantics, --changed's affected-test narrowing and its full-selection gotcha, and proving a run happened via result JSON + REPORT.md rather than stdout. Use before any regeneration over an adopted suite, after upgrading the tool, or when a --changed run appears to have done nothing.
---

# Regenerating a flawless suite

The model is regenerate-by-default: derived files track the tool and your
sources, and only what the tool cannot rebuild is protected. Know the table
before touching an adopted suite:

| Category | Files | On re-run | Under `--force` |
| --- | --- | --- | --- |
| Write-once | `budgets.json`, `host/main.tsx`, `provider.fixtures.ts`, `e2e/global-setup.ts`, `mocks/handlers.ts` | kept | **kept** |
| Merge-kept | `e2e/params.json`, `load/routes.pipes` | kept | **merged** — your edits, rates, commented pipes survive |
| Colocated specs | `src/**/*.flawless.test.tsx` | kept | **overwritten** |
| Everything else | out-dir specs, configs, generated prose, REPORT.md, sidecars | rewritten | rewritten |

## The no-force run over an existing suite

Refreshes derived files surgically (a clean tool upgrade often diffs ONE file)
but `perf-harness` refuses without `--force` and the run **exits 1** with
REPORT.md recording "task threw" for it. Expected, not breakage — there is
currently no refresh mode between nothing and `--force` (findings ledger
FR-028). Select `--tasks` without `perf-harness` for an exit-0 refresh.

## `--force` and the clobber drill

`--force` rebuilds the harness and overwrites every colocated spec — it cannot
tell a hand-hardened spec from an untouched one. The drill:

1. Commit (or stash) before forcing.
2. Force-run, then `git diff --name-only -- '*[.]flawless.test.tsx'`.
3. `git checkout` the specs you had hardened; keep the regenerated versions of
   untouched ones (they may legitimately track source changes you made).
4. Expect new spec files for components the analyser newly detected — and
   remember their browser specs need a hand-added `host/main.tsx` registry
   entry (see flawless-unit-browser).

## `--changed`

`--changed` keeps analysis and generation complete and narrows only the RUN:
vitest `related` walks the module graph for unit specs, playwright gets an
anchored `--grep`, e2e runs when an affected component renders on a route.

**The gotcha:** the affected run is gated on no task having failed — so over
an adopted suite, a full seven-task selection hits the perf-harness refusal
and the affected run is silently skipped. Narrow the tasks:

```bash
flawless-react "src/**/*.tsx" --nextjs . --tasks unit-browser,e2e --changed --no-interactive
```

Suite failures reach the exit code (a failed affected suite exits 1), so
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
  for the run kind (tiny for no-force, colocated-wide for `--force`).
- Another session may be working the same repos: check `git log -1` against
  what you last saw before attributing a surprise diff to the tool.

## Style adoption

Generated files are reformatted with the host project's biome or prettier
(including `.mts`/`.cts` configs), and JSON merges preserve the file's
indentation — a regeneration should produce a semantic diff, never a reformat.
If `biome ci` errors on a generated file after a regen, that is a tool bug;
report it rather than hand-formatting generated output.

## Never

- Never `--force` an adopted suite with uncommitted hand-hardened specs.
- Never read a mid-session change to the target app as proof your run
  executed — only your own result file plus the REPORT.md diff counts.
- Never "fix" the no-force exit 1 by adding `--force` reflexively — decide
  whether you want the harness rebuilt and the colocated overwrite that rides
  with it.
