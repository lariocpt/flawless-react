# flawless-react 0.3.1 — dogfood fix plan

Nine defects found by dogfooding `@lariocpt/flawless-react@0.3.1` against a real monorepo
(`~/Projects/personal/mybodycorpai`: Next 16 app-router + hono API in `apps/web`, Expo SDK 54 in
`apps/mobile`). Full evidence: `~/FLAWLESS-DOGFOOD-31-oct.md`.

**How to use this file.** Each chunk is one session, one idea, one PR. Work them in order — later
chunks assume earlier ones landed. Every chunk states what was *measured*, never what is assumed; if
your measurement disagrees with the text, the measurement wins and you say so in the PR.

Repo conventions that apply to every chunk:

- Branch off `main`, open a PR into `main`. One idea per commit. Commit messages may cite only
  numbers you actually measured in that commit.
- Gates before pushing: cleared-cache `bun run check`, `bunx tsc --noEmit`, `bun test` (1610 tests at
  the time of writing — the count must not go down).
- After a successful push, run the `mesh-repo-sync` skill.
- The repo has a culture of invariant guards with a test attached (see `src/emitPaths.ts`): when a fix
  is "never do X again", add the guard, not just the fix.

Two claims from the original report were **wrong** and are corrected here so nobody chases them:

- **Not an app bug:** four `*/new` routes returning 404 for an `owner`. The pages call
  `if (!myMembership || !isTrustee(myMembership.roles)) notFound()`, and the API tests assert
  `403 for non-trustee` (`apps/web/tests/api/polls.test.ts:109`). Intended; the e2e just needed a
  trustee session.
- **Not an app bug:** "invoice detail renders a list without keys". Both `.map()` sites already have
  keys (`key={idx}` with a biome-ignore, `key={p.id}`). The React warning comes from the tool's own
  `resolveAsyncUi`, which turns static JSX children into an array — that belongs to Chunk 9.

---

## Chunk 0 — Baseline harness (same session as Chunk 1)

**Why.** Eight of the nine defects are only provable against a real target project, and every chunk
below needs a before/after number. Build that once.

**Do.**

1. Create a fixture project the test suite can generate into, modelled on the dogfood target but tiny
   (`tests/fixtures/aliased-next-app/` — **landed there**, not `test/`: the repo has no singular
   `test/` tree and a second one would trip the stray-nested-checkout hunt in AGENTS.md):
   - `tsconfig.json` with `compilerOptions.paths: { "@/*": ["./src/*"] }` and **no** `baseUrl`;
   - `src/app/layout.tsx` (async root layout returning `<html>`), one async RSC page that awaits a
     data function and renders a client child, one client component reading a synchronous store hook
     (a real zustand store is fine — the bug needs a sync hook);
   - `src/app/api/[[...route]]/route.ts` — a hono-style catch-all, so Chunk 5 has a target;
   - a `biome.json`/eslint config strict enough to reject `any`.
2. Add `test/dogfood-baseline.test.ts` that runs the generator against the fixture (in-process if
   `src/core.ts` exports the entry, otherwise as a child process) and asserts the *current*, wrong
   behaviour with a `// FIX-PLAN: chunk N` marker per defect — so each chunk flips its marker from
   "wrong" to "right" instead of inventing a new harness later.
3. Record the numbers in `test/fixtures/README.md`: files emitted, and which planes start.

**Acceptance.** `bun test tests/dogfood-baseline.test.ts` passes; the file names, for each of chunks
1–9, the assertion that currently fails in the real world and is green here because it is not asserted
yet.

**Do not.** Do not fix anything in this chunk. If a defect does not reproduce in the fixture, say so in
the PR body and describe what the fixture lacks — that is a result, not a failure.

**Result (chunk 0, 1 Nov).** Landed as `tests/fixtures/aliased-next-app/` +
`tests/dogfood-baseline.test.ts` + `tests/fixtures/README.md`. Defects 1–6 and 9 reproduce (1, 3, 4
also at runtime: webServer exit 1, `renderToReadableStream is not a function`, `toasts.map is not a
function` — the last two need react/react-dom pinned to 19.1.0 and installed *before* generation, see
the fixture README). Defect 7's mechanism reproduces statically but its runtime symptom is masked by
defect 4 (the page spec dies at `toasts.map` before the empty-container symptom can show); defect 8
needs a stdio MCP client and is a named placeholder, not an assertion.

---

## Chunk 1 — Defect #1: the harness tsconfig drops the app's path aliases

**Symptom, measured.** Browser and perf planes die before a single test runs:

```
[WebServer] error: Could not resolve: "@/components/providers/store-provider". Maybe you need to "bun install"?
Error: Process from config.webServer was not able to start. Exit code: 1
```

**Root cause — corrected by measurement (chunk 1, 1 Nov).** The symptom was right; the blamed line
was not. `tsConfig()` in `src/scaffold/templates.ts` is only emitted for **non**-Next suites
(`templates.ts:158` guards it with `if (!opts.nextjsHost)`). For a Next host the harness tsconfig is
emitted by `src/scaffold-tests/index.ts` (write-once, guarded only by `skipInnerPackageJson`, which
no caller sets) — so `flawless/tsconfig.json` *is* written for Next apps, with no `baseUrl`/`paths`,
and Bun's bundler (which consults the nearest tsconfig per importing file) resolves
`flawless/provider.tsx`'s `@/…` through it. Deleting the file — leaving the app's own
paths-carrying tsconfig as the nearest one — started both planes, proving the mechanism. The vitest
config's vite `alias` block (`computeResolveAliases` → `ModuleResolver.aliasPatternsFor`) already
solved the same problem for vite; the harness tsconfig had never been given it.

**Do — as landed.** `tsConfig()` now takes an optional alias block, and `harnessAliasBlock(aliasRoot,
outDir)` (same file) computes it from `ModuleResolver.aliasPatternsFor` + `baseUrlFor` — every target
`paths` alias (star keys and exact keys), rewritten relative to the app root, target `baseUrl`
carried, never absolute (the `emitPaths` invariant). The unit-browser task passes `aliasRoot:
ctx.nextjs?.root` (Next mode only: a standalone suite touches the app through relative paths, whose
files resolve their own aliases through their own nearest tsconfig). A guard throws at generation if
an alias would be dropped. Because the file is write-once, a tsconfig whose bytes are *exactly* the
old tool default is refreshed on the next run; anything hand-touched keeps the write-once promise.

**Do.**

1. In `src/scaffold/templates.ts`, change `tsConfig()` to accept the target's resolved alias map
   (thread it from the caller in `src/scaffold/index.ts`, which already reads the target tsconfig for
   the vitest aliases — reuse that value, do not re-read the file).
2. Emit, only when the target actually has aliases:
   ```jsonc
   "baseUrl": "..",                       // relative to the harness dir = the app root
   "paths": { "@/*": ["src/*"] }          // rewritten relative to baseUrl, not absolute
   ```
   Rewrite each target path so it is expressed from the app root (the target's `./src/*` becomes
   `src/*`). Preserve every alias, not just `@/*`. If the target has `baseUrl` set, carry it too.
3. Guard: if the target has aliases and the emitted harness tsconfig would not, that is a bug — throw
   or assert in dev rather than emit a broken harness (this is the `emitPaths.ts` pattern).
4. Tests in `src/scaffold-tests/`: (a) target with `@/*` → harness tsconfig contains `baseUrl` and the
   rewritten path; (b) target with three aliases → all three present; (c) target with no aliases →
   byte-identical output to today (no empty `paths: {}` noise); (d) target with `baseUrl` → preserved.
5. Flip the Chunk 0 marker for defect #1.

**Acceptance.** Against the fixture: `bun run flawless:browser` starts its webServer and runs (it
previously died at startup). Quote the before/after in the PR: "browser plane: webServer exit 1 →
N specs executed".

**Gotchas.** Do not write absolute paths into the harness tsconfig — the suite is committed and must
not name the machine that generated it (same invariant `src/emitPaths.ts` holds for sidecars).

---

## Chunk 2 — Defect #2: the generator breaks the host project's own type-check

**Symptom, measured.** After a generation run, the *app's* build/type-check fails on generated files:

- web: `next build` dies type-checking `flawless/host/registry.ts`;
- native: `bunx tsc --noEmit` fails with `error TS2708: Cannot use namespace 'jest' as a value`
  across `flawless/unit/*.flawless.test.tsx`.

Both went green by adding `"flawless"` to the app tsconfig's `exclude`. The tool writes files into the
project and then breaks the project's build.

**Root cause.** Nothing in the generator ever touches the target's `tsconfig.json`. It already has the
machinery for exactly this kind of merge for `package.json` (`src/packageJson.ts`, `src/suiteScripts.ts`
— merge, never clobber, and report what was merged), so the pattern exists; it just was not applied to
tsconfig.

**Measured corrections (chunk 2, 1 Nov).** The mechanism held; three details did not, and the
measurement wins:

1. **The exclude alone does not make the fixture green.** After adding `"flawless"` to the fixture's
   `exclude`, `bunx tsc --noEmit` still failed — one error: a COLOCATED spec (in `src/`, inside the
   program regardless of the exclude) calls `toBeInTheDocument` whose type augmentation arrives only
   through `flawless/setup.ts`, now on the excluded side. Fixed as a second mechanism: a spec that
   calls a jest-dom matcher imports `@testing-library/jest-dom/vitest` itself.
2. **The fixture cannot produce a `next build` type-check at all** — before or after generation.
   `next build` dies loading `next.config.ts` under bun's node_modules layout (`TypeError: Cannot
   read properties of undefined (reading 'fileExists')`), and with the config renamed to `.mjs`,
   webpack fails to resolve the app's own `@/` paths (paths without `baseUrl`) on a PRISTINE copy
   with no generated files. The fixture's equivalent type-check is `bunx tsc --noEmit` — which is
   exactly what `next build`'s type-check step runs against the same tsconfig — and that is what the
   chunk quotes.
3. **The native TS2708 half stays static.** A Next fixture emits vitest specs, not jest ones; the
   `Cannot use namespace 'jest' as a value` symptom is the Expo twin of the same mechanism and is
   recorded as static-only in `tests/dogfood-baseline.test.ts`.

The gotcha about `extends` was real and is now pinned by a test: inherited `exclude` patterns anchor
to the DECLARING config's dir, so a repo-root base excluding `flawless` does NOT cover
`apps/web/flawless` — anchoring wrong would have produced both a false "kept" and a real duplicate.

**Candidate defect #10 (fixed — the #10 chunk):** a host on vitest 4/5, which pull vite 8, died
collecting every spec under a host `"jsx": "preserve"`. The wording here ("vitest 5 + vite 7
ignores the emitted `esbuild.jsx` override") was wrong on both halves — the vite is 8, and the
key is not ignored but discarded beside vitest's always-injected `oxc` default, after which jsx
falls through to the host tsconfig. Not a fixture quirk — any real user on vitest 4/5 with a
preserve host hits the same wall. Fixed by family-gated emission; see the corrected #10 section
in the candidate triage and `tests/fixtures/vitest5-app/`.

**Do.**

1. New `src/tsconfigJson.ts` mirroring `src/packageJson.ts`: read the target tsconfig as JSONC
   (comments and trailing commas are legal — use the same parser the repo already uses for tsconfig
   reading, do not add a dependency without checking first), ensure `exclude` contains the suite dir,
   write back **preserving the file's own formatting** (if the value can be changed by a line-level
   edit, do a line-level edit; only fall back to re-serialising when the key is absent).
2. Merge rule: add the suite dir name (e.g. `flawless`) to `compilerOptions`-level `exclude` only if
   missing; if `exclude` is absent, add the key. Never reorder or reformat existing entries.
3. Report it the way scripts are reported: the run summary should say `tsconfig.json: added "flawless"
   to exclude` (or `kept`), so a user sees the tool touched their config and why.
4. Also emit a one-line comment in the harness README explaining why the exclude exists, because the
   next person to prune a config will delete it again — that is exactly how this regressed in the
   dogfood repo.
5. Tests: (a) tsconfig with `exclude: ["node_modules"]` → `["node_modules", "flawless"]`, formatting
   preserved; (b) already-present → file byte-identical; (c) no `exclude` key → key added; (d) JSONC
   with comments → comments survive; (e) `--force` re-run → still byte-identical.
6. Flip the Chunk 0 marker for defect #2.

**Acceptance.** Against the fixture: `bunx tsc --noEmit` in the target is clean after a run that
previously produced TS2708s; `next build` (or the fixture's equivalent type-check) passes. Quote both.

**Gotchas.** Some targets extend a base tsconfig that already excludes the dir; detect the effective
exclude (own file first, then `extends` chain) or you will add a duplicate that a reviewer rightly
objects to.

---

## Chunk 3 — Defect #3: `renderToReadableStream` is not exported by the build the alias points at

**Symptom, measured.** Every document-root spec (`app/layout`, `global-error`) fails with
`renderToReadableStream is not a function`.

**Root cause.** The spec template emits `import { renderToReadableStream } from "react-dom/server"`,
while the generated `vitest.config.mts` aliases `react-dom/server` → `node_modules/react-dom/server.js`,
which re-exports the **node** build:

```
server.node.js exports:    renderToPipeableStream renderToStaticMarkup renderToString version
server.browser.js exports: renderToReadableStream renderToStaticMarkup renderToString version
```

The same config already aliases `react-dom/server.browser`, so the specifier the spec should use is
already wired.

**Measured corrections (chunk 3, 1 Nov).** The mechanism held; the supporting claims needed
measurement, and the version gate changed the design:

1. **"The same config already aliases `react-dom/server.browser`" — true, in both modes, but it had
   to be proven.** Measured on the fixture with react-dom 19.1.0 installed, generated with the
   current tree: the emitted `vitest.config.mts` aliases `react-dom/server` →
   `<nm>/react-dom/server.js` AND `react-dom/server.browser` → `<nm>/react-dom/server.browser.js`
   in **both** Next-host and standalone mode (`computeResolveAliases`' pin block in
   `src/tasks/unitAndBrowser.ts` — both pins emit whenever the files exist at generation time).
   Without an installed react-dom neither pin is emitted and vite resolves both specifiers through
   react-dom's own exports map onto the same builds.
2. **The export tables, re-measured on installed packages:**

   ```text
   react-dom@19.1.0  server.node.js    renderToPipeableStream renderToStaticMarkup renderToString version
                     server.browser.js renderToReadableStream renderToStaticMarkup renderToString version
   react-dom@19.2.0  server.node.js    + renderToReadableStream resume resumeToPipeableStream
                     server.browser.js renderToReadableStream renderToStaticMarkup renderToString resume version
   ```

   `server.browser.js` still exports `renderToReadableStream` on modern react-dom — the export map
   did not move again — so the specifier swap is safe across the version gate, not a 19.1 fix that
   becomes a 19.2 break.
3. **As landed: a measured specifier, not a hardcoded one.** `src/reactDomServerStream.ts` probes
   the react-dom the emitted aliases point at (the `reactPinDir` anchor) and names the specifier
   whose resolved build exports `renderToReadableStream`, preferring `react-dom/server.browser`
   (it carries the export on 18.x, 19.1 and 19.2 alike). A react-dom that satisfies neither
   candidate is a capability gap: the spec emits a `test.skip` naming the export gap and the
   version seen — never an "is not a function" red. The guard (`tests/documentRootStream.test.ts`)
   greps rendered output and re-derives the export table from bytes on disk, so it cannot encode
   19.1's table as eternal truth.
4. **The native twin needs nothing.** `src/scaffold-tests/nativeTemplates.ts` emits no react-dom
   import and the native jest config aliases no `react-dom/*` subpath (measured: zero matches in
   `nativeTemplates.ts`/`nativeIndex.ts`). The TS2708 half stays static (chunk 2).

**Result (chunk 3, 1 Nov).** Fixture unit plane (react-dom pinned 19.1.0): the layout spec's failure
went from `renderToReadableStream is not a function` (defect 3) to `createStore(...) is not a
function` — defect 4's `vi.fn(async () => ({}))` guess at `zustand/vanilla`'s curried factory; the
page spec's two `toasts.map` reds are defect 4's too. Tally stays 3 failed / 3 passed / 1 skipped,
but no spec fails for defect 3 any more; the layout goes fully green only with chunk 4's mock
shapes. In the dogfood repo the two document-root specs went red→green with this change plus
chunk 4's real fixtures (`~/FLAWLESS-DOGFOOD-31-oct.md` §3 + §4: "Replacing them with real fixtures
… turned the file green").

**Do.**

1. In the document-root spec template (`src/scaffold-tests/templates.ts`; the native twin is
   `src/scaffold-tests/nativeTemplates.ts`), import from `react-dom/server.browser` and keep a
   one-line comment saying why — the next reader will "simplify" it back otherwise.
2. Add a template-level assertion (or unit test) that no emitted spec imports
   `renderToReadableStream` from `react-dom/server` — a grep-style guard over the rendered output, so
   the regression cannot come back silently.
3. Check the alias block itself: if a target genuinely cannot resolve `server.browser` (older
   react-dom), the spec must skip with a reason naming the export gap rather than fail with
   "is not a function".
4. Tests: rendered output contains `react-dom/server.browser`; the guard test fails if a template is
   changed back.
5. Flip the Chunk 0 marker for defect #3.

**Acceptance.** Document-root specs for the fixture's async root layout pass. In the dogfood repo the
two affected specs went from red to green with exactly this change (plus Chunk 4's fixtures for the
layout one) — quote that.

**Gotchas.** Do not "fix" this by repointing the `react-dom/server` alias at the browser build: other
specs legitimately want the node build's `renderToString`. The specifier is the bug, not the alias.

---

## Chunk 4 — Defect #4: guessed mock shapes are `async` for synchronous hooks

**Symptom, measured.** `src/app/layout.flawless.test.tsx` fails with
`TypeError: toasts.map is not a function`. The generated mocks were:

```ts
vi.mock("zustand", () => ({ useStore: vi.fn(async () => ({})) }));
vi.mock("zustand/react/shallow", () => ({ useShallow: vi.fn(async () => ({})) }));
vi.mock("@/lib/store", () => ({ createAppStore: vi.fn(async () => ({})) }));
vi.mock("@/lib/store/selectors", () => ({ useToasts: vi.fn(async () => ({})) }));
```

Replacing them with real fixtures (`useToasts: () => []`, zustand left real) turned the file green —
which proves the mock, not the app, was at fault. The pattern appeared 50 times across the web suite.

**Root cause.** `src/analyse/resolveDepReturns.ts` (~line 233 distinguishes "declared async" from
"could not be inferred") feeds `src/scaffold-tests/templates.ts` (~line 2439 emits the
"shape could not be inferred" body). When the return type is unknown the template defaults to
`vi.fn(async () => ({}))` — async and `{}` regardless of how the call site uses the value.

**Measured corrections (chunk 4, 1 Nov).** The symptom and the fix direction held; the blamed
machinery did not, and the dogfood's hand-verified fix had a second mechanism the plan dropped:

1. **Neither blamed line emitted the async mock.** The fixture's zustand-family stubs came from
   `dataModuleMock.entry()`'s no-evidence fallback in `src/scaffold-tests/mocks.ts` (~line 764),
   not from `templates.ts:2439`, and `extractDataDeps.ts:239` — the `await Promise.all([...])`
   path the `awaited` flag is set on — never saw these hooks at all.
2. **`awaited` is per-declaration, not per-use-site.** The plan's "the analyser already knows
   whether the import is `await`ed at each use site" is false: the channel records one boolean
   per imported binding. A module awaited in one file and called sync in another arrives as one
   answer; call-site disagreement now surfaces as a TODO naming both call sites instead of
   silently picking a side.
3. **The deps channel never ran for the fixture's sync components.** `src/analyse/index.ts:313`
   extracted data deps only for async units, so the sync client components that read the store
   recorded nothing and every guess fell to the no-evidence fallback. Fixed with a NEW `mockDeps`
   analyse channel (sync call-site evidence feeding only the mock emitter — guards, predicates
   and the RSC skip never read it), not by widening `dataDeps`.
4. **The hook rule overrides only a GUESS, not a stated contract.** The plan says `use*` → sync,
   always. As landed, a `use*` binding whose annotation says `Promise<T>` keeps its async mock:
   a stated contract beats a naming heuristic. The rule fires only where async-ness was guessed.
5. **The second mechanism was missing from the plan.** The dogfood hand-fix was "real fixtures +
   zustand left real". Call-site rules alone still emit a guessed stub for `zustand/vanilla`'s
   curried `createStore<AppState>()((set) => …)` — no guessed shape survives being called as
   `stub()((set) => …)`. As landed: a package module no analysed file CALLS is not mocked at all
   (left real), and a mixed package factory carries a comment saying which exports are guesses.
   `importOriginal` was rejected (importing a package's real module can pull `next/cache` write
   helpers into the jsdom graph); extending the skip to local modules was rejected (local modules
   are exactly where the guessed fixtures belong).
6. **The `[]` for `.map` use sites lands as a one-element array**, `[{ id: "flawless-id", … }]`,
   per the emitter's documented `mockLiteral` contract: a one-element array witnesses the element
   shape AND a non-empty render; an empty array witnesses nothing and makes `.map` assertions
   vacuous. The denylist (Do.4) was not needed — the hook rule plus the package skip cover the
   zustand family without a list to maintain.

**Result (chunk 4, 1 Nov).** Fixture unit plane, freshly generated with the fixed tree and run
(vitest 2.1.9, react-dom 19.1.0): **4 files, 6 passed / 1 skipped / 0 failed**. Before: the
layout spec red with `TypeError: createStore(...) is not a function` (the async stub called as a
curried sync factory), the page spec red ×2 with `toasts.map is not a function`, InboxList and
store-provider green (3 passed / 1 skipped). After: the layout spec emits **no `vi.mock` at all**
— the whole zustand family left real, the dogfood hand-fix's shape; the page spec emits
`useToasts: vi.fn(() => [{ id: "flawless-id", text: "flawless-text" }])` from its `.map` use
site; the store-provider spec mounts the real store (2 passed / 1 skipped). This satisfies the
§4 acceptance quote ("Replacing them with real fixtures … turned the file green", the pattern
50× across the web suite). Defect 7 did NOT surface on this fixture — its page children are sync
and the layout uses the streaming renderer; chunk 9 needs a promise-valued-children fixture.
The native plane has its own emitter (`networkModuleMocks` in `nativeTemplates.ts`, mocks only
`fetch()`-containing modules, annotation-driven); the hook guard was added to its two
guessed-async branches and is provably inert on the current native fixture.

**Do.**

1. Thread the **call-site shape** into the mock emitter. The analyser already knows whether the import
   is `await`ed at each use site; use it:
   - awaited at the call site → async mock is correct;
   - called synchronously (assignment, `.map`, JSX child, `if`) → **sync** mock;
   - a hook name (`use*`) → sync, always. A hook returning a Promise is a different contract.
2. Improve the default *shape* for the unknown case, in this order: (a) the type annotation if present;
   (b) the shape implied by the member accesses the analyser sees (`x.map` → `[]`, `x.length` → `[]`,
   `x.y` → `{ y: … }`); (c) only then `{}`. Where the analyser sees `.map`/`.length`/iteration, emit
   `[]`, not `{}`.
3. Keep the `TODO(flawless)` comment, but make it state the guess and the reason:
   `// TODO(flawless): guessed [] because the only use site is .map() — give it a real fixture.`
   A bare "could not be inferred" tells the next person nothing.
4. Never emit `async` for a specifier in a known-sync list (zustand's `useStore`, `useSyncExternalStore`
   callbacks, React hooks). A small denylist plus the call-site rule is enough; do not try to be clever.
5. Tests: for a fixture component that does `const toasts = useToasts(); toasts.map(...)`, the emitted
   spec contains a sync `[]` mock and the spec passes when run; for a genuinely awaited dep, the async
   mock is unchanged (prove no regression on the existing 1610 tests).
6. Flip the Chunk 0 marker for defect #4.

**Acceptance.** The fixture's store-reading component generates a passing spec. In the dogfood repo,
`src/app/layout.flawless.test.tsx` went green with exactly this fix — quote it.

**Gotchas.** Some deps are *both* (a function called with and without `await` in different files). When
call sites disagree, prefer sync and say so in the TODO; a sync mock under `await` still works
(`await 5 === 5`), the reverse does not.

**Candidate defect #11 (recorded by chunk 0, verdict by chunk 4): the `.gitignore` write is
intended, not a defect.** `src/nextjs/detect.ts` (`ignoreEntries`/`updateGitignore`) adds suite
artifacts to the host's `.gitignore` on purpose — the saleor-dashboard rationale: generated files
committed by accident rot silently — and `src/core.ts` reports it ("added N entry(ies) to
.gitignore"). Closed as intended-and-reported; no chunk owns it and none should.

**Candidate defect #12 (recorded by chunk 4, not fixed by any chunk): colocated specs cannot run
from the suite dir.** Running vitest with the cwd inside a suite dir that carries its own
`package.json` (the standalone layout) fails every colocated spec with `Failed to load url …
Does the file exist?` — vite's `server.fs.allow` roots at the cwd and refuses the app files
above it. The emitted `flawless/vitest.config.mts` sets no `fs.allow`; running from the APP root
with `--config flawless/vitest.config.mts` works (that is how chunk 4's execution test runs).
Any user who `cd flawless && npx vitest` hits this and sees a phantom "files do not exist" red.
Fix is one line (`server.fs.allow: [projectRoot]` in the emitted config) and needs its own chunk.

**Candidate defect #13 (recorded by chunk 4, not fixed by any chunk): a mock factory is complete
only for its evidenced importers.** A mocked module's factory covers the exports the analysed
call sites evidence; a module also imported by NON-analysed files in the render graph (a util
re-exporting a store action) can touch an export the factory never emitted → `undefined is not a
function` at runtime. The package-module skip (correction 5) removed the fixture's exposure —
uncalled package modules are left real — and the drop hazard did not reproduce as a "dropped
export" here (`createStore` was present-but-async, not missing), but the hazard is real for local
mixed-importer modules and needs a factory-completeness rule of its own.

---

## Chunk 5 — Defect #5: catch-all API routers, and a `--api` refresh that does not propagate

**Symptom, measured.** The target is hono behind `src/app/api/[[...route]]/route.ts`:

```
swagger paths derived:  1  →  ["/api/{route}"]
swagger paths real:    71  →  apps/web/openapi.json (the app's own `bun run openapi:export`)
```

Consequences: MSW emitted one catch-all handler, load pipes were starved, and two components that
fetch on mount 404'd in the browser host. Pointing `--api` at the real spec produced 103 handlers and
the 404s stopped — but only after `mocks/handlers.ts` was deleted by hand.

**Two separate bugs.**

(a) **Silent flattening.** Nothing warns that a catch-all route was collapsed into one path.
(b) **Write-once trap.** `--api` refreshes `swagger.json` but not `mocks/handlers.ts`, because handlers
are write-once ("Edit freely — flawless-react will not overwrite this file"). A project that ran once
before it had a spec keeps a useless catch-all forever, silently.

**Do — as landed (chunk 5, 1 Nov).**

1. **The plan's two sites were both wrong.** The flattening is not in
   `src/scaffold/openapi.ts` — that file is the spec *parser* (`extractRoutes`), it never sees a
   filesystem. It is `appRouterSegment`/`pagesRouterSegment` in `src/nextjs/apiRoutes.ts`, which map
   `[[...x]]` and `[...x]` to one swagger path param. Those walkers now set `NextjsApiRoute.catchAll`,
   and `core.ts` turns the flag into the warning — after the `--api`/live-spec enrichment, so a run
   that already passed a real spec stays quiet. The warning names the file, the collapsed count and
   the way out, and names `openapi.json`/`openapi.yaml` or an `openapi*` package.json script when the
   project has one.
2. **The write-once check is not in `src/nextjs/mswHandlers.ts` either** — that file is a pure
   renderer with no filesystem logic. The `existsSync` guard lives in `src/nextjs/emit.ts`, which is
   where the provenance contract landed. It reuses `src/scaffold-tests/stamp.ts` rather than inventing
   a second hash dialect: the file opens with the existing `@flawless-generated sha256:<16hex>
   flawless-react@<version>` line, and the spec digest rides on the line *below* it
   (`// @flawless-spec sha256:<16hex>`), inside the hashed body. That placement is the compatibility
   contract — `STAMP_RE` is untouched, so a file already stamped by 0.3.1 classifies exactly as it
   used to, and `restampGenerated` re-hashes the stamp line after the host formatter runs while
   preserving everything below it.
3. Contract, every kept branch byte-identical: absent → `created`; `--force` → regenerated (the named
   escape hatch, hand-edits included); stamp mismatch → `kept (hand-edited) — regenerate with --force
   or delete it`; **no stamp at all** → kept, always; untouched + same digest → `kept`; untouched +
   digest moved → `regenerated from a newer spec`; untouched + stamped before spec digests existed →
   kept, because its digest is unknowable.
4. The summary reports both the handlers outcome and the coverage: `mocks/handlers.ts: <report>` and
   `handlers: N emitted, covering M spec path(s)`, so a catch-all stub is visible in run output.
5. Tests: `tests/handlersProvenance.test.ts` (a–f, including the 0.3.1-stamp compatibility case) and
   the flipped Chunk 0 marker, which now captures the run's stderr to assert the warning.

**Acceptance, measured (1 Nov, in-process `runCore` against the hono-style fixture).** Spec-less:
1 path, 2 handlers, and the warning fires — naming `src/app/api/[[...route]]/route.ts` and `--api`;
with an `openapi.json` present the same line ends `pass --api openapi.json` instead of `<path>`.
`--api` at the real 71-path spec (231 KB, `mybodycorpai/apps/web/openapi.json`, still checked out):
**99 handlers covering 71 spec paths**, up from 2 covering 1. Re-running with a spec that gained one
path reported `regenerated from a newer spec` and produced **100 handlers covering 72 paths** with
nothing deleted by hand; the same run before the fix left the handlers file untouched.

**Corrected: the plan's "6 (one per verb)" baseline was wrong.** The AST walk reads the methods the
route file actually exports, so the fixture's catch-all yields 2 handlers (GET, POST), not 6.

**Candidate defect #14 (recorded by chunk 5, not fixed by any chunk): a failed live-spec fetch is
silent by default.** `src/nextjs/liveSpec.ts` fetches `http://localhost:3000/api/docs` (1500 ms
timeout) whenever `--swagger-url` is not `off`, and returns `{ ok: false }` on a non-200, a non-JSON
content type, or any throw. `core.ts` only warns when the user *passed* `--swagger-url`: with the
default, a dead dev server produces no output at all and the run quietly falls back to the AST walk —
the same class of silence as the flattened catch-all this chunk fixed, one file over. What the user
sees today is nothing. Not widened here: the fix is a decision about whether the default fetch should
exist at all (it adds 1500 ms to every CI run that has no dev server), which is bigger than a warning.

---

## Chunk 6 — Defect #6: the browser plane crashes renderers at default parallelism

**Symptom, measured.** 24 cores, 125 GiB RAM, `/dev/shm` 63 G — not the classic container cause. At
playwright's default worker count every full run produced 1–3 hard renderer crashes, on a different
spec each time:

```
Error: locator.fill: Target crashed
Error: page.waitForFunction: Target page, context or browser has been closed
```

`FLAWLESS_WORKERS=4` gave 145 passed / 0 failed, twice in a row. The perf plane showed the same class:
its one failure (`stress-click-rerender x 50`) passes in isolation in 3.6 s.

**Root cause — corrected by measurement.** The plan named one config and named it wrong twice:
`browser/playwright.config.ts` is **not** emitted by `src/scaffold/templates.ts` — that emitter
(`playwrightConfig()`, `workers:` at ~574) writes the suite-root `playwright.config.ts`, whose
`testDir` is `./profile`: it is the **perf/profile plane**. The browser plane's config is
`browserPlaywrightConfig()` in `src/scaffold-tests/templates.ts`. There are **four** emitted
playwright configs, not one:

| emitted file | emitter | plane | `workers` before |
| --- | --- | --- | --- |
| `flawless/playwright.config.ts` | `playwrightConfig()`, `src/scaffold/templates.ts` | perf/profile (`testDir: "./profile"`) | `FLAWLESS_WORKERS ?? (CI ? 1 : undefined)` |
| `flawless/browser/playwright.config.ts` | `browserPlaywrightConfig()`, `src/scaffold-tests/templates.ts` | browser (`testDir: "."`) | same expression |
| `flawless/e2e/playwright.config.ts` | `e2eConfig()`, `src/tasks/e2eRoutes.ts` | route e2e | hardcoded `1` |
| `flawless/e2e/playwright.config.ts` (expo) | `expoE2eConfig()`, `src/tasks/e2eExpo.ts` | native e2e web | hardcoded `1` |

The two unbounded configs share the identical expression — the browser crash and the perf plane's
`stress-click-rerender x 50` failure were two configs with one shared cause. CI already resolved
to 1 in both, so the bound changes local runs only. The e2e plane already pins `workers: 1`.

**Do — as landed (chunk 6, 1 Nov).**

1. Both unbounded configs emit
   `workers = FLAWLESS_WORKERS ?? (CI ? 1 : Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))))`,
   reasoning in the comment that already discussed `FLAWLESS_WORKERS`. The `max(1, …)` guard is an
   addition to the plan's formula: on a 1-CPU box the bare `min(4, cpus/2)` floors to 0. The bound
   resolves to 4 on the 24-core dogfood machine — the value that measured green twice there.
2. `launchOptions: { args: ["--disable-dev-shm-usage"] }` added to both configs' `use` block, with
   the reason in the emitted comment: a small-`/dev/shm` container produces the identical
   `Target crashed` from a different cause; the flag is insurance for that cause, not a second
   fix for the measured one.
3. **Host death: measured, playwright already reports it, nothing changed.** Killed the shared
   host mid-run on the dogfood suite: every subsequent spec fails with
   `page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5173/` (111 failed / 35 passed).
   The error names the refused host URL on every failure — self-diagnosing, unlike the renderer
   crash it is being distinguished from. No readiness probe was added; playwright has no
   mid-run webServer supervision and a per-test liveness fixture would touch every spec template
   to restate what the error already says.
4. Tests: `tests/emittedConfigs.test.ts` loads both emitted configs and asserts the resolved
   value — default = the bound, `FLAWLESS_WORKERS` wins over both the bound and CI, CI resolves
   to 1, `use.launchOptions.args` carries the flag. (Incidental: bun caches `file://` imports by
   pathname and ignores the query, so re-loading one config needs a fresh path.)
5. Flipped the Chunk 0 marker for defect #6.

**Acceptance, measured (1 Nov, dogfood app `mybodycorpai/apps/web`, 156 browser tests + 360
profile tests, same suite bytes and playwright 1.64.1, only the worker count varying — the new
default resolves to 4 on this machine, so `FLAWLESS_WORKERS=4` runs are the new default's runtime
behaviour).** The plan's "N crashes → 0 across 3 runs" is not measurable on the 4-spec fixture
(it cannot crash renderers), and on the dogfood app **today** the motivating crash rate did not
reproduce at either width: browser plane, sequential clean runs — control (½-CPU = 12 workers):
1 crash in 6 runs, wall 31–36 s; bounded (4): 1 crash in 6 runs, wall 48–49 s. The failure mode
(`Target page, context or browser has been closed`, different spec each time) still appears at
both widths on the current machine state (a ~60 GiB model server is resident; the dogfood ran
without it), so the crash-rate win is the dogfood's own numbers, not today's. What today does
show is the perf plane's side of the trade: bounding makes the recorded measurements *tighter* —
per-test p95 9.2–9.5 s → 4.7–5.2 s, max ~20 s → ~8 s, budget warnings 12 → 2 across the pairs —
at a wall-clock cost of ~40 % on the browser plane (33 s → 48 s) and ~60 % on the perf plane
(86 s → 138 s). `stress-click-rerender x 50` passed in every clean run at both widths. A slower
green with tighter numbers beats a faster red; the numbers are in the PR.

**Gotchas.** Do not "fix" this by making every worker boot its own host: the shared host is what makes
the plane fast, and the perf plane's measurements depend on one server.

---

## Chunk 7 — Defect #8: the MCP server does not exit after the call completes

**Symptom, as reported.** Every `flawless_run` over stdio returned a complete JSON result and then
hung until killed. All three generation calls in the dogfood exited 124 (`timeout`) *despite* the
client calling `child.kill()` in `finally`.

**Root cause — the plan's was wrong, and most of the defect was not a defect (chunk 7, 1 Nov).**
The stdio client was built and the four cases measured, and the mechanism the plan blamed does not
exist in the code:

- Children are spawned `stdin: "ignore", stdout: "pipe", stderr: "pipe"` (`src/mcp/run.ts`), so they
  never inherit the transport pipes. A grandchild cannot hold the *client's* stdout open, because it
  never had a handle on it.
- Process-group teardown already existed and was already tested: `LIVE`, `track()`, `killGroup()`
  (`process.kill(-pid, SIGKILL)`), the sticky `killLiveChildren()`, and the watchdog test at
  `tests/mcp.test.ts`. Two of the plan's three fixes were already shipped.
- Measured on the pre-change tree, over 5 runs each, trigger → process exit: stdin closed after a
  cheap call 4/6/9 ms; after a drained `flawless_run` 8/10/31 ms; piped batch 6/6/16 ms; SIGTERM
  after a response 3/5/12 ms; SIGTERM mid-generation 3/7/41 ms with no grandchild alive. Instrumented
  output confirmed the signal path reaches `process.exit(0)` and the EOF path reaches its `return 0`.
  Nothing hung. **The reported >60 s wait is the client keeping stdin open**: an open stdin is an open
  session, the server is correct to stay, and a client that waits for teardown without closing stdin
  or signalling waits forever. That is the documented contract, now written down as one.

Three real holes were found by building the measurement, and each is fixed:

1. **A straggler could wedge a call forever.** `runFlawlessChild` cleared its watchdog at
   `proc.exited` and then awaited the stdout/stderr reads with no bound. A straggler in the child's
   process group that inherited the write ends (a dev server a test runner leaked) held those reads
   open indefinitely: no response frame, a shutdown chain that never settles, and a server that
   ignores SIGTERM. Fixed with a bounded drain — 2 s grace, group kill, 2 s more — returning partial
   output and announcing the cut. Measured on a leaky-child fixture: never returned → 2.03 s.
2. **A signal landing during the EOF drain skipped the kill.** `shutdown()` early-returned when a
   teardown was already in flight, and the piped batch makes that the common case: EOF starts the
   drain before the run child spawns. Measured: the child outlived the server and died only when it
   next wrote into the dead pipe, 152 ms later for a chatty child and its full run for a quiet one.
   The kill now runs before the early return.
3. **The forced drain had no bound of its own.** A signal waited on the call chain, whose only bound
   is the call's watchdog — floor 1 s, ceiling 4 h. The signal and stdin-error paths now race the
   drain against 5 s and exit anyway, naming the abandonment on stderr. The EOF drain stays unbounded
   by design: that is what lets a piped batch finish.

**Do — as landed.** The stdio client became a permanent test (`mcp exit contract` in
`tests/mcp.test.ts`: idle server, piped `flawless_run`, and a mid-generation signal that must kill),
the three holes above were fixed in `run.ts` and `server.ts`, and `docs/mcp.md` now states the exit
contract clients may rely on. The `unref()` idea was not needed: nothing keeps a handle the server
does not read.

**Acceptance, measured.** Time from the last result frame to process exit, 5 runs each (min/median/
max), compiled binary before → compiled binary after (same tree lineage, per AGENTS.md): cheap call
+ stdin close 4/6/9 → 2/4/12 ms; `flawless_run` + stdin close 8/10/31 → 2/6/42 ms; piped batch
6/6/16 → 2/3/5 ms; SIGTERM after response 3/5/12 → 2/2/4 ms; SIGTERM mid-generation 3/7/41 →
5/9/18 ms. The before numbers were already fast — the defect was the client's reading, and the fix
is the contract plus the three holes that could make it true.

**Gotchas.** Do not make the server exit *immediately* on response — MCP is a session, and clients send
further calls. The contract is: exit when stdin closes and the batch has drained, and do not keep
pipes open that nothing reads.

**Candidate defect #15 (recorded by chunk 7, FIXED 2 Nov):** GitHub `releases/latest` was
`v0.3.0` while npm carried `0.3.1` (`@lariocpt/flawless-react` dist-tag `latest` = 0.3.1, verified
1 Nov), and the website's example gate validates against the GitHub artifact — so the site's gate has
been testing an older binary than the one users install. It was a release-process gap, not a tool
defect: the 0.3.1 GitHub release had simply never been published. On 2 Nov the `v0.3.1` tag
(`b12e482`, the 0.3.1 version bump — the same tree npm published from) went live with a release
carrying the four cross-compiled binaries plus `SHA256SUMS`; the published linux-x64 asset passes
the Jenkins smoke gates (`--version` reports 0.3.1, `--flags` survives compilation, an Expo fixture
run emits its jest config and native specs), and `releases/latest` now matches npm.

---

## Chunk 8 — Defect #9: generated `flawless/setup.ts` fails a host repo's lint gate

**Status: FIXED (chunk 8, 2 Nov).** Option 1 (emit it lint-clean) landed, and the lint-the-suite test
is in `tests/dogfood-baseline.test.ts`. What follows replaces the plan text where measurement
disagreed with it.

**Symptom, measured.** The dogfood repo's pre-commit biome hook refused the commit:
`Checked 324 files… Found 5 errors`, all `noExplicitAny` in `flawless/setup.ts`. Until the file was
excluded, a first run could not be committed at all in a linted repo.

**The plan's anchors were wrong in two ways (chunk 8, 2 Nov).**

- The `any`s are emitted by `setupTs()` (`src/scaffold-tests/templates.ts:830`) after all — but not
  in its opening region, which is why grepping that region found none. They sit in two blocks of the
  polyfill body: the jsdom canvas stub (`__canvasProto`, `__make2d`, `ctx` — 3) and the
  `next/router` `withRouter` mock (2). Chunk 0's fixture count of 4 vs the dogfood's 5 was the same
  line counted twice: `(Component: any) => (props: any)` is one line, two occurrences.
- **The generator already invokes the host's own biome — as a formatter.** `src/scaffold/adoptStyle.ts`
  walks up from the project root (biome config → the project's own biome; prettier config → prettier;
  neither → untouched) and runs `biome check --write` on what was written. That is precisely why this
  defect survived: **adoptStyle formats, it does not lint** — `noExplicitAny` is a lint rule, invisible
  to a formatter run whose safe fixes cannot retype a file. The fix therefore had to happen at the
  template, not in the style pass.

**Fix, measured.** The fixture's emitted suite under the fixture's own biome.json
(recommended + `noExplicitAny: error`, biome 2.5.1): **10 errors → 0**. The dogfood's 5 were only
`setup.ts` because the fixture's config is *stricter* than the dogfood's — running the suite-wide
gate surfaced five more lint errors the dogfood never counted:

- `host/main.tsx` × 3 and `host/index.html` × 1 `noAssignInExpressions` (the `x ?? (x = …)` /
  `(t.updates ??= []).push` idioms, and `var p = (g.process = g.process || {})`) — rewritten as
  explicit get-then-set in `src/scaffold/templates.ts`.
- `host/server.ts` × 1 `noImplicitAnyLet` (`let code;` → `let code: string;`).
- `reports/summary.json` a format error: it was the one suite file core wrote that was **not** in
  adoptStyle's `writtenFiles` (emitted two-space, biome defaults to tabs) — it now is, like
  `swagger.json` before it.

No `biome-ignore` comments were needed anywhere: every `any` had an honest type (`Record<string,
unknown>` for the canvas prototype/ctx, which the block index-writes by name;
`import("react").ComponentType<Record<string, unknown>>` for `withRouter`). Option 3 was not reached.

**Candidate defect #16 (recorded by chunk 8, not fixed by any chunk): the emitted suite leaves
7 warnings + 12 infos under the host's recommended ruleset.** None fails a host gate (biome exits 0
on warnings): `noUnusedImports` × 5 (profile specs import the full `_helpers` surface
whether or not the emitted spec uses it; `playwright.config.ts` imports `os` unused),
`noUnusedFunctionParameters` × 1, `noUnusedVariables` × 1 (`catch (e) {}` in `host/index.html`),
`useTemplate` × 11 and `noUselessFragments` × 1. Template hygiene, not committability.

**eslint: a named gap.** adoptStyle detects biome and prettier configs only — an eslint host gets no
style pass at all today, and this chunk's proof covers biome hosts. The emitted suite is *not*
verified against eslint's default ruleset (whose `no-unused-vars` would bite the same profile-spec
imports). Closing the gap (detect an eslint config, run it like biome) is a separate defect.

**Acceptance, measured.** "biome over the generated suite: 10 errors → 0" (fixture, the fixture's
own biome.json, repo-pinned biome 2.5.1), and `setup.ts` `: any` occurrences 5 → 0. The
lint-the-suite test costs ~150 ms (two biome spawns over 37 files, ~110 ms wall) on top of the
baseline harness's existing generation.

---

## Chunk 9 — Defect #7: RSC page specs render an empty container (diagnose first, then fix)

**Status: fixed.** 5 files, 29 tests in the dogfood repo — the five async-RSC detail pages. Everything
below was measured with a probe, not inferred.

**What is known.**

- The awaited page returns a **valid** element: `$$typeof Symbol(react.transitional.element)`,
  `type: "div"`, props `className, children`, children `div | div | Card | Card`.
- `render(<AppProvider>{ui}</AppProvider>)` and `render(<>{ui}</>)` both leave
  `container.outerHTML === "<div></div>"`.
- React logs no error. The only output is:
  - `Each child in a list should have a unique "key" prop. Check the top-level render call using <div>.`
  - `A suspended resource finished loading inside a test, but the event was not wrapped in act(...).`
- A control `<p>` in the same wrapper renders fine in the same file, so the harness works.
- Repointing the vitest React aliases at the app's own copy (root react 19.1.0 vs app 19.2.4) made it
  far worse — 360 failures instead of 36 — so the tool's alias choice is the coherent one. **Do not
  retry that theory.**

**The two lines above are the answer, and they point at one mechanism.** `resolveAsyncUi` (emitted by
`src/scaffold-tests/templates.ts`) resolves async *components* by invoking them, and rebuilds children
as a **flat array** via `cloneElement(el, {}, resolved)`. Two consequences:

1. static JSX children become an array → React demands keys → the key warning is a **tool artifact**,
   not an app bug;
2. a promise-valued prop/child is never awaited, so under `createRoot` the tree suspends; with no
   `Suspense` boundary and no `act()` flush, React commits nothing — which is exactly an empty
   container with no error, and exactly the "suspended resource finished loading" line.

**Do.**

1. Confirm the mechanism on the fixture before changing templates: render the fixture's async RSC page
   with the current template, capture `console.error`/`console.warn` **before** the render call (the
   dogfood probe installed the capture too late and missed the signal once), and show the suspended
   resource line plus the empty container in the same run.
2. Fix `resolveAsyncUi` to resolve **promise-valued props and children**, not just async components:
   walk `el.props`, awaiting any thenable, and keep element identity when nothing changed (the current
   code already tries to avoid needless `cloneElement`).
3. Stop flattening static JSX children into a keyed-less array: preserve the original children (single
   child stays a single child; arrays keep their existing keys). If a key must be synthesised for a
   synthesised array, do it deliberately and say why.
4. Wrap the render in a `Suspense` boundary with a fallback the spec can wait on, and await settle
   inside `act()` so a late-resolving resource cannot land outside the flush.
5. If, after 1–4, a page still cannot render in jsdom (e.g. it legitimately needs Next's own
   client-component boundary), the spec must **skip with a reason** naming what is missing — never a
   silent `catch { return; }`, which is how a red suite pretends to be green.
6. Tests: fixture RSC page with (a) an awaited promise child, (b) a promise-valued prop, (c) a nested
   async component — each generates a spec that passes and asserts real content; plus a guard test that
   no emitted spec contains a bare `catch { return; }` around a render.
7. Flip the Chunk 0 marker for defect #7.

**Acceptance.** Quote: "RSC page specs: 29 failing → 0 failing, N assertions now asserting content
instead of returning silently", and the key warning gone (it is the tell that children were flattened).

**Gotchas.** The template's own comment says an exit here is a tool gap and must stay red. Keep that
philosophy: a skip must name the missing capability, and the count of skips must appear in `REPORT.md`.

**Result (chunk 9, 2 Nov).** Reproduced on the fixture, then fixed; the plan text needed three
corrections, all measured. The fixture grew three shapes (`promise-child`, `promise-prop`, `nested`
pages + `ReportTitle`/`Outer`/`Inner` components, `loadHeading()` in `data.ts` — a macrotask-delayed
promise so a late resolution can land outside `act`). All three land on the **createRoot** path:
`extractRenderMode` routes to the streaming renderer only when the component returns `<html>`
(document-root); every other async component is `rsc` → `render()`. Chunk 4's note stands: the
fixture's layout streams, its pages never did.

Measured on the installed unit plane (vitest 2.1.9, react-dom 19.1.0, jsdom; receipts in
`tests/fixtures/README.md`): **before** — 2 failed / 14 passed / 1 skipped, the promise-prop page
committing the empty container (`<div />`) with both act lines and the key warning on the pages with
≥2 children; **after** — 0 failed / 16 passed / 1 skipped, zero stderr. Dogfood quote (§7): "5 files,
29 tests" — the five async-RSC detail pages failing every content assertion with exactly the two log
lines this fixture now reproduces; the dogfood number is quoted, not re-measured here.

Corrections to the plan text:

1. **"promise-valued props/children are never awaited" — only the PROPS half is true.** A promise
   CHILD was awaited by accident: the recursion `return node`s a thenable and `await` unwraps it, so
   shape (a) rendered content before the fix too (carrying the key warning). The empty container
   reproduced only on a promise-valued PROP — the shape the resolver ignored entirely. The fix makes
   the child await explicit (`isThenable`) and walks every prop.
2. **"keep element identity when nothing changed" survives, but identity alone cannot kill the key
   warning.** React's jsx runtime marks static children through a dev-only internal
   (`_store.validated`); no public API reproduces that mark, and `cloneElement` validates only its
   varargs. So a *changed* children array synthesises positional keys deliberately
   (`flawless-async-<i>`, keyed entries that arrived keyed keep theirs), with the why in the emitted
   comment and a reasoned `biome-ignore` for `noArrayIndexKey`. Unchanged arrays return identity and
   clone nothing — the warning is gone on both paths (measured: zero key warnings after).
3. **Step 5's jsdom-capability skip was not needed** — all three shapes render in jsdom after 1–4.
   The skip contract landed anyway, at the place that actually swallows: the static-content template's
   `catch { return; }` became a named guard-path skip (`console.warn` + `ctx.skip()`), a guard test
   reddens any emitted spec with a bare `catch { return; }` around a resolve/render, and REPORT.md
   gained a "Named skips" section counting every `test.skip` generation emitted (chunk 3's three
   questions are answered in the PR body).

---

## Suggested order and effort

| chunk | defect | size | blocks |
| --- | --- | --- | --- |
| 0 | baseline harness | S | everything after |
| 1 | #1 harness tsconfig paths | S | browser/perf planes in aliased repos |
| 2 | #2 app tsconfig exclude | M | the host project's own build |
| 3 | #3 `server.browser` import | XS | document-root specs |
| 4 | #4 sync mock shapes | M | ~50 specs' honesty |
| 5 | #5 catch-all + stale handlers | M | API-backed specs, load pipes |
| 6 | #6 bound browser workers | XS | suite stability |
| 7 | #8 MCP process exit | S | any automation over stdio |
| 8 | #9 setup.ts lint | XS | committing a first run |
| 9 | #7 RSC empty render | L (diagnose) | 29 specs |

Chunks 1, 3, 6, 8 are each under an hour and unblock real planes; do them early. Chunk 9 is the only one
that might end in "documented limitation" rather than a fix — that is an acceptable outcome provided the
spec skips with a named reason and the report counts it.

---

## Candidate triage (2 Nov, re-measured against `main` @ 838c142)

Every open candidate from the chunks above was re-measured against the current tree — measurement
beats plan text, so where the recorded text is wrong it is corrected below, not silently kept.
Verdicts: **reproduces** (real today), **fixed** (green today, receipt given), **closed** (not a
defect / already resolved). The eslint gap gets a number: **#17**.

| candidate | verdict | proving command (cold) |
| --- | --- | --- |
| #10 vitest 4/5 + vite 8 JSX | **fixed** (re-measured; combo and mechanism corrected) | `bun test tests/vitest5AppExecution.test.ts` |
| #11 `.gitignore` write | closed — intended, already recorded above | `grep -n "ignoreEntries" src/nextjs/detect.ts` |
| #12 colocated specs dead from the suite dir | reproduces — **fixed this session** | `bun test tests/suiteDirExecution.test.ts` (red without the fix, green with) |
| #13 mock factory incomplete for non-analysed importers | reproduces exactly as recorded — **fixed; verified on the verification host (3 Nov)** | `bun test tests/mockFactoryExtension.test.ts` + the baseline's defect-13 test — all five gates green; receipts in the #13 section |
| #14 silent live-spec fetch | recorded text stands (not re-measured this session) | see chunk 5's write-up |
| #15 GitHub release lagged npm | fixed 2 Nov, already recorded above | `gh release view v0.3.1` |
| #16 emitted suite leaves lint residue | reproduces — and **grew**: 33 warnings + 13 infos | recipe below |
| #17 eslint hosts get no style pass | confirmed gap | `grep -in eslint src/scaffold/adoptStyle.ts` → no matches |

### #10 — fixed; the recorded combo and the recorded mechanism were both wrong

**Combo correction (again).** The plan says "vitest 5 + vite 7"; the 2 Nov re-measurement
corrected the vite to 8 but named vitest 5.0.5. Re-measured against current `main`: vitest
**5.1.0** peers vite `^6.4.0 || ^7.0.0 || ^8.0.0`, and a fresh install lands vite **8.3.5** —
and vitest **4.1.12** spans the same vite 8 (`^6.0.0 || ^7.0.0 || ^8.0.0`), so the wall is not a
vitest 5 curiosity; any host on vitest 4 or 5 with `jsx: "preserve"` hits it.

**Mechanism correction.** The 2 Nov text said "oxc ignores the emitted `esbuild.jsx` override".
Measured in the dists, it is a two-step discard: vitest 4/5 *always* inject an `oxc` default
into the user's vite config (5.1.0: `oxc: { target: "node22" }` unless `oxc: false`;
4.1.12: `oxc: { target: "node18" }` on the rolldown-vite build), and vite 8's `resolveConfig`
then discards an `esbuild` key that sits beside `oxc` — the "Both esbuild and oxc options were
set" warning — after which the jsx option has no explicit value and follows the host tsconfig.
Under `"jsx": "preserve"` (Next's own default) that leaves raw JSX, which dies when vite's ssr
transform re-parses its own transform output: `RolldownError: Parse failure: Unexpected JSX
expression` — every spec, on both entry points. (vite 7.3.7, for contrast, ships no oxc
machinery at all: no both-set warning, no `convertEsbuildConfigToOxcConfig`, no `vite:oxc`
plugin — an `oxc` key is inert there and esbuild is the transformer, which is why the old
single-mechanism emission was correct for every generation it ever shipped into.)

**The fix — family-gated emission.** The emitted config declares ONE jsx mechanism, chosen from
the vitest the suite will *actually* run, not from the manifest pin: `esbuild: { jsx:
"automatic" }` while the suite's vite is <= 7 (byte-identical to what older versions emitted —
the frozen vitest 2 path is untouched) and `oxc: { jsx: { runtime: "automatic" } }` from vite 8
up. The family comes from the installed store (the vitest that resolves and the vite that
lands), then the suite manifest's own vitest pin — EXCEPT while that pin is byte-identical to
the tool's own generated default, which is this tool's output, not a declaration — then the
host's declared vitest (a range answering at its top: `>=2 <6` installs 5, so the config is
written for vite 8), then the generated default. An explicit jsx beats the tsconfig on both
transformers, so the preserve host is covered on every generation; oxc natively honours the
tsconfig's `jsxImportSource` (probed with a throwing fake runtime — it emitted the import
unprompted), so no forwarding is emitted. The "three overlapping mechanisms" in the 2 Nov text
narrows to TWO jsx keys: the jsx-runtime resolve alias survives vite 8 untouched (probed), and
the generated specs never import React, so the automatic runtime is always the one in the react
the manifest pins. The alternative of emitting both keys was rejected by measurement: under the
vitest 2 / vite 5 types an `oxc` key in the config is a hard TS2769, so a dual-key config
type-checks red on today's green vitest 2 hosts.

**Receipt.** `tests/fixtures/vitest5-app/` — host tsconfig `jsx: "preserve"`, own package.json
declaring `vitest: "^5.0.0"` (a fresh install lands vitest 5.1.x + vite 8.3.x), two small
components, its own biome config — and `tests/vitest5AppExecution.test.ts`, which installs the
fixture's stack *before* running the tool (the `bun.lockb` that install drops is the boundary
the store walk stops at), asserts the installed majors, runs the tool, and pins the emitted
config: oxc present, the esbuild spelling absent, the one comment that is the whole
explanation — while the fresh suite manifest still carries the generated `^2.1.0` default the
emission must not have followed. It then runs the colocated specs green from the suite's own
`test:unit` with cwd inside the suite dir (bun resolves the app store's vitest 5 — the
manifest's pin is never installed) and from the app root with `--config`; both runs report
2 passed with no `Parse failure` and no both-set warning. Emission-side coverage is in
`tests/vitestJsxEmission.test.ts` (the range grammar, the four legs, the mechanism switch, the
one-comment layout, and the host-shape × vite-generation guard matrix). The vitest 2 path is
unchanged: every existing execution test stays green on the esbuild spelling.

**Acceptance (met).** A fixture on vitest 5 (vite 8) with host `jsx: "preserve"` runs its
colocated specs green from the app root — and from the suite's own `test:unit` too, which the
original acceptance did not ask for; the vitest 2 path is unchanged; the emitted config carries
one comment explaining which mechanism serves which vite generation.

### #12 — reproduces; fixed this session; two corrections to the recorded text

**Layout correction:** the plan blames "the standalone layout". Measured, it is the **colocated**
layout that is exposed: standalone specs live *under* the suite dir, which fs.allow already
covers, so standalone is immune. Colocated specs live in the app and import across the suite
boundary, and the suite dir always carries its own `package.json`.

**Mechanism correction:** vite's allow-list does not "root at the cwd" in general. vitest 2.1.9's
`resolveFsAllow` returns `[dirname(rootConfigFile), searchForWorkspaceRoot(cwd), rootDir]` — with
cwd inside the suite dir, `searchForWorkspaceRoot` stops at the suite `package.json` and
`dirname(config)` is the suite dir, so every app file above is refused with the phantom
`Failed to load url … Does the file exist?`. The config's `root: projectRoot` does **not** widen
fs.allow; an explicit `server.fs.allow` merges in and does. The fix is the plan's one line —
`server: { fs: { allow: [projectRoot] } }` — but only in the **colocate branch** of the emitted
`vitest.config.mts` (standalone needs nothing).

**Receipt (measured):** aliased-next-app fixture, colocate gen, vitest 2.1.9: `cd flawless &&
../node_modules/.bin/vitest run` went **10 failed → 16 passed / 1 skipped**; the app-root run
(`--config flawless/vitest.config.mts`) stayed green before and after. The user-visible entry
point is the emitted `flawless/package.json`'s own `test:unit: "vitest run"` script, which runs
from exactly that cwd. Pinned by `tests/suiteDirExecution.test.ts`, verified to go red when the
templates fix is stashed.

### #13 — reproduces exactly as recorded; **fixed — verified on the verification host**

The hazard is real, not the plan's earlier "did not reproduce as dropped export" hedge.
**Before (the 2 Nov triage's measured receipt):** fixture (page spec, mocked
`@/lib/data`): **2 failed** with `Error: [vitest] No "signOff" export is defined on the
"@/lib/data" mock` — the mock factory covered only evidenced importers, and the render graph
reached the mocked module through a NON-analysed util (`src/lib/labels.ts` via `InboxList` →
`signatureLine()` imports `signOff`). Recipe: any page whose component graph imports a mocked
module through a file the analysis never opened.

**Seam — the analysis side, not the mocks side.** The recorded text above placed the fix in
`src/scaffold-tests/mocks.ts` (the `graphOnly`/`mergedNames` machinery as the seam); that
candidate lost: `emitModuleMocks` has no resolver or `SourceFileCache` in scope, so it cannot
read a non-analysed target's import lines at all — it only ever sees the MIs the analysis
hands it. The extension therefore lives in `analyse/index.ts`, where the resolver, the shared
cache and the `walkTree`/`mergeImport` merge machinery are all in scope: it reads each
non-analysed target's import lines through the shared `SourceFileCache` (the only new I/O — no
new parsing machinery, no new dependencies; `collectModuleImports` was already exported from
`parseFile.ts`) and folds them into the per-module view as a synthetic whose runtime names all
land as `mergedNames` with `graphExtension: true` and no purity of its own. One hop only. The
mocks side then ships two small relaxations that make those names covered without voting:
`mergeInto` exempts a `graphOnly` binding from the pure/data exemption, and `reachesDataPath`
admits a `graphExtension` statement. Rule as shipped: every export of a mocked module
reachable through the render graph exists in the factory even when no analysed call site
evidences it — a name with no call site earns the graph-only stub (`vi.fn(() => ({}))`) and a
`TODO(flawless)` guess line, never a real fixture, and never a reason to mock a module that
stays exempt.

**After — verified on the verification host (bigcachy, 3 Nov).** Per operator request nothing
was executed on the authoring machine, so the branch as authored was never witnessed anywhere;
the host first made the three commits the gates surfaced, then measured all five below, in this
order, all before the push:

1. `rm -rf node_modules/.cache/biome && bun run check` — **0 errors, 2 warnings**, both
   pre-existing on `2f52c9c` (`noTemplateCurlyInString` at
   `tests/dogfood-baseline.test.ts:282` and `tests/report.test.ts:597`). The authored tree
   still carried two formatter diffs (its moved merge and its new test file); the host applied
   them as `57754c3`, after which the cold check measured the 0/2 above.
2. `bunx tsc --noEmit` — the authored branch reported exactly **2 errors**, both in this
   chunk's new code; clean after `b6cfe7a`. The first was a tsc 5.9.3 contextual-typing edge:
   the synthetic's spread condition `up.importedNames?.length > 0` errors TS18048 inside the
   object literal — the compiler re-checks the condition against the literal's contextual type
   and drops the `?.` guard's narrowing there — while the same expression type-checks fine as a
   plain statement (bisected in a scratch file). The fix hoists the read into a const local
   before the literal; behaviour is identical (an empty array fails both tests), and the
   adjacent `typeOnlyNames` spread needed no change. The second was `lines[i]` being
   `string | undefined` under `noUncheckedIndexedAccess` (`?? ""` — the empty string never
   matches `/^import/`).
3. `bun test` ×2 — the host's **first two runs measured 1728/11/1**: the fixture execution
   test failed because it installed only BEFORE `runCore`, while the tool's standing
   invocation writes `msw`/`@playwright/test`/`react-scan` into the app's package.json
   (`src/core.ts`), so the emitted suite's setup file import of `./mocks/node` (which imports
   `msw/node`) died at collect — `Failed to resolve import "msw/node" from
   "flawless/mocks/node.ts"` — and every spec in the plane failed before any test ran, while
   the emitted spec's text assertions (the `signOff` factory line) already passed. `19cb3b0`
   adds the post-regen `bun install` — the real user flow, which the guard test already ran,
   and which is why the guard stayed green. After it: **1729 pass / 11 skip / 0 fail twice**
   (1740 tests / 115 files) = the 1726 pre-fix receipt + exactly the 3 new tests; the 11 skips
   are unchanged.
4. `bun test tests/mockFactoryExtension.test.ts` — **2 pass / 0 fail** (6.39 s). The
   fixture's regenerated page spec carries `signOff: vi.fn(() => ({}))` plus the
   `TODO(flawless)` guess line in the `@/lib/data` factory, leaves `@/lib/labels` unmocked,
   and its probe's `.sig` span renders exactly `[object Object] Inbox` through the real labels
   lib (1 passed); the page spec — the 2 Nov triage's **2 failed** — **2 passed**; the full
   unit plane **17 passed + 1 named skip** (the store-provider interaction guard), 0 failed.
   The guard app pins the never-forcing property: pure `./utils` unmocked while async
   `./data` is mocked, and the probe's "themed card" text is producible only by the real `cn`
   join. (Both tests need registry access for the bun installs.)
5. Same-binary-lineage before/after per AGENTS.md — both binaries built the same way
   (`bun build --compile --minify --outfile … src/bin.ts`, 141 modules each), both runs
   against the chunk's fixture standing shape: the control (`2f52c9c`) regenerated the page
   spec whose factory still lacks `signOff` — the page spec **2 failed** with exactly `Error:
   [vitest] No "signOff" export is defined on the "@/lib/data" mock`, the 2 Nov triage's
   receipt reproduced byte-for-byte, and the full plane 2 failed | 14 passed | 1 skipped (10
   files, 1 failed). The treatment (branch tip) ran the same flow green: page spec **2
   passed**, full plane **16 passed | 1 skipped, 0 failed** (17 tests — the binary flow
   writes no probe spec, the probe is test-written, not tool-emitted — vs the in-process
   test's 18), with the factory receipts confirmed in the emitted text (`signOff` stub
   present, `vi.mock("@/lib/labels"` absent, TODO guess line present).

**Acceptance (as recorded, unchanged):** a fixture with a mocked module reached only through a
non-analysed util runs green; the emitted factory contains the reached export; existing mock
tests stay green. The standing shape now lives in `tests/fixtures/aliased-next-app/` (the
type-first `InboxList` + `labels.ts` + `signOff`); it is pinned by
`tests/dogfood-baseline.test.ts` (the text twin) and `tests/mockFactoryExtension.test.ts`
(the execution twin + the never-forcing guard).

### #16 — reproduces, and the residue grew

The recorded **0 errors / 33 warnings / 13 infos** (`e827f19`) is stale on
two axes at once: the tree moved (#17 landed 24 of those warnings away) and
the receipt was not measured with the recipe's own repo-pinned biome.

**Baseline correction — the 33/13 receipt reproduces on no version.** A
version sweep over the identical `838c142` tree + fixture copy (the recipe:
`check . --formatter-enabled=false --reporter=json` from the copy root,
full tree):

| biome | full tree (`838c142` output) |
|---|---|
| 1.9.4 | 68 err / 7 warn / 0 info |
| 2.0.3 | 3 err / 33 warn / 15 info |
| 2.3.13 | 3 err / 36 warn / 17 info |
| **2.5.1 (repo pin)** | **2 err / 36 warn / 17 info** |
| 2.5.14 (bigcachy's PATH biome) | 2 err / 36 warn / 18 info |

The closest is 2.0.3 (same 33-warning total) but its composition differs
in three ways at once (a `deserialize` warn where the receipt has
`noUnusedVariables`; 3 errors where the receipt has 0; `useTemplate` ×15
with no `noUselessFragments`). The receipt's four-rule warning core does
match the 2.5.1 run exactly (`noUnusedImports` 18 +
`noUnusedFunctionParameters` 7 + `suppressions/unused` 7 +
`noUnusedVariables` 1 = 33), but the exact old version is unrecoverable —
the plan's own "host biome gate" wording concedes it was a PATH biome.
The recipe says repo-pinned biome, so **the 2.5.1 numbers are
authoritative**: on `edd0b62` (post-#17) the fresh full-task colocate regen
measures **0 err / 12 warn / 16 info** on the tool-written output,
**2 err / 12 warn / 18 info** full tree. Decomposition: `838c142` = 2/36/17;
`376023e` = 2/36/18 (+1 info is `labels.ts`, a #13 fixture file);
`edd0b62` = 2/12/18 (#17 removed 24 warnings: imports 18→0, params 7→1).

**`--write` premise correction.** The plan claimed "none of these are
fixable by `adoptStyle`'s `--write` (every fix biome offers is
unsafe-for-default)". Measured on the regenerated tree: the repo-pinned
**2.5.1 `--write` fixes exactly 3 of the 12** (the `useArrowFunction`
class; 12→9), and **2.5.14 fixes none** (12→12 — the arrow fix was
reclassified between 2.5.1 and 2.5.14). The safe-fix set is
version-dependent across 2.5.x, and a host with no resolvable biome gets
no pass at all, so the acceptance (a plain `check`) cannot depend on
`--write` at any version; the templates must emit clean.

**Import-canonicalization correction (third plan correction).** Every
prompt baseline above was measured on bigcachy, whose PATH biome 2.5.14
ran the style pass and silently organized the emitted imports. On a host
with no PATH biome (l-dev-ai, cachyos-mini-mobile) the same regen measured
**26 err / 3 warn / 18 info** full tree — 24 `organizeImports` errors +
3 `useImportType` warnings on tool-written files. The emitter's import
layout was never canonical on its own. Fixed in `src/importCanon.ts`:
biome 2.5.1's `organizeImports` algorithm ported from its Rust sources
(chunk runs, statement/specifier sort keys, inverted CLDR collation
tables, path proximity, natural digits) plus the `useImportType`
isolated-mode fix for the `vi` binding, applied at the four write sites
before stamping so the stamp hash covers the final bytes. No-style arm,
full tree, before → after: **26/3/18 → 2/0/18**.

**Measured — branch `fix/dogfood-031-chunk-16-biome-host` (C1 `2b824f8`,
C2 `fd11ec1`, C3 `9c22c5b`, C4 `e9a6539` + `5d5e070`) over `main` at
`edd0b62`**, both arms the same fixture (`tests/fixtures/aliased-next-app`)
fresh-copied and the same standing invocation (all seven tasks,
colocated), both binaries built `bun build --compile --minify … src/bin.ts`
and run on bigcachy (PATH biome 2.5.14 present, style pass ran — 63 files
"formatted" both arms):

1. **Before (control, `edd0b62`):** tool-written output **0 err / 12 warn /
   16 info**, full tree **2/12/18**. The 12: 7 `suppressions/unused` (the
   dead `noArrayIndexKey` suppression in every RSC spec) + 3
   `useArrowFunction` + 1 `noUnusedVariables` (both `flawless/host/index.html`)
   + 1 `noUnusedFunctionParameters` (`host/server.ts` next/font callback).
2. **After (treatment, branch tip):** tool-written output **0 err / 0 warn /
   16 info**, full tree **2/0/18**. `suppressions/unused` 0,
   `noUnusedImports` 0, no info delta vs the control. The 16 surviving
   infos: `useTemplate` ×15 (3 browser specs, `host/main.tsx` ×3,
   `host/server.ts` ×5, `setup.ts` ×3, `vitest.config.mts` ×1) +
   `noUselessFragments` ×1 (`provider.tsx`); the full tree's 18 add the
   fixture's own two (`useTemplate` in `labels.ts`, `deserialize` on its
   `biome.json`). The 2 errors are the fixture's own pre-existing
   `organizeImports` (`InboxList.tsx`, `store-provider.tsx`) — out of
   scope, the repo's biome excludes `tests/fixtures`.
3. Pins: `tests/biomeHost.test.ts` holds the closed state with the control
   recorded in its header — PATH biome neutralized during `runCore` so the
   style pass cannot mask emitter layout, repo-pinned 2.5.1 check from the
   copy root, 0 warnings tree-wide, errors confined to the two pinned
   fixture files, required-site non-vacuity list. `tests/importCanon.test.ts`
   pins 26 cases (Rust test pairs, binary-probe shapes, idempotency).
   Gates on the committed tree: cold check **0 errors + the 2 pre-existing
   warnings**, `tsc --noEmit` clean, `bun test` **1767 pass / 11 skip /
   0 fail** (1778 tests / 118 files = the 1748 baseline + 30 new) twice.

**Acceptance (as recorded, unchanged):** fresh full-task colocate generation
+ `biome check` over the suite reports **0 warnings** (any surviving info
named and justified in the PR body); `suppressions/unused` specifically 0.
Met: 0 warnings tree-wide, `suppressions/unused` 0, zero errors on any
tool-written file; the surviving infos are named above and in the PR.

### #17 — the eslint gap, numbered

`src/scaffold/adoptStyle.ts` detects only `biome.json`/`biome.jsonc` and prettier configs; an
eslint host gets `formatter: "none"` — no style pass at all — and the emitted suite has never been
verified against eslint's default ruleset (whose `no-unused-vars` bites the same profile-spec
imports #16 lists). **Chunk it** after #16, whose template hygiene half of the work is shared.
**Acceptance:** a fixture carrying `eslint.config.js` gets a detected style pass; the emitted
suite passes the host's eslint with 0 errors (warnings named), or the PR states precisely which
rule the suite cannot satisfy and why.

**Measured — branch `fix/dogfood-031-chunk-17-eslint` (C1 `5329893`, C2 `911ee38`, C3
`71e19cf`) over `main` at `376023e`**, both arms the same fixture
(`tests/fixtures/eslint-next-app`) fresh-copied and the same standing invocation (all seven
tasks, colocated), both binaries built `bun build --compile --minify … src/bin.ts` (141
modules each):

1. **Before (control, `376023e`):** no `style:` line in the tool log — the eslint host got
   `formatter: "none"`, no style pass at all. The host's own `eslint src flawless --format
   json` over the tool-written tree exits **1** over **40 of the 60** files on disk (the
   JS-family filter; the 20 non-JS files match no config entry) with **32 errors / 0
   warnings**: **10 `no-useless-escape`** (`flawless/host/server.ts` ×8 — the stub
   `onResolve` filters, `vitest.config.mts` ×2 — the pnpm-alias raw patterns `[^\/]`) +
   **22 `@typescript-eslint/no-unused-vars`** (10 files — `flawless/playwright.config.ts`
   ×1, the 3 profile specs ×3 each, the 4 colocated specs ×2–4). None of the 32 is
   auto-fixable (`--fix` is a measured no-op) — every one is a template defect.
2. **After (treatment, `71e19cf`):** the tool log carries
   `style: formatted 32 generated file(s) with the project's eslint`, and the host's own
   eslint over the regenerated tree exits **0** over the same **40 files** with **0 errors /
   0 warnings** (`byRule {}`). The fixture's devDeps resolve the floating pins to eslint
   9.39.5 / @eslint/js 9.39.5 / typescript-eslint 8.72.1 / typescript 5.9.3 — the test's
   0-warnings assertion is the tripwire if they drift.
3. Pins: `tests/eslintHost.test.ts` now holds the closed state (exit 0, no errors, no
   warnings, the 40-file required set unchanged) with the control's 32/0/exit 1 recorded in
   its header; `tests/depReturnsExecution.test.ts` (the OpaquePanel uncertain-dep RSC
   control) is the execution-side witness for the `t`-parameter deviation below. Gates on
   the committed tree: `bun test` **1737 pass / 11 skip / 0 fail** (1748 tests / 116 files
   = the 1729 baseline + 7 C1 tests + 1 C2 test), cold check **0 errors + the 2
   pre-existing warnings**, `tsc --noEmit` clean.

**Template lines #16 inherits** (its baseline must be re-measured on this tree, since these
edits move exactly the hygiene its 33-warning receipt counts — the five are
conditional-emission, the same pattern #16 needs against biome's `noUnusedImports`):
(a) `vitestConfig` raw patterns via `regexLiteralSlashes` (in-class `\/` → `/`); (b) the
`unitSpec` import prune (`describe`/`screen`/`waitFor`/`userEvent`, with `screen`'s
`void screen` keep-alive shape — a deviation from the plan's `screen.`-only); (c) the
`rscSpec` prune (`describe`/`vi`) plus the **conditional `t` parameter** — a second
deviation, the plan's blanket removal was a `ReferenceError` on every uncertain-dep RSC
spec because `uncertainEscape()` emits `t.skip()`; (d) the profile spec's `_helpers`/`_heap`
imports built from the skip state (`repeatClick` de-imported, `takeHeapSnapshot` kept alive
by the foot `void`); (e) the deleted unused `node:path` import in `playwrightConfig`.

### #14 — deferred with a named trigger

Not re-measured this session; the chunk 5 write-up stands (default live-spec fetch fails silently
when no dev server is listening). Deferred because the fix is a product decision — whether the
default fetch should exist at all, since it adds 1500 ms to every CI run without a dev server —
not a bug patch. **Trigger:** the next user report of a quiet AST-walk fallback, or any decision
to keep/remove the default fetch, opens the chunk.

### #18 — `mergeImport`'s isTypeOnly inheritance can drop a merged value name (latent)

Where a same-module merge has no unit-own base and its first statement is type-only,
`mergeImport` inherits the base's `isTypeOnly` into the merged view even though a later
statement added value names — that is exactly what keeps `@/lib/labels` real in the fixture,
and it is intended (a value-first order would mock labels and hide the hazard). On a DATA
module the same inheritance is the hazard: the group pre-pass skips type-only views via
`reachesDataPath`, so value names arriving only through the merged extra never enter the
factory's group — and when another value-import path mocks the module, the missing name
then fails exactly as #13 did. No current fixture orders a mocked data module type-first
(the fixture's data module is value-first at the unit, so the merge base is a value and the
view stays a value), which is why this is latent. Recorded from the #13 fix; no chunk
committed.

### #19 — non-analysed chains past one hop, and `export *` barrels

The shipped extension reads exactly one hop — the non-analysed target's own import lines.
Deeper chains (non-analysed A importing non-analysed B, which reaches the mocked module) are
outside the coverage: the names B binds from the mocked module are invisible at A's hop, and
an `export *` barrel between the graph and the mocked module is equally invisible, because a
barrel's own import lines do not show the names it re-exports. Both are deliberate scope
bounds of the one-hop fix; if either bites, the failure reads exactly as #13 did. A separate
chunk when that happens.

### #20 — client-mode mock inputs ignore the tree (unverified residual)

The client-mode `mockInputs` is the unit's own MIs only — `treeImports`, and with it the
extension's synthetic, never reach the client-mode view. Read from the template, the client
loop mocks allowlisted packages only (everything else `continue`s before the data path), so
the #13 phantom class — a real local importer running against a mocked local data module —
has no client-mode surface today. If that reading is wrong, or client mode ever grows
data-path mocking, the unit-only inputs will miss the tree evidence. Verify the template
before asserting either way; recorded, not chunked.

### Ordered chunk list (by user-visible cost)

1. **#10** — vitest 4/5 users hit a silent total-red wall. **Fixed** (family-gated jsx
   emission; `tests/fixtures/vitest5-app/`).
2. **#13** — phantom mock failures on reachable-but-unevidenced exports; erodes trust in green
   runs. **Fixed** (analysis-side one-hop graph extension; `tests/mockFactoryExtension.test.ts`
   — verification deferred, receipts above).
3. **#17** — eslint hosts get no style pass; whole class of hosts unverified.
4. **#16** — lint residue on every generation; noisy but non-blocking.
5. **#14** — silent fallback; deferred, trigger above.

Two loose ends recorded for the record, neither owned here: #11 and #15 stay closed as written
above (no chunk should reopen them), and the 183 → 119 colocated-web-specs question is owned by
`VERDICT-SHAPE-EXPLORATION-PROMPT.md`, not by this plan.
