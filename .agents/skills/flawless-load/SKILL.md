---
name: flawless-load
description: Run and maintain the crust load pipes flawless-react generates — routes.pipes, LOAD_BASE pointing at a production build, LOAD_AUTH as a header line, routes.setup.ts seeding LOAD_<PARAM> ids and proving the session, last-/baseline-<name>.json gating, and the anti-vacuous probes that decide whether a p95 describes a route or a login page. Use right before running `flawless:load`, when pipes report suspiciously fast p95s, when a run exits on the auth probe, or when a baseline needs arming. For route specs and the e2e login see flawless-e2e.
---

# flawless load pipes

```bash
bunx @lariocpt/flawless-react "src/app/**/page.tsx" --nextjs . --tasks load
```

`load` writes `flawless/load/routes.pipes` — crust pipelines for the analysed page
routes plus the GET endpoints the page's components actually fetch (mutations are
excluded on purpose). Crust runs them; nothing in this repo does.

Measuring anything but the real, production app is fiction, and every vacuous pass
in this plane comes from forgetting that: an unauthenticated dashboard request 302s
to a login page that answers **200**, so every pipe passes.

## Run it

```bash
bun run build:web && PORT=3001 bunx next start &         # PROD build on :3001
SESSION=$(jq -r '.cookies[] | select(.name=="session").value' flawless/e2e/.auth.json)
export LOAD_BASE=http://localhost:3001
export LOAD_AUTH="cookie: session=$SESSION"
bun run flawless:load    # routes.setup.ts seeds the ids and proves the auth
```

- **`LOAD_BASE` must be a production build.** `next dev` compiles routes on demand,
  so the first request to each route measures the compiler. Check the server banner
  says `next start`. If the app's `start` script has no port flag, the default :3000
  may collide with something else on the box — `PORT=3001` wins.
- **`LOAD_AUTH` is a header line** — for a cookie session, `cookie:
  session=<value>` taken from the e2e run's `flawless/e2e/.auth.json`, not a Bearer
  token. The e2e run is the cheapest way to get a real one: see flawless-e2e.

## `routes.setup.ts`: the module that refuses

You no longer source `env.sh`. `flawless/load/routes.setup.ts` runs first (crust
awaits a pipes file's sibling setup module), seeds every `LOAD_<PARAM>` from
`flawless/e2e/params.json`, and throws if it seeded none. The shell version needed
`jq` and, without it, exported nothing *silently* while 2/3 of the pipes measured
the 404 handler. The module has one failure mode and it is loud.

The same module probes every static route and **throws if one lands somewhere
else** — an expired cookie redirects to a login page that answers 200, so `expect
200` passes and the whole file reports healthy percentiles for a login form.
Measured, before the probe existed: 20/20 status 200, p50 19.7ms, exit 0, every
request served /login. A by-design redirect goes under `landing` in params.json.

The module is **write-once** — replace it with a check that knows your app and
nothing will overwrite yours.

## The probes, before you trust a number

A load pipe carries no landing assertion of its own (an e2e spec does) and crust
will happily report a fast, green p95 for 500 redirects.

```bash
echo "$LOAD_ID"                                   # must be non-empty
curl -s -H "$LOAD_AUTH" "$LOAD_BASE/dashboard/buildings/$LOAD_ID" | grep -ci "login"
```

The curl must return real page HTML (tens of KB) and the grep must find no login
form. The same trap wears a second face **after** the run: a pipe whose p95 is
suspiciously fast is measuring the 404 handler or a redirect, not the route. Real
SSR routes on a dev box sit around 10–15 ms p95, not 2 ms.

## Baselines

Each pipe gates p95 against `baseline-<name>.json`; a missing baseline is a pass by
design — the first run arms it. Arm one by copying a good `last-<name>.json`; after
that, a run fails when p95 doubles.

Refresh a baseline only when you can explain the shift in the commit body, and never
refresh a batch of them to make a red run green.

## Regenerating

`--force` **merges** `flawless/load/routes.pipes` rather than overwriting: edited
rates, hand-added flows, and pipes you commented out yourself all survive. A pipe
whose ids are unfilled is emitted **commented out**, above a line naming which key
in `flawless/e2e/params.json` to fill — a blank segment measures the app's 404
handler. The task summary reports live versus commented counts, so REPORT.md cannot
call a gated pipe covered.

## Under `--expo`

`load` RUNS under `--expo` since wave 7 — **API pipes only**. An Expo app has no
server-rendered page routes, so the pipes are the GET endpoints the screens hit,
harvested ONE hop through the app's fetch wrapper (screen → `listBuildings()` →
`apiFetch("/api/buildings")`; a bare `fetch()` never exists in a screen, so the
direct harvest finds 0).

- `LOAD_BASE` points at the **API**, not Metro — Metro serves the UI, not the
  endpoints.
- `LOAD_AUTH` is a bearer or cookie header for that API.
- The write-once `routes.setup.ts` here probes a parameterless GET endpoint and
  fails on a **401**, not on a redirect: an API 401 keeps the URL, so the
  page-route redirect probe would pass vacuously on a dead session.

Mutations are excluded by default here too. See flawless-expo for the native plane's
other differences.

## Never

- Never run pipes against `next dev`, or without the curl probe.
- Never read "N pipes pass" as meaning anything until `$LOAD_ID` was proven
  non-empty and the probe returned authed content.
- Never refresh a baseline without explaining the shift where the next reader will
  find it.
