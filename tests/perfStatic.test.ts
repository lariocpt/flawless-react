import { describe, expect, test } from "bun:test";
import { analyseTree } from "../src/tasks/staticPerfAnalysis.ts";
import type {
  ChildAttrInfo,
  ComponentInfo,
  ComponentTree,
  EffectFeatures,
  Finding,
  HookDetail,
  SourcePosition,
  StateInfo,
} from "../src/types.ts";

const FILE = "/proj/src/T.tsx";

function pos(line: number, column = 1): SourcePosition {
  return { file: FILE, line, column };
}

function comp(name: string, extra: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    componentName: name,
    filePath: FILE,
    importSpecifier: `./${name}.tsx`,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    ...extra,
  };
}

function tree(entry: ComponentInfo, children: ComponentTree[] = []): ComponentTree {
  return { entry, children };
}

function hook(over: Partial<HookDetail> & { name: string }): HookDetail {
  return {
    pos: pos(1),
    argCount: 2,
    argsSummary: ["arrow", "array"],
    deps: undefined,
    depsHasComplex: false,
    missingDepsArray: false,
    callbackReads: [],
    callbackIsInline: true,
    readsBareParamsObject: false,
    ...over,
  };
}

function stateOf(over: Partial<StateInfo> & { varName: string }): StateInfo {
  return {
    kind: "useState",
    typeKind: "number",
    pos: pos(2),
    setterCalls: [],
    flowsToJsx: [],
    setterCalledInEffect: false,
    ...over,
  };
}

function attrOf(
  over: Partial<ChildAttrInfo> & {
    tag: string;
    attr: string;
    valueKind: ChildAttrInfo["valueKind"];
  },
): ChildAttrInfo {
  return { pos: pos(9), ...over };
}

const NO_FEATURES: EffectFeatures = {
  fetch: false,
  setInterval: false,
  setTimeout: false,
  addEventListener: false,
  hasCleanup: false,
};

function rulesOf(findings: Finding[], rule: string): Finding[] {
  return findings.filter((f) => f.rule === rule);
}

describe("perf-static dependency rules", () => {
  test("missing dependency reported at the hook position", () => {
    const t = tree(
      comp("Widget", {
        propsShape: { userId: "" },
        hookDetails: [
          hook({ name: "useEffect", pos: pos(12, 3), deps: [], callbackReads: ["userId"] }),
        ],
      }),
    );
    const found = rulesOf(analyseTree(t).findings, "perf/hook-missing-dependency");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(12);
    expect(found[0]?.column).toBe(3);
    expect(found[0]?.severity).toBe("warn");
    expect(found[0]?.source).toBe("perf-static");
    expect(found[0]?.message).toContain('"userId"');
    expect(found[0]?.message).toContain("stale");
  });

  test("extraneous dependency reported when a known name is listed but never read", () => {
    const t = tree(
      comp("Widget", {
        state: [stateOf({ varName: "count", setterName: "setCount" })],
        hookDetails: [
          hook({
            name: "useMemo",
            pos: pos(8, 19),
            deps: ["count"],
            callbackReads: [],
            resultName: "total",
          }),
        ],
      }),
    );
    const found = rulesOf(analyseTree(t).findings, "perf/hook-extraneous-dependency");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(8);
    expect(found[0]?.message).toContain('"count"');
  });

  test("complex deps and non-inline callbacks bail out of all dep rules", () => {
    const t = tree(
      comp("Widget", {
        propsShape: { userId: "" },
        hookDetails: [
          hook({
            name: "useEffect",
            deps: ["user.id"],
            depsHasComplex: true,
            callbackReads: ["userId"],
          }),
          hook({
            name: "useCallback",
            deps: [],
            callbackIsInline: false,
            callbackReads: ["userId"],
          }),
        ],
      }),
    );
    const findings = analyseTree(t).findings;
    expect(rulesOf(findings, "perf/hook-missing-dependency")).toHaveLength(0);
    expect(rulesOf(findings, "perf/hook-extraneous-dependency")).toHaveLength(0);
  });

  test("state setters are exempt from missing and extraneous checks", () => {
    const t = tree(
      comp("Widget", {
        state: [stateOf({ varName: "count", setterName: "setCount" })],
        hookDetails: [
          hook({ name: "useCallback", deps: [], callbackReads: ["setCount"] }),
          hook({ name: "useMemo", deps: ["setCount"], callbackReads: [] }),
        ],
      }),
    );
    const findings = analyseTree(t).findings;
    expect(rulesOf(findings, "perf/hook-missing-dependency")).toHaveLength(0);
    expect(rulesOf(findings, "perf/hook-extraneous-dependency")).toHaveLength(0);
  });

  test("useCallback without a deps array", () => {
    const t = tree(
      comp("Widget", {
        hookDetails: [
          hook({ name: "useCallback", pos: pos(4, 9), argCount: 1, missingDepsArray: true }),
        ],
      }),
    );
    const found = rulesOf(analyseTree(t).findings, "perf/hook-missing-deps-array");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(4);
    expect(found[0]?.column).toBe(9);
  });

  test("effect-every-render fires only when a feature flag is set", () => {
    const t = tree(
      comp("Widget", {
        hookDetails: [
          hook({
            name: "useEffect",
            pos: pos(6, 3),
            argCount: 1,
            missingDepsArray: true,
            effectFeatures: { ...NO_FEATURES, fetch: true },
          }),
          hook({
            name: "useEffect",
            pos: pos(20, 3),
            argCount: 1,
            missingDepsArray: true,
            effectFeatures: NO_FEATURES,
          }),
        ],
      }),
    );
    const found = rulesOf(analyseTree(t).findings, "perf/effect-every-render");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(6);
    expect(found[0]?.message).toContain("fetch");
  });
});

describe("perf-static memoisation rules", () => {
  test("unstable child prop at the attribute position; key/ref skipped", () => {
    const t = tree(
      comp("Parent", {
        childAttrs: [
          attrOf({ tag: "Card", attr: "style", valueKind: "object-literal", pos: pos(7, 13) }),
          attrOf({ tag: "Card", attr: "key", valueKind: "arrow", pos: pos(7, 30) }),
          attrOf({ tag: "Card", attr: "title", valueKind: "string", pos: pos(7, 44) }),
        ],
      }),
      [tree(comp("Card"))],
    );
    const found = rulesOf(analyseTree(t).findings, "perf/unstable-child-prop");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(7);
    expect(found[0]?.column).toBe(13);
    expect(found[0]?.message).toContain('"style"');
    expect(found[0]?.message).not.toContain("defeats memoisation");
  });

  test("unstable child prop calls out React.memo-wrapped children", () => {
    const t = tree(
      comp("Parent", {
        childAttrs: [attrOf({ tag: "Card", attr: "onSave", valueKind: "arrow", pos: pos(11, 7) })],
      }),
      [tree(comp("Card", { wrappers: ["memo"] }))],
    );
    const found = rulesOf(analyseTree(t).findings, "perf/unstable-child-prop");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain(
      "child is React.memo-wrapped; this prop defeats memoisation",
    );
  });

  test("missing-memo-leaf fires for stable leaves and bails on unknown identifiers", () => {
    const t = tree(
      comp("Parent", {
        propsShape: { title: "" },
        state: [stateOf({ varName: "count", setterName: "setCount" })],
        childAttrs: [
          attrOf({
            tag: "Leaf",
            attr: "title",
            valueKind: "identifier",
            identifier: "title",
            pos: pos(14, 7),
          }),
          attrOf({
            tag: "Leaf",
            attr: "count",
            valueKind: "identifier",
            identifier: "count",
            pos: pos(14, 20),
          }),
          attrOf({
            tag: "Risky",
            attr: "data",
            valueKind: "identifier",
            identifier: "mystery",
            pos: pos(15, 7),
          }),
        ],
      }),
      [
        tree(comp("Leaf")),
        tree(comp("Risky")),
        tree(comp("Memoed", { wrappers: ["memo"] })),
        tree(comp("Plain", { pos: pos(2, 5) })),
      ],
    );
    const found = rulesOf(analyseTree(t).findings, "perf/missing-memo-leaf");
    expect(found).toHaveLength(2);
    // Leaf: stable identifier props → flagged at its first attr.
    expect(found[0]?.message).toContain("<Leaf>");
    expect(found[0]?.line).toBe(14);
    expect(found[0]?.column).toBe(7);
    // Plain: zero attrs qualifies → flagged at its declaration.
    expect(found[1]?.message).toContain("<Plain>");
    expect(found[1]?.line).toBe(2);
    expect(found[1]?.column).toBe(5);
  });

  test("missing-memo-leaf bails when any prop kind is unstable", () => {
    const t = tree(
      comp("Parent", {
        state: [stateOf({ varName: "count", setterName: "setCount" })],
        childAttrs: [attrOf({ tag: "Leaf", attr: "onPick", valueKind: "arrow", pos: pos(5, 7) })],
      }),
      [tree(comp("Leaf"))],
    );
    expect(rulesOf(analyseTree(t).findings, "perf/missing-memo-leaf")).toHaveLength(0);
  });

  test("set-state-in-render only when unguarded", () => {
    const t = tree(
      comp("Parent", {
        state: [
          stateOf({
            varName: "count",
            setterName: "setCount",
            setterCalls: [
              { pos: pos(5, 3), context: "render", guarded: false, argKind: "literal" },
              { pos: pos(7, 5), context: "render", guarded: true, argKind: "literal" },
              { pos: pos(9, 5), context: "handler", guarded: false, argKind: "updater" },
            ],
          }),
        ],
      }),
    );
    const found = rulesOf(analyseTree(t).findings, "perf/set-state-in-render");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.line).toBe(5);
    expect(found[0]?.column).toBe(3);
    expect(found[0]?.message).toContain("setCount");
  });

  test("no-memoisation-with-children counts a memo wrapper as memoisation", () => {
    const kids = [tree(comp("A")), tree(comp("B")), tree(comp("C"))];
    const bare = tree(comp("Parent", { pos: pos(3, 1) }), kids);
    const bareFound = rulesOf(analyseTree(bare).findings, "perf/no-memoisation-with-children");
    expect(bareFound).toHaveLength(1);
    expect(bareFound[0]?.line).toBe(3);

    const wrapped = tree(comp("Parent", { wrappers: ["memo"] }), kids);
    expect(
      rulesOf(analyseTree(wrapped).findings, "perf/no-memoisation-with-children"),
    ).toHaveLength(0);
  });

  test("unresolved props are a per-component spec-quality bucket, not findings", () => {
    // As per-prop findings this was "button.tsx: 148 perf findings" for one
    // component with one unresolvable prop family. It is a fixture gap, not a
    // rerender risk, and the fix (`--props`, the spec's DEFAULTS) addresses props
    // by name — so the names are kept and the declaration positions are not.
    const t = tree(
      comp("Parent", {
        unresolvedProps: ["onSave", "onCancel"],
        propPositions: { onSave: pos(4, 3) },
        pos: pos(2, 1),
      }),
    );
    const report = analyseTree(t);
    expect(rulesOf(report.findings, "perf/unresolved-prop")).toHaveLength(0);
    expect(report.specQuality).toEqual([
      { component: "Parent", file: FILE, props: ["onCancel", "onSave"] },
    ]);
  });

  test("descendants are walked: findings from a grandchild are included", () => {
    const grandchild = tree(
      comp("Grandchild", {
        state: [
          stateOf({
            varName: "n",
            setterName: "setN",
            setterCalls: [
              { pos: pos(40, 3), context: "render", guarded: false, argKind: "literal" },
            ],
          }),
        ],
      }),
    );
    const t = tree(comp("Root"), [tree(comp("Mid"), [grandchild])]);
    const found = rulesOf(analyseTree(t).findings, "perf/set-state-in-render");
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(40);
  });
});
