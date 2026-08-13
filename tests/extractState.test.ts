import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractState } from "../src/analyse/extractState.ts";
import { parseFile } from "../src/analyse/parseFile.ts";
import type { StateInfo } from "../src/types.ts";

const FIXTURE = path.resolve(__dirname, "fixtures/StatefulPanel.tsx");

async function loadState(): Promise<StateInfo[]> {
  const parsed = await parseFile(FIXTURE);
  const unit = parsed.components[0];
  if (!unit) throw new Error("StatefulPanel fixture did not parse");
  if (unit.componentName !== "StatefulPanel") {
    throw new Error(`expected primary component StatefulPanel, got ${unit.componentName}`);
  }
  return extractState(unit.bodyNode, parsed.sourceFile);
}

function byName(state: StateInfo[], name: string): StateInfo {
  const found = state.find((s) => s.varName === name);
  if (!found) throw new Error(`no state entry for ${name}`);
  return found;
}

describe("extractState", () => {
  test("count: full StateInfo for useState(0)", async () => {
    const state = await loadState();
    expect(state.map((s) => s.varName)).toEqual(["count", "items", "expanded", "timerRef"]);

    const count = byName(state, "count");
    expect(count.kind).toBe("useState");
    expect(count.setterName).toBe("setCount");
    expect(count.initialValue).toBe(0);
    expect(count.initialRaw).toBe("0");
    expect(count.typeKind).toBe("number");
    expect(count.pos.file.endsWith("StatefulPanel.tsx")).toBe(true);
    expect(count.pos.line).toBe(23);
  });

  test("setter contexts: handler (handleAdd) vs effect (useEffect)", async () => {
    const state = await loadState();

    const items = byName(state, "items");
    expect(items.typeKind).toBe("array");
    expect(items.initialValue).toEqual([]);
    expect(items.setterCalls).toHaveLength(1);
    const handlerCall = items.setterCalls[0];
    expect(handlerCall?.context).toBe("handler");
    expect(handlerCall?.enclosingName).toBe("handleAdd");
    expect(handlerCall?.argKind).toBe("expression");
    expect(handlerCall?.guarded).toBe(false);
    expect(items.setterCalledInEffect).toBe(false);

    const count = byName(state, "count");
    const effectCall = count.setterCalls.find((c) => c.context === "effect");
    expect(effectCall).toBeDefined();
    expect(effectCall?.enclosingName).toBe("useEffect");
    expect(effectCall?.argKind).toBe("updater");
    expect(count.setterCalledInEffect).toBe(true);
  });

  test("flowsToJsx: count → <span> child, items → List attr", async () => {
    const state = await loadState();

    const count = byName(state, "count");
    expect(count.flowsToJsx).toHaveLength(1);
    const countFlow = count.flowsToJsx[0];
    expect(countFlow?.via).toBe("child");
    expect(countFlow?.tag).toBe("span");
    expect(countFlow?.pos.line).toBe(46);

    const items = byName(state, "items");
    expect(items.flowsToJsx).toHaveLength(1);
    const itemsFlow = items.flowsToJsx[0];
    expect(itemsFlow?.via).toBe("attr");
    expect(itemsFlow?.tag).toBe("List");
    expect(itemsFlow?.attr).toBe("items");
  });

  test("useReducer: dispatch call captured as inline onClick handler", async () => {
    const state = await loadState();
    const expanded = byName(state, "expanded");
    expect(expanded.kind).toBe("useReducer");
    expect(expanded.setterName).toBe("dispatch");
    expect(expanded.typeKind).toBe("boolean");
    expect(expanded.initialValue).toBe(false);
    expect(expanded.initialRaw).toBe("false");
    expect(expanded.setterCalls).toHaveLength(1);
    const call = expanded.setterCalls[0];
    expect(call?.context).toBe("handler");
    expect(call?.enclosingName).toBe("onClick");
    expect(call?.argKind).toBe("literal");
    expect(expanded.setterCalledInEffect).toBe(false);
  });

  test("useRef: .current assignment captured as effect-context setter", async () => {
    const state = await loadState();
    const ref = byName(state, "timerRef");
    expect(ref.kind).toBe("useRef");
    expect(ref.setterName).toBeUndefined();
    expect(ref.initialValue).toBe(null);
    expect(ref.initialRaw).toBe("null");
    // Explicit type argument `number | null` maps to no known kind.
    expect(ref.typeKind).toBe("unknown");
    expect(ref.setterCalls).toHaveLength(1);
    const call = ref.setterCalls[0];
    expect(call?.argKind).toBe("expression");
    expect(call?.context).toBe("effect");
    expect(call?.enclosingName).toBe("useEffect");
    expect(call?.pos.line).toBe(29);
    expect(ref.setterCalledInEffect).toBe(true);
  });

  test("guarded render-phase setter: context render + guarded", async () => {
    const state = await loadState();
    const count = byName(state, "count");
    expect(count.setterCalls).toHaveLength(2);
    const renderCall = count.setterCalls.find((c) => c.context === "render");
    expect(renderCall).toBeDefined();
    expect(renderCall?.guarded).toBe(true);
    expect(renderCall?.argKind).toBe("literal");
    expect(renderCall?.pos.line).toBe(40);
  });
});
