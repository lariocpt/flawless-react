# M3 — suite tsconfig / own program root (shrunk)

## Scope

`src/scaffold-tests/templates.ts` (suite tsconfig emission at scaffold time,
`templates.ts:161`), the scaffold's directory layout, and the suite README. Surface
declared: scaffold emission + docs. No app-side files.

## What 0.3.2 already did (shrinks this step)

- **Correct paths at scaffold time** (fix-plan chunk 1, done): a fresh scaffold's
  `flawless/tsconfig.json` emits working `baseUrl`/`paths` — the measured 0.3.1
  hand-edit #4 (audit C10) disappears for new suites.
- **Scaffold-time only**: the 0.3.2 `--force` runs **never rewrite** the suite
  `tsconfig.json` (byte-identical across regens; the "Hand-patched, not generated"
  comment intact; the regen log prints `tsconfig.json: kept — "flawless" already
  excluded`). Regeneration is not the tsconfig's refresh channel — layout is.

## What remains

The suite directory becomes **its own program root**: its own `include` covering only
the suite, its own `compilerOptions` (not inheriting the app's program), so there is
nothing for the app's `tsc`/`biome`/`next build` to see or need configured. The one
relative import from colocated specs into `flawless/provider` stays — it is the
colocation feature and is documented in the suite README as the single seam.

## Acceptance (measured on the merge commit)

1. Fresh scaffold on a test app: `tsc -p <app>/flawless/tsconfig.json --noEmit` is
   clean with **zero** app-config edits (no `exclude`, no paths patch).
2. The suite `tsconfig.json`'s `include` resolves to files under the suite dir only
   (checked against `git ls-files` of the app).
3. The app's `tsconfig.json` is byte-identical before and after scaffold.
4. Idempotence probe (plan criterion 3): tsconfig byte-identical across the two
   regens, log line `tsconfig.json: kept` in both.

## Moot vs required

- Moot: "suite tsconfig emits correct paths" (0.3.2 chunk 1); the tsconfig
  *regeneration* half of the old M3 (0.3.2 never rewrites it).
- Required: the own-program-root layout.

## Dependencies

Ships **together with M4** (one layout change, one PR — plan order M3+M4): M4's
default placement and M3's program root are two faces of the same move.
