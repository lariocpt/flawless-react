import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { componentNameFromFilename, parseFile } from "../src/analyse/parseFile.ts";

const SHAPES = path.resolve(__dirname, "fixtures/shapes");

describe("component shapes", () => {
  test("anonymous default arrow takes its name from the filename", async () => {
    const file = path.join(SHAPES, "DefaultArrow.tsx");
    const parsed = await parseFile(file);
    expect(parsed.components).toHaveLength(1);
    const unit = parsed.components[0];
    expect(unit?.componentName).toBe("DefaultArrow");
    expect(unit?.exportKind).toBe("default");
    expect(unit?.propsTypeLiteral).toBeDefined();
    const t = await analyse({ entry: file, depth: 0, includeChildren: false });
    expect(t.entry.propsShape).toEqual({ title: "" });
  });

  test("export default memo(arrow) unwraps to a named unit with a memo wrapper", async () => {
    const parsed = await parseFile(path.join(SHAPES, "MemoCard.tsx"));
    const unit = parsed.components[0];
    expect(unit?.componentName).toBe("MemoCard");
    expect(unit?.exportKind).toBe("default");
    expect(unit?.wrappers).toEqual(["memo"]);
  });

  test("async server component: isAsync, no use-client, value import resolved", async () => {
    const t = await analyse({
      entry: path.join(SHAPES, "ServerPage.tsx"),
      depth: 1,
      includeChildren: true,
    });
    expect(t.entry.isAsync).toBe(true);
    expect(t.entry.isClientComponent).toBe(false);
    const helper = t.entry.moduleImports?.find((mi) => mi.specifier === "./db-helper.ts");
    expect(helper).toBeDefined();
    expect(helper?.kind).toBe("value");
    expect(helper?.resolvedPath).toBe(path.join(SHAPES, "db-helper.ts"));
    expect(t.entry.moduleImports?.some((mi) => mi.kind === "component")).toBe(false);
  });

  test("'use client' multi-component file: exported primary + same-file child", async () => {
    const file = path.join(SHAPES, "ClientMulti.tsx");
    const parsed = await parseFile(file);
    expect(parsed.isClientComponent).toBe(true);
    expect(parsed.components).toHaveLength(2);
    expect(parsed.components[0]?.componentName).toBe("A");
    const t = await analyse({ entry: file, depth: 1, includeChildren: true });
    expect(t.entry.componentName).toBe("A");
    expect(t.entry.isClientComponent).toBe(true);
    const b = t.children.find((c) => c.entry.componentName === "B");
    expect(b).toBeDefined();
    expect(b?.entry.exportKind).toBe("none");
    expect(b?.entry.localTag).toBe("B");
    expect(b?.entry.filePath).toBe(file);
  });

  test("index.tsx components are named after their directory", async () => {
    const file = path.join(SHAPES, "widget-x/index.tsx");
    expect(componentNameFromFilename(file)).toBe("WidgetX");
    const parsed = await parseFile(file);
    expect(parsed.components[0]?.componentName).toBe("WidgetX");
    expect(parsed.components[0]?.exportKind).toBe("default");
  });
});
