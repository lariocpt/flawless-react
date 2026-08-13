import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractRootTag } from "../src/analyse/extractRootTag.ts";
import { extractStaticText } from "../src/analyse/extractStaticText.ts";
import { analyse } from "../src/analyse/index.ts";
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

/**
 * These go through analyse() rather than the extractors directly, because the
 * point is the RenderEnv it builds: the props and useState values the generated
 * spec will actually pass.
 */
describe("initial-render analysis", () => {
  async function entryOf(fixture: string) {
    const t = await analyse({
      entry: path.join(FIXTURES, fixture),
      depth: 0,
      includeChildren: false,
    });
    return t.entry;
  }

  test("a decidable useState guard describes the branch that actually mounts", async () => {
    // useState(false) + `if (!open) return <button>` means the collapsed trigger
    // is what renders. Reading the tail return instead produced eight assertions
    // about markup the spec never creates — twelve red tests in the dogfood app.
    const e = await entryOf("GatedBranch.tsx");
    expect(e.staticText).toEqual(["Record payment"]);
    expect(e.staticText).not.toContain("Amount due");
  });

  test("a local const folded from a prop decides a ternary below it", async () => {
    const e = await entryOf("ConditionalField.tsx");
    expect(e.staticText).toEqual(["Always here"]);
    expect(e.rootTag).toBe("div");
  });

  test("an undecidable guard returning content yields no answer at all", async () => {
    const e = await entryOf("UndecidableGuard.tsx");
    expect(e.staticText).toEqual([]);
    expect(e.rootTag).toBeUndefined();
  });

  test("an undecidable guard returning null still describes the tail", async () => {
    // Bailing here would delete working assertions from every component that
    // guards on a prop whose type could not be resolved.
    const e = await entryOf("EarlyReturn.tsx");
    expect(e.staticText).toEqual(["Hi there"]);
    expect(e.rootTag).toBe("p");
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
