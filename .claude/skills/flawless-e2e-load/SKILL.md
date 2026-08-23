---
name: flawless-e2e-load
description: Run and maintain flawless-react's route e2e specs and crust load pipes — seeded-DB prerequisites, the global-setup login, params.json ids, env.sh, LOAD_BASE/LOAD_AUTH, baselines, and the anti-vacuous probes that decide whether the numbers mean anything. Use right before running flawless:e2e or flawless:load, when pipes report suspiciously fast p95s, or when e2e fails at global setup.
---

# flawless e2e + load

Both suites run against the **real app** — e2e because MSW cannot intercept a
server component's database access, load because measuring anything else is
fiction. That realism is also where every vacuous pass hides, so the probes
below are not optional.

## e2e: seeded DB, real login

Prerequisites, in order:

```bash
bun run db:up && bun run db:migrate && bun run db:seed   # Postgres + seed users
bun run dev:web                                          # app on :3001
bun run flawless:e2e
```

`flawless/e2e/global-setup.ts` signs in as the seeded user and persists
`storageState` to `e2e/.auth.json`. It **throws if login lands back on
/login** — that throw is an anti-vacuous guard, not a bug. When it fires, the
seed drifted (wrong user, wrong password, unseeded DB); fix the seed, never
the guard. Override credentials with `FLAWLESS_E2E_EMAIL` / `_PASSWORD` /
`_BASEURL`.

Dynamic segments come from `flawless/e2e/params.json` (write-once, merge-kept):
`defaults` filled with seeded UUIDs, per-route overrides optional. A blank id
does not fail — it produces a URL with an empty segment that hits the 404
handler, which is exactly the failure mode env.sh exists to prevent for load.

## load: production build, proven auth

```bash
bun run build:web && PORT=3001 bunx next start &         # PROD build on :3001
SESSION=$(jq -r '.cookies[] | select(.name=="session").value' flawless/e2e/.auth.json)
export LOAD_BASE=http://localhost:3001
export LOAD_AUTH="cookie: session=$SESSION"
source flawless/load/env.sh                              # exports LOAD_<PARAM> ids
bun run flawless:load
```

- **LOAD_BASE must be a production build.** `next dev` compiles routes on
  demand, so the first request to each route measures the compiler. Check the
  banner says `next start`. If the app's `start` script has no port flag, the
  default :3000 may collide with something else on the box — `PORT=3001` wins.
- **LOAD_AUTH is a header line** — for cookie sessions, `cookie:
  session=<value>` taken from the e2e run's `.auth.json`, not a Bearer token.
- **jq is a hard prerequisite** for `env.sh`; without it the LOAD_<PARAM>
  exports silently stay empty and 2/3 of the pipes measure the 404 handler.

## The anti-vacuous probes — run BEFORE the pipes

```bash
echo "$LOAD_ID"                                   # must be non-empty
curl -s -H "$LOAD_AUTH" "$LOAD_BASE/dashboard/buildings/$LOAD_ID" | grep -ci "login"
```

The curl must return real page HTML (tens of KB), and the grep must find no
login form. An unauthenticated dashboard request 302s to the login page, which
answers 200 — so every pipe passes while measuring the login screen. The same
trap wears a second face after the run: **a pipe whose p95 is suspiciously
fast is measuring the 404 or the redirect**, not the route. Compare against
the committed baselines; real SSR routes on a dev box sit in the 10–15 ms p95
range, not 2 ms.

## Baselines

Each pipe gates p95 against `baseline-<name>.json` (missing baseline = pass,
by design — the first run arms it). Arm a baseline by copying a good
`last-<name>.json`; refresh one only when you can explain the shift in the
commit body. Never refresh a batch of baselines to make a red run green.

`--force` **merges** `routes.pipes` rather than overwriting: edited rates,
hand-added flows, and pipes you commented out yourself all survive. Pipes with
unfilled ids are emitted commented-out above a line naming the params.json key
to fill.

## Contract-checked e2e (optional)

Put crust's validating proxy in front and assert no response violated the
OpenAPI spec:

```bash
crust -c 'mock-server --swagger openapi.json --port 4747 --proxy http://localhost:3001' &
FLAWLESS_E2E_BASEURL=http://localhost:4747 bun run flawless:e2e
crust -c 'GET :4747/__crust/violations | (v => v.violations.filter(x => x.direction === "response")) | assert (a => a.length === 0)'
```

## Never

- Never run load pipes against `next dev`, or without the curl probe.
- Never weaken or delete global-setup's throw-on-/login guard.
- Never read "33 pipes pass" as meaning anything until `$LOAD_ID` was proven
  non-empty and the probe returned authed content.
- Never refresh a baseline without explaining the shift where the next reader
  will find it.
