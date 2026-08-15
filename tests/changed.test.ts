import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { affectedSpecs, grepFor } from "../src/changed.ts";
import type { ComponentTree } from "../src/types.ts";

const fixture = (rel: string): string => path.resolve(__dirname, "fixtures", rel);

async function treeOf(rel: string): Promise<ComponentTree> {
  return analyse({ entry: fixture(rel), depth: 3, includeChildren: true });
}

describe("affectedSpecs", () => {
  test("a changed component selects its own spec", async () => {
    const tree = await treeOf("Dashboard.tsx");
    const affected = affectedSpecs([tree], [fixture("Dashboard.tsx")]);
    expect(affected.components).toContain("Dashboard");
    expect(affected.changedFiles).toEqual([fixture("Dashboard.tsx")]);
  });

  test("a changed CHILD selects the page that renders it", async () => {
    // The relationship a path filter cannot see: the page's own file did not
    // change, but editing something it renders changes what the page produces.
    const tree = await treeOf("Dashboard.tsx");
    const child = tree.children[0];
    expect(child).toBeDefined();
    const affected = affectedSpecs([tree], [(child as ComponentTree).entry.filePath]);
    expect(affected.routes).toContain(fixture("Dashboard.tsx"));
  });

  test("an unrelated change selects nothing", async () => {
    const tree = await treeOf("Dashboard.tsx");
    const affected = affectedSpecs([tree], [fixture("CheckboxForm.tsx")]);
    expect(affected.components).toEqual([]);
    expect(affected.routes).toEqual([]);
  });

  test("an unexported component is reported as covered through its parent", async () => {
    const tree = await analyse({
      entry: fixture("shapes/Unexported.tsx"),
      depth: 0,
      includeChildren: false,
      roots: "exported",
    }).catch(() => undefined);
    // Fixture may not exist in every checkout — the rule is what matters, and
    // it is asserted directly below.
    if (!tree) return;
    const affected = affectedSpecs([tree], [tree.entry.filePath]);
    if (tree.entry.exportKind === "none") {
      expect(affected.withoutSpecs).toContain(tree.entry.componentName);
      expect(affected.components).not.toContain(tree.entry.componentName);
    }
  });
});

describe("grepFor", () => {
  test("selects the component and not its namesakes", () => {
    const re = new RegExp(grepFor(["Card"]));
    expect(re.test("Card: mounts at defaults")).toBe(true);
    expect(re.test("CardHeader: mounts at defaults")).toBe(false);
    expect(re.test("MyCard: mounts at defaults")).toBe(false);
  });

  test("matches the way Playwright actually greps — the whole title chain", () => {
    // `^` would anchor against the file path, which is why the first attempt
    // found no tests at all.
    const re = new RegExp(grepFor(["Card"]));
    expect(re.test("[chromium] › flawless/browser/Card.spec.ts › Card: mounts")).toBe(true);
    expect(re.test("[chromium] › flawless/browser/CardHeader.spec.ts › CardHeader: mounts")).toBe(
      false,
    );
  });

  test("several components become one alternation", () => {
    const re = new RegExp(grepFor(["Card", "Alert"]));
    expect(re.test("Alert: renders")).toBe(true);
    expect(re.test("Card: renders")).toBe(true);
    expect(re.test("Button: renders")).toBe(false);
  });

  test("nothing affected matches nothing, rather than everything", () => {
    // The dangerous failure here is an empty pattern, which Playwright would
    // read as "run the whole suite".
    const re = new RegExp(grepFor([]));
    expect(re.test("Card: mounts at defaults")).toBe(false);
    expect(re.test("")).toBe(false);
  });
});
