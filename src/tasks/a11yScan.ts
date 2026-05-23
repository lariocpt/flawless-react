import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ComponentTree, Finding, RunContext, Task, TaskResult } from "../types.ts";
import { runBiome } from "./biomeRunner.ts";

export const a11yScan: Task = {
  id: "a11y",
  label: "Accessibility / web-standards scan",
  description: "Biome a11y rules over the targeted tree (file:line)",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    const reportsDir = path.join(ctx.outDir, "reports");
    await mkdir(reportsDir, { recursive: true });
    const allFindings: Finding[] = [];
    const written: string[] = [];

    try {
      for (const tree of ctx.trees) {
        const files = collectFiles(tree);
        const findings = await runBiome({
          files,
          source: "a11y",
          rules: biomeA11yRules(),
          categoryPrefix: "lint/a11y",
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

function biomeA11yRules(): unknown {
  return {
    recommended: false,
    a11y: {
      noAccessKey: "error",
      noAriaUnsupportedElements: "error",
      noAutofocus: "warn",
      noDistractingElements: "error",
      noHeaderScope: "error",
      noInteractiveElementToNoninteractiveRole: "error",
      noLabelWithoutControl: "warn",
      noNoninteractiveElementToInteractiveRole: "error",
      noNoninteractiveTabindex: "warn",
      noPositiveTabindex: "warn",
      noRedundantAlt: "warn",
      noRedundantRoles: "error",
      useAltText: "error",
      useAnchorContent: "error",
      useAriaActivedescendantWithTabindex: "error",
      useAriaPropsForRole: "error",
      useButtonType: "error",
      useFocusableInteractive: "warn",
      useHeadingContent: "error",
      useHtmlLang: "error",
      useIframeTitle: "error",
      useKeyWithClickEvents: "warn",
      useKeyWithMouseEvents: "warn",
      useMediaCaption: "warn",
      useValidAnchor: "warn",
      useValidAriaProps: "error",
      useValidAriaRole: "error",
      useValidAriaValues: "error",
      useValidLang: "error",
    },
  };
}
