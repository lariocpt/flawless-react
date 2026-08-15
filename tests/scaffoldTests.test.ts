import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scaffoldUnitBrowser } from "../src/scaffold-tests/index.ts";
import type { ComponentInfo, ComponentTree } from "../src/types.ts";

const dirs: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-scaffold-tests-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function comp(name: string, filePath: string, extra: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    componentName: name,
    filePath,
    importSpecifier: `./${name}.tsx`,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    exportKind: "default",
    ...extra,
  };
}

function tree(entry: ComponentInfo, children: ComponentTree[] = []): ComponentTree {
  return { entry, children };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("scaffoldUnitBrowser (file writes)", () => {
  test("writes the expected file set and reports written + skipped", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    const { written, skipped } = await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(src, "Widget.tsx")))],
      outDir,
      variants: 3,
    });

    const expected = [
      path.join(outDir, "vitest.config.ts"),
      path.join(outDir, "setup.ts"),
      path.join(outDir, "browser", "playwright.config.ts"),
      path.join(outDir, "unit", "Widget.test.tsx"),
      path.join(outDir, "browser", "Widget.spec.ts"),
      path.join(outDir, "package.json"),
    ];
    expect(written.sort()).toEqual([...expected].sort());
    expect(skipped).toEqual([]);
    for (const file of expected) expect(existsSync(file)).toBe(true);
    expect(readFileSync(path.join(outDir, "unit", "Widget.test.tsx"), "utf8")).toContain(
      "Widget renders at defaults without crashing",
    );
  });

  test("creates outDir when it does not exist and skips the browser spec for async components", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "nested", "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    const { written } = await scaffoldUnitBrowser({
      trees: [tree(comp("Page", path.join(src, "Page.tsx"), { isAsync: true }))],
      outDir,
      variants: 2,
      skipInnerPackageJson: true,
    });

    expect(existsSync(path.join(outDir, "unit", "Page.test.tsx"))).toBe(true);
    expect(existsSync(path.join(outDir, "browser", "Page.spec.ts"))).toBe(false);
    expect(written).not.toContain(path.join(outDir, "package.json"));
    expect(existsSync(path.join(outDir, "package.json"))).toBe(false);
  });
});

describe("scaffoldUnitBrowser inner package.json", () => {
  test("creates one with the test:unit / test:perf / test:browser scripts", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");

    await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
      skipInnerPackageJson: false,
    });

    const pkg = readJson(path.join(outDir, "package.json"));
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts["test:unit"]).toBe("vitest run");
    expect(scripts["test:perf"]).toBe("playwright test profile");
    expect(scripts["test:browser"]).toBe("playwright test --config browser/playwright.config.ts");
    expect(pkg.name).toBe("flawless-suite");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect((pkg.dependencies as Record<string, string>).react).toBe("^18.3.0");
    expect((pkg.devDependencies as Record<string, string>).vitest).toBe("^2.1.0");
  });

  test("skipInnerPackageJson true writes no package.json", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
      skipInnerPackageJson: true,
    });
    expect(existsSync(path.join(outDir, "package.json"))).toBe(false);
  });

  test("merging an existing tab-indented package.json keeps its tabs and its own fields", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    mkdirSync(outDir, { recursive: true });
    const pkgPath = path.join(outDir, "package.json");
    writeFileSync(
      pkgPath,
      '{\n\t"name": "existing-suite",\n\t"version": "1.2.3",\n\t"scripts": {\n\t\t"dev": "vite"\n\t},\n\t"devDependencies": {\n\t\t"vitest": "^1.0.0"\n\t}\n}\n',
    );

    await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
      skipInnerPackageJson: false,
    });

    const text = readFileSync(pkgPath, "utf8");
    expect(text).toContain('\t"');
    expect(text).not.toContain('\n  "');
    expect(text.endsWith("\n")).toBe(true);

    const pkg = readJson(pkgPath);
    const scripts = pkg.scripts as Record<string, string>;
    expect(pkg.name).toBe("existing-suite");
    expect(pkg.version).toBe("1.2.3");
    expect(scripts.dev).toBe("vite");
    expect(scripts["test:unit"]).toBe("vitest run");
    // Existing dependency pins win over the defaults.
    expect((pkg.devDependencies as Record<string, string>).vitest).toBe("^1.0.0");
  });

  test("an unparseable package.json is replaced rather than crashing the scaffold", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    mkdirSync(outDir, { recursive: true });
    const pkgPath = path.join(outDir, "package.json");
    writeFileSync(pkgPath, "{ not json");

    await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
    });

    const pkg = readJson(pkgPath);
    expect((pkg.scripts as Record<string, string>)["test:unit"]).toBe("vitest run");
  });
});

describe("scaffoldUnitBrowser colocate", () => {
  test("existing colocated specs are skipped and left byte-identical", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    const cardSpec = path.join(src, "Card.flawless.test.tsx");
    const original = "// flawless-sentinel: keep this file\n";
    writeFileSync(cardSpec, original);

    const trees = [
      tree(comp("Card", path.join(src, "Card.tsx"))),
      tree(comp("Chip", path.join(src, "Chip.tsx"))),
    ];
    const { written, skipped } = await scaffoldUnitBrowser({
      trees,
      outDir,
      variants: 2,
      colocate: true,
      skipInnerPackageJson: true,
    });

    expect(skipped).toEqual([cardSpec]);
    expect(written).not.toContain(cardSpec);
    expect(readFileSync(cardSpec, "utf8")).toBe(original);

    // The component without a pre-existing spec is still written next to its source.
    const chipSpec = path.join(src, "Chip.flawless.test.tsx");
    expect(written).toContain(chipSpec);
    expect(readFileSync(chipSpec, "utf8")).toContain("Chip renders at defaults without crashing");
    // Shared config still lands in outDir.
    expect(existsSync(path.join(outDir, "vitest.config.ts"))).toBe(true);
    expect(existsSync(path.join(outDir, "browser", "Card.spec.ts"))).toBe(true);
  });

  test("force overwrites an existing colocated spec", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    const cardSpec = path.join(src, "Card.flawless.test.tsx");
    writeFileSync(cardSpec, "// flawless-sentinel: keep this file\n");

    const { written, skipped } = await scaffoldUnitBrowser({
      trees: [tree(comp("Card", path.join(src, "Card.tsx")))],
      outDir,
      variants: 2,
      colocate: true,
      force: true,
      skipInnerPackageJson: true,
    });

    expect(skipped).toEqual([]);
    expect(written).toContain(cardSpec);
    const text = readFileSync(cardSpec, "utf8");
    expect(text).not.toContain("flawless-sentinel");
    expect(text).toContain("Card renders at defaults without crashing");
    expect(text).toContain('import Card from "./Card";');
  });

  test("multi-component files colocate one spec per component", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });
    const modulePath = path.join(src, "card.tsx");

    const { written } = await scaffoldUnitBrowser({
      trees: [
        tree(comp("Card", modulePath, { exportKind: "named" }), [
          tree(comp("CardHeader", modulePath, { exportKind: "named" })),
        ]),
      ],
      outDir,
      variants: 2,
      colocate: true,
      skipInnerPackageJson: true,
    });

    const cardSpec = path.join(src, "card.Card.flawless.test.tsx");
    const headerSpec = path.join(src, "card.CardHeader.flawless.test.tsx");
    expect(written).toContain(cardSpec);
    expect(written).toContain(headerSpec);
    expect(readFileSync(cardSpec, "utf8")).toContain('import { Card } from "./card";');
    expect(readFileSync(headerSpec, "utf8")).toContain('import { CardHeader } from "./card";');
  });
});
