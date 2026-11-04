# Changelog

Notable changes to flawless-react. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project is pre-1.0, so
minor versions may carry breaking changes.

The tool grew for hundreds of commits before its first tag, so this is a curated record
of what the tool is today, not a per-commit log: every entry names a shipped surface with
tests behind it, and `README.md` and `docs/` stay authoritative for detail. What the tool
deliberately does not claim lives in `docs/limits.md`.

## [Unreleased]

## [0.3.2] — 2026-11-04

The dogfood fix loop, released: all nine defects found by dogfooding 0.3.1
against a real monorepo, plus the six candidates the loop's re-measurement
kept — #10, #12, #13, #16, #17 and #21. The plan, every correction to it and
the release-time re-audit of all 21 findings live in
`DOGFOOD-0.3.1-FIX-PLAN.md` in the repository. No task, flag or emitted-path
changes: generation is what changed. What a generation run does differently:

- **The harness tsconfig carries the app's path aliases** — `baseUrl` plus the
  app's `paths` rewritten relative to the app root — so an aliased Next repo
  starts its browser and perf planes instead of dying at webServer start
  (defect #1).
- **The generator merges the suite dir into the host tsconfig's `exclude`** —
  merge, never clobber, the file's own formatting preserved, and the run
  reports it — so a generation no longer breaks the app's own `tsc`/`next
  build` (defect #2).
- **Document-root specs import `renderToReadableStream` from the specifier
  the emitted aliases actually resolve to** — probed against the installed
  react-dom at generation, preferring `react-dom/server.browser`, and a
  react-dom that carries the export on neither candidate skips with a named
  reason instead of failing (defect #3).
- **Mock shapes follow the call sites** — a hook called synchronously gets a
  sync mock, a `.map` use site gets a one-element array that witnesses the
  element shape, and package modules no analysed file calls are left real
  (defect #4, the `toasts.map is not a function` class).
- **A catch-all API route that flattens a router into one swagger path is
  named** — the file, the collapsed count and the way out — and
  `mocks/handlers.ts` refreshes from a newer spec through a digest line under
  its generation stamp instead of going stale behind the write-once guard
  (defect #5: against the real 71-path spec, 2 handlers covering 1 path
  became 99 covering 71).
- **Browser and perf planes bound their worker count** — at most 4 locally,
  1 in CI, `FLAWLESS_WORKERS` overrides — and pass
  `--disable-dev-shm-usage`, the fix for the `Target crashed` renderer
  failures at default parallelism (defect #6).
- **The MCP server's exit contract is written down and its drains are
  bounded** — it exits when stdin closes and the batch has drained; a
  straggler in the child's process group gets a 2 s grace and a group kill
  (measured 2.03 s where it previously never returned), and a signal races
  the drain against 5 s instead of waiting on the call's watchdog (defect
  #8).
- **`flawless/setup.ts` and the whole emitted suite are lint-clean** under a
  strict host ruleset — the fixture's biome run went 10 `noExplicitAny`
  errors to 0 with no `biome-ignore` comments — so a first run is
  committable in a linted repo (defect #9).
- **Async RSC page specs render real content** — promise-valued props and
  children are awaited, static children keep their identity, the render
  settles inside `Suspense` + `act`, and a render that cannot settle skips
  with a named reason counted in REPORT.md instead of an empty container
  (defect #7: the dogfood's five async-RSC detail pages, 29 failing content
  assertions).
- **Vitest 4/5 hosts with `jsx: "preserve"` no longer hit a silent total-red
  wall** — the emitted config declares one jsx mechanism chosen from the
  vite the suite will actually run (oxc from vite 8 up, esbuild below),
  where every such host previously died with a `Parse failure` on every spec
  (#10).
- **Colocated specs run from the suite's own `test:unit`** — the emitted
  vitest config widens `server.fs.allow` to the project root in the colocate
  layout, where `cd flawless && npx vitest` used to fail every spec with a
  phantom "files do not exist" (#12: 10 failed → 16 passed / 1 skipped on
  the fixture).
- **Mock factories cover exports the render graph reaches but no analysed
  call site evidences** — one hop through non-analysed files — so a mocked
  module reached through a util the analysis never opened no longer fails
  with "No … export is defined on the … mock" (#13).
- **The emitted suite leaves 0 warnings on a no-style-pass regen**, and the
  emitter is an `organizeImports` fixed point at every write site — a host
  with no biome measures 2 err / 0 warn / 21 info tree-wide (the two errors
  are in fixture files the tool never writes) where the pre-#16 tree
  measured 26 err / 15 warn / 21 and the pre-#21 tree 7/0/21; the pin for
  that now runs the regen in a subprocess whose PATH carries no biome, so it
  is host-independent (#16, #21).
- **eslint hosts get a style pass** — adoptStyle detects an eslint config
  and runs it over the emitted files, where such hosts previously got
  `formatter: "none"` and an unverified suite (the fixture's host eslint went
  32 errors / exit 1 to 0 / 0) (#17).

What this release deliberately does not do is recorded in the plan: #14
(the silent live-spec fallback) stays trigger-gated, and #18–#20 stay
recorded-only.

## [0.3.1] — 2026-10-31

Package metadata only — no behaviour change, no new surface.

- `homepage` now points at the documentation site, which went public today
  (`https://lariocpt.github.io/flawless-react-website/`). The published 0.3.0 tarball predates
  the change, so npmjs still advertised the repo readme as the homepage. npm renders that link
  from the tarball rather than from the repository, so a publish is the only way to correct it —
  which is what this version exists to be.
- The README gained npm and license badges, and the repository's About box has a website for the
  first time.

## [0.3.0] — 2026-10-31

### Added

- **`perf-harness`, the default task.** Scaffolds a Playwright suite that mounts each
  component inside a React `<Profiler>` with budget assertions. Omitting `--tasks` runs
  this task alone — the non-interactive default is one useful suite, not seven.

- **`unit-browser`, the generator.** Vitest unit specs plus real-browser specs built from
  what the analyser actually found — props and where each is used, hooks, state,
  interactions, cva variants, render modes for components that cannot mount standalone.
  The emitted specs are meant to assert something: they open the disclosures they query,
  carry a claim after every dispatch, and where a claim cannot fail they say so as a
  named skip instead of going vacuously green.

- **`perf-static`, `a11y` and `react-rules`, the findings tasks.** Static causes of
  re-renders (unmemoised props, inline objects and closures, effects with unstable deps)
  from the tool's own analyser; an axe-core accessibility scan and a Biome lint sweep
  over the same files. Both need the real engine (a browser, Biome), and each refuses
  with the named reason when its engine cannot run — zero findings always means the scan
  actually ran.

- **`e2e` and `load`, the route tasks.** Playwright route specs with one id fixture
  instead of per-page copies, and crust load pipes with an honest REPORT — a pipe that
  measured the app's 404 handler says so rather than reporting healthy percentiles.

- **Next.js mode (`--nextjs`).** Auto-globs the app when no positional entry is passed,
  mocks API routes with MSW — including a live OpenAPI spec consumed via `--swagger-url`
  and joined at emit time — merges `flawless:*` scripts into the app's `package.json`
  without clobbering a user-customised value, and writes the ignore and formatter-exclude
  entries the suite needs so generated output never collides with the project's own
  tools.

- **Expo / React Native mode (`--expo`).** The analyser learns the native element
  vocabulary, the unit emitter produces a jest-expo suite that runs and type-checks in
  the adopting app, and every task not ported to the platform refuses by name. `expo`
  and `nextjs` are mutually exclusive and refuse the pair as a `UsageError`.

- **The derived provider nest.** Components are mounted inside the providers they
  actually need, through four derivations: same-file context pairing, pairing through a
  shared context object across files, a shim table for library providers
  (react-query, react-router) detected from hooks and from rendered components and
  followed through project wrapper chains, and a real data router for the hooks
  `MemoryRouter` cannot serve — plus a pages-router host for pre-app-router apps.

- **React 17, 18 and 19**, with one physical React: the suite pins to the app's own
  installed copy, because pinning to a second React is the dual-React crash, not a
  version preference.

- **The suite lifecycle: generated, refreshed, kept.** Re-runs over an existing suite
  refresh the harness instead of rewriting it; hash stamps on colocated specs mean a
  hand-edited file is never silently overwritten; `--changed` regenerates only the specs
  an edit reaches, and retired specs go when their component leaves the host.

- **`REPORT.md`,** so the coverage number can be checked: per-file accounting, what was
  kept or retired and why, TODO burn-down, the imports the suite cannot resolve named,
  and a repro line two identical runs produce byte-for-byte.

- **The `--ci` contract, and the programmatic API.** `--ci` makes stdout exactly one
  parseable blob — `{exitCode, outDir, results, keptScripts, testRun, errors?}` — with
  stderr still carrying diagnostics, and `testRun.mode: "none"` if and only if zero
  suites executed, so "green" can never appear on a phase that ran nothing. Library
  callers use `runFlawless`/`runCore` and `analyse()`, which throw `UsageError` instead
  of ever calling `process.exit`.

- **The skill family: fourteen skills in the box.** Every feature surface has its
  `SKILL.md`, shipped inside the binary, and `flawless-react skills install` writes
  `.agents/skills/<name>/` into your project with a `.claude/skills` compat link — no
  project, no entry and no flags required.

- **A prose gate.** `tests/docsLint.test.ts` checks every invocation written in
  `README.md`, `docs/` and the shipped skills — plus the website's corpus when the site
  checkout sits beside this one — against the live CLI's grammar, flag list, task ids,
  env names and emitted paths. Docs and the tool must move together or CI goes red.

- **`install.sh` and the binary channel.** A curl-pipe installer for GitHub release
  assets on linux/darwin × x64/arm64: the checksum is verified while the download is
  still a temp file with no exec bit, and musl hosts are refused with the reason (Bun
  builds are glibc-only). A single-file binary cannot carry Biome, so `react-rules` and
  web-path `a11y` refuse without a machine Biome — the installer says exactly that
  rather than failing. The npm channel, `@lariocpt/flawless-react`, deliberately carries
  the source package with `@biomejs/biome` as a real dependency — every task works, and
  the price is that the npm path requires Bun.

- **`flawless-react mcp` — the Model Context Protocol server.** Eight tools over stdio
  JSON-RPC in two planes: the run plane spawns a `flawless-react` child per call (real
  exit codes, a process group killable at the deadline, per-call `cwd`/`env`, nothing
  held between calls) so a suite runner's own stdout can never corrupt a protocol frame;
  the read plane parses in-process and writes nothing. `tools/list` and the dispatcher
  share one definition path, so they cannot drift; unknown arguments are rejected, not
  ignored; output caps announce their real totals; EOF drains the in-flight batch and a
  signal kills the child group. Hand-rolled framing keeps the dependency count zero.
