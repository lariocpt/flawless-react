# M4 — layout outside the host program (shrunk)

## Scope

Scaffold placement: where `flawless/` sits relative to the app's program, and the
emitted app-side config touches (which should become *none*). Surface declared:
scaffold emission + docs.

## What 0.3.2 already did (shrinks this step)

Fix-plan **chunk 2** (app tsconfig `exclude` entries, web + mobile) and **chunk 8**
(root biome ignore for `setup.ts`) are **already fixed at the 0.3.2 emitter**: fresh
scaffolds emit the app `tsconfig.json` exclude and the biome ignore correctly, so the
three measured hand-edits (audit C10 #1–#3) exist only in 0.3.1-era pinned trees. The
"make the generator write them right" half of the old M4 is done.

## What remains — default placement

The suite is placed so the host's `tsc` / `biome` / `next build` **never include it
without the user opting in** — by layout, not by config entries the generator must
remember to write. For existing 0.3.1-era suites this is a migration (move + the
opt-in note); for fresh apps it is the default. Cost paid and kept: the suite is a
self-contained program (M3) and the single relative import from colocated specs into
`flawless/provider` is the documented seam.

## Acceptance (measured on the merge commit)

1. Fresh app, fresh scaffold: `tsc --noEmit`, `biome check` and `next build` at the
   app root all pass with **zero** app-config edits made by the user (diff of the app's
   config files before/after scaffold is empty).
2. The emitted app configs contain no suite-specific entry (grep for the suite dir
   name across the app's `tsconfig.json`, `biome.json`, `next.config.*` → 0 hits).
3. Colocated specs still import the provider by relative path (the seam) and their
   `import` lines are unchanged by the layout move (path rewrite is mechanical and
   verified by the idempotence probe).
4. Migration path for a 0.3.1-era suite is a documented, reversible file move (the
   pinned `c00697f` tree used as the test case: after migration its app configs need
   no suite entries).

## Moot vs required

- Moot: emitting the exclude/ignore entries correctly (0.3.2 chunks 2/8).
- Required: default placement + migration note; the seam documentation.

## Dependencies

Ships with M3 as one PR (plan order M3+M4). No dependency on M1/M2 output, but lands
after them so their receipts are already the in-repo standard.
