import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { loadLocalSpec } from "../src/nextjs/liveSpec.ts";
import { renderMswHandlers } from "../src/nextjs/mswHandlers.ts";
import type { FetchCallInfo, NextjsApiRoute } from "../src/types.ts";

/**
 * The handler the generator emits has to match the URL the component fetches.
 *
 * These are two independent halves of this tool: `toMswPath` rewrites an
 * OpenAPI `{id}` into MSW's `:id`, while `extractDataDeps` turns a template
 * literal `` fetch(`/api/items/${id}`) `` into `/api/items/:id`. Nothing
 * compared them. Existing coverage asserts the emitted TEXT contains a handler
 * line — which is true of a handler that matches nothing.
 *
 * That failure is silent by construction. A non-matching MSW handler is not an
 * error: the request falls through to the network. The generated host makes it
 * quieter still, booting MSW in a try/catch that warns and continues (see
 * "MSW did not start" in scaffold/templates.ts), so a spec goes green while
 * measuring live data.
 *
 * WHAT STAYS GREEN WHILE THE SUITE BREAKS: if msw ever changes how it parses
 * `:id`, every case here still passes and every generated suite stops
 * intercepting. Nothing below runs msw. Serving the handlers for real would need
 * it as a devDependency, and the install measured 578s against this repo's
 * registry — a recurring cost on both CI stages, which run `bun install
 * --frozen-lockfile` in a cold container. That was judged not worth it for a
 * documented, stable syntax. What these cases DO catch is the two halves
 * drifting apart, which is the change this repo actually makes.
 */

const FIXTURES = path.resolve(__dirname, "fixtures");
const SPEC = path.join(FIXTURES, "nextapp", "openapi.json");

/** The paths of the handlers actually emitted, read back out of the source. */
function emittedHandlerPaths(src: string): Array<{ verb: string; path: string }> {
  const out: Array<{ verb: string; path: string }> = [];
  for (const m of src.matchAll(/http\.(\w+)\("([^"]+)"/g)) {
    out.push({ verb: m[1] as string, path: m[2] as string });
  }
  return out;
}

/**
 * Segment-wise match, which is what MSW's `:param` means.
 *
 * Deliberately NOT a string comparison: the two halves name their parameters
 * from different sources — the spec says `{id}`, a component's template literal
 * says whatever the variable was called — so `/api/items/:id` and
 * `/api/items/:itemId` describe the same endpoint and must both match.
 */
function pathMatches(handlerPath: string, fetchUrl: string): boolean {
  const h = handlerPath.split("/");
  const f = fetchUrl.split("/");
  if (h.length !== f.length) return false;
  return h.every((seg, i) => seg.startsWith(":") || f[i]?.startsWith(":") || seg === f[i]);
}

const getFetches = async (fixture: string): Promise<FetchCallInfo[]> => {
  const tree = await analyse({
    entry: path.join(FIXTURES, fixture),
    depth: 0,
    includeChildren: false,
  });
  return (tree.entry.fetchCalls ?? []).filter((f) => f.method === "GET");
};

const specRoutes = async (): Promise<NextjsApiRoute[]> => {
  // loadLocalSpec swallows a read/parse failure and returns undefined, so a
  // wrong path here would silently yield zero routes and every property below
  // would pass over an empty set.
  const loaded = await loadLocalSpec(SPEC);
  expect(loaded, `${SPEC} loaded`).toBeDefined();
  const routes = (loaded as { routes: NextjsApiRoute[] }).routes;
  expect(routes.length, "the spec declares routes").toBeGreaterThan(0);
  expect(
    routes.some((r) => r.path.includes("{")),
    "the spec declares a PARAMETERISED path — without one the {id} to :id rewrite is never exercised",
  ).toBe(true);
  return routes;
};

const handlers = async (): Promise<Array<{ verb: string; path: string }>> => {
  const emitted = emittedHandlerPaths(renderMswHandlers(await specRoutes()));
  expect(emitted.length, "the spec produced handlers to check").toBeGreaterThan(0);
  return emitted;
};

describe("an emitted MSW handler matches the URL a component fetches", () => {
  test("no OpenAPI brace survives into a handler path", () => {
    // `{id}` reaches msw as a literal segment and matches nothing, which is the
    // whole failure in one character.
    return handlers().then((emitted) => {
      for (const h of emitted) {
        expect(h.path, `${h.verb} ${h.path} is MSW-shaped`).not.toContain("{");
        expect(h.path).not.toContain("}");
      }
    });
  });

  test("the URL EffectsDemo fetches is covered by a handler", async () => {
    // EffectsDemo does fetch(`/api/items/${id}`) → /api/items/:id, and the spec
    // declares /api/items/{id}. Two different halves of the tool, one endpoint.
    const fetches = await getFetches("EffectsDemo.tsx");
    expect(fetches.length, "the fixture still makes a GET").toBeGreaterThan(0);
    const emitted = await handlers();

    let parameterisedPairs = 0;
    for (const f of fetches) {
      const match = emitted.find((h) => h.verb === "get" && pathMatches(h.path, f.urlTemplate));
      expect(match, `a handler covers ${f.urlTemplate}`).toBeDefined();
      if ((match as { path: string }).path.includes(":")) parameterisedPairs += 1;
    }
    // The loop above passes vacuously if every pair is a static path — and the
    // {id} to :id rewrite is exactly the case that needs a hole to exist. This
    // asserts the rewrite was on the path actually matched, not merely present
    // somewhere in the spec.
    expect(parameterisedPairs, "a matched pair exercised a parameterised path").toBeGreaterThan(0);
  });

  test("parameter NAMES may differ between the two halves; the shape may not", async () => {
    const emitted = await handlers();
    const param = emitted.find((h) => h.path.includes(":"));
    expect(param, "the spec has a parameterised path").toBeDefined();
    const p = (param as { path: string }).path;

    // Same endpoint, different variable name in the component — must match.
    expect(pathMatches(p, p.replace(/:\w+/, ":somethingElse"))).toBe(true);
    // An extra segment is a different endpoint — must not.
    expect(pathMatches(p, `${p}/extra`)).toBe(false);
  });

  test("a fetch the spec does not declare is reported as uncovered, not quietly matched", async () => {
    // DepsBugs fetches /api/users/:userId/rows, which this spec has no path for.
    // Without this the matcher could return true for everything and every case
    // above would pass while proving nothing.
    const fetches = await getFetches("DepsBugs.tsx");
    expect(fetches.length).toBeGreaterThan(0);
    const emitted = await handlers();

    const uncovered = fetches.filter(
      (f) => !emitted.some((h) => h.verb === "get" && pathMatches(h.path, f.urlTemplate)),
    );
    expect(uncovered.length, "the unmatched fetch is detected as unmatched").toBeGreaterThan(0);
  });

  test("every declared method gets its own handler verb", async () => {
    // /api/items declares get and post; a method with no http.<verb> line is a
    // request that reaches the network with nothing said about it.
    const routes = await specRoutes();
    const emitted = await handlers();

    for (const r of routes) {
      for (const m of r.methods) {
        const verb = m.toLowerCase();
        const found = emitted.some(
          (h) =>
            h.verb === verb && h.path.replace(/:\w+/g, "*") === r.path.replace(/\{[^}]+\}/g, "*"),
        );
        expect(found, `${m} ${r.path} has a handler`).toBe(true);
      }
    }
  });
});
