/** Bad input from the caller — the CLI maps it to exit 2, internal errors to 1.
 *  Lives here (not core.ts) so leaf modules like nextjs/detect.ts can throw it
 *  without importing core and creating a cycle. */
export class UsageError extends Error {}

export type PropPrimitive = string | number | boolean | null;
export type PropValue = PropPrimitive | PropValue[] | { [k: string]: PropValue };
export type PropsShape = Record<string, PropValue>;

/**
 * Stands in for a real Date inside a PropValue (JSON-safe). A Date-typed prop
 * gets this because a string answers none of getTime/toISOString/
 * toLocaleTimeString; `defaultsJson` rewrites every occurrence back into a
 * live `new Date(...)` at the places a PropsShape becomes spec source.
 */
export const DATE_PROP_SENTINEL = "__flawless_date__";
export const DATE_PROP_ISO = "2024-01-01T00:00:00.000Z";

/** 1-based position of a node in a source file (file is absolute). */
export interface SourcePosition {
  file: string;
  line: number;
  column: number;
}

/**
 * Something a handler provably does, for deciding what a spec may assert AFTER
 * dispatching it.
 *
 * The emitters used to fall back to `expect(container.firstElementChild)
 * .not.toBeNull()` — "the click did not take the component down". Under a
 * provider that is answered by the PROVIDER's node, so it cannot fail (30 of 30
 * spec files carrying it on the dogfood app); without one it goes red on a
 * component that legitimately unmounts. Vacuous or wrong, never useful.
 *
 * These are the crossings a spec can actually observe: a call into a module it
 * mocks, a router navigation, a state setter. Anything else is honestly nothing,
 * and the emitter says so rather than inventing a claim.
 */
export type HandlerEffect =
  | { kind: "call"; root: string; dominated: boolean }
  | {
      kind: "router";
      method: "push" | "replace" | "navigate" | "back";
      target?: string;
      dominated: boolean;
    }
  | { kind: "setState"; setter: string; dominated: boolean };

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
  /**
   * The element's whole accessible name is one prop interpolated into static
   * copy: `<button>+{step}</button>`. `before`/`after` are the trimmed literal
   * text on either side of that interpolation, so the matcher can keep it — a
   * name query of just the prop value never matches "+3", and the failure reads
   * like an interaction gap rather than a dropped prefix.
   */
  | { kind: "prop"; propName: string; before?: string; after?: string }
  /**
   * A literal `data-testid`. Produced by both label ladders and consumed by
   * every selector emitter (`getByTestId`), so it belongs in the union even
   * though the analysers rank it differently: extractDisclosures tries it
   * before `aria-label`, extractInteractions after.
   */
  | { kind: "testid"; value: string }
  | { kind: "aria"; value: string }
  /**
   * The trigger's whole subtree is the `{children}` expression — the app's
   * consumer IS the trigger (ConfirmModal's `<AlertDialogTrigger asChild>
   * {children}</AlertDialogTrigger>`). Nothing inside names it, but a unit
   * spec passes CHILD_TEXT there, so clicking the child text opens it.
   */
  | { kind: "children" }
  | { kind: "none" };

export interface ElementHints {
  testid?: string;
  ariaLabel?: string;
  role?: string;
  id?: string;
  /** Never populated on native — React Native elements have no `name`. */
  name?: string;
  /** Never populated on native — there is no input `type`. */
  type?: string;
  placeholder?: string;
  /** `accessibilityHint`. Native only; RNTL queries it with getByHintText. */
  hint?: string;
  /**
   * `title` on React Native's own `<Button>`, which renders no children — so the
   * prop IS the accessible name, and the usual descendant-text rung finds nothing.
   */
  buttonTitle?: string;
  /**
   * A literal `value` on a TextInput. Native only; RNTL queries it with
   * getByDisplayValue, which has no DOM-side equivalent in this ladder.
   */
  displayValue?: string;
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
  /**
   * What this handler provably does — see HandlerEffect.
   *
   * `dominated` on each entry means the effect is reached with no branch and no
   * earlier return in front of it, so a spec that dispatches the event can
   * assert it happened. An effect that is NOT dominated is real but conditional,
   * and asserting it would be a claim about a path the defaults may not take.
   */
  effects?: HandlerEffect[];
  /**
   * The element renders element children and every one of them is textless — an
   * icon, a spinner — so nothing under it can name it.
   *
   * Native only, and it is the same absence twice: an icon-only control is
   * unaddressable to a spec AND unannounced to a screen reader, so one
   * accessibilityLabel retires both. Recorded here so the skip's wording and the
   * a11y finding can agree without either re-deriving it.
   */
  iconOnly?: boolean;
  /**
   * Literal route paths this handler navigates to — `router.push("/items/new")`.
   *
   * The React Native analogue of a link's href, and statically knowable in
   * exactly the cases that matter. Only LITERALS: a template like
   * `/items/${'${item.id}'}` names a route the spec cannot predict, so it is
   * omitted rather than guessed at.
   *
   * Two consumers: the emitted spec asserts the resulting pathname, and the
   * renderRouter context must carry a stub for each target — without one the push
   * lands on expo-router's injected +not-found and the assertion fails for a
   * reason that has nothing to do with the component.
   */
  pushTargets?: string[];
  /**
   * The handler navigates BACK — `router.back()`.
   *
   * It needs a precondition the harness does not supply by default: renderRouter
   * mounts a single screen at one URL with no history, so back() fails with
   * "The action 'GO_BACK' was not handled by any navigator". Recorded so the
   * emitted test can push an entry first, rather than failing for a reason that
   * is neither the app's nor the tool's.
   */
  navBack?: boolean;
  /**
   * The element is reached only CONDITIONALLY at the props and state the spec
   * passes — typically one row of a `.map()` over data the component fetches.
   *
   * `reachability` returns "unknown" for those and the harvest keeps them, which
   * is right: dropping every mapped row would lose most of a list screen. But a
   * spec cannot DRIVE what does not render, and on a screen whose collection the
   * fixture leaves empty the row is genuinely absent — so the emitter turns these
   * into a skip that says so rather than a test that fails.
   */
  conditional?: boolean;
  pos?: SourcePosition;
}

export interface FieldInfo {
  /** DOM tag on web; the module-side React Native export name on native. */
  tag: "input" | "select" | "textarea" | "TextInput" | "Switch";
  type?: string;
  /** Never set on native — React Native inputs have no `name`. */
  name?: string;
  id?: string;
  placeholder?: string;
  /**
   * Never set on native, and the negative result matters.
   *
   * React Native's idiom is a preceding sibling `<Text>Email</Text>`, but RNTL's
   * getByLabelText matches `accessibilityLabel`/`aria-label`/`aria-labelledby`
   * and NOTHING else — there is no htmlFor and no positional association. So
   * treating a nearby `<Text>` as a label would emit a query that ALWAYS throws,
   * which is worse than a check that cannot fail: it is a check that cannot pass.
   */
  label?: string;
  /**
   * Native only. How the field is bound, which decides whether it can be typed
   * into at all:
   *
   * - "controlled"   — `value={x}` with a matching `onChangeText={setX}`.
   * - "uncontrolled" — `defaultValue`, or neither.
   * - "frozen"       — `value` with NO onChangeText. React Native issues no
   *   controlled-input warning (unlike the DOM), so the input is simply inert and
   *   `fireEvent.changeText` is a silent no-op that still passes. Recorded rather
   *   than dropped so the emitter can say why it skipped.
   */
  control?: "controlled" | "frozen" | "uncontrolled";
  /** Native only: the useState variable `value` is bound to. */
  stateVar?: string;
  pos?: SourcePosition;
}

export interface FormInfo {
  submit: HandlerBinding | undefined;
  fields: FieldInfo[];
  /** The button that submits it, when the markup identifies one. */
  submitControl?: SubmitControl;
  hints: { testid?: string; ariaLabel?: string; id?: string };
  /**
   * The disclosure whose trigger must be clicked before this form exists at
   * all — a form inside a closed Radix dialog is not in the DOM until the
   * trigger opens it (RenameModal). Same gate the click tests honour.
   */
  gatedBy?: LabelSource;
  /**
   * The server action this form's `action={…}` dispatches to, as the module
   * names it.
   *
   * `<form action={action}>` where `const [state, action] = useActionState(
   * loginAction, undefined)` — React invokes `loginAction` on submit, with no
   * guard in between, so a spec that submits can assert it fired. That makes it
   * the one post-dispatch claim on the DOM plane that this app's own shapes
   * actually support: every CLICK handler here puts its action behind a guard
   * AND inside a startTransition callback, so the click ladder correctly
   * declines on all of them.
   *
   * Recorded as the MODULE-side name, because that is what the spec imports and
   * what vi.mock replaced.
   */
  actionBinding?: string;
  pos?: SourcePosition;
}

/**
 * One native host element as the a11y census saw it — the raw material of the
 * native a11y task's rules.
 *
 * Harvested at analysis time because the parse is gone by task time, by a walk
 * of the WHOLE source file that is deliberately NOT reachability-pruned: the
 * clicks harvest decides what a spec can DRIVE, where a phantom element costs a
 * wrong click, but this census decides what a screen reader ENCOUNTERS, and the
 * back button inside an error branch still needs its role. Elements belonging
 * to sibling components in the same file are included — half the dogfood app's
 * pressables live in same-file row components — and the task dedupes by
 * position, since every component analysed out of a file carries the file's
 * whole census.
 */
export interface NativeA11yElement {
  /** Module-side export name of the resolved native host element. */
  element: string;
  /** The element's own start position; `file` is absolute. */
  pos: SourcePosition;
  hints: ElementHints;
  label: LabelSource;
  /** Pressable / TouchableOpacity / TouchableHighlight / TouchableWithoutFeedback. */
  pressable?: true;
  /**
   * Provably renders no text: every element child is textless (the iconOnly
   * proof) or there are no children at all. A pressable with dynamic children
   * is NOT textless — `{building.name}` announces at runtime — which is what
   * keeps the unnamed-control rule at zero false positives.
   */
  textless?: true;
  /** accessibilityLabel / aria-label is present but not a string literal. */
  dynamicLabel?: true;
  /** accessibilityRole / role is present but not a string literal. */
  dynamicRole?: true;
  /**
   * Literal role attributes as written on the element. Kept per attribute
   * because `accessibilityRole` and `role` have DIFFERENT valid-value unions
   * ("header" vs "heading"), so each literal must be validated against its own.
   */
  roleLiterals?: Array<{ attr: "accessibilityRole" | "role"; value: string }>;
  /**
   * aria-hidden / accessibilityElementsHidden / importantForAccessibility=
   * "no-hide-descendants" on the element itself. "unknown" means the attribute
   * is present but not a literal, and the rules treat that as hidden — a miss
   * costs coverage, a guess costs a false finding.
   */
  hiddenFromA11y?: "yes" | "unknown";
  /**
   * The announcement is owned elsewhere: some JSX ancestor is a press-family
   * element, carries a literal accessibility label, or is itself hidden from
   * the a11y tree — or the element is the ROOT of its JSX island (a render
   * prop like `tabBarIcon: () => <Ionicons/>`), handed to an owner this file
   * cannot see. The icon rule stands down on all of these.
   */
  exemptAncestor?: true;
}

export interface InteractionInfo {
  clicks: ClickHandler[];
  forms: FormInfo[];
  /** Present only for native-dialect files. See NativeA11yElement. */
  a11yElements?: NativeA11yElement[];
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
  /**
   * Full member path for a member-access, e.g. ["body","length"] for
   * `drop.body.length`. `member` is its head. The {} floor survives one hop
   * and dies on the second, so the chain is what tells synthesiseDefaults
   * the head needs a value richer than {}.
   */
  chain?: string[];
}

export type StateKind = "useState" | "useReducer" | "useRef" | "useActionState";

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
  via: "child" | "attr" | "condition";
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
  | { kind: "set" }
  | { kind: "map" }
  | { kind: "date" }
  | { kind: "unknown" };

export interface MockField {
  name: string;
  shape: MockShape;
  /** Field is rendered as JSX text, so a spec can assert its value. */
  rendersAsText: boolean;
  /**
   * The component compares this field to a literal, so the fixture uses it.
   *
   * Twenty-two of the dogfood web app's thirty-two page specs never rendered
   * anything: the page looked up the viewer's own membership with
   *
   *   memberships.find((m) => m.building_id === id && m.status === "active")
   *
   * and the synthesised row carried `status: "flawless-status"`, so the find
   * returned undefined and the page called notFound(). The spec then reported
   * the guard exit as a pass, and 117 of the page's 158 lines never ran.
   *
   * Not coverage-chasing: a membership row whose status is a placeholder is not
   * a valid instance of what this page reads. The literal is written in the
   * component's own source — the same class of evidence as every other field
   * here, just read from a comparison rather than from a use.
   */
  equals?: string | number | boolean;
  /**
   * The component compares this field to one of its own props, by path.
   *
   * `memberships.find((m) => m.building_id === id)` where `const { id } = await
   * params` — so the row only matches when its building_id IS the route param
   * the page was rendered for, which is the only membership row that page is
   * ever looking at. Resolved at emit time against the same props fixture the
   * spec's DEFAULTS carries, so the two cannot drift apart.
   */
  equalsProp?: string[];
  /**
   * The component compares this field to a field of another top-level data
   * dependency: `members.find((m) => m.user_id === user.id)` with `const user
   * = await getCurrentUser()` two lines above. Neither side is a literal or a
   * prop, so `equals`/`equalsProp` cannot see it — and the two synthesised
   * values ("flawless-user_id" vs "flawless-id") never match, so the lookup
   * fails and the page guard-exits. Resolved at emit time against the fixture
   * the referenced dep actually mocks with, so the two agree by construction;
   * dropped silently when that dep (or its field) resolves to no value.
   */
  equalsDep?: { var: string; field: string };
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
  /**
   * Fixture value resolved from the dep's own DECLARATION when usage-based
   * inference came up empty: today always from a Promise<T> return
   * annotation ("annotation"); "openapi" values are joined at emit time from
   * wrapsFetch and never stored here. See analyse/resolveDepReturns.ts.
   */
  inferredReturn?: {
    value: PropValue;
    provenance: "annotation" | "openapi";
    /**
     * The declaration is synchronous, so the mock must be too. Only ever set
     * for a dep that is not awaited — `formatZAR(cents): string` mocked as
     * `async () => ({})` made every money value on the page an object.
     */
    sync?: boolean;
    /**
     * The return TypeNode is the `boolean` KEYWORD (or Promise<boolean>) —
     * read at the declaration, because the stored value cannot say: a
     * `(): true` literal annotation and a `(): boolean` both store `true`,
     * and only the second admits `false`. What makes a predicate flip
     * provably reachable under the dep's own contract (B-19).
     */
    booleanAnnotated?: true;
    /** The annotation is a union with a null/undefined arm — `null` is a
     * legal return, so a truthy guard on this dep has a reachable false side. */
    nullableAnnotated?: true;
  };
  /**
   * The dep is an unannotated wrapper whose body performs exactly one
   * fetch(); the emitter joins method+path to the OpenAPI response example
   * (NextjsApiRoute.responseBodies) — the join lives at emit time because
   * analyse() has no route table.
   */
  wrapsFetch?: { method: string; path: string };
  pos: SourcePosition;
}

// ---------------------------------------------------------------------------
// B-19: both sides of a decidable predicate
// ---------------------------------------------------------------------------

/** How a spec flips one predicate: which mock (or prop) moves, and to what. */
export type PredicateFlipKind =
  /** A dep whose boolean-KEYWORD annotation admits false: `isTrustee(…)`. */
  | "dep-bool"
  /** A nullable-annotated dep behind a truthy exit guard: `if (session) redirect(…)`. */
  | "dep-null"
  /** An array dep flipped to [] so the empty side renders. */
  | "dep-empty"
  /** A prop (or destructured awaited-prop field) overridden via buildProps. */
  | "prop";

/**
 * One render branch a certified flip moves. `baselineSide` is the side the
 * DEFAULT fixture evaluates to — the flip takes the other. Witnesses are
 * text-position literals unconditional WITHIN their arm; a side with none
 * can still be asserted by the other side's absence, but never stands alone.
 */
export interface PredicateSiteInfo {
  /** Value of the condition under the default fixture env. */
  baselineSide: boolean;
  trueWitness?: string;
  falseWitness?: string;
  /** Data-selection ternary: the single mocked callee each arm invokes. */
  trueCallee?: string;
  falseCallee?: string;
  /** The site's own position is reachable under that leg's env. */
  reachableAtDefaults: boolean;
  reachableWhenFlipped: boolean;
  pos: SourcePosition;
}

/**
 * A predicate the emitter can invert with one per-test override, plus the
 * sites that provably change side when it does. Only evidence-certified
 * flips appear here; everything detected-but-refused lands in
 * `predicateRefusals` with a named reason (the renderUndecidable rule:
 * refusals are named, never silent).
 */
export interface PredicateInversionInfo {
  kind: PredicateFlipKind;
  /** Local the value binds to ("userIsTrustee", "contractors", "session"),
   * or the dotted prop path for a prop flip. */
  varName: string;
  /** Mocked binding the override targets (dep kinds). */
  calleeRoot?: string;
  specifier?: string;
  /** mockResolvedValueOnce vs mockReturnValueOnce. */
  awaited?: boolean;
  /** buildProps override path (prop kind). */
  propPath?: string[];
  /** The flipped value; absent = `undefined` (a prop omitted). */
  flip?: PropValue;
  sites: PredicateSiteInfo[];
  pos: SourcePosition;
}

export interface PredicateRefusal {
  varName: string;
  reason: /** The controlling callee has more than one call site — a Once-override
   * would flip an unpredictable one. */
    | "multi-call"
    /** The control also decides an exit guard — that false side EXITS, and
     * emitGuardTests owns it. */
    | "guard-entangled"
    /** Flipping provably does not change any site's side. */
    | "invisible"
    /** Every moved site lost its witnesses — nothing falsifiable to assert. */
    | "unwitnessed"
    /** Certified, but over the per-spec inversion cap. */
    | "capped";
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
  /**
   * Module-side export name per entry of `names`: `import { cn as cx }` records
   * "cn" where `names` records "cx". Default and namespace entries repeat the
   * local name — they have no module-side name.
   */
  importedNames?: string[];
  /**
   * The LOCAL names among `names` that were imported with a `type` specifier
   * (`import { cva, type VariantProps } from "class-variance-authority"`).
   *
   * They are erased at compile time: the module does not export them at
   * runtime. So they are not bindings a `vi.mock` factory can supply, and they
   * are no evidence that the module needs mocking. Without this field a mixed
   * statement read as two live imports, and EVERY shadcn/ui module's
   * `import { cva, type VariantProps } from "class-variance-authority"` earned
   * that package a factory mock — where `cva` is stubbed as a class-string
   * producer, so the app's own `const buttonVariants = cva(…)` evaluated to a
   * string and 76 specs of one fresh generation died on
   * "buttonVariants is not a function".
   *
   * `isTypeOnly` covers the whole declaration; this names the individual
   * specifiers of a MIXED one.
   */
  typeOnlyNames?: string[];
  /**
   * Names contributed by the component-tree walk — this file never imported
   * them; some other file in the render does. A mocked module must cover them
   * (its factory replaces every importer's view), but they carry NO evidence
   * about whether the module should be mocked at all: a module whose own
   * bindings are pure helpers stays real even when the graph elsewhere calls
   * `timeAgo` from it. The mock-decision exemptions read this field.
   */
  mergedNames?: string[];
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
  /**
   * Module-side export name → the single literal value that action returns
   * (redirect/notFound exits excluded; "default" for the default export).
   * Only literal-derivable returns are recorded — see
   * analyse/serverActionReturns.ts for the bail policy. Names absent here
   * keep the honest {} stub and the server-action-stub TODO.
   */
  serverActionReturns?: Record<string, PropValue>;
  /**
   * Module-side export name → its own return annotation, for names this
   * component IMPORTS but that never became a dataDep — a helper called inside
   * JSX rather than awaited into a variable.
   *
   * Those got `vi.fn(async () => ({}))` on the reasoning that `{}` beats
   * undefined. It does, against nothing; against the declaration it does not.
   * `formatZAR(cents: number): string` was mocked async returning an object, so
   * every money value on the dogfood app's finance pages rendered as one.
   *
   * `sync` mirrors the declaration: a synchronous function mocked as async
   * hands the component a promise where it expects a value.
   */
  importedReturns?: Record<
    string,
    {
      value: PropValue;
      sync: boolean;
      /** Return TypeNode is the boolean KEYWORD (not a `true` literal) —
       * `false` is a legal return, so a predicate flip is contract-backed. */
      booleanAnnotated?: true;
      /** Annotation is a union with a null/undefined arm. */
      nullableAnnotated?: true;
    }
  >;
  /**
   * Module-side export names whose declarations are DATA constants — literals,
   * object/array literals of data, property-access chains; never a call, a
   * construction, or a function value (analyse/dataExports.ts). When every
   * value binding of the import is one, the RSC mock emitter leaves the module
   * real: the factory replacement would starve transitive importers of the
   * exports this component never named.
   */
  dataExports?: string[];
  /**
   * The LOCAL module behind this import only CALCULATES: no await, no async,
   * no live (non-type) import, no top-level call (analyse/pureModule.ts).
   * Such a module is not a data source however it is imported — the mock
   * loop leaves it real. Without this, a tree-wide mock sweep replaces
   * `splitCode` with {} and the render dies calling .map on the result.
   */
  isPureModule?: boolean;
  /**
   * Module-side export names whose declarations are ASYNC functions, for
   * imports used as JSX tags. React's client renderer refuses an async
   * function component outright, so a server page rendering `<InsightsCard>`
   * under jsdom produces an empty container — the RSC spec must stub such a
   * child rather than mount it. "default" names a default export.
   */
  asyncComponents?: string[];
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
  /**
   * renderPath could not decide WHICH branch renders, and the branches return
   * content rather than nothing — so there is no render to describe at all.
   *
   * Distinct from `renderGuarded`, which means "a render was found, and an
   * undecidable early return stands in front of it". This is the case where no
   * render was found: `if (this.state.error) return <Fallback/>; return children;`
   * is the canonical shape, and it arrives on every class component whose render
   * branches on state, and on any function with an opaque guard returning content.
   *
   * README has always said such a component "produces no description at all".
   * Nothing recorded that, so the emitters harvested the fallback branch and
   * wrote assertions against markup the defaults never render.
   */
  renderUndecidable?: boolean;
  /**
   * The component is a React error boundary, and this is the literal copy its
   * caught state renders.
   *
   * The one undecidable render whose BOTH branches a spec can reach: React's
   * contract for getDerivedStateFromError says a throwing child puts the
   * component here, so the fallback is assertable rather than refused.
   */
  errorBoundary?: { fallbackText: string[] };
  /** A sentinel child passed to this component appears in the markup. */
  childrenFlow?: boolean;
  /** A className passed to this component lands on some rendered element. */
  classNameFlow?: boolean;
  /** Position of the component declaration. */
  pos?: SourcePosition;
  /** How the component leaves its module. "none" = same-file secondary component. */
  exportKind?: "default" | "named" | "none";
  /** Boundary name when `export { Local as Public }` renames the component. */
  exportedAs?: string;
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
  /**
   * Which host-element vocabulary THIS FILE's JSX is written in — "dom" for
   * lowercase intrinsics, "native" for React Native's imported capitalised
   * elements. Decided per file from its own imports, because an Expo app can also
   * target web and a monorepo sweep crosses both. Absent means "dom", which is
   * what every file analysed before this existed was.
   */
  hostDialect?: "dom" | "native";
  /** Component renders JSX children (declared prop, or a children-taking host). */
  acceptsChildren?: boolean;
  /**
   * Children flow into an `asChild` Slot or a bare <Slot>/<Slottable> — the
   * fixture must pass an ELEMENT child (a text child makes Slot throw).
   * analyse/childrenIntoSlot.ts.
   */
  childrenSlotted?: boolean;
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
  /**
   * For a compound part: the family its OWN file exports — the sibling that
   * renders the package Root, the Content sibling when there is one, and
   * this part's role. Derived same-file only (analyse/compoundFamily.ts);
   * whether the family is actually wrappable (open-state Roots only) is the
   * emitters' decision, keyed off `specifier`.
   */
  compoundFamily?: {
    root: string;
    content?: string;
    part: "trigger" | "content" | "other";
    specifier: string;
  };
  /** Literal text rendered unconditionally by the happy-path return. */
  staticText?: string[];
  /** Awaited module-level data dependencies (async server components only). */
  dataDeps?: DataDepInfo[];
  /** Early-exit guards: `if (!x) notFound()`. */
  guards?: GuardInfo[];
  /** Predicates a spec can invert with one override, with the sites that
   * provably change side (async server components only). B-19. */
  predicateInversions?: PredicateInversionInfo[];
  /** Detected-but-refused inversions, each with a named reason. */
  predicateRefusals?: PredicateRefusal[];
  /** Declaration site of every prop seen on the props type (resolved or not). */
  propPositions?: Record<string, SourcePosition>;
  /** Props whose declared type is Promise<...> (e.g. Next.js 15 `params`). */
  promiseProps?: string[];
  state?: StateInfo[];
  hookDetails?: HookDetail[];
  childAttrs?: ChildAttrInfo[];
  moduleImports?: ModuleImportInfo[];
  /**
   * moduleImports of the components rendered BELOW this unit — real code
   * inside a spec's render. Drop awaits getUserDropInteractions even when
   * the page itself imports only getDropsByAuthor, and the module mock is
   * shared by the whole render: without the tree's data modules the real
   * one runs (cookies() in a jsdom mount) or a {} fixture kills the mount.
   */
  treeImports?: ModuleImportInfo[];
  /** Descendants' dataDeps — call-site shapes joined via calleeRoot. */
  treeDataDeps?: DataDepInfo[];
  /**
   * What the CHILD components rendered by this unit's own JSX expect on the
   * props they receive: tag → attr → the child's default value for it
   * (analyse/childBridge.ts). A child reads more of a value than the
   * parent's member accesses show — Drop hands RelativeTime a
   * `drop.createdAt` nobody typed — so synth consults this when building an
   * unresolved prop's stand-in, and analyse folds it into data fixtures.
   */
  childExpected?: Record<string, Record<string, unknown>>;
  fetchCalls?: FetchCallInfo[];
  /**
   * GET/mutation endpoints this component reaches through the app's own fetch
   * wrapper, resolved ONE hop: the screen calls an imported api function
   * (`listBuildings()`), whose body calls a module-local fetch wrapper with a
   * literal path (`apiFetch("/api/buildings")`). `fetchCalls` sees only a bare
   * `fetch()` in the component body; a React Native app never has one — every
   * call goes through `lib/api.ts` — so without this the load harvest is empty.
   * Native-only (the harvest runs solely for host-dialect "native" files); the
   * shape is FetchCallInfo so the load task treats it exactly like a direct
   * fetch. B-16 wave 7.
   */
  apiCalls?: FetchCallInfo[];
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
  /**
   * Leave an existing suite exactly as it is (status "kept", nothing written).
   * Set by perf-harness in changed-mode; ignored when no suite exists yet.
   */
  keepExisting?: boolean;
  report: boolean;
  provider: string | undefined;
  apiSpec: string | undefined;
  extraTrees?: ComponentTree[];
  suiteName?: string;
  nextjsHost?: boolean;
  mswSetup?: boolean;
  /**
   * Context providers the host mounts around each component (analyse/providerWraps
   * derives them; key is `${filePath}::${componentName}`). The route layout that
   * supplies them is not a component entry, so the provider is often no analysed
   * tree's member — SidebarProvider in the kiranism dogfood was used only by
   * app/dashboard/layout.tsx and mounting SidebarTrigger bare then died on
   * "useSidebar must be used within a SidebarProvider".
   */
  providerWraps?: Map<string, ProviderRef[]>;
}

/**
 * A component that supplies context, referenced from OUTSIDE the analysed tree:
 * located by parsing the file the consuming hook lives in.
 */
export interface ProviderRef {
  componentName: string;
  filePath: string;
  exportKind: "default" | "named";
  /** Boundary name when the provider is re-exported under an alias. */
  exportedAs?: string;
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

/**
 * What kind of hand-work a planted TODO(flawless) marker asks for. The three
 * named-and-frequent kinds plus the two structural ones; everything else the
 * templates plant (missing assertions, undrivable forms, guarded interactions)
 * is "other" — on the dogfood app ~89% of markers fell in three kinds, which is
 * exactly the adoption-cost distribution the report needs to show.
 */
export type TodoKind =
  | "uninferred-return-shape"
  | "compound-root-wrap"
  | "server-action-stub"
  | "unaddressable-target"
  // B-12. Not planted per spec like the others: it is recorded once per run
  // when the emitted global-setup.ts is still byte-identical to the stub, so
  // every route spec in the suite is navigating unauthenticated.
  | "e2e-auth-unfilled"
  | "other";

export interface TodoTally {
  kind: TodoKind;
  count: number;
  /** One emitted spec carrying such a marker — absolute; the report relativises. */
  exemplar: string;
}

/** Records one marker of `kind` into the file the recorder was bound to. */
export type TodoRecorder = (kind: TodoKind) => void;

/**
 * Tallies TODO(flawless) markers AT THE EMISSION SITES, as each one is planted.
 * These numbers must never be derived by grepping the emitted text: the marker
 * wording is presentation and changes freely, so a text-based count breaks
 * silently the moment a template is reworded.
 */
export class TodoCounter {
  // Keyed by the file each recorder was bound to: tallying happens at RENDER
  // time, but a renderer's output is not necessarily written (colocated specs
  // are kept when they exist and --force is off), so the writer must be able
  // to retract a whole file's tallies without touching the others'.
  private byFile = new Map<string, Map<TodoKind, number>>();

  add(kind: TodoKind, exemplar: string): void {
    const perKind = this.byFile.get(exemplar) ?? new Map<TodoKind, number>();
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
    this.byFile.set(exemplar, perKind);
  }

  /** A recorder bound to one emitted file, for threading through templates. */
  for(file: string): TodoRecorder {
    return (kind) => this.add(kind, file);
  }

  /**
   * Forget everything tallied into `file`. For the writer that decided not to
   * write it: markers in a discarded render are not debt, and may name TODOs
   * the user already resolved in the file that was kept.
   */
  drop(file: string): void {
    this.byFile.delete(file);
  }

  /** Sorted by kind: this lands verbatim in a committed, deterministic file. */
  toTallies(): TodoTally[] {
    const byKind = new Map<TodoKind, { count: number; exemplar: string }>();
    for (const [file, perKind] of this.byFile) {
      for (const [kind, count] of perKind) {
        const row = byKind.get(kind);
        if (!row) {
          byKind.set(kind, { count, exemplar: file });
          continue;
        }
        row.count += count;
        // Lexicographically smallest, so the exemplar — and REPORT.md with it —
        // is byte-identical however the trees happened to be ordered.
        if (file < row.exemplar) row.exemplar = file;
      }
    }
    return [...byKind.entries()]
      .map(([kind, r]) => ({ kind, count: r.count, exemplar: r.exemplar }))
      .sort((a, b) => (a.kind < b.kind ? -1 : 1));
  }
}

export interface TaskResult {
  id: TaskId;
  ok: boolean;
  outputs: string[];
  findings: Finding[];
  summary: string;
  error?: string;
  /**
   * Where this run sat in the suite's lifecycle: "generated" (fresh outDir),
   * "refreshed" (existing suite, derived files rewritten), "kept" (existing
   * suite left untouched — changed-mode). Set only by perf-harness for now;
   * other tasks may adopt it. Absent means the task makes no such distinction.
   */
  status?: "generated" | "refreshed" | "kept";
  /**
   * Per-kind counts of the TODO(flawless) markers this task's emitters planted.
   * Optional and set only by unit-browser: the report distinguishes "measured,
   * zero" (empty array) from "never measured" (absent), so no other task is
   * widened by it.
   */
  handWork?: TodoTally[];
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
  /**
   * The Expo project this run targets, or undefined. Mutually exclusive with
   * `nextjs` — a project is one or the other, and passing both is a UsageError.
   */
  expo?: ExpoContext;
  /**
   * Whether the React Compiler runs, read off the project's own configs. Set by
   * `runCore` in every mode — web mode has no other route to this fact, and
   * `perf-static`'s memo-family rules are exactly the work the compiler does by
   * itself. Absent only for a hand-built context, and a task must then say it
   * did not check rather than assume either way.
   */
  reactCompiler?: ReactCompilerProbe;
  /** Emit unit specs next to the analysed source files instead of <outDir>/unit. */
  colocate?: boolean;
  /** Every task id selected for this run, so tasks can honour cross-task deps. */
  selectedTasks?: TaskId[];
  /**
   * The run is changed-mode (`--changed [REF]`; true = HEAD). The perf-harness
   * task keeps an existing suite untouched under it: changed narrows the run,
   * never churns generation.
   */
  changed?: string | true;
  /** Context-provider wraps derived after analysis; see ScaffoldOptions.providerWraps. */
  providerWraps?: Map<string, ProviderRef[]>;
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
  expo: string | undefined;
  appResolver: string | undefined;
  swaggerUrl: string | undefined;
  colocate: boolean;
  ci: boolean;
  roots: RootMode;
  exclude: string[];
  useDefaultExcludes: boolean;
  /** `--help` was asked for. parseArgs reports it; main() prints and exits. */
  help: boolean;
  /** `-V`/`--version` was asked for. Same split as `help`. */
  version: boolean;
}

export type NextjsRouter = "app" | "pages";

/**
 * Whether the React Compiler runs for a project, as `detectReactCompiler` reads
 * it off disk — three states because a boolean would let `perf-static` suppress
 * the memo-family rules on a guess.
 *
 * - `on`           — a config spells it on. The three memo-family rules name
 *                    work the compiler does by itself and are suppressed.
 * - `off`          — a config was READ and does not turn it on. Rules run.
 * - `undetermined` — nothing readable. Rules run, and the task says the memo
 *                    findings may be pre-compiled noise. Never silent.
 */
export type ReactCompilerState = "on" | "off" | "undetermined";

export interface ReactCompilerProbe {
  state: ReactCompilerState;
  /**
   * What the answer rests on, spelled the way a person would write it in the
   * config: `app.json experiments.reactCompiler`, `next.config.ts reactCompiler`,
   * `babel.config.js babel-plugin-react-compiler`. For `off` and `undetermined`
   * it names what was read instead, so the state is checkable whichever way it
   * fell — an evidence line that exists only on a suppression is a footnote to
   * one outcome, not evidence.
   */
  evidence: string;
}

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

/**
 * Which host-element vocabulary a run's components are written in.
 *
 * Not a synonym for "which framework mode" — an Expo app can also target web,
 * and a monorepo sweep can cross both. This names the ELEMENT SET the analysis
 * and the emitters have to reason about: lowercase DOM intrinsics (`<div>`), or
 * React Native's imported capitalised components (`<View>` from "react-native").
 *
 * "web" is the default everywhere and is what every run has always done.
 */
export type Platform = "web" | "native";

/**
 * An Expo project, as `detectExpo` reads it off disk.
 *
 * The peer of NextjsContext, and deliberately shaped like it: a nullable context
 * object on RunContext rather than a boolean, so a task can branch once and the
 * facts it needs travel with the decision.
 */
export interface ExpoContext {
  root: string;
  /** The expo-router app directory, when the project uses expo-router. */
  routerRoot: string | undefined;
  /**
   * Expo SDK major, read from the project's own `expo` dependency and never
   * defaulted. jest-expo's major must match it (jest-expo@54 <-> SDK 54), so a
   * guess here produces failures deep inside expo-modules-core that name
   * nothing. Absent only when the range is unreadable AND expo is not installed,
   * and the caller must then say so rather than substitute a number.
   */
  sdkMajor: number | undefined;
  /** expo-router major, same rule. */
  routerMajor: number | undefined;
  /**
   * The project compiles with the React Compiler (app.json's
   * `experiments.reactCompiler`, or babel-plugin-react-compiler in the babel
   * config).
   *
   * Load-bearing for perf-static: the compiler memoises automatically, so
   * `perf/unstable-child-prop`, `perf/missing-memo-leaf` and
   * `perf/no-memoisation-with-children` name work it has already done. On the
   * dogfood app that is 136 of 168 findings — 81% of the task's entire output
   * (docs/archive/2026-08-expo-probes.md).
   */
  reactCompiler: boolean;
  /** NativeWind is wired through babel (`jsxImportSource: "nativewind"`). */
  nativewind: boolean;
  /** Port `expo start --web` serves on; Metro's default is 8081, not 3000. */
  webPort: number;
}
