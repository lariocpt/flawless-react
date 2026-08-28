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
| ~~B-9~~ (done, PR #24) | **zod-schema inference**: resolve `z.infer<typeof schema>` aliases by reading the zod schema (object/enum/literal subset, bail elsewhere) | Round 6's sharpest finding: z.infer enum aliases (`MeetingParticipantRole`, `RsvpStatus`, `ConsentStatus`) sit as MEMBERS of nearly every shared interface, so bail-on-any-hole vetoes whole fixtures even after B-8 resolves the declaration perfectly. The one genuinely shared-typed uncertain dep on mybodycorpai fails exactly here | L |
| ~~B-10 / B-18~~ (done, PR #50) | **Unwrap `cache()`/HOF-wrapped exports**: `export const getCurrentUser = cache(async (): Promise<User> => …)` — the function mapper skips CallExpression initializers, so the annotation is never read | Round 6 census: `getCurrentUser` ×2 of the uncertain-dep remainder on mybodycorpai; React `cache()` is the standard Next.js DAL idiom | S |
| B-11 | **Browser-host stubbing for built workspace "use server" packages**: SERVER_STUBS keys on the analyser's src path while the bundle resolves the bare spec via package.json main/exports — a dist-built package bypasses the stub filter | B-8 review finding 6 (correctness lens, PLAUSIBLE): B-8 extends server-action detection into workspace packages without extending the interception; unit plane is sound (vi.mock by bare spec, proven by execution test) | M |
| B-16 (waves 0-3 done, PRs #38-#41) | **Expo / React Native mode**: a per-file host-element dialect plus a native element model, a jest-expo + @testing-library/react-native unit emitter, an Expo-web host, a native accessibility analyser, expo-router route e2e, and API-only load pipes — parity across all seven tasks for a second platform | Pre-flight probes on mybodycorpai/apps/mobile (SDK 54, expo-router 6, RN 0.81.5, `experiments.reactCompiler: true`), recorded in [2026-08-expo-probes.md](./2026-08-expo-probes.md). The four that decide the design: **the `a11y` task returns 0 findings across 31 files carrying 82 `<Pressable>`s with no `testID`, `accessibilityLabel` or `accessibilityRole` between them** — vacuously green, while the same sweep finds 3/3 on the tool's own A11yOffender fixture; **136 of `perf-static`'s 168 findings (81%) are the three memoisation rules the React Compiler already implements**; only **46.8%** of reachable press targets are addressable by any locator rung; and NativeWind's `className` reaches neither the DOM nor the bundle without babel, though react-native-web consumes it with **zero** console output, so an unstyled host does not redden a healthy component's spec **Landed:** the platform seam and `--expo` (#39), the native element model (#40), and a jest-expo unit plane proven by executing it — 8 suites, 17 passed, 3 skipped, 0 failed under real jest-expo, with both mutation probes biting (#41). **Open:** the Expo-web host and browser specs, the native a11y analyser, expo-router e2e, and API-only load pipes — each refuses by name today rather than emitting DOM artefacts for a React Native project. | XL |
| ~~B-17~~ (done, PRs #53 + #54 + #60) | **Class components are invisible to `parseFile`**: it recognises function declarations, arrows and `const X: React.FC` variable statements only (`parseFile.ts:235,259`), so a `class X extends React.Component` is skipped with "could not locate a React component" | Found while probing B-16, and platform-agnostic — it is not a React Native issue. `mybodycorpai/apps/mobile/components/error-boundary.tsx` is a class, and it is **the only named export in the entire app**; every other component there is a default export or file-local, so this is the one component a `--roots exported` sweep of that app cannot see at all | M |
| B-19 | **The false side of a boolean guard is never exercised**: a fixture makes a predicate true, so `userIsTrustee ? A : B` only ever renders `A`. Both mocking to `{}` (truthy) and mocking to the annotation's `true` take the same branch | Rounds 1-6 measurement: web branch coverage is 56.2% against 74.9% lines, and 8 of 32 page specs still exit through a guard. A "both sides of a decidable guard" test is the next structural lever, and it is bigger than a fixture fix — it needs a second mount with the predicate inverted, and a rule for which predicates are safe to invert | L |
| B-20 | **`extractDataDeps` reads fields off callback parameters only**: `memberships.find(…)` contributes its predicate's fields, but `mine.label` — read off the `find` RESULT — contributes nothing, so a field only reachable that way keeps a synthesised value | Found writing the round-6 fixture for `MembershipGuardPage`: the test had to render through `.map()` to exercise the field it wanted, because the `find` result's own reads are invisible | M |
| ~~B-25~~ (done, PR #59) | **The mount-path and variant-matrix assertions cannot fail either**: `expect(container.firstElementChild).not.toBeNull()` at `templates.ts:601`/`:653`, the same expression the post-dispatch floor used | Proven by execution: a component whose whole body is `return null`, rendered under the derived provider, PASSES it — next-themes' ThemeProvider injects a `<script>` and `firstElementChild` finds that. 25 mount + 11 variant assertions across 124 provider-mounted specs on the dogfood app. The design round's "design-1 subject boundary", to be queried from a wrapper the emitter controls rather than from `container` — noting a bare `<div>` wrapper breaks a component whose root HTML confines to a `<tr>`/`<li>`, which the compound-part chain already handles | M |
| B-26 | **Rung 4 (state witness) is not worth its design**: measured ceiling of 6 on the dogfood app, not the ~22 the design round projected | 28 canary-bound clicks, of which only 7 have a DOMINATED setState effect and only 6 of those have a state var with a literal initial — before the harder question of whether the change is observably rendered. Its own reviewer broke both forms: vacuous with no before-leg (green against the correct component AND both mutants), red on that same correct component with one. Recorded as measured-and-declined rather than left on the list as though it were pending | L |
| ~~B-22~~ (done, PR #51) | **No `ts.Program` gate over the emitted NATIVE suite**: emittedTypes imported the DOM renderer only, so the whole `--expo` emitter was checked for SYNTAX and nothing else | It let three defects ship. On its first run the new gate reported `as never` spreads on every component spec (TS2698) and an `unknown` cast for a props-less component; adding the missing fixture made it name E1 directly (`PropsRoute.flawless.test.tsx:47 TS2552: Cannot find name 'handlers'`) | M |
| ~~B-23~~ (done, PR #51) | **Native mocks keyed on LOCAL import names**: `used` held `mi.names` while the loop iterates the module's own export names, so `import { listItems as fetchItems }` silently got a bare `{}` with NO marker | R-3's poisoning shape: the destructure binds undefined, the screen renders its error state, and the failure looks like the component. The web emitter has read `importedNames` since it was added. The same mismatch ran the other way for the three subtree lookups, so an aliased import also lost its loaded-state test AND its skip | S |
| ~~B-24~~ (done, PR #51) | **Emitted native specs did not type-check in the adopting app**: `{...(DEFAULTS as never)}` is TS2698, and `ComponentProps<typeof X>` is `unknown` for a props-less component | The DOM emitter documented this exact form as broken in its own RSC branch; the native copy used it one line below a comment about keeping Expo's strict tsconfig green. Invisible on the dogfood app, whose 31 screens are all routes — it would have bitten the first adopter with a components/ directory | S |
| ~~B-21~~ (done, PR #50) | **A type re-exported from an import does not resolve**: `import type { User } from "@scope/shared"; export type { User };` — the barrel chase looked only for a LOCAL declaration of that name, found none, and stopped | Found closing B-10: with the wrapper fix in, all three of the dogfood app's `lib/dal.ts` exports were VISIBLE and still resolved to nothing, because `User` reaches them through exactly this shape in `lib/users.ts`. Isolated with a three-file probe (`plain` ok, `wrapped` ok, `viaReexport` undefined), so the two defects were separated before either was fixed | S |
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
