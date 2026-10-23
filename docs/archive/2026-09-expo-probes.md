# Expo mode, waves 4/6/7 — pre-flight probes

The 2026-08 probes decided waves 0–5. These decided the rest of the tail: run
2026-09-12 against `mybodycorpai/apps/mobile` at `ec86541` (post-#26, the
wave-5 a11y remediation) with the API at `apps/web` on a seeded dev database,
tool at `31eb96f` (post-#66). Same rule as the first ledger: this records what
was true on the day, and history does not get rewritten when a finding is
later fixed.

Census halves were measured by four parallel read-only sweeps over both repos;
execution halves against the real servers (`next dev -p 3001` + `expo start
--web --port 8081`) in headless chromium.

---

## W1 — does Metro serve real routes with real statuses? **Yes, both.**

`expo start --web` under SDK 54 with `web.output: "static"` answers:

```
GET /                                             200  41063B
GET /login                                        200  43860B
GET /garbage-route-xyz                            404  40536B
GET /buildings/22222222-2222-4222-8222-…000001    200  41843B
```

Per-route byte sizes and a real 404 for an unknown path — this is per-route
rendered HTML, not one SPA shell for everything. Two consequences for the e2e
design: the `status < 500` assertion keeps teeth on a dev server, and the
served HTML contains each route's copy (`/login` carries "Email", "Password",
"Sign in" ×2 in the response body), so content assertions work.

## W2 — does the wave-5 remediation reach the react-native-web DOM? **Yes.**

RNW 0.21's `createDOMProps` maps `accessibilityRole` through `propsToAriaRole`
into a real DOM `role` attribute, and `role="button"` additionally gets
keyboard focusability. Measured live: `role="button"` present in the served
`/login` HTML; on an authed building screen headless chromium counts **9
`role=button` elements**, and both remediated rungs hit —
`getByRole("button", { name: "Go back" })` = 1, `getByLabel("Go back")` = 1.
So the DOM ladder's strongest rungs work against Expo web, one wave after the
a11y remediation created the roles. (RNW logs a one-time `console.warn`
deprecation for the `accessibilityRole` spelling; warns are not errors and no
emitted assertion reads them.)

## W3 — does cookie auth work through Playwright storageState? **Yes, verbatim.**

On web the app stores no token (`readToken` short-circuits on
`Platform.OS === "web"`) and calls the API with `credentials: "include"` — the
session is a cookie on the API origin. The emitted global-setup stub's worked
example, executed as written: request-context `POST /api/auth/login` with the
seeded `trustee@demo.local` / `demodemo` → `storageState` captures
`session@localhost` → a browser context built from it renders a protected
dynamic route fully (**0 console errors**) with the seeded params.json ids
serving unchanged. CORS was already open for exactly this
(`apps/web/src/lib/api/app.ts` allows any localhost origin in dev, comment
naming Expo's :8081). One runtime caveat: Playwright request contexts break
under **Bun** (`_parseSetCookieHeader` gets a relative URL from Bun's http
shim) — irrelevant to the suite, which runs under `bunx playwright` = Node.

## W4 — what does an auth wall look like? **Two faces, both catchable.**

- Unauthenticated `/` → **client-side redirect** to `/login` (URL changes).
  The B-12 landing assertion catches it.
- Unauthenticated protected deep link → **wall rendered in place**: same URL,
  status 200, body "Unauthorized", and **2 console errors** (the API's 401s).
  The landing assertion is blind here — the console assertion and the copy
  witness are not.

This is why the expo route spec carries a third assertion the Next.js flavour
never needed: **the copy witness**, `getByText(<longest happy-path literal>)`,
the claim that cannot be true of a wall.

## W5 — the app finding: cold starts always land on /login. 

`lib/auth-store.ts` boots `status: "unauthenticated"` and nothing hydrates it —
no `getMe` probe on mount anywhere. So `goto /` bounces to `/login` even with
a valid session cookie. For e2e this is a `landing` override in params.json
(`{"landing": {"/": "/login"}}` — recorded truth, never invented); for the app
it is a real cold-start session-restore gap, surfaced by the wave before a
line of it was written. An app-side fix is the app's decision, not the tool's.

## W6 — is a real Metro render console-clean? **Yes, when authed.**

Authed `/` and an authed building screen: **0 console errors, 0 warnings**
under real Metro with NativeWind active. `expect(errors).toEqual([])` is
satisfiable on a healthy screen and fails exactly on the 401 wall — the
assertion has both directions.

## W7 — the environment trap: port 3000 is a PRODUCTION container.

`lib/api.ts` falls back to `http://localhost:3000` when `EXPO_PUBLIC_API_URL`
is unset — and on the dogfood LAN, :3000 is the production mybodycorpai
container. Metro inlines `EXPO_PUBLIC_*` at bundle time, so an unset var bakes
the wrong origin in silently. The emitted config and README both carry the
warning; the global-setup example refuses when the var is unset. The dev API
is :3001.

---

## Wave 4 (`perf-harness`, the Expo-web host) — measured and DECLINED

The census that decided it, all in-repo evidence:

- The dogfood component population is route screens: 31 of 32 files are
  expo-router routes or layouts; the one named non-route export
  (ErrorBoundary) is renderUndecidable and host-ineligible regardless.
- The host cannot mount a route screen: `useFocusEffect`/`useNavigation`/
  `useLocalSearchParams` demand a navigator; the only navigator-mounting
  machinery the tool owns (`renderRouter`'s context builder) is **jest-bound**
  (fake timers, RNTL renderer, `jest` global); the host registry's
  assumptions — JSON props through `page.evaluate`, one static provider
  wrapper, no per-component context — cannot carry a router context. A screen
  registered anyway fails with "Couldn't find a navigation object": a red spec
  on a healthy component.
- The profile click scenarios filter on `c.event === "onClick"` — an
  all-`onPress` codebase skips every click/stress scenario **with a wrong
  reason string**.
- Paint/layout honesty was already ruled out in writing in the 2026-08 probes
  ("a limitation to publish, not to hide"); API-level perf is wave 7's scope;
  the P1 `react-native → react-native-web` resolve plugin was never committed.

**Measured ceiling on the dogfood app: ~0 of 32 host-mountable components.**
A wave built against that number is engineering for a component population
this app does not have, ending in the one outcome the seam exists to refuse.
Declined per the B-15/B-26 precedent; the refusal now says so and points here.
**Revisit condition**: an adopter with a real `components/` directory of
non-route, navigator-free components — that is the population the host
architecture already serves.

## Wave 6 (expo-router e2e) — cleared, and shipped as this round

Everything above is its evidence. What transfers unchanged from the Next.js
flavour: the params.json machinery (identical bracket templates from
`expoFileToRoute`), the B-12 landing assertion and its `landing` override, the
write-once global-setup with byte-identity hand-work accounting, `--grep`
route narrowing (`GET <template>` in the describe title). What is new: Metro's
port and web script in the config, a 90s navigation timeout (first-request
bundling), the copy witness as the third anti-vacuity rung, and the
API-is-a-prerequisite split (Metro is bootable by the config; the API is not
knowable by the tool).

## Wave 7 (API-only load pipes) — LANDED 2026-09-12

Shipped as the numbers below predicted. The one-hop harvest
(`src/analyse/harvestApiEndpoints.ts`, retained on `ComponentInfo.apiCalls`,
native-only) measured **30 GET endpoints across 28/31 screens** on apps/mobile
— close to the projected 34; the ~4 gap is store-mediated calls the one-hop
trace does not follow (a v2 note). The `--expo` load engine
(`src/tasks/loadExpo.ts`) reuses the Next pipe/params/env/merge machinery
verbatim and differs only in the two places it must: API targets rather than
page routes, and a `routes.setup.ts` that fails on a **401** (an API endpoint
keeps its URL on a dead session, so the redirect probe would pass vacuously). A
query-string interpolation (`…/invoices${scope?…:""}`) is truncated to its base
path instead of emitting a bogus `:q` hole. The original design numbers, for the
record:

- **Today's harvest yields 0 endpoints on the dogfood app.** `fetchCalls` is
  direct-`fetch`-in-component only; every mobile call goes through
  `lib/api.ts` (`component → listX() → apiFetch() → fetch()`, two levels, and
  `apiFetch`'s own URL is the useless template `:BASE_URL:path`). Zero direct
  fetches under `app/**`. The wave therefore needs a one-hop module harvest:
  each imported-and-called api function's body carries a literal/template
  path at its `apiFetch(...)` call site.
- **Ceiling with that harvest: 34 unique GET paths** (35 GET functions;
  `/api/me` shared), of which **26 are load-tested nowhere today** (8 covered:
  2 by the web flawless pipes, 7 by the hand-written `crust/load/read-paths.pipes`,
  one shared).
- What "API-only" drops: the page-route pipes (`pageFileToRoute` is
  Next-specific and an Expo app has no server-rendered routes) and the
  route-guard half of `routes.setup.ts`.
- Auth precedent already in-repo: `crust/load/read-paths.setup.ts` mints its
  own trustee + Bearer token via fixture factories — no pasted secrets — and
  the pipes header's `LOAD_AUTH` contract is already scheme-agnostic.
