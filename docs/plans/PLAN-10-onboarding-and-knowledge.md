# C3 — clone to green without asking anyone, and prose rules that have teeth

## Scope

`CONTRIBUTING.md` (new), `package.json` (one `check:cold` script), `tests/envCensus.test.ts`
(new), `tests/noStrayTests.test.ts` (new), `tests/toolchainPins.test.ts` (extended),
`AGENTS.md` (pointer edits only), `docs/architecture.md` (pointer only). No change to
emission.

## Premise

A newcomer's first question has no answer in the repo. `README.md:577-582` says
`bun install` / `bun test` / `bun run check` / `bunx tsc --noEmit`, which is true and
insufficient: the suite needs a **real node that is not the bun shim**
(`tests/emittedExecution.test.ts:355-368`), **zsh** (`:44-58`), **jq**, **git**
(`src/changed.ts:49-93`), **crust** — which `tests/crustGate.test.ts:19-30` deliberately
refuses to skip (*"a missing crust is a broken environment, not a reason to hand the blind
spot back"*) — and **chromium** for the gated cases. `package.json:62-64` declares
`"engines": { "bun": ">=1.1.0" }` while `AGENTS.md:39-41` and `Jenkinsfile:85-93` explain
that below 1.4 concurrent installers corrupt a shared cold cache, which is every CI run.
None of this is written down anywhere a newcomer would find it; it is written down in
`Jenkinsfile`, which is the maintainer's machine expressed in Groovy.

The second half is the rules that only exist as warnings. `AGENTS.md` is a good document
and it is also a list of things that will silently go wrong:

| Rule (`AGENTS.md`) | Enforced? |
| --- | --- |
| `bun run check` must be run cold (`:30-32`) | ⚠ prose — a cached check reports success over an unformatted file |
| a `bun test` tally that disagrees with CI is a phantom worktree checkout (`:42-46`) | ⚠ prose — the recipe is a `find` command in a sentence |
| bun ≥ 1.4 in practice (`:39-41`) | ⚠ prose, contradicted by `engines` |
| rebuild the binary from the measured tree (`:52-60`) | ⚠ prose, by convention |
| `bunx tsc --noEmit` stays clean, biome pins, emitted-spec honesty | ✅ tests (`tests/toolchainPins.test.ts`, the `*Execution` family) |

Four of the five are one keystroke away from being enforced.

## What it ships

### 1. `CONTRIBUTING.md` — the actual path, with the reasons

Prerequisites as a table (bun ≥ 1.4 **and why**, real node **and how to tell** —
`node -p "typeof Bun"` must print `undefined`, the Jenkins check at `:113-117` verbatim,
zsh, jq, git, crust with its public install line, chromium for the gated tests), then
clone → install → green, then what the gated tests are and how to arm them
(`FLAWLESS_CI_BROWSER=1`, `FLAWLESS_CI_NATIVE=1`), then the PR shape from `AGENTS.md:35-36`
with the five gates spelled out as commands. `AGENTS.md` keeps its pointer and stops being
the only place any of it is written.

### 2. `bun run check:cold`

`rm -rf node_modules/.cache/biome && biome check`, so the rule in `AGENTS.md:30-32` is a
script name instead of a memory. `CONTRIBUTING.md`, `docs/releasing.md` (C2) and the CI
workflow (C1) all call it; `AGENTS.md` keeps its explanation and gains the command.

### 3. `tests/envCensus.test.ts` — silent skips become a census

14 tests are gated on `FLAWLESS_CI_BROWSER` / `FLAWLESS_CI_NATIVE` (≈ 0.8 % of ~1,787) and
skip quietly; crust, real node, zsh and jq fail loudly but only when reached. One always-run
test prints a table of what this machine could and could not measure — crust version, real
node, zsh, jq, chromium, network, and the sibling website checkout
(`tests/helpers/docs.ts:135-138` skips website linting when absent, which is right for a
stranger and must be *visible* rather than invisible). Same principle as the verdict: an
unmeasured thing is reported as unmeasured, never as a zero.

### 4. `tests/noStrayTests.test.ts`

The phantom-worktree rule as a test: fail if any `*.test.ts` exists outside `tests/`
(excluding `node_modules` and gitignored scratch), with the found paths and the fix in the
message. This is `AGENTS.md:45`'s `find` command promoted to a gate.

### 5. `engines` tells the truth

`"bun": ">=1.4.0"`, with the reason comment moved from `AGENTS.md` into `package.json`, and
a `toolchainPins` assertion that `engines` and the pinned CI image major agree. A declared
floor the maintainers do not honour is worse than none.

### 6. Incident lore gets an index, not a rewrite

The prose that cannot become a test (the talkformai auth-constructor incident
(`src/analyse/authShims.ts:26-31`), the FR-047 crust flake rate
(`tests/crustGate.test.ts:104-121`), the Clerk placeholder-key webServer timeout
(`src/tasks/e2eRoutes.ts:302-309`)) stays where it is — those comments are load-bearing —
but `CONTRIBUTING.md` gains a short **"why the suite is shaped like this"** list pointing
at each one, so the next maintainer meets them in one place instead of by stepping on them.

## Acceptance (measured on the merge commit)

1. A container that has none of the optional tools (the honest test: `oven/bun:1.4` plus
   nothing else) follows `CONTRIBUTING.md` and reaches a green `bun test` after installing
   exactly what the table lists — with the install commands and the elapsed time in the
   receipts. If a step is missing from the document, the document is wrong and is fixed in
   the same commit.
2. `tests/envCensus.test.ts` prints the census on a machine with everything and on a
   machine with nothing, and the two outputs differ in the expected rows; both are in the
   receipts.
3. `tests/noStrayTests.test.ts` passes on the clean tree and fails on a planted stray file
   (guard-the-guard).
4. `bun run check:cold` is byte-equivalent in result to the documented two-command form,
   and every prose reference that told humans to type the two commands now names the
   script — `grep -rn 'rm -rf node_modules/.cache/biome' README.md docs/ .agents/` returns
   only the script definition and this plan.
5. `engines` change lands with its pin test, and the CI workflow (C1) still installs
   cleanly on it.

## Gates

Plan-level criteria 1–4. Criterion 5's scope hygiene: this step touches docs, two new test
files, `package.json` and one script — a diff that also "improves" `AGENTS.md` prose is a
second commit.

## Moot vs required

- Moot: a devcontainer or docker-compose that pretends to solve this while the private
  registry, crust and the dogfood app stay outside it; deleting the incident comments in
  favour of a wiki.
- Required: the documented path with its reasons, the four enforcement steps, the env
  census, and a truthful `engines`.

## Dependencies

C1 provides the portable CI the CONTRIBUTING path is verified against; C2's
`release:check` calls `check:cold`. Otherwise independent.

## Receipts

_None yet._
