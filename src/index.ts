/**
 * Programmatic API. CLI-equivalent entry point:
 *
 *   import { runFlawless } from "flawless-react";
 *   const { results, trees, outDir } = await runFlawless({
 *     entry: "src/components/Widget.tsx",
 *     nextjs: ".",
 *     tasks: ["unit-browser", "perf-static"],
 *   });
 *
 * Never calls process.exit; throws UsageError for bad input.
 */
import { type CoreResult, runCore } from "./core.ts";
import type { PropsShape, RootMode, TaskId } from "./types.ts";

export interface RunFlawlessOptions {
  /** Entry .tsx path or glob. Optional in Next.js mode (components glob auto-detected). */
  entry?: string;
  tasks?: TaskId[];
  out?: string;
  /** Next.js project root — enables Next.js mode ("." for cwd). */
  nextjs?: string;
  provider?: string;
  apiSpec?: string;
  swaggerUrl?: string;
  colocate?: boolean;
  /** "exported" emits a tree per exported component in each entry file. */
  roots?: RootMode;
  /** Extra globs to skip, appended to the defaults. */
  exclude?: readonly string[];
  useDefaultExcludes?: boolean;
  variants?: number;
  depth?: number;
  includeChildren?: boolean;
  force?: boolean;
  report?: boolean;
  propsOverride?: PropsShape;
  inlineSummary?: boolean;
  runTests?: boolean;
  /** Progress lines on stdout/stderr (default false for the programmatic API). */
  log?: boolean;
}

export async function runFlawless(options: RunFlawlessOptions): Promise<CoreResult> {
  return runCore({
    pattern: options.entry as string,
    outDir: options.out,
    taskIds: options.tasks,
    depth: options.depth,
    variants: options.variants,
    includeChildren: options.includeChildren,
    force: options.force,
    report: options.report,
    propsOverride: options.propsOverride,
    provider: options.provider,
    apiSpec: options.apiSpec,
    inlineSummary: options.inlineSummary,
    nextjs: options.nextjs,
    swaggerUrl: options.swaggerUrl,
    colocate: options.colocate,
    roots: options.roots,
    exclude: options.exclude,
    useDefaultExcludes: options.useDefaultExcludes,
    runTests: options.runTests,
    log: options.log ?? false,
  });
}

export { analyse, analyseFile, ModuleResolver, parseFile } from "./analyse/index.ts";
export type { CoreOptions, CoreResult } from "./core.ts";
export { DEFAULT_EXCLUDES, runCore, UsageError } from "./core.ts";
export { detectNextjs } from "./nextjs/detect.ts";
export { scaffold } from "./scaffold/index.ts";
export { scaffoldUnitBrowser } from "./scaffold-tests/index.ts";
export { ALL_TASK_IDS, findTask, TASKS } from "./tasks/index.ts";
export { analyseTree } from "./tasks/staticPerfAnalysis.ts";
export type {
  ComponentInfo,
  ComponentTree,
  Finding,
  HookDetail,
  PropUsage,
  StateInfo,
  TaskId,
  TaskResult,
} from "./types.ts";
