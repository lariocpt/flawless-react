import { describe, expect, test } from "bun:test";
import { renderReportMarkdown } from "../src/reporters/report.ts";
import type { ComponentInfo, ComponentTree, TaskResult } from "../src/types.ts";

function comp(name: string, extra: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    componentName: name,
    filePath: `/proj/src/${name}.tsx`,
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

const tree = (entry: ComponentInfo, children: ComponentTree[] = []): ComponentTree => ({
  entry,
  children,
});

const task = (id: string, over: Partial<TaskResult> = {}): TaskResult =>
  ({
    id,
    ok: true,
    outputs: [],
    findings: [],
    summary: "",
    ...over,
  }) as TaskResult;

const INPUT = {
  trees: [
    tree(comp("Widget")),
    tree(comp("Page", { renderMode: "rsc" as const, isAsync: true })),
    tree(comp("DialogContent", { renderMode: "compound-part" as const })),
  ],
  results: [
    task("unit-browser", { outputs: ["a", "b"], summary: "unit tests for 3 component(s)" }),
  ],
  outDir: "/proj/flawless",
  projectRoot: "/proj",
  unparseable: [{ file: "/proj/src/badge.tsx", reason: "could not locate a React component" }],
};

describe("renderReportMarkdown", () => {
  test("every component lands in exactly one column, and the totals say so", () => {
    // This is the invariant that turns "175 components covered" from a file
    // count into a claim you can check.
    const md = renderReportMarkdown(INPUT);
    expect(md).toContain("| **total** | **1** | **2** |");
    expect(md).toContain("1 + 2 = 3");
    expect(md).toContain("A further 1 file(s) yielded no component at all");
  });

  test("each excluded component is named with its reason", () => {
    const md = renderReportMarkdown(INPUT);
    expect(md).toContain("| `Page` | `src/Page.tsx` | async server component");
    expect(md).toContain("compound part");
    // Paths are repo-relative so they read as they do in an editor.
    expect(md).not.toContain("/proj/src/Page.tsx");
  });

  test("unreadable files are listed rather than lost to stderr", () => {
    const md = renderReportMarkdown(INPUT);
    expect(md).toContain("### Files no component could be read from");
    expect(md).toContain("`src/badge.tsx` — could not locate a React component");
  });

  test("is byte-identical across calls", () => {
    // REPORT.md is committed. A timestamp or a Set iteration order leaking into
    // it would churn git status on every run and mask real emission drift.
    expect(renderReportMarkdown(INPUT)).toBe(renderReportMarkdown(INPUT));
    expect(renderReportMarkdown(INPUT)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  test("standing gaps are stated, not just the run's own skips", () => {
    const md = renderReportMarkdown(INPUT);
    expect(md).toContain("## Standing gaps");
    expect(md).toContain("only through a child gets no `next/link` mock");
  });

  test("a fully mountable set says so instead of printing an empty table", () => {
    const md = renderReportMarkdown({ ...INPUT, trees: [tree(comp("Widget"))], unparseable: [] });
    expect(md).toContain("Every component is mountable in the browser host.");
    expect(md).not.toContain("| Component | File | Reason |");
  });
});

describe("a partial run says so", () => {
  const ALL = ["perf-harness", "unit-browser", "perf-static", "a11y", "react-rules", "e2e", "load"];

  test("names the tasks it did not run", () => {
    // `--tasks load` used to rewrite the Tasks table with one row and no
    // qualification, so the file read as "this project has one task". Two
    // sessions reverted a truncated REPORT.md by hand before anyone noticed the
    // report was the thing lying.
    const md = renderReportMarkdown({
      trees: [],
      outDir: "/tmp/x",
      allTaskIds: ALL,
      results: [
        { id: "load", ok: true, outputs: ["a"], findings: [], summary: "load pipes for 33" },
      ],
    } as never);
    expect(md).toContain("This run selected 1 of 7 tasks");
    expect(md).toContain("`perf-harness`");
    expect(md).toContain("`e2e`");
  });

  test("a full run says nothing extra", () => {
    const md = renderReportMarkdown({
      trees: [],
      outDir: "/tmp/x",
      allTaskIds: ALL,
      results: ALL.map((id) => ({ id, ok: true, outputs: [], findings: [], summary: id })),
    } as never);
    expect(md).not.toContain("This run selected");
    expect(md).not.toContain("Not run");
  });
});
