// A Next page's route params, and the two mock defects that kept twenty-two of
// the dogfood app's thirty-two page specs from rendering anything at all.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyseFile, createAnalyseSharedContext } from "../src/analyse/index.ts";
import { withRouteParams } from "../src/scaffold-tests/registry.ts";
import type { ComponentInfo } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures/rsc");

describe("withRouteParams", () => {
  test("an empty-string segment becomes a real value", () => {
    // Next does not match a dynamic segment against "", so `{ id: "" }` is a
    // request that cannot happen — and the pages act like it: the lookup finds
    // nothing, notFound() fires, and the spec records the guard exit as a pass.
    expect(withRouteParams({ params: { id: "" } })).toEqual({ params: { id: "flawless-id" } });
  });

  test("a catch-all's empty array becomes one segment", () => {
    expect(withRouteParams({ params: { slug: [] } })).toEqual({
      params: { slug: ["flawless-slug"] },
    });
  });

  test("a value the analyser resolved is left alone — it is evidence", () => {
    expect(withRouteParams({ params: { status: "draft", id: "" } })).toEqual({
      params: { status: "draft", id: "flawless-id" },
    });
  });

  test("only params — an empty string elsewhere is a legitimate default", () => {
    // mapType's "" for a string prop is right for a caption or a placeholder.
    // This function exists because it is never right for a route segment.
    expect(withRouteParams({ label: "", params: { id: "" } })).toEqual({
      label: "",
      params: { id: "flawless-id" },
    });
  });

  test("no params, or a non-object params, passes through untouched", () => {
    expect(withRouteParams({ label: "" })).toEqual({ label: "" });
    expect(withRouteParams({ params: "x" })).toEqual({ params: "x" });
  });

  test("the same object comes back when nothing changed — no needless churn", () => {
    const shape = { params: { id: "abc" } };
    expect(withRouteParams(shape)).toBe(shape);
  });
});

describe("a helper's own return annotation reaches its mock", () => {
  async function infoFor(fixture: string): Promise<ComponentInfo> {
    const trees = await analyseFile(
      { entry: path.join(FIXTURES, fixture), depth: 1, includeChildren: false, roots: "exported" },
      createAnalyseSharedContext(),
    );
    const first = trees[0];
    if (!first) throw new Error(`${fixture} produced no component`);
    return first.entry;
  }

  test("a SYNC helper called inside JSX is recorded sync, with its real value", async () => {
    // `formatZAR(cents: number): string` was stubbed `vi.fn(async () => ({}))`:
    // asynchronous for a synchronous function, and an object where the page
    // renders a string. It never became a dataDep because it is called inside
    // JSX rather than awaited into a variable, so nothing looked at it.
    const info = await infoFor("MembershipGuardPage.tsx");
    const mi = (info.moduleImports ?? []).find((m) => m.specifier === "./data-helpers.ts");
    expect(mi).toBeDefined();
    const r = mi?.importedReturns?.formatMoney;
    expect(r).toBeDefined();
    expect(r?.sync).toBe(true);
    // resolveTypeNodeValue seeds every caller with "value"; what matters here
    // is that it is a STRING rather than the `{}` the blind stub emitted.
    expect(r?.value).toBe("flawless-value");
  });

  test("an ASYNC helper is recorded async", async () => {
    const info = await infoFor("MembershipGuardPage.tsx");
    const mi = (info.moduleImports ?? []).find((m) => m.specifier === "./data-helpers.ts");
    const r = mi?.importedReturns?.listMembershipsForUser;
    expect(r?.sync).toBe(false);
  });

  test("a Promise<void> helper is absent — undefined is its realistic value", async () => {
    // Present, it would mock to a value the function does not return; recorded
    // as a gap, it would carry "give this a realistic return value" for a
    // function that returns nothing.
    const info = await infoFor("MembershipGuardPage.tsx");
    const mi = (info.moduleImports ?? []).find((m) => m.specifier === "./data-helpers.ts");
    expect(mi?.importedReturns && "recordVisit" in mi.importedReturns).toBe(false);
  });
});
