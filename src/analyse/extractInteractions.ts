import ts from "typescript";
import type {
  ClickHandler,
  ElementHints,
  FieldInfo,
  FormInfo,
  HandlerBinding,
  HandlerEffect,
  InteractionInfo,
  LabelSource,
  PropsShape,
  SubmitControl,
} from "../types.ts";
import { findDisclosures } from "./extractDisclosures.ts";
import { domOnlyResolver, type HostTagResolver } from "./hostTag.ts";
import type { HostDialect } from "./nativeDialect.ts";
import { NATIVE_TAG_TO_ROLE, TEXTLESS_ELEMENTS } from "./nativeProps.ts";
import { posOf } from "./pos.ts";
import { hookCalleeName } from "./refs.ts";
import {
  emptyEnv,
  evaluate,
  initialRenderExpression,
  type RenderEnv,
  reachability,
  truthy,
} from "./renderPath.ts";

const EVENT_PATTERN =
  /^on(Click|MouseDown|PointerDown|Submit|Change|Input|Focus|Blur|KeyDown|KeyPress)$/;

/**
 * React Native events @testing-library/react-native can drive without inventing
 * a payload.
 *
 * Deliberately excluded: onScroll, onEndReached, onLayout, onContentSizeChange.
 * Each needs a synthetic nativeEvent carrying contentSize/layoutMeasurement, and
 * a made-up viewport is a guess the resulting assertion then depends on.
 *
 * onChange IS included: React Native's TextInput onChange payload is a
 * documented shape (`{ nativeEvent: { text } }`) — a specification, not a guess.
 */
const NATIVE_EVENT_PATTERN =
  /^on(Press|LongPress|PressIn|PressOut|ChangeText|Change|SubmitEditing|EndEditing|Focus|Blur|ValueChange|Refresh)$/;

const FORM_FIELD_TAGS = new Set(["input", "select", "textarea"]);

export function extractInteractions(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  propsShape: PropsShape,
  unresolvedProps: string[] = [],
  env: RenderEnv = emptyEnv(),
  /** Component tag → the host element it actually renders, where resolvable. */
  tagRootTags: Map<string, string> = new Map(),
  /** Which tags are host elements. Defaults to the DOM rule, so web is unchanged. */
  hostTag: HostTagResolver = domOnlyResolver,
  /**
   * The file's element vocabulary, decided by detectHostDialect from its whole
   * import list. Passed rather than probed: no single tag name is present in
   * every React Native file.
   */
  dialect: HostDialect = "dom",
  /**
   * State setter names, so a `setX(…)` in a handler is recorded as a setState
   * effect rather than as an opaque call. Passed rather than re-derived:
   * extractState already owns this and running it twice invites the two to
   * disagree.
   */
  setterNames: Set<string> = new Set(),
): InteractionInfo {
  // Handler props are function-typed, which extractProps cannot synthesise and
  // routes to unresolvedProps. Union both so the classifier sees them.
  const propNames = new Set([...Object.keys(propsShape), ...unresolvedProps]);
  const clicks: ClickHandler[] = [];
  const forms: FormInfo[] = [];

  // The dialect, taken from the caller.
  //
  // This was `hostTag("View")?.dialect === "native"`, which is only true when the
  // file imports View UNDER THAT EXACT LOCAL NAME. `import { Pressable, Text }`,
  // `import { View as Box }` and `import * as RN` all answered "dom", so the DOM
  // EVENT_PATTERN was used, onPress matched nothing, and clicks came back EMPTY —
  // producing a spec with a mount assertion, no interaction tests, and NO SKIP
  // naming the gap. Green, touching nothing, silent about it: the exact failure
  // this tool exists to refuse, on the commonest file shape in a React Native app.
  //
  // detectHostDialect already answers this correctly from the file's whole import
  // list, and analyse/index.ts computes it one line before building the resolver.
  // It just was not passed.
  const native = dialect === "native";
  const eventPattern = native ? NATIVE_EVENT_PATTERN : EVENT_PATTERN;

  /**
   * Elements a label harvest may look THROUGH on native.
   *
   * A container (View, Text, a layout wrapper) holds the copy one level down, so
   * descending finds "Sign in" inside `<Pressable><Text>Sign in</Text></Pressable>`.
   * A textless element (an icon, a spinner) genuinely renders no text, so it
   * stays an interruption — which is what leaves an icon-only Pressable honestly
   * unlabelled instead of borrowing a name it does not have.
   *
   * An UNKNOWN component tag is also an interruption. It may well render text,
   * but we cannot see that from here, and claiming a name the render may not
   * produce is the wrong way to be wrong.
   */
  /**
   * The children of a conditional's taken branch, when it renders a transparent
   * element.
   *
   * Parentheses are the whole reason this is a function. Prettier and biome both
   * format a multi-line JSX ternary as `cond ? (\n  <A/>\n) : (\n  <B/>\n)`, so
   * the branch is a ParenthesizedExpression and a bare `isJsxElement` check
   * misses EVERY real submit button. The fixture was written without parentheses
   * and passed; the dogfood app has them everywhere and did not.
   */
  const childrenOfBranch = (branch: ts.Expression): ts.NodeArray<ts.JsxChild> | undefined => {
    const el = unwrapParens(branch);
    if (!ts.isJsxElement(el)) return undefined;
    return transparent(el) ? el.children : undefined;
  };

  /**
   * Whether an element renders element children and ALL of them are textless.
   *
   * Not simply "has no label": a Pressable whose text sits behind an undecidable
   * condition is unlabelled too, but adding an accessibilityLabel is not the
   * whole story there. Icon-only is the case where the remediation is exact.
   */
  const isIconOnly = (el: ts.JsxElement): boolean => {
    let sawElement = false;
    let allTextless = true;
    const walk = (children: ts.NodeArray<ts.JsxChild>): void => {
      for (const c of children) {
        if (ts.isJsxText(c) && c.text.trim()) allTextless = false;
        else if (ts.isJsxExpression(c) && c.expression) allTextless = false;
        else if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) {
          const name = readTagName(ts.isJsxElement(c) ? c.openingElement.tagName : c.tagName);
          const resolved = hostTag(name);
          sawElement = true;
          if (!resolved || !TEXTLESS_ELEMENTS.has(resolved.name)) allTextless = false;
          if (ts.isJsxElement(c)) walk(c.children);
        } else if (ts.isJsxFragment(c)) walk(c.children);
      }
    };
    walk(el.children);
    return sawElement && allTextless;
  };

  /**
   * Literal navigation targets reached from a handler expression.
   *
   * `onPress={() => router.push("/items/new")}` is the shape; the receiver must
   * be an expo-router router (a local bound from useRouter()), and the argument
   * must be a string literal. A template literal names a route the spec cannot
   * predict — `/items/${'${item.id}'}` depends on data — so it is skipped rather
   * than half-matched.
   */
  const NAV_METHODS = new Set(["push", "replace", "navigate"]);
  /** `router.back()` — same receiver rule, no argument to read. */
  const callsBack = (init: ts.JsxAttribute["initializer"]): boolean => {
    if (!init || !ts.isJsxExpression(init) || !init.expression) return false;
    let found = false;
    const walk = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "back" &&
        routerNames.has(rootIdentifierOf(n.expression.expression))
      ) {
        found = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(init.expression);
    return found;
  };
  /**
   * Locals bound from expo-router's useRouter(), so a `.push` on anything else
   * is not read as navigation. `const router = useRouter()` is the only shape
   * this recognises; anything less direct bails rather than guesses.
   */
  const routerNames = new Set<string>();
  {
    const findRouters = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        ts.isCallExpression(n.initializer) &&
        ts.isIdentifier(n.initializer.expression) &&
        n.initializer.expression.text === "useRouter"
      ) {
        routerNames.add(n.name.text);
      }
      ts.forEachChild(n, findRouters);
    };
    findRouters(bodyNode);
  }
  const collectPushTargets = (init: ts.JsxAttribute["initializer"]): string[] => {
    if (!init || !ts.isJsxExpression(init) || !init.expression) return [];
    const out: string[] = [];
    const walk = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        NAV_METHODS.has(n.expression.name.text) &&
        // The RECEIVER has to be a router, not merely something with a method of
        // that name. String.prototype.replace and Array.prototype.push share the
        // namespace, so `setRaw(raw.replace("$", ""))` was captured as a
        // navigation to "$" and emitted `toHavePathname("$")` — a guaranteed
        // failure on a screen that navigates nowhere.
        routerNames.has(rootIdentifierOf(n.expression.expression))
      ) {
        const arg = n.arguments[0];
        if (arg && ts.isStringLiteral(arg)) out.push(arg.text);
      }
      ts.forEachChild(n, walk);
    };
    walk(init.expression);
    return [...new Set(out)];
  };

  const transparent = (el: ts.JsxElement): boolean => {
    const resolved = hostTag(readTagName(el.openingElement.tagName));
    if (!resolved || resolved.dialect !== "native") return false;
    return !TEXTLESS_ELEMENTS.has(resolved.name);
  };
  const descend = native
    ? (child: ts.JsxChild): ts.NodeArray<ts.JsxChild> | undefined => {
        if (ts.isJsxElement(child)) return transparent(child) ? child.children : undefined;
        // `{busy ? <Spinner/> : <Text>Sign in</Text>}` is the shape of every
        // submit control in a real app. The condition reduces at the props and
        // initial state the spec passes — `busy` starts false — so the label IS
        // knowable, and treating the whole expression as opaque threw away the
        // one name the button actually has. Same evaluator the visit loop uses
        // to decide reachability, so the two cannot disagree about which branch
        // renders.
        if (!ts.isJsxExpression(child) || !child.expression) return undefined;
        const inner = unwrapParens(child.expression);
        // `{busy && <Text>Saving</Text>}` as well as the ternary: both are how a
        // real screen writes a conditional label.
        if (
          ts.isBinaryExpression(inner) &&
          inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ) {
          const gate = evaluate(inner.left, scope);
          if (gate === undefined || !truthy(gate)) return undefined;
          return childrenOfBranch(inner.right);
        }
        if (!ts.isConditionalExpression(inner)) return undefined;
        const decided = evaluate(inner.condition, scope);
        if (decided === undefined) return undefined;
        return childrenOfBranch(truthy(decided) ? inner.whenTrue : inner.whenFalse);
      }
    : undefined;

  // Scope the harvest to the JSX that actually mounts. Scanning the whole body
  // collected a "Cancel" button and a #notes field from a disclosure's expanded
  // branch, then drove them against the collapsed render — three failures in one
  // file, each looking like a missing element rather than a phantom one.
  const initial = initialRenderExpression(bodyNode, env);
  const scope = initial?.scope ?? env;

  // Elements that only exist after a trigger is clicked. Querying them straight
  // after render finds nothing, and the failure reads as a wrong selector.
  const disclosures = initial ? findDisclosures(initial.expr) : [];
  const gateFor = (n: ts.Node): LabelSource | undefined =>
    disclosures.find((d) => d.gated.has(n))?.trigger;

  // How many elements of each host tag this render contains. A bare-tag locator
  // is only a name for the element when it is the only one of its kind.
  const tagCounts = countHostTags(initial ? initial.expr : bodyNode, tagRootTags);

  const visit = (n: ts.Node): void => {
    // "no" means provably not rendered at these props; "unknown" is kept, since
    // dropping it would lose every .map row and render-prop target.
    if (initial && n !== initial.expr && reachability(n, initial.expr, scope) === "no") return;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = readTagName(n.tagName);
      if (tag !== "<dynamic>") {
        const enclosing = enclosingElement(n);
        const hints = collectHints(
          n.attributes,
          scope,
          native ? "native" : "dom",
          hostTag(tag)?.name,
        );
        const label = extractLabel(enclosing, hints, propNames, descend);

        if (tag === "form") {
          forms.push(
            buildForm(
              enclosing,
              n.attributes,
              propNames,
              posOf(n, sourceFile),
              sourceFile,
              scope,
              bodyNode,
            ),
          );
        }

        for (const attr of n.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          if (!ts.isIdentifier(attr.name)) continue;
          const event = attr.name.text;
          if (!eventPattern.test(event)) continue;
          if (tag === "form" && event === "onSubmit") continue;
          const binding = classifyBinding(attr.initializer, propNames);
          const gatedBy = gateFor(n);
          clicks.push({
            event,
            tag,
            label,
            hints,
            binding,
            ...(gatedBy ? { gatedBy } : {}),
            ...((tagCounts.get(tag) ?? 0) > 1 ? { ambiguousTag: true } : {}),
            ...(native && enclosing && isIconOnly(enclosing) ? { iconOnly: true } : {}),
            // With NO decidable initial render, the walk falls back to the whole
            // body and harvests handlers from every branch — including ones the
            // defaults provably never take. `initial &&` short-circuited, so
            // those arrived unmarked and read as certainly-present, which is how
            // a spec came to drive a button inside `if (this.state.error)`.
            // Nothing here is known to render, so all of it is conditional.
            ...(initial
              ? reachability(n, initial.expr, scope) !== "yes"
                ? { conditional: true }
                : {}
              : { conditional: true }),
            ...(() => {
              if (!native) return {};
              const targets = collectPushTargets(attr.initializer);
              return targets.length > 0 ? { pushTargets: targets } : {};
            })(),
            ...(native && callsBack(attr.initializer) ? { navBack: true } : {}),
            // What the handler provably DOES, for deciding what may be asserted
            // after dispatching it. The alternative was
            // `expect(container.firstElementChild).not.toBeNull()`, which under a
            // provider cannot fail and without one reddens a component that
            // legitimately unmounts.
            ...(() => {
              const init = attr.initializer;
              if (!init || !ts.isJsxExpression(init) || !init.expression) return {};
              const effects = handlerEffects(init.expression, routerNames, setterNames, bodyNode);
              return effects.length > 0 ? { effects } : {};
            })(),
            pos: posOf(attr, sourceFile),
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  // When no single render describes the component, fall back to the whole body
  // rather than emitting nothing at all.
  if (initial) visit(initial.expr);
  else ts.forEachChild(bodyNode, visit);

  return { clicks, forms };
}

/**
 * How many elements in this render could answer to a bare host-tag locator.
 *
 * A `<button>` counts towards `button`, and so does a component tag whose OWN
 * root element is a button — read from that component's source, one hop away.
 * Where the tag cannot be resolved (a third-party component, a dynamic tag) the
 * old naming convention stands in; it can only over-count, and over-counting
 * costs a test rather than a wrong click.
 *
 * VoteCard is why any of this exists: one mapped `<button>` carrying the
 * handler and one `<Button>` rendering "Cast vote", which
 * `page.locator("button").first()` resolved to instead.
 *
 * An element inside `.map()` is counted once — the source shows one, the DOM may
 * show none or twenty. That is enough to answer the only question being asked:
 * does this locator have competition.
 */
function countHostTags(root: ts.Node, tagRootTags: Map<string, string>): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (tag: string): void => {
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = readTagName(n.tagName);
      bump(tag);
      if (/^[A-Z]/.test(tag)) {
        const resolved = tagRootTags.get(tag);
        if (resolved) {
          // Evidence: this tag's own root element, read from its source.
          bump(resolved);
        } else {
          // Unresolvable — a third-party component, a dynamic tag. Fall back to
          // the naming convention, which can only over-count and so can only
          // turn a locator into a skip.
          const lower = tag.toLowerCase();
          for (const host of ["button", "input", "textarea", "select", "form"]) {
            if (lower.endsWith(host)) bump(host);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return counts;
}

function enclosingElement(
  n: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): ts.JsxElement | undefined {
  if (ts.isJsxOpeningElement(n) && n.parent && ts.isJsxElement(n.parent)) {
    return n.parent;
  }
  return undefined;
}

function readTagName(tag: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(tag)) return tag.text;
  if (ts.isPropertyAccessExpression(tag)) return readPropertyAccess(tag);
  return "<dynamic>";
}

function readPropertyAccess(p: ts.PropertyAccessExpression): string {
  const head = ts.isIdentifier(p.expression)
    ? p.expression.text
    : ts.isPropertyAccessExpression(p.expression)
      ? readPropertyAccess(p.expression)
      : "<dynamic>";
  return `${head}.${p.name.text}`;
}

function collectHints(
  attrs: ts.JsxAttributes,
  env: RenderEnv = emptyEnv(),
  dialect: "dom" | "native" = "dom",
  /** Resolved host element name, for the one RN element that carries an implicit role. */
  element: string | undefined = undefined,
): ElementHints {
  const hints: ElementHints = {};
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const name = ts.isIdentifier(a.name) ? a.name.text : undefined;
    if (!name) continue;
    if (name === "disabled") {
      const state = disabledAtInitialRender(a.initializer, env);
      if (state) hints.disabled = state;
      continue;
    }
    // React Native's disabled equivalent for a text field, with inverted polarity.
    if (dialect === "native" && name === "editable") {
      const state = disabledAtInitialRender(a.initializer, env);
      if (state === "always") hints.disabled = "conditional";
      else if (state !== undefined) hints.disabled = state;
      continue;
    }
    const value = readStringInitializer(a.initializer);
    if (value === undefined) continue;
    if (dialect === "native") {
      // The React Native locator surface. `name` and `type` are deliberately
      // never populated here — they have no React Native equivalent, and leaving
      // them empty is what makes selectors.ts's DOM-only branches naturally
      // inert on native data rather than emitting a query that cannot match.
      switch (name) {
        case "title":
          // RN's <Button title="Save"/> renders no children; `title` IS the name.
          hints.buttonTitle = value;
          break;
        case "testID":
          hints.testid = value;
          break;
        case "accessibilityLabel":
        case "aria-label":
          hints.ariaLabel = value;
          break;
        case "accessibilityRole":
        case "role":
          hints.role = value;
          break;
        case "accessibilityHint":
          hints.hint = value;
          break;
        case "placeholder":
          hints.placeholder = value;
          break;
        case "value":
          hints.displayValue = value;
          break;
        // `id`/`nativeID` are real facts about the source and DO work under
        // react-native-web + Playwright, so they are recorded. The RNTL emitter
        // simply must not read them, and a test pins that.
        case "id":
        case "nativeID":
          hints.id = value;
          break;
      }
      continue;
    }
    switch (name) {
      case "data-testid":
        hints.testid = value;
        break;
      case "aria-label":
        hints.ariaLabel = value;
        break;
      case "role":
        hints.role = value;
        break;
      case "id":
        hints.id = value;
        break;
      case "name":
        hints.name = value;
        break;
      case "type":
        hints.type = value;
        break;
      case "placeholder":
        hints.placeholder = value;
        break;
    }
  }
  // React Native's own <Button> is the ONE element whose source sets an
  // accessibilityRole unconditionally, and it names itself with `title` rather
  // than with children. Without this it fell to the bottom of the ladder and was
  // skipped as "nothing identifies it: no testID, no accessibilityLabel, no
  // accessibilityRole" — a remediation that is factually wrong, on an element
  // that getByRole("button", { name }) addresses perfectly. NATIVE_TAG_TO_ROLE
  // existed for this and had no production caller.
  if (dialect === "native" && element !== undefined) {
    const implicitRole = NATIVE_TAG_TO_ROLE[element];
    if (implicitRole !== undefined && hints.role === undefined) hints.role = implicitRole;
  }
  return hints;
}

/**
 * Whether `disabled={...}` holds at the props and initial state a spec renders.
 *
 * `<Button disabled={!selected || pending}>` with `useState(null)` is disabled
 * the moment it mounts, which the same evaluator that picks the initial render
 * branch can decide. Clicking it anyway cost a 30-second Playwright timeout per
 * occurrence; asserting it is disabled is both faster and true. Anything that
 * does not reduce stays "conditional" and is driven as before.
 */
function disabledAtInitialRender(
  init: ts.JsxAttribute["initializer"],
  env: RenderEnv,
): ElementHints["disabled"] {
  // Bare `disabled` with no value is the HTML shorthand for disabled={true}.
  if (!init) return "always";
  if (init.kind === ts.SyntaxKind.StringLiteral) return "always";
  if (!ts.isJsxExpression(init) || !init.expression) return undefined;
  const value = evaluate(init.expression, env);
  if (value === undefined) return "conditional";
  return truthy(value) ? "always" : undefined;
}

function readStringInitializer(init: ts.JsxAttribute["initializer"]): string | undefined {
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)) {
    return init.expression.text;
  }
  return undefined;
}

/** Below this a fragment identifies nothing — "(" or "—" would match half the page. */
const MIN_LABEL_FRAGMENT = 3;

function extractLabel(
  parent: ts.JsxElement | undefined,
  hints: ElementHints,
  propNames: Set<string>,
  /**
   * On native, look through container children for the text.
   *
   * In the DOM the copy sits inside the handler element: `<button>Save</button>`.
   * In React Native it is ALWAYS one level down, inside a `<Text>`:
   *
   *     <Pressable onPress={...}><Text>Sign in</Text></Pressable>
   *
   * Reading direct children only, this loop sees a JsxElement, sets hasDynamic
   * and returns { kind: "none" } — so on the dogfood app EVERY press handler was
   * unlabelled, and every interaction spec would have been a skip.
   *
   * Descending is not a guess: RNTL's own getTextContent recurses the whole
   * subtree and joins it, and fireEvent.press walks UP to the nearest press
   * responder — so the descendant <Text> is a legitimate handle for the ancestor
   * <Pressable>, which is exactly the canonical RNTL idiom.
   */
  descend: ((child: ts.JsxChild) => ts.NodeArray<ts.JsxChild> | undefined) | undefined = undefined,
): LabelSource {
  if (parent) {
    // Collect every literal fragment, and note whether anything non-literal sits
    // among them. Taking the first fragment and calling it the whole accessible
    // name turned `Record payment ({fmt(due)} outstanding)` into the exact name
    // "Record payment (", which no rendered element can equal.
    // Contiguous literal RUNS, not one concatenation. Joining across a dynamic
    // child produced "Record payment ( outstanding)" for
    // `Record payment ({fmt(due)} outstanding)` — a string that appears nowhere,
    // because the amount sits between the two halves.
    const runs: string[] = [];
    let run = "";
    let hasDynamic = false;
    let propLabel: LabelSource | undefined;

    const endRun = (): void => {
      const text = run.replace(/\s+/g, " ").trim();
      if (text) runs.push(text);
      run = "";
    };

    const walk = (children: ts.NodeArray<ts.JsxChild>): void => {
      for (const child of children) {
        if (ts.isJsxText(child)) {
          run += child.text;
          continue;
        }
        if (ts.isJsxExpression(child) && child.expression) {
          if (ts.isStringLiteral(child.expression)) {
            run += child.expression.text;
            continue;
          }
          if (ts.isIdentifier(child.expression) && propNames.has(child.expression.text)) {
            propLabel ??= { kind: "prop", propName: child.expression.text };
          }
        }
        // On native, a container child is a level to look THROUGH, not a dynamic
        // interruption — the text lives inside it. `descend` returns the children
        // to keep walking, or undefined for anything opaque: an icon, a spinner,
        // an unresolved component, or a conditional whose branch cannot be
        // decided. So an icon-only Pressable still ends up honestly unlabelled.
        const through = descend?.(child);
        if (through) {
          walk(through);
          continue;
        }
        // An icon element, an interpolation, a call: text we cannot predict, so
        // whatever ran up to here is a fragment of the real accessible name.
        hasDynamic = true;
        endRun();
      }
    };
    walk(parent.children);
    endRun();

    if (!hasDynamic && runs.length === 1) return { kind: "text", value: runs[0] as string };
    // The longest run is the most identifying thing the source offers.
    const longest = runs.sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= MIN_LABEL_FRAGMENT) {
      return { kind: "text-partial", value: longest };
    }
    if (propLabel) return propLabel;
  }
  if (hints.ariaLabel) return { kind: "aria", value: hints.ariaLabel };
  if (hints.testid) return { kind: "testid", value: hints.testid };
  return { kind: "none" };
}

function classifyBinding(
  init: ts.JsxAttribute["initializer"],
  propNames: Set<string>,
): HandlerBinding {
  if (!init || !ts.isJsxExpression(init) || !init.expression) return { kind: "inline" };
  const expr = init.expression;
  if (ts.isIdentifier(expr)) {
    if (propNames.has(expr.text) && /^on[A-Z]/.test(expr.text)) {
      return { kind: "prop", propName: expr.text };
    }
    return { kind: "local", localName: expr.text };
  }
  if (ts.isPropertyAccessExpression(expr)) {
    // props.onSave → prop. Anything else nested is treated as local.
    if (ts.isIdentifier(expr.expression) && expr.expression.text === "props") {
      const name = expr.name.text;
      if (propNames.has(name) && /^on[A-Z]/.test(name)) {
        return { kind: "prop", propName: name };
      }
    }
  }
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    const propCall = findPropCallInBody(expr.body, propNames);
    if (propCall) return { kind: "prop", propName: propCall };
    return { kind: "inline" };
  }
  return { kind: "inline" };
}

function findPropCallInBody(body: ts.Node, propNames: Set<string>): string | undefined {
  let found: string | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && propNames.has(callee.text) && /^on[A-Z]/.test(callee.text)) {
        found = callee.text;
        return;
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "props" &&
        propNames.has(callee.name.text) &&
        /^on[A-Z]/.test(callee.name.text)
      ) {
        found = callee.name.text;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

function buildForm(
  parent: ts.JsxElement | undefined,
  attrs: ts.JsxAttributes,
  propNames: Set<string>,
  pos: FormInfo["pos"],
  sourceFile: ts.SourceFile,
  env: RenderEnv,
  /** The component body, for resolving `action={x}` back to the action itself. */
  componentBody?: ts.Node,
): FormInfo {
  let submit: HandlerBinding | undefined;
  let actionLocal: string | undefined;
  const hints: { testid?: string; ariaLabel?: string; id?: string } = {};
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const name = ts.isIdentifier(a.name) ? a.name.text : undefined;
    if (name === "onSubmit") submit = classifyBinding(a.initializer, propNames);
    if (name === "action") actionLocal = readIdentifierInitializer(a.initializer);
    if (name === "data-testid") hints.testid = readStringInitializer(a.initializer);
    if (name === "aria-label") hints.ariaLabel = readStringInitializer(a.initializer);
    if (name === "id") hints.id = readStringInitializer(a.initializer);
  }
  const fields = parent ? collectFields(parent, sourceFile) : [];
  const submitControl = parent ? findSubmitControl(parent, propNames, env) : undefined;
  const actionBinding =
    actionLocal === undefined ? undefined : actionSourceOf(actionLocal, componentBody);
  return {
    submit,
    fields,
    ...(submitControl ? { submitControl } : {}),
    ...(actionBinding ? { actionBinding } : {}),
    hints,
    pos,
  };
}

/**
 * The button that submits this form, read out of the markup.
 *
 * Two rules, and the asymmetry between them is the point:
 *
 * - A host `<button>` inside a form submits it unless it says otherwise, because
 *   that is HTML's default `type`.
 * - A component tag counts only when it declares `type="submit"`. shadcn and
 *   base-ui both render `type="button"` by default — the DOM dumps from the
 *   failing run show it — so on a `<Button>` the ABSENCE of a type attribute is
 *   not evidence of anything.
 *
 * An enabled control wins; a disabled one is still returned, flagged, so the
 * spec can say "the only way to submit this form is disabled at these props"
 * rather than "there is no submit control", which would be false.
 */
function findSubmitControl(
  parent: ts.JsxElement,
  propNames: Set<string>,
  env: RenderEnv,
): FormInfo["submitControl"] {
  const found: SubmitControl[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = readTagName(n.tagName);
      const isHostButton = tag === "button";
      if (isHostButton || /Button$/.test(tag)) {
        const hints = collectHints(n.attributes, env);
        const declared = hints.type;
        const submits = isHostButton
          ? declared === undefined || declared === "submit"
          : declared === "submit";
        if (submits) {
          found.push({
            label: extractLabel(enclosingElement(n), hints, propNames),
            host: isHostButton,
            ...(hints.disabled === "always" ? { disabled: true } : {}),
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(parent, visit);
  return found.find((c) => !c.disabled) ?? found[0];
}

function collectFields(parent: ts.JsxElement, sourceFile: ts.SourceFile): FieldInfo[] {
  const fields: FieldInfo[] = [];
  const labelsByHtmlFor = new Map<string, string>();

  // First pass: harvest <label htmlFor="x"> text-content keyed by htmlFor.
  //
  // Uppercase `*Label` tags count too, but only when they carry htmlFor: that is
  // a React DOM prop, so its presence is evidence the component forwards to a
  // real <label>. shadcn's <Label htmlFor> is the common case, and matching the
  // lowercase tag alone left every one of those fields with no accessible label.
  const collectLabels = (n: ts.Node): void => {
    if (ts.isJsxElement(n)) {
      const opening = n.openingElement;
      if (ts.isIdentifier(opening.tagName) && isLabelTag(opening.tagName.text)) {
        let htmlFor: string | undefined;
        for (const a of opening.attributes.properties) {
          if (!ts.isJsxAttribute(a)) continue;
          if (ts.isIdentifier(a.name) && a.name.text === "htmlFor") {
            const v = readStringInitializer(a.initializer);
            if (v) htmlFor = v;
          }
        }
        if (htmlFor) {
          const text = jsxTextOf(n);
          if (text) labelsByHtmlFor.set(htmlFor, text);
        }
      }
    }
    ts.forEachChild(n, collectLabels);
  };
  collectLabels(parent);

  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = readTagName(n.tagName);
      if (FORM_FIELD_TAGS.has(tag)) {
        const hints = collectHints(n.attributes);
        // A placeholder is NOT an accessible label. Falling back to it here made
        // every placeholder-only field emit getByLabelText(placeholder), which
        // always throws — while emitFormTest's getByPlaceholderText branch, which
        // is already correct, could never be reached because `label` was set.
        const label = (hints.id && labelsByHtmlFor.get(hints.id)) ?? undefined;
        fields.push({
          tag: tag as FieldInfo["tag"],
          type: hints.type,
          name: hints.name,
          id: hints.id,
          placeholder: hints.placeholder,
          label,
          pos: posOf(n, sourceFile),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(parent, visit);
  return disambiguateByName(fields);
}

/**
 * Drop fields whose `name` does not pick out one control.
 *
 * `canPostInternal ? <select name="visibleTo"> : <input type="hidden"
 * name="visibleTo">` collects both branches — the condition is a prop nothing
 * resolves, so neither is provably rendered. The generated fill then called
 * selectOption on a name that at runtime was the hidden input, and waited for a
 * `<select>` that never appears.
 *
 * A group that agrees on tag and type is a different thing: sixteen checkboxes
 * called "trades" are one control, and `.first().check()` drives it correctly.
 * So the rule is disagreement, not multiplicity.
 */
function disambiguateByName(fields: FieldInfo[]): FieldInfo[] {
  const byName = new Map<string, FieldInfo[]>();
  for (const f of fields) {
    if (!f.name) continue;
    const group = byName.get(f.name);
    if (group) group.push(f);
    else byName.set(f.name, [f]);
  }
  const seen = new Set<string>();
  const out: FieldInfo[] = [];
  for (const f of fields) {
    if (!f.name) {
      out.push(f);
      continue;
    }
    const group = byName.get(f.name) as FieldInfo[];
    const agrees = group.every((g) => g.tag === f.tag && g.type === f.type);
    if (!agrees || seen.has(f.name)) continue;
    seen.add(f.name);
    out.push(f);
  }
  return out;
}

/** The host tag, or a wrapper whose name ends in "Label" (shadcn's <Label>, <FormLabel>). */
function isLabelTag(tag: string): boolean {
  return tag === "label" || /Label$/.test(tag);
}

function jsxTextOf(el: ts.JsxElement): string | undefined {
  for (const child of el.children) {
    if (ts.isJsxText(child)) {
      const t = child.text.trim();
      if (t) return t;
    } else if (
      ts.isJsxExpression(child) &&
      child.expression &&
      ts.isStringLiteral(child.expression)
    ) {
      return child.expression.text;
    }
  }
  return undefined;
}

/** Strip the parentheses a formatter puts around a multi-line JSX branch. */
function unwrapParens(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

/** The root identifier of an expression, for deciding what a `.push` was called on. */
function rootIdentifierOf(expr: ts.Expression): string {
  let cur: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur)) {
    cur = ts.isCallExpression(cur) ? cur.expression : cur.expression;
  }
  return ts.isIdentifier(cur) ? cur.text : "";
}

/**
 * True iff `call` runs whenever the handler runs.
 *
 * "Dominated" in the flow sense: the call sits in the handler body's own
 * top-level statement list, and no preceding sibling can leave the function
 * first. Not inside an if/switch/loop/try/catch/finally, and not inside a
 * nested function.
 *
 * A NEW predicate rather than a reuse of hasConditionalBetween, whose existing
 * consumers depend on today's meaning: that one walks ANCESTORS only, so the
 * dominant real shape —
 *
 *   if (!parsed.success) { setErr(…); return; }
 *   setBusy(true);
 *
 * — reads as unguarded for `setBusy`, because the `if` is a preceding SIBLING
 * and not an ancestor. Asserting on `setBusy` there is a claim about a path the
 * defaults may never reach.
 */
export function reachedUnconditionally(call: ts.Node, body: ts.Node): boolean {
  // Walk up to the handler body, refusing any construct that makes the call
  // conditional on something.
  let node: ts.Node = call;
  let stmt: ts.Statement | undefined;
  for (;;) {
    // Stop AT the body. A concise arrow (`onClick={() => save()}`) has the call
    // itself as its body, so without this the arrow below disqualified the very
    // handler it is the body of — every inline one-expression handler came back
    // conditional.
    if (node === body) break;
    const parent: ts.Node | undefined = node.parent;
    if (!parent || parent === body) break;
    if (
      ts.isIfStatement(parent) ||
      ts.isSwitchStatement(parent) ||
      ts.isCaseClause(parent) ||
      ts.isDefaultClause(parent) ||
      ts.isForStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isTryStatement(parent) ||
      ts.isCatchClause(parent) ||
      ts.isConditionalExpression(parent)
    ) {
      return false;
    }
    // A short-circuit right-hand side runs only if the left decided so.
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
      parent.right === node
    ) {
      return false;
    }
    // A nested function is not the handler's own flow.
    if (
      ts.isArrowFunction(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isFunctionDeclaration(parent)
    ) {
      return false;
    }
    if (ts.isStatement(parent) && parent.parent === body) stmt = parent;
    node = parent;
  }
  if (!stmt) {
    // A concise arrow body (`onClick={() => save()}`) has no statement list at
    // all, so the call is trivially the whole handler.
    return true;
  }
  // Nothing before it in the same list may leave the function first.
  const list = ts.isBlock(body) ? body.statements : undefined;
  if (!list) return true;
  for (const s of list) {
    if (s === stmt) return true;
    if (exitsEarly(s)) return false;
  }
  return true;
}

/** Whether a statement can return or throw out of the handler at any depth. */
function exitsEarly(stmt: ts.Statement): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    // A return inside a nested function returns from THAT function.
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) return;
    if (ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(stmt);
  return found;
}

/**
 * What a handler expression provably does. See HandlerEffect.
 *
 * Syntactic only: a call whose callee root is an identifier, a router method on
 * a `useRouter()` receiver, or a `set*` call. It claims nothing about what those
 * do — the emitter decides whether it can observe them.
 */
export function handlerEffects(
  expr: ts.Expression,
  routerNames: Set<string>,
  setterNames: Set<string>,
  /**
   * The component body, for resolving `onClick={submit}` to the local `submit`.
   *
   * ONE hop, and it is the shape that matters: on the dogfood app every handler
   * that reaches a server action is written this way, so without it the ladder
   * produced zero real claims over 174 specs and only deleted things. Two hops
   * would be a call graph; a miss costs a canary, which is honest.
   */
  componentBody?: ts.Node,
): HandlerEffect[] {
  const body = handlerBody(expr, componentBody);
  if (!body) return [];
  const out: HandlerEffect[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const dominated = reachedUnconditionally(n, body);
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        const method = callee.name.text;
        if (
          (method === "push" ||
            method === "replace" ||
            method === "navigate" ||
            method === "back") &&
          routerNames.has(rootIdentifierOf(callee.expression))
        ) {
          const arg = n.arguments[0];
          const target =
            arg && ts.isStringLiteral(arg)
              ? arg.text
              : arg && ts.isNoSubstitutionTemplateLiteral(arg)
                ? arg.text
                : undefined;
          out.push({ kind: "router", method, ...(target ? { target } : {}), dominated });
        }
      } else if (ts.isIdentifier(callee)) {
        if (setterNames.has(callee.text)) {
          out.push({ kind: "setState", setter: callee.text, dominated });
        } else {
          out.push({ kind: "call", root: callee.text, dominated });
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(body);
  return out;
}

/**
 * The body whose statements the handler runs — inline, or the local function it
 * names.
 *
 * `onClick={submit}` is the ordinary way to write anything longer than one
 * expression, and treating it as opaque made every such handler unassertable.
 */
function handlerBody(expr: ts.Expression, componentBody?: ts.Node): ts.Node | undefined {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr.body;
  if (ts.isIdentifier(expr) && componentBody) return localFunctionBody(expr.text, componentBody);
  return undefined;
}

/** The body of a function declared locally under `scope` and bound to `name`. */
function localFunctionBody(name: string, scope: ts.Node): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) {
      found = n.body;
      return;
    }
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      found = n.initializer.body;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** A JSX attribute whose value is a bare identifier: `action={formAction}`. */
function readIdentifierInitializer(init: ts.JsxAttribute["initializer"]): string | undefined {
  if (!init || !ts.isJsxExpression(init) || !init.expression) return undefined;
  return ts.isIdentifier(init.expression) ? init.expression.text : undefined;
}

/**
 * The server action behind a form's `action={local}`.
 *
 * Two shapes, both statically decidable and both present in real code:
 *
 *   const [state, action] = useActionState(loginAction, undefined);  ->  loginAction
 *   <form action={loginAction}>                                      ->  loginAction
 *
 * The FIRST is what matters: React calls the wrapped action on submit, with
 * nothing in between to guard it. Only `useActionState` is unwrapped — a local
 * function assigned to `action` may do anything before dispatching, and claiming
 * otherwise would be exactly the guess the click ladder refuses to make.
 */
function actionSourceOf(local: string, scope?: ts.Node): string | undefined {
  if (!scope) return local;
  let found: string | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isArrayBindingPattern(n.name) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      hookCalleeName(n.initializer.expression) === "useActionState"
    ) {
      const el1 = n.name.elements[1];
      if (el1 && ts.isBindingElement(el1) && ts.isIdentifier(el1.name) && el1.name.text === local) {
        const arg0 = n.initializer.arguments[0];
        if (arg0) found = actionRootOf(arg0, scope);
      }
      if (found) return;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  // No useActionState binding: the attribute names the action directly, or names
  // a local this cannot follow. Returning the local is right for the first and
  // harmless for the second — the emitter only asserts on a name it has ALSO
  // confirmed is a mocked import.
  return found ?? local;
}

/**
 * The action an expression handed to useActionState ultimately calls.
 *
 * Three shapes, all in the dogfood app:
 *
 *   useActionState(loginAction, undefined)                    -> loginAction
 *   useActionState(createAction.bind(null, id), {})           -> createAction
 *   const a = createAction.bind(null, id); useActionState(a)  -> createAction
 *
 * `.bind` is followed because a bound function calls the original — asserting the
 * original fired is exactly true. One hop through a local const, for the same
 * reason handlerEffects takes one: it is how people write it, and a miss costs a
 * weaker test rather than a wrong one.
 */
function actionRootOf(expr: ts.Expression, scope: ts.Node, depth = 0): string | undefined {
  if (depth > 2) return undefined;
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "bind" &&
    ts.isIdentifier(expr.expression.expression)
  ) {
    return expr.expression.expression.text;
  }
  if (!ts.isIdentifier(expr)) return undefined;
  const name = expr.text;
  let via: string | undefined;
  const visit = (n: ts.Node): void => {
    if (via) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer
    ) {
      via = actionRootOf(n.initializer, scope, depth + 1);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  // No local binding to follow: the name IS the action.
  return via ?? name;
}
