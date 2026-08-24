import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import { unitAndBrowser } from "../src/tasks/unitAndBrowser.ts";
import type {
  ComponentInfo,
  ComponentTree,
  RunContext,
  SourcePosition,
  TodoTally,
} from "../src/types.ts";
import { TodoCounter } from "../src/types.ts";

const OUT = "/proj/flawless";
const SRC = "/proj/src";

function pos(line = 1): SourcePosition {
  return { file: `${SRC}/T.tsx`, line, column: 1 };
}

function comp(name: string, extra: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    componentName: name,
    filePath: `${SRC}/${name}.tsx`,
    importSpecifier: `./${name}.tsx`,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    exportKind: "named",
    renderMode: "client",
    ...extra,
  };
}

const tree = (entry: ComponentInfo): ComponentTree => ({ entry, children: [] });

/** An RSC whose awaited dep's return shape the analyser admits it cannot infer. */
const opaqueRsc = (name = "Page"): ComponentTree =>
  tree(
    comp(name, {
      isAsync: true,
      renderMode: "rsc",
      exportKind: "default",
      moduleImports: [
        {
          specifier: "@/lib/data",
          names: ["getThing"],
          kind: "value",
          isTypeOnly: false,
          hasDefault: false,
          pos: pos(),
        },
      ],
      dataDeps: [
        {
          varName: "thing",
          callee: "getThing",
          calleeRoot: "getThing",
          specifier: "@/lib/data",
          awaited: true,
          shape: { kind: "unknown" },
          uncertain: true,
          pos: pos(3),
        },
      ],
    }),
  );

function tally(trees: ComponentTree[], browserSpecs = false): TodoTally[] {
  const todos = new TodoCounter();
  renderUnitBrowser({ trees, outDir: OUT, variants: 3, browserSpecs, todos });
  return todos.toTallies();
}

describe("TODO(flawless) markers are counted at their emission sites", () => {
  test("an RSC with an opaque data dep counts one uninferred-return-shape", () => {
    const t = tally([opaqueRsc()]);
    expect(t.length).toBe(1);
    expect(t[0]?.kind).toBe("uninferred-return-shape");
    expect(t[0]?.count).toBe(1);
    // The exemplar names the emitted spec that carries the marker, not the source.
    expect(t[0]?.exemplar).toContain("/unit/");
    expect(t[0]?.exemplar).toEndWith(".test.tsx");
  });

  test("a stubbed server action counts one server-action-stub", () => {
    const t = tally([
      tree(
        comp("SaveForm", {
          moduleImports: [
            {
              specifier: "@/app/actions",
              names: ["save"],
              kind: "value",
              isTypeOnly: false,
              hasDefault: false,
              isServerAction: true,
              serverActionExports: ["save"],
              pos: pos(),
            },
          ],
        }),
      ),
    ]);
    expect(t).toEqual([expect.objectContaining({ kind: "server-action-stub", count: 1 }) as never]);
  });

  test("a compound part counts one compound-root-wrap", () => {
    const t = tally([tree(comp("DialogHeader", { renderMode: "compound-part" }))]);
    expect(t.length).toBe(1);
    expect(t[0]?.kind).toBe("compound-root-wrap");
    expect(t[0]?.count).toBe(1);
  });

  test("an unaddressable click counts once per spec layer that skips on it", () => {
    const trees = [
      tree(
        comp("Menu", {
          interactions: {
            clicks: [
              {
                event: "onClick",
                // An uppercase component tag with no testid/aria/text is the
                // unlocatable shape both emitters skip with a TODO.
                tag: "MenuTrigger",
                label: { kind: "none" },
                hints: {},
                binding: { kind: "local", localName: "open" },
              },
            ],
            forms: [],
          },
        }),
      ),
    ];
    const unitOnly = tally(trees, false);
    expect(unitOnly).toEqual([
      expect.objectContaining({ kind: "unaddressable-target", count: 1 }) as never,
    ]);
    // With browser specs on, the browser emitter skips on the same target too.
    const both = tally(trees, true);
    expect(both).toEqual([
      expect.objectContaining({ kind: "unaddressable-target", count: 2 }) as never,
    ]);
  });

  test("a form with no declared submit control lands in other", () => {
    const t = tally([
      tree(
        comp("Search", {
          interactions: { clicks: [], forms: [{ submit: undefined, fields: [], hints: {} }] },
        }),
      ),
    ]);
    expect(t).toEqual([expect.objectContaining({ kind: "other", count: 1 }) as never]);
  });

  test("a component whose spec needs no hand-work counts nothing", () => {
    expect(tally([tree(comp("Plain", { rootTag: "div" }))])).toEqual([]);
  });

  test("the exemplar is the lexicographically smallest path, whatever the tree order", () => {
    const t = tally([opaqueRsc("Zed"), opaqueRsc("Alpha")]);
    expect(t.length).toBe(1);
    expect(t[0]?.count).toBe(2);
    expect(t[0]?.exemplar).toContain("Alpha.test.tsx");
  });
});

describe("the unit-browser task surfaces the tallies", () => {
  test("handWork rides the TaskResult through scaffoldUnitBrowser", async () => {
    // End to end through index.ts on purpose: the collector travels inside the
    // options object, so a rebuild of that object anywhere on the path would
    // silently drop it and the report would read "none" against real debt.
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-todo-"));
    const ctx = {
      trees: [opaqueRsc()],
      outDir: dir,
      variants: 3,
      heaps: "stress",
      force: true,
      report: false,
      provider: undefined,
      apiSpec: undefined,
      inlineSummary: false,
      nextjs: undefined,
      selectedTasks: ["unit-browser"],
    } as RunContext;
    const res = await unitAndBrowser.run(ctx);
    expect(res.ok).toBe(true);
    expect(res.handWork?.map((t) => t.kind)).toEqual(["uninferred-return-shape"]);
    expect(res.handWork?.[0]?.count).toBe(1);
  });
});
