# S1 — e2e: from five hand-writes to one command that names what is missing

## Scope

`src/tasks/e2eRoutes.ts` and `src/tasks/e2eExpo.ts` (emission only), `src/runner/runTests.ts`
(one pre-flight), `src/reporters/report.ts` + `verdict.ts` (the blocked state's wording),
`src/core.ts` (one emitted script entry), the two e2e execution tests, and the
`flawless-e2e` skill. No new task id, no runtime in the CLI.

## Premise

The e2e plane is emitted in seconds and run by nobody. The reason is not the suite, it is
the setup, and the setup is five hand-writes, each of which fails in a way that looks like
a test failure rather than a missing prerequisite:

1. **Seed the database** — `e2eRoutes.ts:12-17`: *"MSW cannot intercept RSC data access
   (direct DB calls), so v1 runs against the app with its real backing services — seed
   the DB first."*
2. **Write the login** — the emitted `global-setup.ts` stub (`:336-358`) plants a
   `TODO(flawless): authenticate here` and writes an **empty** storage state (`:355`);
   every guarded route then 404s or redirects, and the hand-work tally
   `e2e-auth-unfilled` (`:100`, `:141-144`) is the only thing that knows why.
3. **Fill `params.json`** — blank slots for every dynamic segment (`:579-669`); an
   unfilled slot makes its spec `test.skip` with *"no id fixture for <route>"* (`:421-423`).
4. **Record `landing` overrides** for routes that redirect on purpose — never written by
   the tool, only carried (`:587-593`).
5. **Have a dev server and browsers** — the config boots one itself with a 120 s deadline
   (`:310-318`), and the failure text (*"Timed out waiting 120000ms from
   config.webServer"*, `:305`) is famously not a test failure.

The tool's own answer to an unfilled suite is already good — `assertOnRoute`
(`:474-488`) names both fixes in its message — but it only fires once a run has started,
so the first experience of the e2e plane is 40 red tests that were never runnable.

## What it ships

### 1. An emitted setup doctor

`flawless/e2e/doctor.mjs` + `bun run flawless:e2e:doctor`. It answers, in one screen and
as JSON with `--json`:

- is the app reachable at the base URL (and is it the dev server or a prod build);
- does `.auth.json` exist, is it non-empty, and is it still byte-identical to the stub
  (the exact test `e2eRoutes.ts:141-144` already uses for `e2e-auth-unfilled`);
- which `params.json` slots are blank, which routes they belong to, and the env override
  (`FLAWLESS_E2E_<PARAM>`, `:726-733`) for each;
- which routes redirect and have no `landing` entry;
- whether Playwright's browser is installed.

Every check is a **named blocker with the fix in the same line**, in the repo's existing
voice. The doctor is emitted code, not CLI runtime: the "no runtime" rule
(`docs/architecture.md:454`) stays intact.

### 2. A concrete auth recipe per provider, not a generic TODO

`src/analyse/authShims.ts:22-40` already classifies the app's auth provider family
(Clerk, next-auth, Supabase auth-helpers/`@supabase/ssr`) — the same fact that lets the
unit plane stub a signed-out session. Ship provider-specific `global-setup.ts` bodies:

- **Clerk** → the `@clerk/testing/playwright` `signIn()` path, driven by
  `FLAWLESS_E2E_EMAIL` / `FLAWLESS_E2E_PASSWORD`, with the test-mode caveat in the
  comment;
- **next-auth** → a `request.newContext` POST to the credentials endpoint the app
  actually declares (the endpoint is derivable from the harvested API routes,
  `src/nextjs/routes.ts` + `harvestApiEndpoints.ts`), then `storageState`;
- **Supabase** → the email-password endpoint equivalent, same env pair;
- **unknown provider** → today's stub, and the doctor names it as the blocker.

Write-once survives: a hand-edited `global-setup.ts` is never overwritten
(`e2eRoutes.ts:86-89`), so the recipe is what a *fresh* suite gets, and the doctor is
what tells a stale one.

### 3. `--run-tests` says "blocked", loudly, before it says "red"

`planGeneratedRuns` (`src/runner/runTests.ts:48-61`) gains one step for the e2e entry:
run the doctor; if it reports blockers, do not spawn Playwright. Report
`e2e blocked — 3 setup items unfilled (auth stub unfilled; 7 params slots blank; 2
redirects without landing)` and exit non-zero. `--allow-blocked` runs it anyway, for the
case where the blockers are known and the red is the point. A blocked plane is recorded in
`VERDICT.json` as blocked with its reasons — never as a pass, never as a silent skip, and
never as the `ran: 0` "nothing ran — never report green" case
(`runTests.ts:40-45`) that the runner already refuses to call green.

### 4. Params: bulk fill from a file the app already has

`params.json` blanks are the slowest hand-write because the ids live in the app's own seed
file. Ship `bun run flawless:e2e:params --from <json|ndjson>` — an emitted script that
takes a `{ "<param name>": <value> }` map (or a seed dump) and fills matching slots,
leaving the rest blank and re-printing what is still missing. It writes only
`params.json`, which is already write-once-merged (`e2eRoutes.ts:554-578`).

### 5. The cold-start receipt, as an acceptance metric

Track S's plan-level criterion is a measured cold start. This step's receipt is a timed
run on a fresh worktree of the pinned dogfood app: `clone → seeded → first green
flawless:e2e`, before and after, with the command list pasted. The before number is
measured on a binary built from the merge-base, same lineage rule as everything else.

## Acceptance (measured on the merge commit)

1. Doctor: on a fresh emission with nothing filled, it lists exactly the blockers the
   tool knows about (auth stub, N blank params, M redirects without landing, browser
   state) and exits non-zero; after the recipe is filled and params supplied, it exits 0.
   Both runs' output is in the receipts, and a guard-the-guard case proves a filled
   `global-setup.ts` that is still byte-identical to the stub is reported as unfilled.
2. Auth recipes: for each of the three provider families, a fixture app whose emitted
   `global-setup.ts` contains the provider's concrete recipe and no generic TODO; for an
   app with no recognised provider, the stub plus the named blocker. `tests/e2eExecution.test.ts`
   keeps its stand-in-server shape (`:49-78`) and gains a case where the emitted recipe
   performs the login against the stand-in and the suite goes green — the hand-work the
   test currently does by hand (`fillSetup`, `:193-224`) becomes the emitted code's job.
3. Blocked-not-red: `--run-tests` with an unfilled e2e plane reports `blocked`, spawns no
   Playwright process (asserted by the test), exits non-zero, and writes a blocked verdict
   entry; with `--allow-blocked` it runs and reports the reds it used to report.
4. Cold start on the pinned app: the measured minutes drop, and the drop is attributable
   to a named step in the receipt (which hand-write got cheaper), not to a vaguer
   "it felt faster".
5. Expo sibling: `e2eExpo.ts` gets the doctor and the `EXPO_PUBLIC_API_URL` prerequisite
   check (`:152-157`) inside it; its execution test proves the same blocked/green pair.

## Gates

Plan-level criteria 1–4 plus track S's cold-start criterion. Scope hygiene: this step
touches emission and the runner only; a diff that changes route discovery or the params
merge algorithm is a separate commit.

## Moot vs required

- Moot: making the CLI seed a database, boot a server, or hold credentials — the no-runtime
  rule and the fact that the tool cannot know a schema. Also moot: eliminating the
  hand-writes that are genuinely app knowledge (which seed script to run, which user is a
  valid test login). The doctor's job is to make those *legible*, not to guess them.
- Required: the doctor, the three provider recipes, the blocked state, the params bulk
  fill, and the measured cold start.

## Dependencies

Independent of track D. S2 reuses the doctor's shape and its `.auth.json` session
handoff; S3 gives "blocked" a home in the verdict, which is where this step's new state
must land — S1 and S3 are the same vocabulary, and S1 defines it first.

## Receipts

_None yet._
