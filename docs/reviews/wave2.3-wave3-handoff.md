# Handoff: finish Wave 2.3 (B-4 hash-stamped colocated refresh) + Wave 3 (B-3 → B-1 → B-2)

Written 2026-08-24 by the prior session for a fresh context. This is the full spec —
trust it over re-deriving; every file/line reference below was verified against the
tree at `f3c6b33` (current `main` == current `wave2/hash-refresh`).

## Where the engagement stands

- Ledger: `docs/reviews/2026-08-findings.json` — 34 findings, 24 fixed. Backlog:
  `docs/reviews/backlog.md` — B-4 is the only Wave-2 item left; B-1/B-2/B-3 are Wave 3.
- Waves 0, 1, 2.1 (suite lifecycle/refresh mode), 2.2 (host registry split) are merged
  to main (PRs #6–#9). Wave 2.3 is THIS branch, currently empty.
- Wave 2.3 was attempted twice via Workflow orchestration (run `wf_08e19edd-f09`); the
  implementer agent died to API 529 Overloaded three times total. **Do not resume that
  workflow.** Implement inline in the main session; use a small workflow (or two
  subagents) only for the adversarial REVIEW pass after the diff is committed.

## Engagement rules (user-set, standing)

- Failing test first for every behavior change. `bun test` + `bunx tsc --noEmit` green
  before any merge. Emitted artefacts are verified by EXECUTING them, never by parsing
  or eyeballing (see memory + `tests/emittedExecution.test.ts`'s header for the ethos).
- Checkpoint commit+push to the wave branch at milestones — long tasks must survive a
  crash. One PR per wave, merged into main (**merges are pre-authorized by the user**),
  `mesh-repo-sync` after main moves.
- Adversarial review before merge: at least two reviewer passes with different lenses
  (correctness; test-honesty with mutation probes — break the code, prove a test goes
  red). Repair confirmed defects before merging.
- Each wave also lands its doc closures: `docs/`, the six skills in `.claude/skills/`
  (copy changed skills to `~/.claude/skills/` too), backlog strike-through, ledger
  status flips.
- **Do NOT touch `~/Projects/personal/mybodycorpai`** — dogfood round 5 is gated until
  its crust work is merged on its main AND the user gives the go.
- After Wave 3: stop and report. Wave 4 (test rigor: FR-011/014/018/019/021/022/023/024)
  and the PAUSE checkpoint come after, per the approved plan.

---

## Wave 2.3 — hash-stamped colocated refresh (B-4)

### Problem

Colocated specs (`<component>.flawless.test.tsx`, written beside sources under
`--colocate`) are skip-if-exists; `--force` currently clobbers them unconditionally,
destroying hand-hardened edits. B-4: stamp generated specs with a content hash so
`--force` can tell "untouched by humans" from "hand-edited" and only rewrite the former.

### Spec

Stamp = first line of every colocated spec:

```
// @flawless-generated sha256:<hex16> flawless-react@<version>
```

`<hex16>` = first 16 hex chars of sha256 of the file body **minus the stamp line**.
`<version>` from `src/version.ts` (`VERSION`).

**New module `src/scaffold-tests/stamp.ts`:**
- `STAMP_RE` — anchored `^`, tolerate `\r?\n` after the line.
- `hashBody(body: string): string` — sha256 hex sliced to 16 (`node:crypto` createHash).
- `stamp(body, version = VERSION): string` — stamp line + body.
- `splitStamp(text): { hash?, version?, body }` — peel the first line iff it matches.
- `classifyStamped(text): "untouched" | "edited" | "stampless"`.
- `restampGenerated(paths: string[]): Promise<number>` — for each existing file whose
  FIRST line matches STAMP_RE: recompute hash of current body, rewrite the stamp
  (preserving the stamp's own version field) only if it changed. Ignores everything else,
  so callers can pass a mixed list.

**Decision matrix in `src/scaffold-tests/index.ts` (`scaffoldUnitBrowser`, write loop
lines 40–49):** colocated files are exactly the `RenderedFile`s with `skipIfExists`
(set only at `src/scaffold-tests/templates.ts:115–121`; `absPath` is the colocated
target). New behavior:
- not exists → write `stamp(f.content)` (provisional stamp of the un-formatted render).
- exists, no `--force` → keep, `skipped` (UNCHANGED semantics).
- exists, `--force` → read + `classifyStamped`:
  - `untouched` → rewrite with fresh stamp → counts as written/refreshed.
  - `edited` → keep, push to new `keptEdited: string[]`.
  - `stampless` → keep, push to new `keptLegacy: string[]`.
- Non-colocated files (no `skipIfExists`) are NOT stamped — they're the regenerated set.
- `ScaffoldUnitBrowserResult` gains `keptEdited` and `keptLegacy`.

**Task accounting in `src/tasks/unitAndBrowser.ts`:** it already does
`for (const kept of skipped) todos.drop(kept)` — extend the drop to `keptEdited` and
`keptLegacy` (a kept file's discarded render must not tally hand-work; see the
`TodoCounter` doc comment in `src/types.ts:521`). Summary gains, when non-empty:
- `keptEdited`: `N hand-edited or reformatted colocated spec(s) kept — delete to
  regenerate: <paths>` (relative paths, cap the listing at ~10 + "+N more").
- `keptLegacy`: `N pre-stamp colocated spec(s) kept — delete to regenerate: <paths>`.

**Two-phase restamp in `src/core.ts`:** `adoptProjectStyle(styleRoot, writtenFiles)` is
called at core.ts:495 and may REFORMAT the freshly written specs, invalidating the
provisional hash — the next `--force` would then classify every untouched spec as
hand-edited. So AFTER the adoptProjectStyle try/catch (after line ~504), add its own
try/catch calling `restampGenerated(writtenFiles)` (warn on failure, never fatal).
Passing all writtenFiles is safe — restamp self-filters on STAMP_RE. This must run even
when adoptProjectStyle failed (it's then a no-op since the hash still matches).

### Tests (write these RED first)

1. `tests/stamp.test.ts` — pure unit: stamp/splitStamp round-trip; classify all three
   verdicts; corrupted hash char → `edited`; CRLF tolerance; `restampGenerated` rewrites
   after a body change, is a no-op on a matching stamp, ignores stampless files.
2. `tests/stampRefresh.test.ts` — the load-bearing execution test, full `runCore`:
   - Setup per test-file: `mkdtemp` project dir; copy `tests/fixtures/Dashboard.tsx`
     into `<dir>/src/`; write `biome.json` with
     `{"formatter":{"enabled":true,"indentStyle":"tab"}}`; **symlink the repo's
     `node_modules` into the project dir** — `adoptProjectStyle` resolves biome via
     `resolveLocalBin` walking UP from the biome.json dir (adoptStyle.ts:113), and from
     an os tmpdir there is no binary without the symlink (adoptStyle.test.ts documents
     this trap). `findUp` for biome.json walks up from styleRoot = outDir (standalone
     mode), so biome.json in the project root above outDir IS found.
   - Invoke like tests/core.test.ts does: `runCore({ pattern: <src glob>, outDir:
     <dir>/flawless, taskIds: ["unit-browser"], colocate: true, log: false,
     inlineSummary: false })`.
   - Run 1: colocated spec exists beside the source; first line matches STAMP_RE;
     `hashBody(splitStamp(text).body) === hash` — AND assert the body **contains `\t`**.
     The tab assertion is the anti-vacuity guard: templates emit spaces, so tabs prove
     biome actually ran and the restamp happened against the FORMATTED bytes. If biome
     didn't run, this fails loudly (the `requireInterpreter` discipline from
     emittedExecution.test.ts — never skip past a broken environment).
   - Run 2 (no force): kept — content byte-identical, task summary carries the existing
     "kept — rerun with --force" note.
   - Run 3 (`force: true`, untouched): rewritten (assert content/mtime changed or at
     minimum stamp still validates and no kept-note in summary).
   - Run 4: append a hand-edit line to the spec → `--force` → file byte-identical
     (edit survives), summary lists it as hand-edited; `handWork` tallies exclude it.
   - Run 5: strip the stamp line → `--force` → kept, listed separately as pre-stamp.
   - Guard-the-guard: corrupt one hex char of a valid stamp → `--force` keeps it
     (classified edited).
3. Matrix unit tests in `tests/scaffoldTests.test.ts` (fast, no biome): use its
   existing `comp()`/`tree()` builders + `scaffoldUnitBrowser` directly to pin the
   verdict→action table including `keptEdited`/`keptLegacy` result fields.

### Docs for this wave

- `docs/generated-suite.md`: document the stamp line + the `--force` matrix + the
  delete-to-regenerate escape for edited/legacy specs.
- `docs/extending.md`: wherever colocated regeneration is described, align with the
  matrix (this file was already adapted for refresh mode in Wave 2.1 — extend, don't
  contradict).
- README's `--force` description (grep for it) — one sentence on the new semantics.
- Skills: `.claude/skills/flawless-regen/SKILL.md` (force matrix, stamp, escape hatch)
  and `.claude/skills/flawless-unit-browser/SKILL.md` (stamp line meaning; don't
  hand-delete the stamp casually — that reclassifies the file as legacy). Copy both to
  `~/.claude/skills/` after editing.
- `docs/reviews/backlog.md`: strike through B-4 with a one-line "done, PR #N" note.

### Merge

Branch `wave2/hash-refresh` (already checked out) → PR "wave 2.3: hash-stamped
colocated refresh (B-4)" → merge into main → `mesh-repo-sync` from the repo → delete
this handoff file's "Wave 2.3" section is NOT needed (leave the doc, it's history).

---

## Wave 3 — inference features, strictly in order B-3 → B-1 → B-2

One branch + PR per item (`wave3/server-action-returns`, `wave3/mock-return-shapes`,
`wave3/compound-wrappers`). Same discipline as above. Specs, from the approved plan:

### B-3 server-action returns (M)

- New `analyse/serverActionReturns.ts`. Lift `ownReturns` out of
  `src/analyse/parseFile.ts` into a shared module first (it already skips
  accessors/constructors — keep that). Reuse `literalToValue` (in
  `src/analyse/renderPath.ts`) as the bail policy: only literal-derivable values.
- `redirect(...)`/`notFound()` calls are exits, not return values. Two distinct
  non-exit return values → bail (stay a TODO). One resolvable value → record it.
- Additive `serverActionReturns?` on `ModuleImportInfo` (src/types.ts). The mock
  emitter (`src/scaffold-tests/mocks.ts`) and host-stub emitters consume it; the
  `uninferred-return-shape` TODO is dropped only when EVERY name in the module resolved.
- Execution test: a fixture server-action module whose action returns a literal object;
  the emitted spec must be GREEN with the realistic value where the old `{}` stub made
  the component crash (prove the old way was red: mutation probe or a paired fixture).

### B-1 mock return shapes (L — this is the 87-TODO burn-down)

- Enrichment pass `analyse/resolveDepReturns.ts`, running only for deps whose return
  shape is currently uncertain/unknown.
- Path A: declared `Promise<T>` return annotations — resolve `T` via a narrow exported
  wrapper over extractProps' `resolveTypeNode`/`resolveTypeDecl` machinery
  (src/analyse/extractProps.ts), ctx anchored at the dep's own file; `T[]` → emit a
  one-element array.
- Path B: unannotated single-fetch wrappers — record as `wrapsFetch` (method + path),
  join to OpenAPI response examples AT EMIT TIME via the existing `apiRoutes` plumbing
  (NextjsApiRoute already carries response bodies).
- Additive `inferredReturn?` with provenance (`"annotation" | "openapi"`); the emitter
  writes the fixture value with a provenance comment. Dotted callees and anything
  non-literal stay TODOs — FR-014 is Wave 4's problem, do not compound it here.
- Tests: annotation resolution matrix (interface, type alias, array, generic bail);
  emit-time OpenAPI join; execution test where the enriched mock turns a previously
  crashing spec green; TODO tally drops proportionally (todoCounts.test.ts idiom).

### B-2 compound Root wrappers (L — 44 TODOs + up to 46 newly mountable)

- Analyser: derive the compound family from the part's OWN file — an exported sibling
  that renders `<X.Root>`/Root + a Content sibling → additive `compoundFamily?` on
  ComponentInfo. No cross-file chasing in v1.
- Emit side: static table of open-state knowledge only (dialog-family `open` props).
  New `compoundPartSpec` in scaffold-tests/templates.ts: Trigger renders inside a
  closed Root; other parts inside `<Root open><Content>…</Content></Root>`;
  portal-aware assertions (query via `screen` AND `baseElement`).
- Host half (registry split landed in Wave 2.2, so this goes in the REGENERATED file):
  `COMPOUND_WRAP` table in `host/registry.ts` (src/scaffold/templates.ts
  `hostRegistry()`), `nest()` consults it, hostEligibility flips for wrapped parts,
  report totals adapt. Mind the sorted-registry comparator (total code-unit order, not
  localeCompare) and the ALL/ALL_FN_PROPS/ALL_WRAP_IN spread contract in the write-once
  main.tsx — main.tsx gains `ALL_COMPOUND_WRAP` spread only if genuinely needed; prefer
  keeping the new table fully regenerated-side.
- Execution test: minimal fake radix-style package in fixtures proving the wrapper is
  LOAD-BEARING — the bare part throws without the Root wrapper, spec green with it.
- Accordion/tabs value-prop families are explicitly OUT of v1.

### Wave 3 doc closures

Ledger: B-1/B-2/B-3 completion notes in backlog.md; `docs/generated-suite.md` mock
provenance section; flawless-api + flawless-unit-browser skills if emitted shapes
changed; TODO-count expectations in the regen skill ("~181 → ≲30 on a typical app"
claim only if the repo's own fixtures support it — never overclaim).

## After Wave 3

Report to the user and STOP. Do not start Wave 4, do not touch mybodycorpai. Remaining
plan (Wave 4 test-rigor items, PAUSE gate, gated Wave 5 dogfood) is in
`~/.claude/plans/functional-percolating-wirth.md` and mirrored in the session tasks.
