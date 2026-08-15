import path from "node:path";
import { scaffold } from "../scaffold/index.ts";
import { flattenTrees, hostEligibility } from "../scaffold-tests/registry.ts";
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
      heaps: ctx.heaps,
      force: ctx.force,
      report: ctx.report,
      provider: ctx.provider,
      apiSpec: ctx.apiSpec,
      nextjsHost: ctx.nextjs !== undefined,
      mswSetup: ctx.nextjs !== undefined,
    });
    // The number of components the host can actually mount, not the number of
    // entry trees. Those differ by more than half in a real app — most of what
    // the sweep finds is a server component or a compound part — and reporting
    // the tree count claimed a coverage the suite never had.
    const flat = flattenTrees([first, ...rest]);
    const hosted = flat.filter((c) => hostEligibility(c.info).eligible);
    const names = hosted.map((c) => c.info.componentName);
    return {
      id: "perf-harness",
      ok: true,
      outputs: written,
      findings: [],
      summary: `scaffolded perf suite for ${names.length} of ${flat.length} component(s): ${names.join(", ")}`,
    };
  },
};
