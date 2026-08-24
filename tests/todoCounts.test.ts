import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
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
const opaqueRsc = (name = "Page", filePath?: string): ComponentTree =>
  tree(
    comp(name, {
      ...(filePath ? { filePath } : {}),
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

describe("skipped colocated specs contribute no tallies", () => {
  // Tallying happens during render, but the writer keeps an existing colocated
  // spec when --force is off — so any tally from a kept file describes markers
  // the run never wrote, including TODOs the user has already resolved.
  const runColocated = (dir: string, force: boolean): ReturnType<typeof unitAndBrowser.run> =>
    unitAndBrowser.run({
      trees: [opaqueRsc("Page", path.join(dir, "src", "Page.tsx"))],
      outDir: path.join(dir, "flawless"),
      variants: 3,
      heaps: "stress",
      force,
      report: false,
      provider: undefined,
      apiSpec: undefined,
      inlineSummary: false,
      nextjs: undefined,
      colocate: true,
      selectedTasks: ["unit-browser"],
    } as RunContext);

  test("a no-force rerun over an existing spec must not count its markers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-skip-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    const first = await runColocated(dir, true);
    expect(first.ok).toBe(true);
    expect(first.handWork?.[0]?.count).toBe(1);
    const spec = path.join(dir, "src", "Page.flawless.test.tsx");
    expect(existsSync(spec)).toBe(true);
    // The user resolves the TODO in place; the rerun keeps their file.
    await Bun.write(spec, (await Bun.file(spec).text()).replaceAll("TODO(flawless)", "resolved"));
    const rerun = await runColocated(dir, false);
    expect(rerun.ok).toBe(true);
    expect(rerun.handWork).toEqual([]);
  });

  test("--force rewrites the spec, so its markers count again", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-force-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    await runColocated(dir, true);
    const again = await runColocated(dir, true);
    expect(again.handWork?.map((t) => t.kind)).toEqual(["uninferred-return-shape"]);
    expect(again.handWork?.[0]?.count).toBe(1);
  });

  test("--force over a hand-edited spec keeps it, so its markers must not count", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-kept-edited-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    const first = await runColocated(dir, true);
    expect(first.handWork?.[0]?.count).toBe(1);
    const spec = path.join(dir, "src", "Page.flawless.test.tsx");
    // The user hardened the file; --force now KEEPS it (stamp mismatch), and
    // the discarded render's marker would be debt against work they own.
    await Bun.write(spec, `${await Bun.file(spec).text()}// hand-hardened\n`);
    const rerun = await runColocated(dir, true);
    expect(rerun.ok).toBe(true);
    expect(rerun.handWork).toEqual([]);
    // The kept note must precede the component list: REPORT.md truncates each
    // task summary at 120 chars, and the name list runs to thousands — a note
    // appended after it would exist only in summary.json and stdout.
    expect(rerun.summary).toMatch(/^unit tests for 1 component\(s\) \(1 hand-edited/);
  });

  test("--force over a pre-stamp spec keeps it, so its markers must not count", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-kept-legacy-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    await runColocated(dir, true);
    const spec = path.join(dir, "src", "Page.flawless.test.tsx");
    const text = await Bun.file(spec).text();
    // Strip the stamp line: a spec generated before stamping existed.
    await Bun.write(spec, text.split("\n").slice(1).join("\n"));
    const rerun = await runColocated(dir, true);
    expect(rerun.ok).toBe(true);
    expect(rerun.handWork).toEqual([]);
    expect(rerun.summary).toMatch(/^unit tests for 1 component\(s\) \(1 pre-stamp/);
  });

  test("the kept listing caps at 10 paths and says how many more there are", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-kept-cap-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    const names = Array.from({ length: 12 }, (_, i) => `Page${String(i + 1).padStart(2, "0")}`);
    const runTwelve = (force: boolean): ReturnType<typeof unitAndBrowser.run> =>
      unitAndBrowser.run({
        trees: names.map((n) => opaqueRsc(n, path.join(dir, "src", `${n}.tsx`))),
        outDir: path.join(dir, "flawless"),
        variants: 3,
        heaps: "stress",
        force,
        report: false,
        provider: undefined,
        apiSpec: undefined,
        inlineSummary: false,
        nextjs: undefined,
        colocate: true,
        selectedTasks: ["unit-browser"],
      } as RunContext);
    await runTwelve(true);
    for (const n of names) {
      const spec = path.join(dir, "src", `${n}.flawless.test.tsx`);
      await Bun.write(spec, `${await Bun.file(spec).text()}// hand-hardened\n`);
    }
    const rerun = await runTwelve(true);
    expect(rerun.summary).toContain("12 hand-edited or reformatted colocated spec(s) kept");
    expect(rerun.summary).toContain("Page01.flawless.test.tsx");
    expect(rerun.summary).toContain("Page10.flawless.test.tsx");
    expect(rerun.summary).not.toContain("Page11.flawless.test.tsx");
    expect(rerun.summary).toContain("+2 more");
    expect(rerun.handWork).toEqual([]);
  });
});

describe("tallies match the written text", () => {
  test("the handWork sum equals the TODO(flawless) occurrences across the files the run wrote", async () => {
    // The ONLY test allowed to grep for the marker. It exists precisely to
    // catch an emit site that plants the text without tallying, or tallies
    // without planting — the drift the emission-site counters cannot see.
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-sum-"));
    const res = await unitAndBrowser.run({
      trees: [
        opaqueRsc(),
        tree(
          comp("Menu", {
            interactions: {
              clicks: [
                {
                  event: "onClick",
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
        tree(
          comp("Search", {
            interactions: { clicks: [], forms: [{ submit: undefined, fields: [], hints: {} }] },
          }),
        ),
      ],
      outDir: dir,
      variants: 3,
      heaps: "stress",
      force: true,
      report: false,
      provider: undefined,
      apiSpec: undefined,
      inlineSummary: false,
      nextjs: undefined,
      selectedTasks: undefined,
    } as RunContext);
    expect(res.ok).toBe(true);
    let written = 0;
    for (const f of res.outputs) {
      if (!existsSync(f)) continue;
      written += (await Bun.file(f).text()).split("TODO(flawless)").length - 1;
    }
    const tallied = (res.handWork ?? []).reduce((n, t) => n + t.count, 0);
    expect(written).toBeGreaterThan(0);
    expect(tallied).toBe(written);
  });
});
