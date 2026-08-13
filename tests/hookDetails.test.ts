import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractHookDetails } from "../src/analyse/extractHooks.ts";
import { parseFile } from "../src/analyse/parseFile.ts";
import type { ComponentScope } from "../src/analyse/refs.ts";
import type { HookDetail } from "../src/types.ts";

const EFFECTS_DEMO = path.resolve(__dirname, "fixtures/EffectsDemo.tsx");

/** Scope built literally (mirrors what buildComponentScope produces for the fixture). */
function demoScope(): ComponentScope {
  return {
    propNames: new Set(["id", "label", "user"]),
    propAliases: new Map(),
    paramName: undefined,
    stateVars: new Set(["data", "n"]),
    setterNames: new Set(["setData", "setN"]),
    refNames: new Set(),
    memoResultNames: new Set(["total", "refresh"]),
    derivedNames: new Map(),
  };
}

async function detailsOf(): Promise<HookDetail[]> {
  const parsed = await parseFile(EFFECTS_DEMO);
  const body = parsed.components[0]?.bodyNode;
  if (!body) throw new Error("EffectsDemo fixture yielded no component body");
  return extractHookDetails(body, parsed.sourceFile, demoScope());
}

describe("extractHookDetails", () => {
  test("one entry per call site, in source order", async () => {
    const hooks = await detailsOf();
    expect(hooks.map((h) => h.name)).toEqual([
      "useState",
      "useState",
      "useMemo",
      "useEffect",
      "useCallback",
      "useEffect",
    ]);
    expect(hooks[0]?.argsSummary).toEqual(["array"]);
    expect(hooks[1]?.argsSummary).toEqual(["literal:0"]);
  });

  test("fetch effect: deps, effect features, real position", async () => {
    const hooks = await detailsOf();
    const effect = hooks[3];
    expect(effect).toBeDefined();
    if (!effect) return;
    expect(effect.name).toBe("useEffect");
    expect(effect.deps).toEqual(["id"]);
    expect(effect.depsHasComplex).toBe(false);
    expect(effect.missingDepsArray).toBe(false);
    expect(effect.callbackIsInline).toBe(true);
    expect(effect.effectFeatures).toEqual({
      fetch: true,
      setInterval: false,
      setTimeout: false,
      addEventListener: true,
      hasCleanup: true,
    });
    expect(effect.pos.line).toBeGreaterThan(1);
    expect(effect.pos.file.endsWith("EffectsDemo.tsx")).toBe(true);
  });

  test("useCallback without a deps array is flagged", async () => {
    const hooks = await detailsOf();
    const cb = hooks[4];
    expect(cb).toBeDefined();
    if (!cb) return;
    expect(cb.name).toBe("useCallback");
    expect(cb.argCount).toBe(1);
    expect(cb.argsSummary).toEqual(["arrow"]);
    expect(cb.deps).toBeUndefined();
    expect(cb.missingDepsArray).toBe(true);
    expect(cb.callbackReads).toEqual(["setData"]);
    expect(cb.effectFeatures).toBeUndefined();
    expect(cb.resultName).toBe("refresh");
  });

  test("useMemo: resultName + callbackReads catch the missing dep", async () => {
    const hooks = await detailsOf();
    const memo = hooks[2];
    expect(memo).toBeDefined();
    if (!memo) return;
    expect(memo.name).toBe("useMemo");
    expect(memo.resultName).toBe("total");
    expect(memo.deps).toEqual(["n"]);
    expect(memo.missingDepsArray).toBe(false);
    // Reads both state vars even though the deps array only lists "n".
    expect(memo.callbackReads).toEqual(["data", "n"]);
  });

  test("member-access dep marks depsHasComplex", async () => {
    const hooks = await detailsOf();
    const effect = hooks[5];
    expect(effect).toBeDefined();
    if (!effect) return;
    expect(effect.name).toBe("useEffect");
    expect(effect.deps).toEqual(["user.id"]);
    expect(effect.depsHasComplex).toBe(true);
    expect(effect.callbackReads).toEqual(["setN", "user"]);
    expect(effect.readsBareParamsObject).toBe(false);
  });
});
