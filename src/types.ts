export type PropPrimitive = string | number | boolean | null;
export type PropValue = PropPrimitive | PropValue[] | { [k: string]: PropValue };
export type PropsShape = Record<string, PropValue>;

export interface ComponentInfo {
  componentName: string;
  filePath: string;
  importSpecifier: string;
  propsShape: PropsShape;
  variants: PropsShape[];
  hooks: string[];
  unresolvedProps: string[];
}

export interface ComponentTree {
  entry: ComponentInfo;
  children: ComponentTree[];
}

export interface AnalyseOptions {
  entry: string;
  depth: number;
  includeChildren: boolean;
}

export interface MockRoute {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface ScaffoldOptions {
  outDir: string;
  variants: number;
  force: boolean;
  report: boolean;
  provider: string | undefined;
  apiSpec: string | undefined;
  extraTrees?: ComponentTree[];
  suiteName?: string;
}

export type TaskId = "perf-harness" | "unit-browser" | "perf-static" | "a11y" | "react-rules";

export interface Finding {
  rule: string;
  severity: "error" | "warn";
  file: string;
  line: number;
  column: number;
  message: string;
  source: TaskId;
}

export interface TaskResult {
  id: TaskId;
  ok: boolean;
  outputs: string[];
  findings: Finding[];
  summary: string;
  error?: string;
}

export interface RunContext {
  trees: ComponentTree[];
  outDir: string;
  variants: number;
  force: boolean;
  report: boolean;
  provider: string | undefined;
  apiSpec: string | undefined;
  inlineSummary: boolean;
  json: boolean;
}

export interface Task {
  id: TaskId;
  label: string;
  description: string;
  needsTree: boolean;
  run(ctx: RunContext): Promise<TaskResult>;
}

export interface CliArgs {
  entry: string | undefined;
  out: string | undefined;
  depth: number;
  variants: number;
  includeChildren: boolean;
  force: boolean;
  report: boolean;
  propsOverride: PropsShape | undefined;
  provider: string | undefined;
  apiSpec: string | undefined;
  tasks: TaskId[] | undefined;
  noInteractive: boolean;
  json: boolean;
  runTests: boolean;
  inlineSummary: boolean;
}
