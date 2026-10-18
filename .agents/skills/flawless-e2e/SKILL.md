---
name: flawless-e2e
description: Run and maintain flawless-react's route e2e specs against a real dev server — seeded-DB prerequisites, the global-setup login and storageState, params.json ids and `landing` overrides, FLAWLESS_E2E_BASEURL, the auth wall that 404s or serves the login page at a real path, and the landing assertion that decides whether a green e2e run tested a route. Use right before running `flawless:e2e`, when e2e fails at global setup, when every route 404s, or when a suite passes suspiciously cheaply. For load pipes and their baselines see flawless-load.
---

# flawless route e2e

Everything here runs against the **real app**: MSW cannot intercept a server
component's direct database access, so mocking it would be a lie. That realism is
also where every vacuous pass hides — a green route spec is only worth what its
landing assertion is worth.

```bash
bunx flawless-react "src/app/**/page.tsx" --nextjs . --tasks e2e
```

## Prerequisites, in order

```bash
bun run db:up && bun run db:migrate && bun run db:seed   # Postgres + seed users
bun run dev:web                                          # app on :3001
bun run flawless:e2e
```

From the suite dir, with the plane's own config and its own copy of Playwright:

```bash
node node_modules/@playwright/test/cli.js test --config e2e/playwright.config.ts
```

Running it from the app root instead is how `test.describe() called here` /
`No tests found` appear: two `@playwright/test` copies (app root + suite) and the
run picks up the wrong one.

## Signing in

`flawless/e2e/global-setup.ts` is where you sign in as the seeded user and persist
`storageState` to `e2e/.auth.json`. **What the tool emits is a stub** that writes an
empty state (so the config's `storageState` always resolves) plus a worked example.
It is write-once — never overwritten, `--force` included, because it is yours the
moment you touch it.

A filled setup should **throw if login lands back on /login**. That throw is an
anti-vacuous guard, not a bug: when it fires the seed drifted (wrong user, wrong
password, unseeded DB). Fix the seed, never the guard.

You are not relying on remembering that, though. **Every emitted route spec asserts
it landed on the route it asked for** — both the render test and the interaction
test — so an unauthenticated suite fails naming its escapes instead of quietly
testing the login screen. Until the hook is filled, REPORT.md's hand-work table
says so; the check is byte-identity against the stub, so it clears the moment you
edit the file.

**What that assertion does and does not catch**, because an overclaim here is the
same bug wearing a different hat. It catches redirects that CHANGE THE URL and have
landed by the time the spec looks — a server 3xx, and a client-side navigation that
completes before `networkidle` settles. It does **not** catch a middleware *rewrite*
that serves the login page at the requested path, a 401 body, or a redirect that
fires later than the spec waited. A 401 usually still reds the spec, but through the
console-error check, not this one.

## The auth wall, in its three shapes

The same cause — the app's own middleware (`auth.protect()`, a Clerk/next-auth
guard) with placeholder or missing credentials — surfaces one stage earlier each
time you chase it:

1. **`Timed out waiting …ms from config.webServer`, no spec ran.** Playwright calls
   a server up only on `200 ≤ status < 404` from the readiness URL, which is the app
   root; behind the wall the root 404s and Playwright retries the whole timeout
   (`[WebServer] GET / 404` repeating in the log).
2. **Every route 404s while `/` loads in a browser.** The guard is per-route and the
   root is public.
3. **Specs pass on a login page.** A rewrite keeps the path and returns 200.

There is no tool-side fix for placeholder keys. Either put real credentials in
`e2e/global-setup.ts`, or set `FLAWLESS_E2E_BASEURL` to a server you started
yourself (the emitted config drops its own `webServer` block for that — useful when
the app is already running, or when you want the wall up and provably authenticated
past), or do not claim those routes.

## ids and landings: `flawless/e2e/params.json`

Write-once and merge-kept, so `--force` never touches what you fill in. An
unresolvable id never fabricates a URL: the spec emits a `test.skip` naming the file
to fill (`no id fixture for /posts/[id] — fill flawless/e2e/params.json`), so an
unfilled route is a visible skip, not a 404 measured as a pass. On the load side the
same hole is `routes.setup.ts`, which refuses the run instead of measuring the 404
handler — see flawless-load.

The resolver (`e2e/params.ts`) tries four things, in order:

1. `FLAWLESS_E2E_<PARAM>` — per-parameter environment override, uppercased;
2. `routes[<route>][<param>]` in params.json — for a route that needs a
   **consistent set** (a building and one of its floors);
3. `defaults[<param>]` — the usual case, one seeded record;
4. `FLAWLESS_E2E_ID` — the legacy single-id escape hatch.

`landing` records a route that redirects **on purpose** (a default sub-tab, a locale
landing) so its spec asserts the real destination instead of failing forever:

  ```json
  { "landing": { "/dash": "/dash/overview" } }
  ```

Both belong in `params.json`, not in the spec: `--force` regenerates specs and
leaves this file alone.

## Contract-checked runs (optional)

Put crust's validating proxy in front and assert no response violated the OpenAPI
spec:

```bash
crust -c 'mock-server --swagger openapi.json --port 4747 --proxy http://localhost:3001' &
FLAWLESS_E2E_BASEURL=http://localhost:4747 bun run flawless:e2e
crust -c 'GET :4747/__crust/violations | (v => v.violations.filter(x => x.direction === "response")) | assert (a => a.length === 0)'
```

The filter to `direction === "response"` matters: request-direction violations are
usually the app talking to itself with fields the spec never described, and they
will drown the ones that mean the app's own output is off-contract.

## Under `--expo`

`e2e` RUNS under `--expo` since wave 6 — expo-router routes against
`expo start --web` (Metro's webPort, default 8081), authenticated against the API
origin with a **cookie** via the setup stub's request-context login + storageState
(the app short-circuits `expo-secure-store` on web and sends `credentials:
"include"`). Three differences to know:

- Set `EXPO_PUBLIC_API_URL` before running. Metro bakes it into the bundle; unset,
  the app falls back to whatever its source hardcodes — on one dogfooded LAN, a
  production container.
- Metro's statuses are REAL (unknown routes 404, per-route HTML — measured in
  `docs/reviews/2026-09-expo-probes.md`), so a 404 is a routing bug, not harness
  noise.
- Each spec carries a third test, the **copy witness** (`getByText` on the screen's
  longest analysis-proven literal), because an auth wall rendered in place keeps the
  URL and a clean-ish console. The witness is the claim that cannot be true of a
  wall.

A cold start that always lands on the login screen is a `landing` override in
params.json, not a spec edit. See flawless-expo for the rest of the native plane.

## Never

- Never weaken or delete global-setup's throw-on-/login guard.
- Never "fix" a params.json syntax error by deleting the file: an invalid file fails
  the run with `is not valid JSON — fix or delete it and re-run` precisely because a
  hand-edited file's contents are yours; repair the JSON.
- Never read "N routes pass" as meaning anything until the spec's landing assertion
  was real (a filled `params.json`, a storageState that is not the empty stub).
- Never add a `landing` override to make a red spec green without checking what it
  lands on: that is how a wall becomes permanent coverage of the login page.
