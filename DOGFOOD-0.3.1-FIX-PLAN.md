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

**Do.**

1. In `src/scaffold/openapi.ts` (and the Next route scanner that feeds it), detect catch-all segments
   (`[[...x]]`, `[...x]` under `app/api`) and emit a warning naming the file and the count:
   `1 path derived from a catch-all router; if you export an OpenAPI spec, pass --api <path>`.
   If the target also has an `openapi.json`/`openapi.yaml` (or a script named `openapi*` in
   package.json), name it in the warning.
2. In `src/nextjs/mswHandlers.ts`, make the write-once check smarter than "file exists": store a
   provenance marker inside the generated file (a hash of the spec it came from, the way the specs
   already carry `@flawless-generated sha256:…`). On a run where the spec changed and the file still
   matches the *old generated* hash, regenerate it and report `handlers.ts: regenerated from a newer
   spec`. If the user edited it (hash mismatch), keep it and report
   `handlers.ts: kept (hand-edited) — regenerate with --force or delete it`.
3. Make the summary say how many handlers exist and how many spec paths they cover, so a catch-all
   stub is visible in the run output rather than discovered an hour later.
4. Tests: (a) catch-all fixture → warning present, mentions `--api`; (b) handlers file untouched by a
   second run with the same spec; (c) second run with a *different* spec and an unedited handlers file
   → regenerated and reported; (d) hand-edited handlers file → kept and reported.
5. Flip the Chunk 0 marker for defect #5.

**Acceptance.** Against the hono-style fixture: the warning appears on a spec-less run; with `--api`
pointed at a 70-ish-path spec, handler count goes from 6 (one per verb) to the real per-path count, and
a second `--api` run with a changed spec refreshes handlers without deleting anything by hand.

**Gotchas.** Do not overwrite a handlers file that has no provenance marker at all (a file from 0.3.1 or
hand-written from scratch) — keep it and tell the user what to do.

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

**Root cause.** The generated `browser/playwright.config.ts` (`src/scaffold/templates.ts`, `workers:`
at ~line 477) leaves workers at playwright's default (½ CPU) while **one** shared host server serves
every worker. Each page bundles the whole app; the crash is contention, not the app.

**Do.**

1. Bound the default: `workers = FLAWLESS_WORKERS ?? (CI ? 1 : Math.min(4, cpus/2))`, and keep the
   existing env override semantics. Document the reasoning in the config comment that already discusses
   `FLAWLESS_WORKERS`.
2. Add `launchOptions: { args: ["--disable-dev-shm-usage"] }` — cheap insurance for containers where
   `/dev/shm` *is* small, which is the same symptom with a different cause.
3. Make the host reusable-but-stable: it already is (`reuseExistingServer`), but add a readiness probe
   that fails with a clear message if the host died mid-run, so a crash is reported as "host died"
   rather than as a random spec failure.
4. Tests: the emitted config contains the bounded default and the launch arg; a run against the
   fixture with default settings completes without renderer crashes.
5. Flip the Chunk 0 marker for defect #6.

**Acceptance.** Quote: "browser plane at default settings: N renderer crashes → 0 across 3 consecutive
runs; wall clock X s → Y s". If bounding workers costs meaningful throughput, say so with the numbers —
a slower green beats a faster red, but the trade must be stated.

**Gotchas.** Do not "fix" this by making every worker boot its own host: the shared host is what makes
the plane fast, and the perf plane's measurements depend on one server.

---

## Chunk 7 — Defect #8: the MCP server does not exit after the call completes

**Symptom, measured.** Every `flawless_run` over stdio returned a complete JSON result and then hung
until killed. All three generation calls in the dogfood exited 124 (`timeout`) *despite* the client
calling `child.kill()` in `finally`. A client that waits for process teardown blocks forever.

**Root cause to confirm.** `src/mcp/server.ts` / `src/mcp/run.ts` spawn workers (bun/tsc/playwright
children). A grandchild holding the inherited stdout/stderr pipe keeps the client's readline alive, so
the client never sees EOF; `kill()` on the direct child does not close the grandchildren's handles.

**Do.**

1. Reproduce with a 20-line stdio client (spawn `flawless-react mcp`, `initialize`, `tools/call
   flawless_run`, then wait) and measure how long the process takes to exit after the response. Put the
   number in the PR.
2. Fix on the server side, not the client side:
   - spawn children with `stdio` pipes the parent owns (not inherited), and `.unref()` handles the
     parent does not read;
   - on tool completion, terminate the whole process group (`detached: true` + `process.kill(-pid)`),
     not just the direct child;
   - on stdin EOF, shut down within a bounded grace period and exit non-zero if children refuse.
3. Add a test that asserts the server exits within N ms of stdin closing, for both an idle server and
   one that just finished a `flawless_run`. This is an invariant guard: keep it cheap (fixture project,
   one task).
4. Document in the MCP docs that clients may rely on process exit after stdin close.

**Acceptance.** Quote: "time from result to process exit: >60 s (killed) → X ms, measured over N runs",
plus the new test in the suite.

**Gotchas.** Do not make the server exit *immediately* on response — MCP is a session, and clients send
further calls. The contract is: exit when stdin closes, and do not keep pipes open that nothing reads.

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
