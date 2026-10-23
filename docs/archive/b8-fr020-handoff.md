# Handoff — FR-020 (--ci contract tests) then B-8 (workspace-package type resolution) + dogfood round 6

Written 2026-08-24, at the close of the wave 0–5 engagement (PRs #6–#19 merged,
ledger 33/34, readiness 55/70, Jenkins publishing on every main push). This is
the verified spec for the next session: exact seams, test designs, and the
gotchas round 5 paid for. Evidence lines below were read on the day of writing;
re-verify line numbers before editing.

## Order of work

1. **FR-020** first — small (effort S), closes the last open ledger item, and
   its assertions harden the `--ci` blob that B-8's dogfood will read.
2. **B-8** — the resolver + re-export work, reviewed and merged.
3. **Dogfood round 6** on mybodycorpai (authorized for this engagement) using
   the LAN-published build containing both.
4. Closures per repo (docs, website, skills, backlog/ledger, KB, memory).

One PR per item, merged into main (pre-authorized), mesh-repo-sync after each.

---

## Part 1 — FR-020: the --json/--ci process contract, tested

Ledger entry (docs/reviews/2026-08-findings.json, id FR-020, P2/tests): "No
test spawns the CLI with --ci and JSON.parses the whole stdout; one stray log
line before the blob would ship unnoticed."

**The promise being tested** (README "CLI reference", tail paragraph): with
`--json`/`--ci`, stdout is exactly one JSON blob
`{ exitCode, outDir, results, keptScripts }`; every human/runner line goes to
stderr; `exitCode` mirrors the process exit code; a red run's blob still
parses. `keptScripts` joined the blob in PR #18 (FR-034).

**Seams**: `tests/cli.test.ts` (existing spawn harness, line ~17); the blob is
emitted in `src/cli.ts` (grep `keptScripts` — the `--ci` shorthand and the
JSON print live together).

**Test design** (subprocess-level, `bun src/index.ts` spawned, tmpdir fixture
component like the existing cli tests):

- Green: run `--ci` on a trivially analysable fixture. `JSON.parse(stdout)`
  **as a whole** succeeds; assert `exitCode === 0` in blob AND process,
  `outDir` exists, `results` is a non-empty array of TaskResults, and
  `keptScripts` is present (an array — empty is fine outside Next.js mode).
- Red: a run whose task fails (the cheapest deterministic red: point the CLI
  at an entry file that does not exist inside an otherwise valid project →
  confirm which failure class that takes; if it is a UsageError instead, use
  a fixture whose component file is syntactically unparseable). Assert
  process exit 1, blob still parses, `exitCode: 1` inside it.
- Usage error: bad flag → exit 2. Decide-and-assert what stdout carries
  (probably no blob; the test pins whatever the contract IS so drift shows).
- **Anti-vacuity control**: the same green run WITHOUT `--json` must make
  `JSON.parse(stdout)` throw (the table is not JSON) — proves the parse
  assertion can fail.
- stderr: assert the human noise landed there, not stdout (a single
  `stderr.length > 0` on a `--run-tests`-free run is enough; don't overfit).

Ledger flip to `fixed` (34/34) + backlog note in the same PR.

---

## Part 2 — B-8: workspace-package type resolution

### The evidence (why this is the biggest remaining inference win)

Dogfood round 5 ended with 118 TODOs on mybodycorpai; the entire ~42-TODO
return-shapes remainder is types imported from `@mybodycorp-ai/shared` — a
bare workspace specifier the resolver refuses. Verified 2026-08-24:

- Root `package.json`: `"workspaces": ["apps/*", "packages/*"]`.
- `packages/shared/package.json`: name `@mybodycorp-ai/shared`, `exports`/
  `types`/`main` all point at `./dist/*` — **built output, may be stale or
  absent** (`tsc -b`). The real source: `packages/shared/src/index.ts`.
- `src/index.ts` is a barrel of `export * from "./errors" | "./schemas" |
  "./schemas/*" | "./types"`.
- `src/types.ts` is plain interfaces, rich in `string | null` members — the
  nullable-union resolution from PR #17 pairs directly with this.
- `schemas.ts` has 7 `z.infer<...>` types — those STAY bailed (zod inference
  is a different frontier; do not start it).

### Seam 1 — `ModuleResolver.resolve` (src/analyse/resolveModule.ts:62)

Today the bare branch returns undefined by design (doc comment lines 5–10:
"node_modules is never walked into" — that invariant STAYS). Add a workspace
branch, tried after tsconfig paths/baseUrl miss:

1. **Workspace map discovery**: from the importer's dir, walk up to the first
   `package.json` with a `workspaces` field (array or `{ packages: [] }`) or
   a `pnpm-workspace.yaml` (`packages:` list). Cache per discovered root
   (same pattern as `dirCache`/`configCache`).
2. **Glob subset**: literal dirs and single-star dir globs (`apps/*`,
   `packages/*`) only. Anything fancier (`**`, negations) is silently skipped
   — resolution returning undefined is the bail-safe direction.
3. **Package match**: read each workspace dir's `package.json` `name`; match
   the spec as `<name>` or `<name>/<subpath>` (longest name wins).
4. **Resolve to SOURCE, not dist**: for the root subpath, `probeModuleFile`
   on `<pkg>/src/index` then `<pkg>/index`; for `<subpath>`, probe
   `<pkg>/src/<subpath>` then `<pkg>/<subpath>`. Deliberately do NOT follow
   `exports`/`main`/`types` dist mappings in v1: dist is often stale/absent,
   and `.d.ts` files have no function bodies, which the fetch-wrapper path
   (`returnsFetchedJson`) needs. A src-probe miss returns undefined.
5. **Invariant**: only directories enumerated by the workspace map are
   entered — all inside the repo; node_modules stays unwalked; non-workspace
   bare specs (`react`, `next/link`) still resolve undefined (control test).

Every existing `resolver.resolve` call site benefits automatically:
`resolveDepReturns.ts:42`, `extractProps.ts:282/624/764/895`,
`resolveTagRootTags`, `compoundFamily`, `extractRenderMode`.

### Seam 2 — re-export chasing (the barrel problem)

Landing on `src/index.ts` is not enough: the type/function is DECLARED
elsewhere and re-exported. Two consumers need a relocation step:

- `resolveImportedTypeDecl` (src/analyse/extractProps.ts:887): today
  `findTypeDecl(targetSf, name)` looks only in the resolved file. On miss,
  follow the target's export declarations: named re-exports
  (`export { A as B } from "./x"` — rename-aware) and star re-exports
  (`export * from "./x"`, each tried in order, first hit wins).
- `resolveDepReturns` (src/analyse/resolveDepReturns.ts:53):
  `exportedFunctions(sf)` maps only same-file declarations; give its miss the
  same relocation step.

**Budget rule**: relocation is *finding where the name lives*, not a semantic
resolution hop — it must NOT consume the `hops` budget (`MAX_HOPS = 2`,
extractProps.ts:76; component → barrel → types.ts would exhaust it before a
single member resolves). Instead bound the barrel walk with a visited-files
set (cap ~32 files; cycles like a→b→a terminate). Factor the walker in one
place (sourceCache is the natural home — it already owns `exportedNames`,
sourceCache.ts:58, which itself only understands NamedExports today) so both
consumers share it.

### Test design (failing test first, per behavior)

Tmp-monorepo fixture (tmpdir): root package.json with `workspaces`,
`packages/shared/src/index.ts` (star-barrel) + `types.ts` (interface with a
`string | null` member and a nested type) + a `Promise<Thing[]>`-annotated
exported function; `apps/web/src/` component importing both from the bare
name; a tsconfig in apps/web WITHOUT a paths alias for it (that's the point).

- extractProps: imported interface members resolve through workspace + barrel
  (including the rename re-export form).
- resolveDepReturns: the dep gains `inferredReturn` with the annotation
  provenance comment; the `| null` member resolves per the union rule.
- Controls: bare `react`-like spec still undefined; workspace entry whose
  src probe misses stays undefined; pnpm-workspace.yaml variant; subpath
  (`@scope/pkg/sub`) variant; barrel cycle terminates; a package OUTSIDE the
  workspaces globs does not resolve even though it sits in packages-like dir.
- **Execution test** (the engagement rule — emitted artefacts run, never just
  parse): scaffold into the tmp app, `bun add -d` the pins, run the emitted
  vitest spec green; then mutate the shared interface (rename a member) →
  regenerate → the fixture changes/spec goes red — proves the resolution is
  live, not vestigial.
- `docs/architecture.md:62–65` and `:177` currently document the deliberate
  bare-specifier undefined — update BOTH in the same PR (docs-lint parses
  crust lines only, so prose edits are safe, but keep examples runnable).

### Adversarial review

Same two-lens pattern as waves 2.3–5: correctness lens read-only + mutation
probes in an isolated worktree (symlink node_modules; COMMIT before probing —
round 5 lost an uncommitted fix to a probe's `git checkout --`). Probe ideas
that earn their keep: delete the visited-set cap (must hang/fail a test),
make relocation consume hops (must fail the barrel-depth test), let the
workspace branch fall through to node_modules (must fail the react control).

---

## Part 3 — Dogfood round 6 (mybodycorpai; authorized)

After both PRs merge and Jenkins publishes (job `flawless-react`, publishes on
main push; also triggerable: POST
`buildWithParameters?BRANCH=main`, token file `~/.secrets/jenkins-api-token`,
curl `-u lario:$(cat ...)`).

1. **Query the registry for the real version — never guess the tag**:
   `npm_config_registry=https://npm.in.drlario.org bunx flawless-react@<ver>`
   (bunx IGNORES project .npmrc; the env var is required). Version format:
   `0.3.0-ci.N.<mainShortSha>`.
2. Branch `test/flawless-dogfood-r6` on mybodycorpai. Plain refresh first
   (expect exit 0), then inspect TODO movement: round 5 ended at **118**, the
   return-shapes cluster ~42. Expect a large bite out of that cluster;
   `z.infer` types staying TODO is correct behavior, count them honestly.
3. The 5 hand-hardened specs (from commit 919d43d) must survive as kept —
   they are the stamp system's regression canary.
4. Run all layers green before merging: `flawless:unit`, browser, profile,
   e2e, crust load (`bun run flawless:load` — the app's customised
   `--env-file` value must SURVIVE the refresh now; its survival is the
   FR-034 fix's live proof — check REPORT.md's `> Kept script(s):` line).
   Load needs the prod build + deterministic seed
   (`scripts/provision-db.sh`, personal-postgres :5433, demo login
   trustee@demo.local/demodemo). mybodycorpai's pre-commit hook runs the app
   suite — commits are slow; don't fight it.
5. PR into mybodycorpai main, merge, mesh-repo-sync.

## Part 4 — Closures (every repo, same discipline as rounds 0–5)

- **Tool docs**: generated-suite.md mock-provenance bullet gains the
  workspace sentence; architecture.md resolver paragraphs rewritten;
  extending.md "Mock data sources" if the story changes. README's Next.js
  bullets if user-visible.
- **Website** (~/Projects/static-websites/flawless-react-website): limits
  page likely lists workspace imports as unresolved — flip it; case-study
  gets the round-6 delta (same pattern as PR #3). PR + merge + sync.
- **Skills**: flawless-api / flawless-regen / flawless-unit-browser if
  contracts moved; copy to `~/.claude/skills/` after editing.
- **Ledger**: FR-020 → fixed (34/34). **Backlog**: strike B-8, add anything
  new honestly discovered (e.g. zod-inference as a candidate frontier).
- **Readiness**: append (never rewrite) a rescore in
  docs/reviews/2026-08-production-readiness.md if a dimension moved.
- **KB**: new learnings file under
  `~/Projects/personal/agents/hermes/flawless-react-agent/knowledge/learnings/`,
  PR into agents main (that repo often has OTHER sessions' dirty files — add
  ONLY yours), then re-ingest:
  `python3 deploy/ingest_kb.py flawless-react-agent`.
- **Memory**: update flawless-react-waves.md + its MEMORY.md index line.

## Gotchas round 5 paid for (do not rediscover)

- zsh: `echo =====` errors (= expansion) — quote separators in shell one-liners.
- sed escapes fail silently — apply mutations via python asserting
  `count == 1`, never trust an unverified in-place edit.
- `biome ci .` is stricter than lint-staged — run it repo-wide before pushing.
- Jenkinsfile sh blocks are Groovy '''…''': double every backslash or the
  pipeline won't parse.
- vitest summary lines are ANSI-coloured — strip `\x1b\[[0-9;]*m` before
  regexing.
- Emitted vitest configs pin `esbuild.jsx: "automatic"` because Next
  tsconfigs say `preserve` — don't remove it while touching templates.
- Playwright config loading is dual (ESM vs CJS transpile): no `__dirname`
  and no `import.meta` in emitted browser configs; relative paths are
  config-relative, `use.storageState` is CWD-relative, runtime anchors come
  from `test.info().config.configFile` (rootDir is the resolved testDir).
- mesh-repo-sync: `cachyos-mini-mobile` unreachable is normal.
