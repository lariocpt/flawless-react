# S2 — load: the same cold-start treatment, plus a baseline you can trust

## Scope

`src/tasks/loadPipes.ts` and `src/tasks/loadExpo.ts` (emission only), `src/core.ts` (two
emitted script entries), `src/reporters/verdict.ts` (the crust-absent fact), the
`flawless-load` skill, `tests/loadPipes.test.ts` / `tests/crustGate.test.ts`. No new task
id; no runtime in the CLI.

## Premise

Load is the most setup-gated plane and the one whose silent failures are most expensive,
because a load run that measures the wrong thing still prints confident numbers. What a
run needs today, all of it by hand:

1. **The crust binary.** `bun run flawless:load` is
   `crust -c 'test-pipes --target …/load/routes.pipes --timeout 60000'`
   (`src/core.ts:602`). At generation time a missing crust is a *successful* task whose
   summary appends "— crust not found on PATH" (`loadPipes.ts:137`, `:144-148`) — a
   deliberate choice (`docs/e2e-and-api.md:205-206`), but one that leaves no durable
   record.
2. **A production build as `LOAD_BASE`.** The emitted header is explicit that a dev
   server *"measures the compiler rather than the app"* (`loadPipes.ts:473-476`) — and
   nothing checks it.
3. **`LOAD_AUTH` as a header line** (`:477-479`), usually a session copied out of the
   e2e auth state, which the skill documents as a `jq` incantation
   (`.agents/skills/flawless-load/SKILL.md:19-27`).
4. **Seeded ids** in `e2e/params.json` — shared with S1; unfilled pipes are emitted
   commented-out with a `# TODO(flawless): no value for …` marker rather than dropped
   (`:311`, `:501-508`), because an empty path segment *"answered 500 on every one of 500
   requests"* (`:81-85`).
5. **A baseline, made by hand**: *"copy a good last-\*.json to baseline-\*.json"*
   (`:485-486`). Nothing records what that baseline measured.

The loud failures are already good — missing `LOAD_BASE`/`LOAD_AUTH`/params throw in
`routes.setup.ts` (`:396-440`), and an expired session is caught by the redirect probe
(`:446-457`, whose comment records the real incident: *"20/20 status 200, p50 19.7 ms,
exit 0, every request served /login"*). The silent ones are the targets: a dev server
passed off as prod, a baseline from a different build, a soak that is 33 × 10 s when you
wanted a smoke.

## What it ships

### 1. `flawless:load:doctor` — the load half of S1's doctor

Same shape, same voice, same `--json`. Checks: crust present and its version; `LOAD_BASE`
set and reachable; `LOAD_AUTH` well-formed (the same validation `routes.setup.ts:404-406`
does, before 500 requests rather than during); params slots; the count of gated pipes;
and **prod-vs-dev**: request one route cold and again warm and flag a first-request/p50
ratio above a stated threshold as *"this looks like a dev server — you are measuring the
compiler"*. The heuristic is stated as a heuristic in the output, with the header's
instruction quoted, so it can warn but never silently pass or silently fail.

### 2. Session handoff from the e2e plane

`flawless:load:auth` reads `flawless/e2e/.auth.json` (the storage state S1's recipe
writes) and prints the `cookie: …` / `authorization: …` line, or exports it for the
current shell. The `jq` dependency the emitted `env.sh` warns about
(`loadPipes.ts:707-711`, `:729-733`) disappears for the common path; the setup module's
own auto-seeding of `LOAD_<PARAM>` (`:421-440`) is unchanged.

### 3. Baseline bootstrap with provenance

`flawless:load:baseline` runs the pipes once at a stated soak, copies each
`last-*.json` to `baseline-*.json`, and writes a sidecar
`baseline-<name>.provenance.json` recording the target URL, the git SHA of the app under
test, the soak parameters, the timestamp and the crust version. A run whose baseline
provenance does not match the current target says so in the report — a baseline is a
claim about a build, and an unlabelled one is how a perf gate quietly stops meaning
anything. The sub-millisecond flake floor that `tests/crustGate.test.ts:104-121` carries
as a comment (*"roughly 1 run in 3"*, floored at `max(observed, 5ms)`) becomes a stated
line in the emitted README and in the assert's comment, not tribal knowledge.

### 4. A soak that can be a smoke without editing the pipes

The emitted pipe body hard-codes `load 10s 50/s` (`renderPipeBody`, `:324-332`). Ship
`LOAD_SOAK` / `LOAD_RATE` env overrides read by `routes.setup.ts`, defaulting to today's
values, so a 33-pipe suite can smoke in seconds the way `crustGate.test.ts:80-83` already
does for its own gate (*"a 10s soak per case is load engineering, not gate semantics"*).
The pipes file itself stays byte-stable — the override is read at run time, so this does
not touch the regen idempotence property.

### 5. Crust absence becomes a recorded fact

The task stays `ok: true` without crust — that decision is right and documented — but
`VERDICT.json` gains the fact (`crust: "absent" | <version>`) so S3's rule, *an absent
field is unmeasured, not zero*, has something to point at. Today the only trace is a
summary string that the next run overwrites.

## Acceptance (measured on the merge commit)

1. Doctor: with crust absent, `LOAD_BASE` unset, and pipes gated, it lists exactly those
   blockers and exits non-zero; with a throwaway `Bun.serve` standing in (the pattern
   `tests/crustGate.test.ts:67-75` already uses) and `LOAD_AUTH: "accept: */*"`, it exits
   0. The dev-vs-prod heuristic is proven on both: a real `next dev` and a real
   `bun run build && bun run start` on the fixture app, with the measured ratio in the
   receipts.
2. Auth handoff: given a storage state with a cookie, `flawless:load:auth` prints the
   exact header line `routes.setup.ts` accepts — proven by feeding its own output back
   into a run.
3. Baseline: `flawless:load:baseline` produces `baseline-*.json` + provenance; a run
   against a mismatched target reports the mismatch; the FR-047 floor appears in the
   emitted README.
4. Soak override: default run is byte-identical to today's pipes; `LOAD_SOAK=2 LOAD_RATE=10`
   changes the soak and nothing else; the two runs' `last-*.json` are both valid inputs
   to the assert stage.
5. Cold start on the pinned app: `fresh emission → first trustworthy load numbers`,
   timed before and after, with the crust install, the prod build, the session step and
   the soak each broken out in the receipt. The prod build's own time is reported, not
   hidden — it is the irreducible part of this plane's cost.
6. Expo sibling: `loadExpo.ts` gets the doctor checks for its probe-skipping case
   (`:216-221`, where every endpoint is parameterised and *"the pipes' own `expect 200` is
   the only gate left"*), so that note stops being a code comment and becomes a reported
   state.

## Gates

Plan-level criteria 1–4 plus track S's cold-start criterion. Criterion 3's regen probe
must show `routes.pipes` byte-identical to the pre-step emission for the same target —
the soak override is read at run time precisely so this holds.

## Moot vs required

- Moot: making the tool build the app, hold a session, or choose a baseline threshold per
  route; replacing crust; per-route SLOs. Also moot: changing the default soak — the
  default is the honest number, the override is the convenience.
- Required: the doctor, the session handoff, the provenance-bearing baseline, the soak
  override, and the recorded crust fact.

## Dependencies

S1 defines the doctor's shape and the `.auth.json` handoff this step consumes. S3 gives
`blocked` and `crust: absent` a home in the verdict. Independent of track D.

## Receipts

_None yet._
