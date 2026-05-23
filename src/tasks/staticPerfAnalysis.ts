import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ComponentInfo, ComponentTree, Finding, RunContext, Task, TaskResult } from "../types.ts";

const MEMO_HOOKS = new Set(["useMemo", "useCallback", "memo", "useRef"]);
const CHILD_RERENDER_THRESHOLD = 3;

interface PerfReport {
  component: string;
  file: string;
  findings: Finding[];
}

export const staticPerfAnalysis: Task = {
  id: "perf-static",
  label: "Static React perf analysis",
  description: "Surface rerender / memoisation / unresolved-prop risks from the parsed tree",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    const reportsDir = path.join(ctx.outDir, "reports");
    await mkdir(reportsDir, { recursive: true });
    const allFindings: Finding[] = [];
    const written: string[] = [];

    for (const tree of ctx.trees) {
      const report = analyseTree(tree);
      for (const finding of report.findings) allFindings.push(finding);
      const out = path.join(reportsDir, `${report.component}.perf-static.json`);
      await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
      written.push(out);
    }

    return {
      id: "perf-static",
      ok: true,
      outputs: written,
      findings: allFindings,
      summary: `static perf analysis: ${allFindings.length} finding(s) across ${ctx.trees.length} root(s)`,
    };
  },
};

function analyseTree(tree: ComponentTree): PerfReport {
  const findings: Finding[] = [];
  walk(tree, findings);
  return {
    component: tree.entry.componentName,
    file: tree.entry.filePath,
    findings,
  };
}

function walk(tree: ComponentTree, findings: Finding[]): void {
  inspect(tree.entry, tree.children.length, findings);
  for (const c of tree.children) walk(c, findings);
}

function inspect(info: ComponentInfo, childCount: number, findings: Finding[]): void {
  const memoHits = info.hooks.filter((h) => MEMO_HOOKS.has(h));
  if (childCount >= CHILD_RERENDER_THRESHOLD && memoHits.length === 0) {
    findings.push({
      rule: "perf/no-memoisation-with-children",
      severity: "warn",
      file: info.filePath,
      line: 1,
      column: 1,
      message:
        `${info.componentName} renders ${childCount} child component(s) but uses none of ` +
        `useMemo/useCallback/memo/useRef — every parent rerender will rerender all children.`,
      source: "perf-static",
    });
  }
  for (const u of info.unresolvedProps) {
    findings.push({
      rule: "perf/unresolved-prop",
      severity: "warn",
      file: info.filePath,
      line: 1,
      column: 1,
      message: `${info.componentName}: could not synthesise a default for prop "${u}" — generated tests will pass undefined.`,
      source: "perf-static",
    });
  }
}
