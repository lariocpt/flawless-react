import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractHooks } from "../src/analyse/extractHooks.ts";
import { extractProps } from "../src/analyse/extractProps.ts";
import { analyse } from "../src/analyse/index.ts";
import { parseFile } from "../src/analyse/parseFile.ts";

const HELLO = path.resolve(__dirname, "fixtures/Hello.tsx");
const DASHBOARD = path.resolve(__dirname, "fixtures/Dashboard.tsx");
const CARD = path.resolve(__dirname, "fixtures/Card.tsx");

describe("parseFile", () => {
  test("locates React.FC component + props type ref", async () => {
    const r = await parseFile(HELLO);
    expect(r.componentName).toBe("Hello");
    expect(r.propsTypeRef).toBeDefined();
    expect(r.imports.has("useState")).toBe(true);
  });

  test("throws helpfully on a non-component file", async () => {
    const empty = path.resolve(__dirname, "fixtures/_empty.tsx");
    await Bun.write(empty, "export const x = 1;\n");
    try {
      await parseFile(empty);
      throw new Error("expected parseFile to throw");
    } catch (err) {
      expect((err as Error).message).toContain("could not locate a React component");
    }
  });
});

describe("extractProps", () => {
  test("Hello → string/number/boolean/union(literal) defaults + variants", async () => {
    const parsed = await parseFile(HELLO);
    const r = extractProps(parsed.sourceFile, parsed.propsTypeRef);
    expect(r.propsShape).toEqual({
      name: "",
      count: 0,
      active: false,
      variant: "primary",
    });
    expect(r.unresolvedProps).toEqual([]);
    // Variants generated for the union prop ("variant"): both "primary" and "secondary".
    const variantValues = r.variants.map((v) => v.variant);
    expect(variantValues).toContain("primary");
    expect(variantValues).toContain("secondary");
  });
});

describe("extractHooks", () => {
  test("Hello → useState", async () => {
    const parsed = await parseFile(HELLO);
    const hooks = extractHooks(parsed.bodyNode);
    expect(hooks).toEqual(["useState"]);
  });

  test("Card → useEffect + useState", async () => {
    const parsed = await parseFile(CARD);
    const hooks = extractHooks(parsed.bodyNode);
    expect(hooks).toEqual(["useEffect", "useState"]);
  });
});

describe("analyse (full tree)", () => {
  test("leaf component, depth 0", async () => {
    const t = await analyse({ entry: HELLO, depth: 0, includeChildren: true });
    expect(t.entry.componentName).toBe("Hello");
    expect(t.children).toEqual([]);
  });

  test("composite component, depth 3", async () => {
    const t = await analyse({ entry: DASHBOARD, depth: 3, includeChildren: true });
    expect(t.entry.componentName).toBe("Dashboard");
    const childNames = t.children.map((c) => c.entry.componentName).sort();
    expect(childNames).toEqual(["Card", "Hello"]);
    expect(t.entry.hooks).toContain("useMemo");
  });

  test("--include-children=false suppresses recursion", async () => {
    const t = await analyse({ entry: DASHBOARD, depth: 3, includeChildren: false });
    expect(t.children).toEqual([]);
  });
});
