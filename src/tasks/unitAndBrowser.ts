import { scaffoldUnitBrowser } from "../scaffold-tests/index.ts";
import type { RunContext, Task, TaskResult } from "../types.ts";

export const unitAndBrowser: Task = {
  id: "unit-browser",
  label: "Generate React unit + browser tests",
  description: "Vitest + @testing-library/react units, Playwright functional browser specs",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    if (ctx.trees.length === 0) {
      return {
        id: "unit-browser",
        ok: false,
        outputs: [],
        findings: [],
        summary: "no components to scaffold",
        error: "no components",
      };
    }
    const written = await scaffoldUnitBrowser({
      trees: ctx.trees,
      outDir: ctx.outDir,
      variants: ctx.variants,
    });
    const names = ctx.trees.flatMap((t) => collectNames(t));
    return {
      id: "unit-browser",
      ok: true,
      outputs: written,
      findings: [],
      summary: `unit + browser tests for ${names.length} component(s): ${names.join(", ")}`,
    };
  },
};

function collectNames(tree: { entry: { componentName: string }; children: unknown[] }): string[] {
  const names: string[] = [tree.entry.componentName];
  for (const c of tree.children as Array<typeof tree>) names.push(...collectNames(c));
  return names;
}
