import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reproCommand } from "../src/core.ts";
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

describe("REPORT.md carries a command that reproduces the run", () => {
  const ROOT = "/home/lario/Projects/personal/mybodycorpai/apps/web";
  const run = (opts: Record<string, unknown>, taskIds: string[] = ["perf-harness"]): string =>
    reproCommand({ pattern: "src/**/*.tsx", ...opts } as never, ROOT, taskIds as never);

  test("it names the published bin, not the interpreter that happened to run it", () => {
    // argv[0..1] is `bun /home/…/src/bin.ts`, which is this machine's checkout.
    expect(run({})).toStartWith("flawless-react ");
    expect(run({})).not.toContain("bun ");
    expect(run({})).not.toContain("bin.ts");
  });

  test("NO absolute path survives, whichever option carried it", () => {
    // The load-bearing invariant. REPORT.md is committed and checked out under a
    // different root on each machine (/home/lario/… vs /mnt/data/…), so one
    // absolute path here churns `git status` everywhere else.
    const cmd = run(
      {
        pattern: `${ROOT}/src/app/page.tsx`,
        nextjs: ROOT,
        outDir: `${ROOT}/flawless`,
        apiSpec: `${ROOT}/openapi.json`,
        provider: `${ROOT}/flawless/provider.tsx`,
        exclude: [`${ROOT}/src/legacy/**`],
      },
      ["load"],
    );
    expect(cmd).not.toContain(ROOT);
    expect(cmd).not.toMatch(/(^|[\s"'])\//);
    expect(cmd).toContain("--nextjs .");
    expect(cmd).toContain("--out flawless");
    expect(cmd).toContain("--api openapi.json");
  });

  test("a relative pattern is left exactly as the caller wrote it", () => {
    // Resolving it against root only to relativise it again turns a correct
    // string into a guess about the cwd it was typed in.
    expect(run({ pattern: "src/**/*.tsx" })).toContain('"src/**/*.tsx"');
  });

  test("globs are quoted, so the shell cannot expand them into a different run", () => {
    expect(run({ pattern: "src/**/*.tsx" })).toContain('"src/**/*.tsx"');
    expect(run({ pattern: "src/App.tsx" })).toContain(" src/App.tsx");
  });

  test("only what differs from the defaults is spelled out", () => {
    expect(run({})).toBe('flawless-react "src/**/*.tsx"');
    expect(run({ depth: 3, variants: 5, heaps: "stress", roots: "primary" })).toBe(
      'flawless-react "src/**/*.tsx"',
    );
    expect(run({ depth: 0, heaps: "off" })).toBe(
      'flawless-react "src/**/*.tsx" --depth 0 --heaps off',
    );
  });

  test("--tasks is spelled out unless it is the CLI's own no-flag default", () => {
    // Running with no --tasks does perf-harness alone, so anything else has to
    // be named or the line reproduces a different run.
    expect(run({}, ["perf-harness"])).not.toContain("--tasks");
    expect(run({}, ["load"])).toContain("--tasks load");
    expect(run({}, ["e2e", "load"])).toContain("--tasks e2e,load");
  });

  test("the same options twice produce the same bytes", () => {
    // REPORT.md is committed and timestamp-free precisely so this holds.
    const opts = { nextjs: ROOT, force: true, roots: "exported", apiSpec: `${ROOT}/openapi.json` };
    expect(run(opts, ["load"])).toBe(run(opts, ["load"]));
  });

  test("the report renders it under a heading that says where to run it", () => {
    const md = renderReportMarkdown({
      trees: [],
      outDir: "/tmp/x",
      command: 'flawless-react "src/**/*.tsx" --nextjs .',
      results: [],
    } as never);
    expect(md).toContain("Reproduce this run from the project root:");
    expect(md).toContain('flawless-react "src/**/*.tsx" --nextjs .');
  });

  test("a standalone run emits no command, because it would not be runnable", async () => {
    // Outside --nextjs there is no project root: the report lands in outDir
    // while the pattern is relative to the caller's cwd. A line telling you to
    // run it "from the project root" would name a directory the pattern does
    // not resolve against, so the honest output is none.
    const { runCore } = await import("../src/core.ts");
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-repro-"));
    await runCore({
      pattern: path.resolve(__dirname, "fixtures", "Toolbar.tsx"),
      outDir: dir,
      taskIds: ["perf-static"],
      inlineSummary: false,
      log: false,
    });
    const md = await Bun.file(path.join(dir, "REPORT.md")).text();
    expect(md).not.toContain("Reproduce this run");
  });

  test("no command means no empty code fence", () => {
    const md = renderReportMarkdown({ trees: [], outDir: "/tmp/x", results: [] } as never);
    expect(md).not.toContain("Reproduce this run");
    expect(md).not.toContain("```bash");
  });
});
