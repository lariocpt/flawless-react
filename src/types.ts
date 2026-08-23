/** Bad input from the caller — the CLI maps it to exit 2, internal errors to 1.
 *  Lives here (not core.ts) so leaf modules like nextjs/detect.ts can throw it
 *  without importing core and creating a cycle. */
export class UsageError extends Error {}

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
  /**
   * A literal fragment of the element's copy, where the rest is an
   * interpolation or a sibling element — `<Button>Record payment ({due})</Button>`
   * or `<MenuItem><Sun /> Light</MenuItem>`. Only this fragment is knowable, so
   * consumers must match it as a SUBSTRING of the accessible name. Asserting it
   * as the whole name is a test that can never pass.
   */
  | { kind: "text-partial"; value: string }
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
  /**
   * Whether the element is disabled at the initial render, decided by evaluating
   * the `disabled` attribute — "conditional" means the expression did not reduce.
   *
   * Playwright waits for a target to become enabled and fails on the timeout, so
   * clicking a statically-disabled control costs the full 30s and then reports
   * nothing useful. Knowing it is disabled turns that into the assertion the
   * source actually supports.
   */
  disabled?: "always" | "conditional";
}

/**
 * The control that submits a form, located structurally rather than by guessing
 * at its wording.
 *
 * The generator used to look for a button whose accessible name matched
 * /submit|save|send|create|.../ — a verb list. Against copy like "Update
 * password" or "Move to review" it matched nothing and the spec hung until the
 * suite timed out: 18 of the dogfood app's 40 browser failures, and about nine
 * minutes of every run. What a form's submit control IS, however, is written
 * down in the markup.
 */
export interface SubmitControl {
  /** Its accessible name, when the source spells it out. */
  label: LabelSource;
  /** A host <button type=submit> vs a component tag that declares type="submit". */
  host: boolean;
  /**
   * Disabled at the props the spec passes — `disabled={pending || picked.length
   * === 0}` with `picked` starting empty. Reported rather than hidden: "no
   * submit control in the markup" would send someone hunting for a button that
   * is plainly there.
   */
  disabled?: boolean;
}

export interface ClickHandler {
  event: string;
  tag: string;
  label: LabelSource;
  hints: ElementHints;
  binding: HandlerBinding;
  /**
   * The element only mounts once this trigger is clicked (a menu item, a dialog
   * body). A spec must open it first and then query asynchronously.
   */
  gatedBy?: LabelSource;
  /**
   * More than one element of this tag renders here, so "the <button>" does not
   * name this one.
   *
   * The last-resort locator is the bare host tag. `page.locator("button")
   * .first()` claims the first button is the one carrying this handler — true
   * only when there is a single button. In VoteCard it resolved to the disabled
   * "Cast vote" control while the handler belonged to a vote option, and the
   * click waited for it to become enabled until the test timed out.
   */
  ambiguousTag?: boolean;
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
  /** The button that submits it, when the markup identifies one. */
  submitControl?: SubmitControl;
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

/**
 * How a component can be mounted in a test. Anything other than client/rsc is
 * a component that cannot be rendered standalone, and the spec says so instead
 * of emitting an assertion that cannot pass.
 */
export type RenderMode = "client" | "rsc" | "document-root" | "compound-part" | "null";

/** Inferred shape of a value an async server component awaits. */
export type MockShape =
  | { kind: "array"; element?: MockShape }
  | { kind: "object"; fields: MockField[] }
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "date-string" }
  | { kind: "truthy-object" }
  | { kind: "unknown" };

export interface MockField {
  name: string;
  shape: MockShape;
  /** Field is rendered as JSX text, so a spec can assert its value. */
  rendersAsText: boolean;
}

/** A module-level data dependency awaited by an async server component. */
export interface DataDepInfo {
  /** Local binding name; undefined for a destructured binding. */
  varName: string | undefined;
  /** Callee as written: "listRecentInsights", "db.query.foo.findMany". */
  callee: string;
  /** Root identifier of the callee, for joining to moduleImports. */
  calleeRoot: string;
  /** Specifier the callee was imported from, when resolvable. */
  specifier?: string;
  awaited: boolean;
  shape: MockShape;
  /** Inference was contradictory or absent — the spec emits a TODO. */
  uncertain: boolean;
  pos: SourcePosition;
}

export type GuardEffect =
  | "notFound"
  | "redirect"
  | "permanentRedirect"
  | "unauthorized"
  | "forbidden"
  | "throw";

/** An early-exit guard in a component body: `if (!x) notFound()`. */
export interface GuardInfo {
  effect: GuardEffect;
  callee: string;
  /** Module the guard callee came from ("next/navigation"). */
  specifier?: string;
  /** Condition source text, one line, <= 80 chars. */
  conditionRaw: string;
  conditionKind: "falsy" | "truthy" | "comparison" | "complex";
  /** dataDeps var names referenced by the condition, in source order. */
  depVars: string[];
  /** The mocked return value that makes this guard fire. */
  triggerValue?: "undefined" | "null" | "empty-array";
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
  /** Resolved target file begins with a "use server" directive. */
  isServerAction?: boolean;
  /** Every top-level export of that module, for stubbing it wholesale. */
  serverActionExports?: string[];
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
  /**
   * An undecidable early return that renders nothing stands between the
   * component's entry and the JSX described here — so at the props a spec can
   * synthesise, it may well render nothing at all.
   */
  renderGuarded?: boolean;
  /** A sentinel child passed to this component appears in the markup. */
  childrenFlow?: boolean;
  /** A className passed to this component lands on some rendered element. */
  classNameFlow?: boolean;
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
  /**
   * Type expressions the analyser gave up on ("Omit", "ButtonPrimitive.Props").
   * Distinct from `unresolvedProps`, which names actual props — the two were
   * previously conflated in one array that every consumer read as prop names.
   */
  unresolvedTypes?: string[];
  /** Host element the props type is anchored to: "div", "button", "input". */
  hostElement?: string;
  /** Component renders JSX children (declared prop, or a children-taking host). */
  acceptsChildren?: boolean;
  /** prop → full literal option list, for grouped variant describes. */
  variantOptions?: Record<string, PropValue[]>;
  /** prop → option → its cva class string. Compared, never asserted verbatim. */
  variantClasses?: Record<string, Record<string, string>>;
  /** Lowercase host tag of the unconditionally-returned JSX root, when unambiguous. */
  rootTag?: string;
  /** How this component can be mounted; drives which spec template is used. */
  renderMode?: RenderMode;
  /** Why, in words — emitted into the spec and the run report. */
  renderNotes?: string[];
  /** Literal text rendered unconditionally by the happy-path return. */
  staticText?: string[];
  /** Awaited module-level data dependencies (async server components only). */
  dataDeps?: DataDepInfo[];
  /** Early-exit guards: `if (!x) notFound()`. */
  guards?: GuardInfo[];
  /** Declaration site of every prop seen on the props type (resolved or not). */
  propPositions?: Record<string, SourcePosition>;
  /** Props whose declared type is Promise<...> (e.g. Next.js 15 `params`). */
  promiseProps?: string[];
  state?: StateInfo[];
  hookDetails?: HookDetail[];
  childAttrs?: ChildAttrInfo[];
  moduleImports?: ModuleImportInfo[];
  fetchCalls?: FetchCallInfo[];
  /**
   * The component reports errors itself — `console.error(...)`, or `.error(...)`
   * on an imported binding such as a logger.
   *
   * An error boundary whose whole job is to log what it caught cannot also
   * satisfy "mounts without console errors". Asserting that against
   * `app/(auth)/error.tsx` failed the component for honouring its contract, so
   * the mount spec drops that one assertion — and says why — while keeping the
   * uncaught-exception and rendered-output assertions, which stay meaningful.
   */
  logsErrors?: string;
}

export interface ComponentTree {
  entry: ComponentInfo;
  children: ComponentTree[];
}

/** Which components in an entry file become roots of their own tree. */
export type RootMode = "primary" | "exported";

export interface AnalyseOptions {
  entry: string;
  depth: number;
  includeChildren: boolean;
  /** Default "primary" — one tree per file, as the tool has always behaved. */
  roots?: RootMode;
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
  heaps?: HeapMode;
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
  /** How much of the V8 heap the profile suite keeps; see HeapMode. */
  heaps: HeapMode;
  force: boolean;
  report: boolean;
  provider: string | undefined;
  apiSpec: string | undefined;
  inlineSummary: boolean;
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

/**
 * How much of the V8 heap the profiling suite keeps.
 *
 * A snapshot of a real app's heap is tens of megabytes, and the suite takes one
 * before and after every scenario. The dogfood run left 566MB on disk and paid
 * two full heap captures for every measurement it bracketed — an observer that
 * costs more than the thing observed.
 *
 * - `off`    — no CDP capture at all. Fastest, and the measurements are the
 *              component's rather than the component's plus a heap walk.
 * - `stress` — capture always, persist on a failure or a stress scenario. The
 *              default, and what the suite has always done.
 * - `all`    — persist every scenario. For hunting a leak, not for CI.
 */
export type HeapMode = "off" | "stress" | "all";

export interface CliArgs {
  entry: string | undefined;
  out: string | undefined;
  depth: number;
  variants: number;
  heaps: HeapMode;
  /** Run only specs affected by files changed since this ref (true = HEAD). */
  changed: string | true | undefined;
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
  roots: RootMode;
  exclude: string[];
  useDefaultExcludes: boolean;
}

export type NextjsRouter = "app" | "pages";

export interface NextjsApiRoute {
  path: string;
  methods: string[];
  file: string;
  /** Per-method response body (from OpenAPI example/schema). */
  responseBodies?: Record<string, unknown>;
}

export interface NextjsContext {
  root: string;
  router: NextjsRouter;
  appResolver: string | undefined;
  apiRoutes: NextjsApiRoute[];
}
