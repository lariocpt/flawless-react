import path from "node:path";
import { scaffold } from "../scaffold/index.ts";
import type { RunContext, Task, TaskResult } from "../types.ts";

export const perfHarness: Task = {
  id: "perf-harness",
  label: "Generate performance testing harness",
  description: "Playwright + React.Profiler + react-scan suite",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    const [first, ...rest] = ctx.trees;
    if (!first) {
      return {
        id: "perf-harness",
        ok: false,
        outputs: [],
        findings: [],
        summary: "no components to scaffold",
        error: "no components",
      };
    }
    const suiteName = path.basename(path.resolve(ctx.outDir)).replace(/[^a-zA-Z0-9_-]+/g, "-");
    const written = await scaffold(first, {
      outDir: ctx.outDir,
      extraTrees: rest,
      suiteName,
      variants: ctx.variants,
      force: true,
      report: ctx.report,
      provider: ctx.provider,
      apiSpec: ctx.apiSpec,
      nextjsHost: ctx.nextjs !== undefined,
      mswSetup: ctx.nextjs !== undefined,
    });
    const components = [first, ...rest].map((t) => t.entry.componentName);
    return {
      id: "perf-harness",
      ok: true,
      outputs: written,
      findings: [],
      summary: `scaffolded perf suite for ${components.length} component(s): ${components.join(", ")}`,
    };
  },
};
