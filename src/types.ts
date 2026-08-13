export type PropPrimitive = string | number | boolean | null;
export type PropValue = PropPrimitive | PropValue[] | { [k: string]: PropValue };
export type PropsShape = Record<string, PropValue>;

/** 1-based position of a node in a source file (file is absolute). */
export interface SourcePosition {
  file: string;
  line: number;
  column: number;
}

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
  pos?: SourcePosition;
}

export interface FieldInfo {
  tag: "input" | "select" | "textarea";
  type?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  label?: string;
  pos?: SourcePosition;
}

export interface FormInfo {
  submit: HandlerBinding | undefined;
  fields: FieldInfo[];
  hints: { testid?: string; ariaLabel?: string; id?: string };
  pos?: SourcePosition;
}

export interface InteractionInfo {
  clicks: ClickHandler[];
  forms: FormInfo[];
}

/** How a prop is used inside the component body. */
export type PropUsageKind =
  | "jsx-attr"
  | "passed-to-child"
  | "jsx-child"
  | "hook-dep"
  | "hook-arg"
  | "call"
  | "member-access"
  | "conditional"
  | "other";

export interface PropUsage {
  propName: string;
  kind: PropUsageKind;
  pos: SourcePosition;
  /** JSX tag for jsx-attr / passed-to-child / jsx-child. */
  tag?: string;
  /** Attribute name for jsx-attr / passed-to-child. */
  attr?: string;
  /** Hook name for hook-dep / hook-arg. */
  hook?: string;
  /** Property accessed off the prop, when the reference is `prop.member`. */
  member?: string;
}

export type StateKind = "useState" | "useReducer" | "useRef";

export interface SetterCallSite {
  pos: SourcePosition;
  context: "handler" | "effect" | "callback" | "render" | "unknown";
  /** Nearest useful name: "handleAdd", "useEffect", "onClick". */
  enclosingName?: string;
  /** An if/ternary/&&/|| sits between the component body and the call. */
  guarded: boolean;
  argKind: "literal" | "updater" | "expression" | "none";
}

export interface StateJsxFlow {
  tag: string;
  via: "child" | "attr";
  attr?: string;
  pos: SourcePosition;
}

export interface StateInfo {
  kind: StateKind;
  varName: string;
  /** setX / dispatch; undefined for useRef. */
  setterName?: string;
  /** Synthesised only when the initializer is literal-composable. */
  initialValue?: PropValue;
  /** Initializer source text, truncated to 120 chars. */
  initialRaw?: string;
  typeKind: "string" | "number" | "boolean" | "null" | "array" | "object" | "unknown";
  pos: SourcePosition;
  setterCalls: SetterCallSite[];
  flowsToJsx: StateJsxFlow[];
  setterCalledInEffect: boolean;
}

export interface EffectFeatures {
  fetch: boolean;
  setInterval: boolean;
  setTimeout: boolean;
  addEventListener: boolean;
  hasCleanup: boolean;
}

export interface HookDetail {
  name: string;
  pos: SourcePosition;
  argCount: number;
  /** Per arg: "arrow" | "function" | "identifier:x" | "literal:0" | "object" | "array" | "call" | "other". */
  argsSummary: string[];
  /** Raw source text per deps-array element; undefined when there is no array arg. */
  deps: string[] | undefined;
  /** Any deps element that is not a plain identifier (member access, spread, call…). */
  depsHasComplex: boolean;
  /** Hook is a deps-taking hook but no array literal was passed. */
  missingDepsArray: boolean;
  /** Component-scope identifiers read inside the arg-0 callback (sorted, unique). */
  callbackReads: string[];
  callbackIsInline: boolean;
  /** The bare props object identifier is referenced inside the callback (analysis bail signal). */
  readsBareParamsObject: boolean;
  /** Only for useEffect / useLayoutEffect. */
  effectFeatures?: EffectFeatures;
  /** `const x = useMemo(...)` → "x". */
  resultName?: string;
}

/** Value shape of an attribute passed to an uppercase (component) JSX child. */
export type AttrValueKind =
  | "string"
  | "number"
  | "boolean-true"
  | "null"
  | "identifier"
  | "member"
  | "object-literal"
  | "array-literal"
  | "arrow"
  | "function"
  | "call"
  | "jsx"
  | "spread"
  | "other";

export interface ChildAttrInfo {
  tag: string;
  /** "...spread" for JsxSpreadAttribute. */
  attr: string;
  valueKind: AttrValueKind;
  /** Root identifier for identifier / member kinds. */
  identifier?: string;
  pos: SourcePosition;
}

/** A fetch() call site inside the component body. */
export interface FetchCallInfo {
  /** URL with interpolations replaced by :holes — "/api/buildings/:buildingId/ai/ask". */
  urlTemplate: string;
  /** Hole names in order: ["buildingId"]. */
  holes: string[];
  method: string;
  pos: SourcePosition;
  /** Call sits inside a useEffect/useLayoutEffect callback. */
  inEffect: boolean;
}

/** A top-level import declaration of the analysed file, classified for scaffolding. */
export interface ModuleImportInfo {
  specifier: string;
  /** Local names bound by this declaration (default + named + namespace). */
  names: string[];
  /** "component" iff any local name is used as a JSX tag root in the file. */
  kind: "component" | "value";
  isTypeOnly: boolean;
  hasDefault: boolean;
  /** Absolute path when the specifier resolves to a project-local module. */
  resolvedPath?: string;
  pos: SourcePosition;
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
  /** Position of the component declaration. */
  pos?: SourcePosition;
  /** How the component leaves its module. "none" = same-file secondary component. */
  exportKind?: "default" | "named" | "none";
  /** Async function component (server component in app-router projects). */
  isAsync?: boolean;
  /** File carries a "use client" prologue directive. */
  isClientComponent?: boolean;
  wrappers?: Array<"memo" | "forwardRef">;
  /** JSX tag the parent used for this child (differs from componentName under aliasing). */
  localTag?: string;
  propUsage?: PropUsage[];
  /** Declaration site of every prop seen on the props type (resolved or not). */
  propPositions?: Record<string, SourcePosition>;
  /** Props whose declared type is Promise<...> (e.g. Next.js 15 `params`). */
  promiseProps?: string[];
  state?: StateInfo[];
  hookDetails?: HookDetail[];
  childAttrs?: ChildAttrInfo[];
  moduleImports?: ModuleImportInfo[];
  fetchCalls?: FetchCallInfo[];
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

export type TaskId =
  | "perf-harness"
  | "unit-browser"
  | "perf-static"
  | "a11y"
  | "react-rules"
  | "e2e"
  | "load";

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
  /** Emit unit specs next to the analysed source files instead of <outDir>/unit. */
  colocate?: boolean;
  /** Every task id selected for this run, so tasks can honour cross-task deps. */
  selectedTasks?: TaskId[];
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
  colocate: boolean;
  ci: boolean;
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
