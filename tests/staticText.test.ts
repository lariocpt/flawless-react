import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractRootTag } from "../src/analyse/extractRootTag.ts";
import { extractStaticText } from "../src/analyse/extractStaticText.ts";
import { type ParsedComponentUnit, parseFile } from "../src/analyse/parseFile.ts";

const FIXTURES = path.resolve(__dirname, "fixtures/text");

async function unitOf(fixture: string, componentName?: string): Promise<ParsedComponentUnit> {
  const parsed = await parseFile(path.join(FIXTURES, fixture));
  const unit = componentName
    ? parsed.components.find((c) => c.componentName === componentName)
    : parsed.components[0];
  if (!unit) throw new Error(`${fixture}: no component named ${componentName ?? "(primary)"}`);
  return unit;
}

async function textOf(fixture: string, componentName?: string): Promise<string[]> {
  return extractStaticText((await unitOf(fixture, componentName)).bodyNode);
}

async function rootTagOf(fixture: string, componentName?: string): Promise<string | undefined> {
  return extractRootTag((await unitOf(fixture, componentName)).bodyNode);
}

describe("extractStaticText", () => {
  test("keeps only unconditional sole-child copy", async () => {
    // "From" is dropped by the sole-child rule (its <p> also holds <em>), "·"
    // and "→ →" by the punctuation filter, the ternary/map copy by the path
    // predicate, and the aria-label by the JsxAttribute exclusion.
    expect(await textOf("StaticCopy.tsx")).toEqual(["Recent activity", "Asha", "Refresh brief"]);
  });

  test("ignores early-return guard paths, reading only the tail return", async () => {
    expect(await textOf("EarlyReturn.tsx")).toEqual(["Hi there"]);
  });

  test("bails when the last statement is not a JSX return", async () => {
    expect(await textOf("NoStaticText.tsx")).toEqual([]);
  });

  test("dedupes and caps at 8", async () => {
    const text = await textOf("ManyLines.tsx");
    expect(text).toEqual([
      "Alpha heading",
      "Bravo body",
      "Charlie body",
      "Delta body",
      "Echo body",
      "Foxtrot body",
      "Golf body",
      "Hotel body",
    ]);
  });

  test("reads a fragment root, which has no root tag of its own", async () => {
    expect(await textOf("AmbiguousRoot.tsx", "FragmentRoot")).toEqual(["Fragment heading"]);
  });
});

describe("extractRootTag", () => {
  test("lowercase host root, tolerating a `return null` guard", async () => {
    expect(await rootTagOf("StaticCopy.tsx")).toBe("section");
    expect(await rootTagOf("EarlyReturn.tsx")).toBe("p");
  });

  test("undefined when a second return renders a different root", async () => {
    expect(await rootTagOf("AmbiguousRoot.tsx", "AmbiguousRoot")).toBeUndefined();
  });

  test("undefined for a fragment root", async () => {
    expect(await rootTagOf("AmbiguousRoot.tsx", "FragmentRoot")).toBeUndefined();
  });

  test("undefined for a qualified tag and for a non-JSX tail return", async () => {
    expect(await rootTagOf("AmbiguousRoot.tsx", "QualifiedRoot")).toBeUndefined();
    expect(await rootTagOf("NoStaticText.tsx")).toBeUndefined();
  });
});
