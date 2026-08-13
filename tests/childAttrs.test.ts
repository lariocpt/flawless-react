import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractChildAttrs } from "../src/analyse/extractChildAttrs.ts";
import { parseFile } from "../src/analyse/parseFile.ts";
import type { ChildAttrInfo } from "../src/types.ts";

const UNSTABLE = path.resolve(__dirname, "fixtures/UnstableParent.tsx");
const LEAF = path.resolve(__dirname, "fixtures/StableLeaf.tsx");

async function attrsOf(fixture: string): Promise<ChildAttrInfo[]> {
  const parsed = await parseFile(fixture);
  const unit = parsed.components[0];
  if (!unit) throw new Error(`no component parsed from ${fixture}`);
  return extractChildAttrs(unit.bodyNode, parsed.sourceFile);
}

function cardAttr(attrs: ChildAttrInfo[], name: string): ChildAttrInfo | undefined {
  return attrs.find((a) => a.tag === "Card" && a.attr === name);
}

describe("extractChildAttrs", () => {
  test("object-literal / arrow / array-literal kinds with real positions", async () => {
    const attrs = await attrsOf(UNSTABLE);
    const style = cardAttr(attrs, "style");
    const onPick = cardAttr(attrs, "onPick");
    const items = cardAttr(attrs, "items");
    expect(style?.valueKind).toBe("object-literal");
    expect(onPick?.valueKind).toBe("arrow");
    expect(items?.valueKind).toBe("array-literal");
    expect(style?.pos).toEqual({ file: UNSTABLE, line: 34, column: 9 });
    expect(onPick?.pos).toEqual({ file: UNSTABLE, line: 35, column: 9 });
    expect(items?.pos).toEqual({ file: UNSTABLE, line: 36, column: 9 });
  });

  test("identifier vs member: identifier field is the ROOT identifier", async () => {
    const attrs = await attrsOf(UNSTABLE);
    const title = cardAttr(attrs, "title");
    expect(title?.valueKind).toBe("identifier");
    expect(title?.identifier).toBe("title");
    const user = cardAttr(attrs, "user");
    expect(user?.valueKind).toBe("member");
    expect(user?.identifier).toBe("user");
  });

  test('spread attribute is recorded as "...spread"', async () => {
    const attrs = await attrsOf(UNSTABLE);
    const spreads = attrs.filter((a) => a.valueKind === "spread");
    expect(spreads).toHaveLength(1);
    expect(spreads[0]?.tag).toBe("Card");
    expect(spreads[0]?.attr).toBe("...spread");
    expect(spreads[0]?.pos.line).toBe(43);
  });

  test("bare attr → boolean-true; number / jsx / string kinds classified", async () => {
    const attrs = await attrsOf(UNSTABLE);
    expect(cardAttr(attrs, "enabled")?.valueKind).toBe("boolean-true");
    expect(cardAttr(attrs, "count")?.valueKind).toBe("number");
    expect(cardAttr(attrs, "render")?.valueKind).toBe("jsx");
    expect(cardAttr(attrs, "variant")?.valueKind).toBe("string");
  });

  test("lowercase host elements produce no entries", async () => {
    const attrs = await attrsOf(UNSTABLE);
    // div className, button type/onClick, and the <b> inside render={...}
    // must all be ignored: only component tags are recorded.
    expect(new Set(attrs.map((a) => a.tag))).toEqual(new Set(["Card", "StableLeaf"]));
  });

  test("StableLeaf attrs are all identifier kind", async () => {
    const attrs = await attrsOf(UNSTABLE);
    const leaf = attrs.filter((a) => a.tag === "StableLeaf");
    expect(leaf.map((a) => a.attr)).toEqual(["title", "count"]);
    expect(leaf.map((a) => a.valueKind)).toEqual(["identifier", "identifier"]);
    expect(leaf.map((a) => a.identifier)).toEqual(["title", "count"]);
  });

  test("StableLeaf itself renders only host elements → no entries", async () => {
    const attrs = await attrsOf(LEAF);
    expect(attrs).toEqual([]);
  });
});
