import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractProps } from "../src/analyse/extractProps.ts";
import { extractPropUsage } from "../src/analyse/extractPropUsage.ts";
import { parseFile } from "../src/analyse/parseFile.ts";
import { buildComponentScope } from "../src/analyse/refs.ts";
import type { PropUsage } from "../src/types.ts";

const DEMO = path.resolve(__dirname, "fixtures/UsageDemo.tsx");
const PROPS_PARAM = path.resolve(__dirname, "fixtures/UsagePropsParam.tsx");

async function usageOf(fixture: string): Promise<PropUsage[]> {
  const parsed = await parseFile(fixture);
  const unit = parsed.components[0];
  if (!unit) throw new Error(`no component found in ${fixture}`);
  const props = extractProps(parsed.sourceFile, unit.propsTypeRef, unit.propsTypeLiteral);
  const scope = buildComponentScope(unit, props, [], unit.bodyNode);
  return extractPropUsage(unit.bodyNode, parsed.sourceFile, scope);
}

describe("extractPropUsage (UsageDemo)", () => {
  test("title → jsx-child of <h1> at the exact position", async () => {
    const usage = (await usageOf(DEMO)).filter((u) => u.propName === "title");
    expect(usage).toHaveLength(1);
    const title = usage[0] as PropUsage;
    expect(title.kind).toBe("jsx-child");
    expect(title.tag).toBe("h1");
    expect(title.pos.file).toBe(DEMO);
    expect(title.pos.line).toBe(26);
    expect(title.pos.column).toBe(12);
  });

  test("user → passed-to-child on <Avatar name={user.name}> with member", async () => {
    const usage = (await usageOf(DEMO)).filter((u) => u.propName === "user");
    expect(usage).toHaveLength(1);
    const user = usage[0] as PropUsage;
    expect(user.kind).toBe("passed-to-child");
    expect(user.tag).toBe("Avatar");
    expect(user.attr).toBe("name");
    expect(user.member).toBe("name");
  });

  test("filter → one hook-dep (useEffect) and one conditional", async () => {
    const usage = (await usageOf(DEMO)).filter((u) => u.propName === "filter");
    expect(usage).toHaveLength(2);
    const dep = usage.find((u) => u.kind === "hook-dep");
    expect(dep).toBeDefined();
    expect(dep?.hook).toBe("useEffect");
    expect(dep?.pos.line).toBe(18);
    const cond = usage.find((u) => u.kind === "conditional");
    expect(cond).toBeDefined();
    expect(cond?.pos.line).toBe(20);
  });

  test("onSave → jsx-attr onClick of lowercase <button>", async () => {
    const usage = (await usageOf(DEMO)).filter((u) => u.propName === "onSave");
    expect(usage).toHaveLength(1);
    const onSave = usage[0] as PropUsage;
    expect(onSave.kind).toBe("jsx-attr");
    expect(onSave.tag).toBe("button");
    expect(onSave.attr).toBe("onClick");
  });
});

describe("extractPropUsage (UsagePropsParam)", () => {
  test("props.title via param and body-destructured user are both counted", async () => {
    const usage = await usageOf(PROPS_PARAM);
    expect(usage).toHaveLength(2);

    const title = usage.find((u) => u.propName === "title");
    expect(title).toBeDefined();
    expect(title?.kind).toBe("jsx-child");
    expect(title?.tag).toBe("p");

    // `const { user } = props` alias canonicalises back to propName "user".
    const user = usage.find((u) => u.propName === "user");
    expect(user).toBeDefined();
    expect(user?.kind).toBe("jsx-attr");
    expect(user?.tag).toBe("img");
    expect(user?.attr).toBe("alt");
    expect(user?.member).toBe("name");
  });
});
