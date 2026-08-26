import { mkdir } from "node:fs/promises";
import path from "node:path";
import { relativeToEmitted } from "../emitPaths.ts";
import { A11Y_REPORT } from "../tasks/a11yScan.ts";
import { REACT_RULES_REPORT } from "../tasks/eslintReactRules.ts";
import type { ComponentTree, Finding, TaskId, TaskResult } from "../types.ts";

export function printFindings(findings: Finding[]): void {
  if (findings.length === 0) return;
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  for (const [file, list] of byFile) {
    process.stdout.write(`\n${path.relative(process.cwd(), file)}\n`);
    for (const f of list) {
      const sev = f.severity === "error" ? "ERROR" : "warn ";
      process.stdout.write(`  ${sev}  ${f.line}:${f.column}  ${f.rule}  ${f.message}\n`);
    }
  }
}

export function printSummaryTable(results: TaskResult[]): void {
  process.stdout.write("\nSummary:\n");
  for (const r of results) {
    const status = r.ok ? "ok" : "FAIL";
    const findings = r.findings.length;
    const outputs = r.outputs.length;
    process.stdout.write(
      `  [${status}] ${r.id.padEnd(14)} files:${outputs} findings:${findings}  ${r.summary}\n`,
    );
    if (r.error) process.stdout.write(`         error: ${r.error}\n`);
  }
}

export async function writeSummaryJson(outDir: string, results: TaskResult[]): Promise<string> {
  const reportsDir = path.join(outDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const out = path.join(reportsDir, "summary.json");
  const body = {
    ts: new Date().toISOString(),
    results: results.map((r) => ({
      id: r.id,
      ok: r.ok,
      summary: r.summary,
      outputs: r.outputs.length,
      findings: r.findings.length,
      error: r.error,
    })),
  };
  await Bun.write(out, `${JSON.stringify(body, null, 2)}\n`);
  return out;
}

export async function writeInlineSummaries(
  trees: ComponentTree[],
  results: TaskResult[],
  outDir: string,
): Promise<string[]> {
  const byComponent = new Map<string, Finding[]>();
  const components = new Map<string, ComponentTree>();
  for (const t of trees) collectComponents(t, components);

  for (const r of results) {
    for (const f of r.findings) {
      const owner = findOwner(f.file, components);
      if (!owner) continue;
      const list = byComponent.get(owner) ?? [];
      list.push(f);
      byComponent.set(owner, list);
    }
  }

  const written: string[] = [];
  for (const [name, tree] of components) {
    const dir = path.dirname(tree.entry.filePath);
    const out = path.join(dir, `${name}.flawless.json`);
    const findings = byComponent.get(name) ?? [];
    const counts: Record<TaskId | "total", number> = {
      "perf-harness": 0,
      "unit-browser": 0,
      "perf-static": 0,
      a11y: 0,
      "react-rules": 0,
      e2e: 0,
      load: 0,
      total: findings.length,
    };
    for (const f of findings) counts[f.source] += 1;
    const top = [...findings]
      .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))
      .slice(0, 3)
      .map((f) => ({
        rule: f.rule,
        severity: f.severity,
        line: f.line,
        column: f.column,
        message: f.message,
      }));
    // Every path here is relative to THIS file, not to the machine that wrote
    // it. The sidecar lands beside the analysed source and is committed like any
    // other generated file, so an absolute path in one names the developer who
    // ran the tool — src/emitPaths.ts exists to stop exactly that, and this was
    // the one emitted file its sentinel sweep did not cover. Resolve with
    // path.resolve(dirname(<this file>), value).
    const rel = (target: string): string => relativeToEmitted(dir, target);
    const body = {
      component: name,
      file: rel(tree.entry.filePath),
      counts,
      top,
      // a11y and react-rules are SWEEPS: each writes a single aggregate for the
      // whole run, and only perf-static reports per component. These two used
      // to be spelled `${name}.a11y.json` and `${name}.react-rules.json` —
      // files no run has ever produced — so two thirds of this map pointed at
      // nothing, and the published docs copied the wrong names from it.
      reports: {
        a11y: rel(path.join(outDir, "reports", A11Y_REPORT)),
        reactRules: rel(path.join(outDir, "reports", REACT_RULES_REPORT)),
        perfStatic: rel(path.join(outDir, "reports", `${name}.perf-static.json`)),
      },
    };
    await Bun.write(out, `${JSON.stringify(body, null, 2)}\n`);
    written.push(out);
  }
  return written;
}

function collectComponents(tree: ComponentTree, into: Map<string, ComponentTree>): void {
  if (!into.has(tree.entry.componentName)) into.set(tree.entry.componentName, tree);
  for (const c of tree.children) collectComponents(c, into);
}

function findOwner(file: string, components: Map<string, ComponentTree>): string | undefined {
  for (const [name, tree] of components) {
    if (path.resolve(tree.entry.filePath) === path.resolve(file)) return name;
  }
  return undefined;
}

function severityWeight(s: "error" | "warn"): number {
  return s === "error" ? 2 : 1;
}
