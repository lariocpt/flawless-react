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

`flawless/e2e/global-setup.ts` is where you sign in as the seeded user and
persist `storageState` to `e2e/.auth.json`. **What the tool emits is a stub**
that writes an empty state (so the config's `storageState` always resolves) plus
a worked example — it is never overwritten, `--force` included, because it is
yours once you touch it.

A hand-filled setup should **throw if login lands back on /login**: that throw
is an anti-vacuous guard, not a bug. When it fires the seed drifted (wrong user,
wrong password, unseeded DB); fix the seed, never the guard.

You are not relying on remembering that, though. **Every emitted route spec
asserts it landed on the route it asked for** — both the render test and the
interaction test — so an unauthenticated suite fails naming its escapes instead
of quietly testing the login screen. Until the hook is filled, REPORT.md's
hand-work table says so; the check is byte-identity against the stub, so it
clears the moment you edit the file.

**What that assertion does and does not catch**, because an overclaim here is
the same bug wearing a different hat. It catches redirects that CHANGE THE URL
and have landed by the time the spec looks — a server 3xx, and a client-side
navigation that completes before `networkidle` settles. It does **not** catch a
middleware *rewrite* that serves the login page at the requested path, a 401
body, or a redirect that fires later than the spec waited. A 401 usually still
reds the spec, but through the console-error check, not this one.

A route that redirects **on purpose** (a default sub-tab, a locale landing)
would otherwise fail forever. Record the real destination in
`flawless/e2e/params.json` under `landing`, keyed by route template:

```json
{ "landing": { "/dash": "/dash/overview" } }
```

Put it there, not in the spec: `--force` regenerates specs and leaves
`params.json` alone. Override the base URL with `FLAWLESS_E2E_BASEURL`.

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
bun run flawless:load    # routes.setup.ts seeds the ids and proves the auth
```

- **LOAD_BASE must be a production build.** `next dev` compiles routes on
  demand, so the first request to each route measures the compiler. Check the
  banner says `next start`. If the app's `start` script has no port flag, the
  default :3000 may collide with something else on the box — `PORT=3001` wins.
- **LOAD_AUTH is a header line** — for cookie sessions, `cookie:
  session=<value>` taken from the e2e run's `.auth.json`, not a Bearer token.
- **You no longer source `env.sh`.** `flawless/load/routes.setup.ts` runs
  first (crust awaits a pipes file's sibling setup module), seeds every
  `LOAD_<PARAM>` from `params.json`, and throws if it seeded none. env.sh needed
  jq and, without it, exported nothing *silently* while 2/3 of the pipes
  measured the 404 handler. The module has one failure mode and it is loud.
- **The auth check is enforced, not advised.** The same module probes every
  static route and throws if one lands somewhere else — an expired cookie
  redirects to a login page that answers 200, so `expect 200` passes and the
  whole file reports healthy percentiles for a login form. Measured: 20/20
  status 200, p50 19.7ms, exit 0, every request served /login. Record a
  by-design redirect under `landing` in `params.json`.
- The module is **write-once** — replace it with a check that knows your app and
  nothing will overwrite yours.

## The anti-vacuous probes — run BEFORE the pipes

These are for the **load** pipes. The e2e specs now carry their own landing
assertion; a load pipe has nothing of the kind, and `crust` will happily report
a fast, green p95 for 500 redirects to a login page.

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
