// B-19's certifier: which predicates a spec may invert, decided by evaluating
// each site's condition against the very values the emitted mocks will hold —
// once at the defaults, once with a single flip applied.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyseFile, createAnalyseSharedContext } from "../src/analyse/index.ts";
import type { ComponentInfo, PredicateInversionInfo } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures/rsc");

async function infoFor(fixture: string): Promise<ComponentInfo> {
  const trees = await analyseFile(
    { entry: path.join(FIXTURES, fixture), depth: 1, includeChildren: false, roots: "exported" },
    createAnalyseSharedContext(),
  );
  const first = trees[0];
  if (!first) throw new Error(`${fixture} produced no component`);
  return first.entry;
}

function control(info: ComponentInfo, varName: string): PredicateInversionInfo {
  const c = (info.predicateInversions ?? []).find((x) => x.varName === varName);
  if (!c) throw new Error(`no inversion for ${varName}`);
  return c;
}

describe("dep-bool: a boolean-KEYWORD annotation admits false", () => {
  test("the isTrustee shape certifies with all three site forms", async () => {
    const info = await infoFor("TrusteePage.tsx");
    const c = control(info, "userIsTrustee");
    expect(c.kind).toBe("dep-bool");
    expect(c.calleeRoot).toBe("isTrusteeOf");
    expect(c.awaited).toBe(false);
    expect(c.flip).toBe(false);
    const witnesses = c.sites.map((s) => [s.trueWitness, s.falseWitness]);
    // Absence-only, paired, and call-selection — each site form survives.
    expect(witnesses).toContainEqual(["Add contractor", undefined]);
    expect(witnesses).toContainEqual(["All items", "My items"]);
    const calls = c.sites.find((s) => s.trueCallee !== undefined);
    expect(calls?.trueCallee).toBe("listAllItems");
    expect(calls?.falseCallee).toBe("listMyItems");
  });

  test("a `true` LITERAL annotation is never a candidate", async () => {
    // isManagerOf(): true — false is not a legal return, and the stored value
    // cannot tell the two apart; only the TypeNode can. Silent, not refused:
    // the detector never claimed it.
    const info = await infoFor("TrusteePage.tsx");
    expect((info.predicateInversions ?? []).some((c) => c.varName === "alwaysManager")).toBe(false);
    expect((info.predicateRefusals ?? []).some((r) => r.varName === "alwaysManager")).toBe(false);
  });

  test("a callee with two call sites refuses by name", async () => {
    // A Once-override flips only the first call — canModerate feeds two vars.
    const info = await infoFor("TrusteePage.tsx");
    const reasons = (info.predicateRefusals ?? []).map((r) => [r.varName, r.reason]);
    expect(reasons).toContainEqual(["canPost", "multi-call"]);
    expect(reasons).toContainEqual(["canPin", "multi-call"]);
  });
});

describe("dep-empty: an array dep flipped to []", () => {
  test("the empty-side literal is the flip's witness", async () => {
    const info = await infoFor("TrusteePage.tsx");
    const c = control(info, "contractors");
    expect(c.kind).toBe("dep-empty");
    expect(c.flip).toEqual([]);
    const site = c.sites[0];
    // `length === 0` is FALSE under the one-element fixture, so the baseline
    // side is false and the flip renders the true arm's literal.
    expect(site?.baselineSide).toBe(false);
    expect(site?.trueWitness).toBe("No contractors yet");
  });

  test("a collection that decides a guard through its find() result refuses", async () => {
    // GuardPolarityPage: `const mine = members.find(…); if (!mine || …)
    // notFound()` — flipping members to [] would fire that guard, and the
    // taint closure sees it through the alias.
    const info = await infoFor("GuardPolarityPage.tsx");
    const reasons = (info.predicateRefusals ?? []).map((r) => [r.varName, r.reason]);
    expect(reasons).toContainEqual(["members", "guard-entangled"]);
    expect(info.predicateInversions ?? []).toEqual([]);
  });
});

describe("dep-null: a nullable dep behind the page's only truthy guard", () => {
  test("the landing-page shape certifies", async () => {
    const info = await infoFor("SessionGatePage.tsx");
    const c = control(info, "session");
    expect(c.kind).toBe("dep-null");
    expect(c.calleeRoot).toBe("verifySession2");
    expect(c.flip).toBe(null);
    expect(c.sites).toEqual([]);
  });
});

describe("prop: the DEFAULTS decide, buildProps flips", () => {
  test("a bare optional searchParam flips to a truthy string", async () => {
    const info = await infoFor("TokenPage.tsx");
    const c = control(info, "searchParams.token");
    expect(c.kind).toBe("prop");
    expect(c.propPath).toEqual(["searchParams", "token"]);
    expect(c.flip).toBe("flawless-token");
    expect(c.sites[0]?.trueWitness).toBe("Enter a new password");
    expect(c.sites[0]?.falseWitness).toBe("This reset link is missing or malformed");
  });

  test("a literal-compared searchParam flips to the compared literal", async () => {
    const info = await infoFor("TokenPage.tsx");
    const c = control(info, "searchParams.error");
    expect(c.flip).toBe("expired");
    expect(c.sites[0]?.trueWitness).toBe("The link has expired");
  });
});
