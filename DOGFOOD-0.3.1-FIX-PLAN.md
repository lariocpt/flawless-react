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

**Candidate defect #10 (recorded here, not fixed by any chunk):** vitest 5 + vite 7 ignores the
emitted `esbuild.jsx` override and dies collecting every spec under a host `"jsx": "preserve"`
("make sure to not set jsx to preserve"). This is not a fixture quirk — any real user on vitest 5
hits the same wall. It needs its own chunk; see `tests/fixtures/README.md`.

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

**Candidate defect #15 (recorded by chunk 7, not fixed by any chunk):** GitHub `releases/latest` is
`v0.3.0` while npm carries `0.3.1` (`@lariocpt/flawless-react` dist-tag `latest` = 0.3.1, verified
1 Nov), and the website's example gate validates against the GitHub artifact — so the site's gate has
been testing an older binary than the one users install. This is a release-process gap, not a tool
defect: the 0.3.1 GitHub release was never published.

---

## Chunk 8 — Defect #9: generated `flawless/setup.ts` fails a host repo's lint gate

**Symptom, measured.** The dogfood repo's pre-commit biome hook refused the commit:
`Checked 324 files… Found 5 errors`, all `noExplicitAny` in `flawless/setup.ts`. Until the file was
excluded, a first run could not be committed at all in a linted repo.

**Do.** Pick one, in this order of preference:

1. **Emit it lint-clean.** Replace the 5 `any`s with `unknown` + narrowing or `Record<string, unknown>`.
   This is the right fix if it fits; the file is small.
2. If a type is genuinely unavoidable, emit a scoped disable with a reason
   (`// biome-ignore lint/suspicious/noExplicitAny: <why>`), which most configs honour.
3. Only if neither works, have the generator add the host's ignore entry (biome `files.includes`
   `!`, eslint ignore) and **report it** the way Chunk 2 reports the tsconfig edit.

Whichever is chosen, add a test that runs the repo's own linter over the emitted suite in the fixture
and fails on any error — the point is that a generated suite must be committable in a linted repo.

**Acceptance.** Quote: "biome over the generated suite: 5 errors → 0" (or the eslint equivalent), and
the new lint-the-suite test in the suite.

**Gotchas.** Do not silence the host's linter wholesale for `flawless/**` — that hides real findings in
specs the user will hand-edit. Scope to the file, or better, fix the types.

---

## Chunk 9 — Defect #7: RSC page specs render an empty container (diagnose first, then fix)

**Status: open.** 5 files, 29 tests in the dogfood repo — the five async-RSC detail pages. Everything
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
