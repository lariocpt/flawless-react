import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ComponentTree, Finding, RunContext, Task, TaskResult } from "../types.ts";
import { runEslint } from "./eslintRunner.ts";

export const a11yScan: Task = {
  id: "a11y",
  label: "Accessibility / web-standards scan",
  description: "eslint-plugin-jsx-a11y over the targeted tree (file:line)",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    const reportsDir = path.join(ctx.outDir, "reports");
    await mkdir(reportsDir, { recursive: true });
    const allFindings: Finding[] = [];
    const written: string[] = [];

    try {
      for (const tree of ctx.trees) {
        const files = collectFiles(tree);
        const findings = await runEslint({
          files,
          source: "a11y",
          plugins: ["jsx-a11y"],
          rules: jsxA11yRules(),
        });
        const out = path.join(reportsDir, `${tree.entry.componentName}.a11y.json`);
        const report = {
          component: tree.entry.componentName,
          file: tree.entry.filePath,
          findings,
        };
        await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
        written.push(out);
        for (const f of findings) allFindings.push(f);
      }
    } catch (err) {
      return {
        id: "a11y",
        ok: false,
        outputs: written,
        findings: allFindings,
        summary: "a11y scan failed",
        error: (err as Error).message,
      };
    }

    return {
      id: "a11y",
      ok: true,
      outputs: written,
      findings: allFindings,
      summary: `a11y: ${allFindings.length} finding(s) across ${ctx.trees.length} component(s)`,
    };
  },
};

function collectFiles(tree: ComponentTree): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (t: ComponentTree): void => {
    if (seen.has(t.entry.filePath)) return;
    seen.add(t.entry.filePath);
    out.push(t.entry.filePath);
    for (const c of t.children) walk(c);
  };
  walk(tree);
  return out;
}

function jsxA11yRules(): Record<string, "error" | "warn"> {
  return {
    "jsx-a11y/alt-text": "error",
    "jsx-a11y/anchor-has-content": "error",
    "jsx-a11y/anchor-is-valid": "warn",
    "jsx-a11y/aria-activedescendant-has-tabindex": "error",
    "jsx-a11y/aria-props": "error",
    "jsx-a11y/aria-proptypes": "error",
    "jsx-a11y/aria-role": "error",
    "jsx-a11y/aria-unsupported-elements": "error",
    "jsx-a11y/click-events-have-key-events": "warn",
    "jsx-a11y/heading-has-content": "error",
    "jsx-a11y/html-has-lang": "error",
    "jsx-a11y/iframe-has-title": "error",
    "jsx-a11y/img-redundant-alt": "warn",
    "jsx-a11y/interactive-supports-focus": "warn",
    "jsx-a11y/label-has-associated-control": "warn",
    "jsx-a11y/mouse-events-have-key-events": "warn",
    "jsx-a11y/no-access-key": "error",
    "jsx-a11y/no-autofocus": "warn",
    "jsx-a11y/no-distracting-elements": "error",
    "jsx-a11y/no-interactive-element-to-noninteractive-role": "error",
    "jsx-a11y/no-noninteractive-element-interactions": "warn",
    "jsx-a11y/no-noninteractive-element-to-interactive-role": "error",
    "jsx-a11y/no-noninteractive-tabindex": "warn",
    "jsx-a11y/no-redundant-roles": "error",
    "jsx-a11y/no-static-element-interactions": "warn",
    "jsx-a11y/role-has-required-aria-props": "error",
    "jsx-a11y/role-supports-aria-props": "error",
    "jsx-a11y/scope": "error",
    "jsx-a11y/tabindex-no-positive": "warn",
  };
}
