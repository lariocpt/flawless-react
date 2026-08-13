import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { ModuleResolver } from "../src/analyse/resolveModule.ts";

const APP = path.resolve(__dirname, "fixtures/aliased/app/src/App.tsx");
const WIDGET = path.resolve(__dirname, "fixtures/aliased/app/src/components/Widget.tsx");
const UI_INDEX = path.resolve(__dirname, "fixtures/aliased/app/src/components/ui/index.tsx");
const DASHBOARD = path.resolve(__dirname, "fixtures/Dashboard.tsx");

describe("analyse through tsconfig path aliases", () => {
  test("named import via @/ alias + extends chain resolves the child component", async () => {
    const t = await analyse({ entry: APP, depth: 2, includeChildren: true });
    expect(t.entry.componentName).toBe("App");
    const widget = t.children.find((c) => c.entry.componentName === "Widget");
    expect(widget).toBeDefined();
    expect(widget?.entry.filePath).toBe(WIDGET);
    expect(widget?.entry.propsShape).toEqual({ label: "" });
  });

  test("namespace member tag <UI.Badge/> resolves ui/index.tsx and picks the Badge export", async () => {
    const t = await analyse({ entry: APP, depth: 2, includeChildren: true });
    const badge = t.children.find((c) => c.entry.componentName === "Badge");
    expect(badge).toBeDefined();
    expect(badge?.entry.filePath).toBe(UI_INDEX);
    expect(badge?.entry.localTag).toBe("UI.Badge");
    expect(badge?.entry.exportKind).toBe("named");
  });

  test("relative-import regression: Dashboard still yields Card + Hello", async () => {
    const t = await analyse({ entry: DASHBOARD, depth: 3, includeChildren: true });
    const names = t.children.map((c) => c.entry.componentName).sort();
    expect(names).toEqual(["Card", "Hello"]);
  });

  test("bare specifier (react's Fragment tag) yields no child and no throw", async () => {
    const t = await analyse({ entry: APP, depth: 2, includeChildren: true });
    const names = t.children.map((c) => c.entry.componentName).sort();
    expect(names).toEqual(["Badge", "Widget"]);
    const resolver = new ModuleResolver();
    expect(resolver.resolve("react", APP)).toBeUndefined();
  });

  test("ModuleResolver.resolve: alias hit and unknown-alias miss", () => {
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@/components/Widget", APP)).toBe(WIDGET);
    expect(resolver.resolve("@/components/ui", APP)).toBe(UI_INDEX);
    expect(resolver.resolve("#unknown/thing", APP)).toBeUndefined();
  });
});
