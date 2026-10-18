---
name: flawless-api-fixtures
description: Give flawless-react real API data — `--api` with an OpenAPI/Swagger file, `--swagger-url` against a live docs endpoint (including the automatic `--nextjs` probe and `--swagger-url=off`), the MSW handlers and `swagger.json` it writes and which of them survive a re-run, how a body is synthesised when the spec has no example, and the four fetch cases every generated spec carries. Use when generated fixtures are empty `{}`, when a component's fetch is not matched by a handler, when a spec should assert loading or empty-state copy, or when deciding between mocking in specs and running a real backend. For the programmatic API (`runFlawless`, `analyse`) see flawless-api.
---

# flawless API fixtures

Two different things live in this repo's vocabulary and mixing them up wastes an
hour: **MSW handlers** (`flawless/mocks/`), which intercept `fetch` inside the unit
and browser planes, and the **mock server** (`flawless/mock/`), a Bun server you can
point an app at. Both are derived from the same source: your OpenAPI spec, when the
tool can get one.

## Getting a spec

```bash
bunx flawless-react "src/app/dashboard/page.tsx" --nextjs . --api openapi.json --swagger-url=off
```

- **`--api <file>`** — a spec on disk. The value is required and must be a path.
- **`--swagger-url <url>`** — fetch it from a running app (the docs help names
  `http://localhost:3000/api/docs` from `next-swagger-doc`). A spec obtained this way
  is **preferred over static AST inference**.
- In `--nextjs` mode that URL is **probed automatically**, with a 1.5 s timeout, so a
  docs-enabled app needs no flag at all. The probe never throws: a non-2xx, a
  non-JSON content type, or a dead port is reported and the run continues on inferred
  routes. `--swagger-url` forces a different URL; `--swagger-url=off` skips the probe
  — do that when the app under test is slow to boot, or when a *different* app's docs
  endpoint is listening on 3000.
- **With no spec at all**, the tool walks `app/**/api/**/route.ts` and derives routes
  from it — useless for a catch-all API (Hono, tRPC), which is exactly the case
  `--api` exists for.

A spec obtained by either route is written **verbatim** to `flawless/swagger.json`;
without one, that file is **derived from the inferred routes and rewritten every
run**.

## What is written, and what survives a re-run

| file | refresh behaviour |
| --- | --- |
| `flawless/swagger.json` | rewritten every run |
| `flawless/mocks/handlers.ts` | **written once, never overwritten — not by `--force` either** |
| `mocks/browser.ts`, `mocks/node.ts`, `mocks/README.md` | written once, refreshed by `--force` |
| `flawless/mock/server.ts` | only with `--api`: rewritten each run |
| `flawless/mock/routes.ts` | only with `--api`: written once (hand-tuned bodies can't be rebuilt from the spec) |

The handlers file is the one you edit. Its header says so, and it is the reason a
spec with a `{}` body can be fixed once and stay fixed.

How the three MSW entry points wire up:

- **Vitest** — `setupServer` from `mocks/node.ts`, started in `flawless/setup.ts`, so
  a component's `fetch` hits your mock responses in jsdom.
- **Browser specs and the perf host** — `host/main.tsx` calls `startMockWorker()`
  from `mocks/browser.ts` before mounting; a service worker intercepts page `fetch`.
- **Server components, server actions, SSR** — not covered by either. When you run
  against a real Next dev server, wire your own instrumentation to import
  `mocks/node.ts`. The honest reason `e2e` runs against the real app: MSW cannot
  intercept a server component's direct database access, and mocking that would be a
  lie (flawless-e2e).

## Where a fixture body comes from

Per response media type, in order: `example`, then the first `examples[*].value`,
then a body **synthesised from the schema**. Synthesis is literal and worth knowing,
because it explains most empty-looking specs:

- `object` → every property, recursively; `array` → **exactly one item**;
- `string` → `""`, except `format: date-time` → `1970-01-01T00:00:00.000Z`;
- `integer`/`number` → `0`; `boolean` → `false`; `enum` → its **first** member;
- `allOf` → the branches merged into one object;
- `$ref` → resolved **only for local `#/…` refs**; a cycle or an external ref yields
  `null` for that property.
- Response selection prefers a coded status; a `default` response is used last and
  counted as 200.

So `{ id: 0, createdAt: "1970-01-01T00:00:00.000Z", items: [ … ] }` is not a bug — it
is a spec with no examples. The fix is `examples` in the spec, or hand-editing
`mocks/handlers.ts` (which nothing will overwrite), or both.

When a component's endpoint has no derivable body, the generated spec says so in
place:

```
// TODO(flawless): no example found in the API spec — replace {} with a realistic fixture.
```

## What every fetch generates

One `describe("<Component> GET /api/items")` per detected fetch, with four cases:

1. **success** — `server.use(http.get(URL, …))` returning `FIXTURE`, plus a call
   counter so the spec can prove the request happened;
2. **loading** — the same handler behind `delay(150)`, ending in
   `TODO(flawless): assert the loading indicator while the response is pending.`;
3. **error** — `new HttpResponse(null, { status: 500 })`, asserting the component
   survives;
4. **empty** — `FIXTURE` with **the envelope preserved and every array member
   emptied** (`{ items: [] }`, not `[]`), ending in `TODO(flawless): assert the
   empty-state copy.`

The loading and empty assertions are the intended hardening work: the harness proves
the state is reachable, you say what the state looks like.

Path parameters are handled before any of that. A URL hole that corresponds to a
**prop** is filled with `test-<hole>` at render time, because the prop's synthesised
default is `""` and `/api/x//y` never matches a `:param` handler — the request would
silently miss every handler in the file.

Handler matching is **param-name-agnostic**: `/api/x/{id}/y`, `/api/x/:id/y` and
`/api/x/:buildingId/y` are the same shape. So a spec that asks for
`:buildingId` is satisfied by a route declared `{id}`.

## The mock server

With `--api` (a file, not a live probe — `--swagger-url` enriches routes and
`swagger.json` but scaffolds no server), `flawless/mock/` is scaffolded too: `bun
mock/server.ts` serves on `127.0.0.1:${MOCK_PORT:-5174}` (default 5174), compiling
OpenAPI templates (`/users/{id}`) into matchers, and answering anything it does not
know with

```json
{ "error": "not mocked", "method": "POST", "path": "/api/orders" }
```

That 404 body is the diagnostic: a run that behaves oddly against the mock and
correctly against the real API is missing routes in `mock/routes.ts`, not broken
components. Two limits to keep in view: **`routes.ts` is never rewritten** (your
hand-tuned bodies are yours), and **the response body is static** — a path parameter
is captured but does not change the answer, so `/users/1` and `/users/2` return the
same document. Anything where the id must change the response belongs in a handler
you write, or in a real backend.

## Never

- Never read a `{}` fixture as "the tool generated nothing": it means the spec had no
  example. Add `examples`, or fill the handler.
- Never rely on MSW in the unit plane to prove what a server component renders —
  server-side data access is not interceptable there.
- Never let the loading and empty-state TODOs stand while claiming the fetch path is
  covered: the states are reached, not asserted.
- Never treat the mock server as contract validation. For violation reporting, put
  crust's validating proxy in front of the real app (flawless-e2e).
