# Opportunity backlog — 2026-08 review

P3 opportunities from the deep review, each tied to observed dogfood evidence on
mybodycorpai (never invented features). The TODO census that grounds most of
them: 181 `TODO(flawless)` markers across 172 colocated specs, of which the top
three clusters are 89% of all remaining hand-work.

| # | Opportunity | Evidence | Effort |
|---|---|---|---|
| ~~B-1~~ (done, PR #12) | Infer mock **return shapes** for module-level data deps: chase the mocked function's return type the way props are chased, and synthesise from the OpenAPI response schema when the body wraps a fetch of a spec route | 87 of 181 TODOs are "some return shapes could not be inferred"; sibling mocks in the same spec show shaping works when the type resolves | L |
| ~~B-2~~ (done, PR #13) | Emit the **`<Root open>` wrapper** for known compound-part families (@base-ui/react/*, @radix-ui/react-*) — the REPORT already names the exact primitive and package it tells the user to add | 44 TODOs + 46 skipped browser specs are this one pattern; hand-filling two exemplars in dogfood took minutes each and the wrapper was mechanical | M |
| ~~B-3~~ (done, PR #11) | Synthesise **server-action stub returns** from the action module's own return expressions (object literals only, bail otherwise) | 31 TODOs "server action stubbed — give it a realistic return value"; detection already exists via the mock allowlist | M |
| ~~B-8~~ (done, PR #22) | **Workspace-package type resolution**: chase `Promise<T>` annotation types through bare workspace specifiers (`@scope/shared`) whose source lives in the same monorepo — resolve the package name via the workspace map, then continue in its source tree | Dogfood round 5: the nullable-union fix (PR #17) unlocked nothing on mybodycorpai because every lib annotation imports its `T` from `@mybodycorp-ai/shared`; the whole 42-TODO return-shapes remainder is exactly this wall. **Round-6 correction**: that diagnosis was wrong — B-8 shipped and was probed live against the repo (chain works, barrel chase lands in `schemas/meetings.ts`), but it enriched zero deps there: the 42 markers are `getDb` ×21 (unannotated client factory, correctly uninferrable), dotted locals, one `cache()`-wrapped export, and one shared-typed dep vetoed by B-9's z.infer members | M |
| B-9 | **zod-schema inference**: resolve `z.infer<typeof schema>` aliases by reading the zod schema (object/enum/literal subset, bail elsewhere) | Round 6's sharpest finding: z.infer enum aliases (`MeetingParticipantRole`, `RsvpStatus`, `ConsentStatus`) sit as MEMBERS of nearly every shared interface, so bail-on-any-hole vetoes whole fixtures even after B-8 resolves the declaration perfectly. The one genuinely shared-typed uncertain dep on mybodycorpai fails exactly here | L |
| B-10 | **Unwrap `cache()`/HOF-wrapped exports**: `export const getCurrentUser = cache(async (): Promise<User> => …)` — the function mapper skips CallExpression initializers, so the annotation is never read | Round 6 census: `getCurrentUser` ×2 of the uncertain-dep remainder on mybodycorpai; React `cache()` is the standard Next.js DAL idiom | S |
| B-11 | **Browser-host stubbing for built workspace "use server" packages**: SERVER_STUBS keys on the analyser's src path while the bundle resolves the bare spec via package.json main/exports — a dist-built package bypasses the stub filter | B-8 review finding 6 (correctness lens, PLAUSIBLE): B-8 extends server-action detection into workspace packages without extending the interception; unit plane is sound (vi.mock by bare spec, proven by execution test) | M |
| ~~B-4~~ (done, PR #10) | **Content-hash stamp** on generated colocated specs so --force refreshes provably-untouched files and lists the hand-edited ones instead of clobbering them | Dogfood iteration 4: the entire --force clobber surface was exactly the three hand-hardened specs; restoring them needed git archaeology | M |
| ~~B-5~~ (done, wave 1) | Narrow the **e2e affected run** with a --grep built from affected.routes (the emitted titles embed the route template) | runTests.ts:173 runs all 31 dev-server-backed route specs for any affected route | S |
| ~~B-6~~ (done, wave 1) | **"Hand-work remaining" table in REPORT.md**: count TODO(flawless) markers per kind at write time so regenerations show the debt burning down | REPORT accounts for all 183 components but says nothing about the 181 TODOs the same run planted | S |
| ~~B-7~~ (done, wave 1) | Cheap **timing assertion** over tests/fixtures pinning the "half a second" analysis claim as the analyser grows | Claim now carries a dated measurement (2026-08-23, 99 files → 463 ms) but nothing re-checks it | S |

| ~~B-12~~ (done, round 8) | **Emit an e2e setup that fails until filled**: the generated `global-setup.ts` is a hand-fill stub, so route specs assert `status < 500` against a login redirect (which answers 200) and the suite is green before it is real | Round-7 sweep + the `flawless-e2e-load` skill's anti-vacuous probes, which exist precisely because of this shape. Shipped as a **redirect assertion in the route spec** (not a throw in the stub — `global-setup.ts` is write-once even under `--force`, so a change there never reaches an existing suite) plus a REPORT.md hand-work tally keyed on byte-identity with the stub. Proved by EXECUTING the emitted spec in a real chromium against a server that 302s to /login: green before the fix, red until the hook is filled, green after | M |
| ~~B-13~~ (done, round 8) | **Keep diagnostics under `--ci`**: `warn()` writes to stderr but is gated on the same flag as `log()`, so the mode built for machines loses "your `--api` flag was ignored" and "skipping unparseable file" | Round-7 sweep, mechanism read at core.ts:170 + cli.ts's `log: !args.json`. Shipped: `warn()` gates on a separate `quiet` (programmatic-only, default off), all nine warn sites survive `--ci`, and one test pins both halves — warning on stderr, stdout still exactly one blob | S |
| ~~B-14~~ (done, round 8) | **`--run-tests` with only non-runnable tasks says nothing**: no message, no marker in the `--ci` blob — the caller cannot tell "suites passed" from "no suite ran" | Round-7 sweep; same ambiguity class FR-017 fixed for the affected-run gate. Shipped: a warning naming the runnable ids, `testRun` widened with `{mode:"none", reason}` and added to the blob, plus `errors` for FR-041 (a failure belonging to no task) so every red run is explicable from the blob alone | S |
| ~~B-15~~ (measured, NOT taken, round 8) | **Absorb repeated work into the caches**: `parseFile` re-runs component detection per call; `findExportedDecl` re-walks the same barrels per member per component | Round-7 sweep. **Measured before deciding, and the measurement said stop** — numbers in the paragraph below. The redundant work is real; its cost is not. What shipped instead is the timing bound the mode never had | M |

Perf micro-items measured and deliberately NOT taken (recorded so nobody
re-litigates them): parallelising the analyse loop (~2.5% projected saving —
sequential is fine); template building (no quadratic behaviour found); process
spawns (a full 7-task run spawns exactly 3 children — the per-file-spawn fear
is already fixed and guarded by a comment at biomeSweep.ts:89).

**B-15's three caches, measured 2026-08-25 and declined — on the third set of
numbers, because the first two were wrong.** The decision stands; the evidence
behind it was rebuilt after review, and what was rebuilt is recorded here
because the wrong version was more persuasive than the right one.

**The number that decides it** is the real app, which is the measurement the
first pass never took despite it being on the same machine.
`mybodycorpai/apps/web`, `roots: "exported"`, depth 3 — 273 files, 174 trees:
**163 ms warm, 251 ms cold**. A prototype of the two memos, built during
review, buys **~1.14× there (−18 ms)** with byte-identical analysis output.
Eighteen milliseconds, on a run whose generated suite takes minutes to execute,
is not worth an invalidation hazard. That is the whole argument.

**What was measured wrong the first time**, all three of these having been
re-run:

| First claim | Why it was wrong | Actual |
|---|---|---|
| "depth 1→10 moves the total by 4 ms" | the harness passed a literal `depth: 3`, so KIDS=6 and KIDS=10 walked the same 3 levels | 17.4 → 27.8 ms once depth follows the chain |
| "per-tree cost is flat ⇒ linear, not quadratic" | two adjacent points (R=2, R=8) in the flattest part of the curve | per-tree rises 0.309 → **0.442** from R=8 to R=32; the R+1 `parseFile` re-detection term is real and superlinear |
| "the whole barrel prize is ~30 ms at 320 arms; a realistic 60-arm barrel, a few ms" | measured at FILES=6 and reported as an absolute ceiling; the redundancy scales with FILES × ARMS and the two were never crossed | at FILES=100, ARMS 40 → 320 costs **214.6 → 696.3 ms** |

So the redundant work is not only real, it is **superlinear in roots-per-file
and grows with barrel breadth × file count**. It simply does not cost anything
*on the shapes that exist today*: the flagship consumer sits at 174 trees over
273 files with a modest barrel, where the memos are worth 18 ms.

**When to revisit**, since the ceiling is no longer being claimed: a
shadcn-sized generated barrel (hundreds of arms) in a repo with hundreds of
component files. That is the shape where the prototype showed multiples, not
percentages. Re-measure there before assuming this decision still holds.

One argument that was made and does **not** apply: "the memo key must carry the
EFFECTIVE `viaReexport`". That is a hazard for memoising *inside* `walk()`. For
the top-level `findExportedDecl` result the recursion always passes
`viaReexport = true` below the root (`sourceCache.ts:122`), so
`requireExportAtRoot` is the only varying input and keying on it is sufficient.
The prototype passed every `2613f8b` shadowing regression. The reason to
decline is the 18 ms, not a hazard that is not there.

Two corpus mistakes are recorded because they are the reusable part: inline
`{ shape: T }` annotations **bail** (`propsShape: {}`, `unresolvedProps`), so a
corpus built on them measures the bail path while the timings look perfectly
reasonable; and a corpus with no child components never exercises the per-root
subtree re-walk at all. `tests/analysePerf.test.ts` asserts against both, plus
the walked depth, the barrel breadth and the shared cache actually being shared
— five structural guards, each probed and proven to fire. The synthetic corpus
is also ~3× lighter per tree than the real app (0.31 vs 0.94 ms), so its
absolute numbers are not a scale claim about anything.
