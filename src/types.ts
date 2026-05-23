export type PropPrimitive = string | number | boolean | null;
export type PropValue = PropPrimitive | PropValue[] | { [k: string]: PropValue };
export type PropsShape = Record<string, PropValue>;

export type HandlerBinding =
  | { kind: "prop"; propName: string }
  | { kind: "local"; localName: string }
  | { kind: "inline" };

export type LabelSource =
  | { kind: "text"; value: string }
  | { kind: "prop"; propName: string }
  | { kind: "aria"; value: string }
  | { kind: "testid"; value: string }
  | { kind: "none" };

export interface ElementHints {
  testid?: string;
  ariaLabel?: string;
  role?: string;
  id?: string;
  name?: string;
  type?: string;
  placeholder?: string;
}

export interface ClickHandler {
  event: string;
  tag: string;
  label: LabelSource;
  hints: ElementHints;
  binding: HandlerBinding;
}

export interface FieldInfo {
  tag: "input" | "select" | "textarea";
  type?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  label?: string;
}

export interface FormInfo {
  submit: HandlerBinding | undefined;
  fields: FieldInfo[];
  hints: { testid?: string; ariaLabel?: string; id?: string };
}

export interface InteractionInfo {
  clicks: ClickHandler[];
  forms: FormInfo[];
  propUsage: Array<{ propName: string; tag: string }>;
}

export interface ComponentInfo {
  componentName: string;
  filePath: string;
  importSpecifier: string;
  propsShape: PropsShape;
  variants: PropsShape[];
  hooks: string[];
  unresolvedProps: string[];
  interactions?: InteractionInfo;
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
  nextjsHost?: boolean;
  mswSetup?: boolean;
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
  nextjs: NextjsContext | undefined;
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
  nextjs: string | undefined;
  appResolver: string | undefined;
  swaggerUrl: string | undefined;
}

export type NextjsRouter = "app" | "pages";

export interface NextjsApiRoute {
  path: string;
  methods: string[];
  file: string;
  responseShape?: unknown;
  /** Per-method response body (from OpenAPI example/schema). */
  responseBodies?: Record<string, unknown>;
}

export interface NextjsContext {
  root: string;
  router: NextjsRouter;
  appResolver: string | undefined;
  apiRoutes: NextjsApiRoute[];
}
