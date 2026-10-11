import { TEXTLESS_ELEMENTS } from "../analyse/nativeProps.ts";
import { propNameRegex } from "./selectors.ts";
import type { ClickHandler, LabelSource } from "../types.ts";

/**
 * @testing-library/react-native locators, as a priority ladder.
 *
 * A separate file rather than a `flavour` parameter on selectors.ts. Every rung
 * of the DOM ladder is DOM-shaped — TAG_TO_ROLE, `#id`, container.querySelector,
 * SUBMIT_WITHIN_FORM, the lowercase isHostTag, awaitSelector's `as HTMLElement`
 * string surgery — and threading a flag through fourteen exported functions
 * would leave every one of those branches reachable from a native call site by
 * accident. The ladder STRUCTURE transfers; the expressions do not.
 *
 * `undefined` is load-bearing here exactly as it is there: it makes the caller
 * emit a test.skip that NAMES the gap, rather than a locator that matches
 * nothing and passes.
 */

/** Rung the target was found by — the emitter needs it to pick the dispatch. */
export type NativeRung =
  | "testID"
  | "label"
  | "role"
  | "placeholder"
  | "displayValue"
  | "text"
  | "text-partial";

export interface NativeTarget {
  /** An RNTL expression resolving to the element. */
  locator: string;
  rung: NativeRung;
  /**
   * The located element IS the pressable itself (a rung read off its own props),
   * rather than a descendant `<Text>` that merely sits inside it.
   *
   * Decides the dispatch: RNTL's userEvent.press requires a pressable host
   * element and rejects a Text that is not one, while fireEvent.press walks UP
   * to the nearest press responder — which is exactly what a text rung hands it.
   * So the rung the target came from is the evidence for the choice, rather than
   * a preference.
   */
  self: boolean;
}

const j = (v: string): string => JSON.stringify(v);

/**
 * A regex matching a fragment of an element's text, anchored at neither end.
 *
 * RNTL's getByText matches the element's WHOLE composed text content, so a
 * partial label — `<Pressable><Icon/><Text>Add</Text></Pressable>`, where the
 * icon contributes nothing knowable — can only be matched as a substring.
 */
function partialRegex(value: string): string {
  // The class includes `/`, which the DOM twin (selectors.ts) has had all along
  // and this copy did not. An unescaped `/` CLOSES the regex literal, so copy
  // like "24/7" or "and/or" emitted `screen.getAllByText(/Save 50/50 split/)` —
  // a syntax error that takes the WHOLE SPEC FILE out of the run, not just that
  // one assertion.
  return `/${value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/`;
}

/**
 * The ladder. Returns undefined when nothing in the source identifies the
 * element — see describeUnlocatableNative for what the caller says then.
 *
 * There is NO last-resort rung, and that is a decision rather than an omission.
 * The DOM ladder bottoms out at `container.querySelector("button")` when the tag
 * is unambiguous; the two candidates here are both unsound:
 *
 *   - `UNSAFE_getByType(Pressable)` — the prefix is the library warning you it is
 *     coupled to implementation, and under NativeWind's `jsxImportSource` the
 *     Pressable the SOURCE rendered went through cssInterop's wrapper while the
 *     one a spec imports from "react-native" is the bare component. Different
 *     component references, so it matches zero elements, and fireEvent.press on
 *     nothing is a green test that touched nothing.
 *   - "the first pressable in the tree" — wrong for the same reason the DOM
 *     ladder refuses a bare-tag locator on an ambiguous tag, and wrong more
 *     often, because every React Native screen is a stack of Pressables.
 */
export function emitNativeSelector(h: ClickHandler): NativeTarget | undefined {
  if (h.hints.testid) {
    return { locator: `screen.getByTestId(${j(h.hints.testid)})`, rung: "testID", self: true };
  }
  if (h.hints.ariaLabel) {
    return {
      locator: `screen.getAllByLabelText(${j(h.hints.ariaLabel)})[0]`,
      rung: "label",
      self: true,
    };
  }
  // Only an EXPLICIT accessibilityRole. RNTL's getRole() reads that prop alone —
  // there is no Pressable -> button mapping — so inferring one from the tag would
  // emit a query that matches nothing while reporting coverage.
  if (h.hints.role) {
    const name = nameOption(h.label);
    return {
      locator: `screen.getAllByRole(${j(h.hints.role)}${name})[0]`,
      rung: "role",
      self: true,
    };
  }
  // Above text, deliberately: a placeholder names THE ELEMENT, where text names a
  // child. On the dogfood app that ordering is the difference between 25
  // addressable TextInputs and none.
  if (h.hints.placeholder) {
    return {
      locator: `screen.getAllByPlaceholderText(${j(h.hints.placeholder)})[0]`,
      rung: "placeholder",
      self: true,
    };
  }
  if (h.hints.displayValue) {
    return {
      locator: `screen.getAllByDisplayValue(${j(h.hints.displayValue)})[0]`,
      rung: "displayValue",
      self: true,
    };
  }
  // RN's <Button title="Save"/> renders no children, so no text rung can see it;
  // its role and its name both come off its props.
  if (h.hints.buttonTitle) {
    return {
      locator: `screen.getAllByText(${j(h.hints.buttonTitle)})[0]`,
      rung: "text",
      self: true,
    };
  }
  if (h.label.kind === "text") {
    return { locator: `screen.getAllByText(${j(h.label.value)})[0]`, rung: "text", self: false };
  }
  if (h.label.kind === "text-partial") {
    return {
      locator: `screen.getAllByText(${partialRegex(h.label.value)})[0]`,
      rung: "text-partial",
      self: false,
    };
  }
  if (h.label.kind === "prop") {
    if (h.label.before || h.label.after) {
      return {
        locator: `screen.getAllByText(${propNameRegex(h.label)})[0]`,
        rung: "text",
        self: false,
      };
    }
    return {
      locator: `screen.getAllByText(String(DEFAULTS[${j(h.label.propName)}] ?? ""))[0]`,
      rung: "text",
      self: false,
    };
  }
  return undefined;
}

function nameOption(label: LabelSource): string {
  if (label.kind === "text") return `, { name: ${j(label.value)} }`;
  if (label.kind === "text-partial") return `, { name: ${partialRegex(label.value)} }`;
  if (label.kind === "prop") {
    if (label.before || label.after) return `, { name: ${propNameRegex(label, "i")} }`;
    return `, { name: String(DEFAULTS[${j(label.propName)}] ?? "") }`;
  }
  return "";
}

/**
 * Why a handler could not be addressed, in words the emitted skip prints.
 *
 * Three wordings, because unlike the DOM there is no "give it text" escape for an
 * icon button — and because this string is also the remediation the native a11y
 * task will report on the same element. One accessibilityLabel retires both.
 */
export function describeUnlocatableNative(h: ClickHandler): string {
  // icon-only is checked FIRST even when the tag is also ambiguous. Both are
  // true of the same element, but one accessibilityLabel fixes both — it names
  // the control for a screen reader AND distinguishes it from its siblings — so
  // the message that leads to that fix is the more useful one.
  if (h.iconOnly) {
    return (
      `<${h.tag}> renders only an icon, so no text names it — add an accessibilityLabel, ` +
      `which makes it announceable as well as addressable`
    );
  }
  if (h.ambiguousTag) {
    return (
      `more than one <${h.tag}> renders here and nothing distinguishes this one — ` +
      `add a testID, or an accessibilityLabel (which also names it for a screen reader)`
    );
  }
  return (
    `nothing on the <${h.tag}> identifies it: no testID, no accessibilityLabel, ` +
    `no accessibilityRole, and no literal text under it`
  );
}

/**
 * How to drive an event on a located element.
 *
 * A CLOSED switch with no permissive default, unlike the DOM emitter's
 * `default: userEvent.click(...)`. A click on a React Native tree is nonsense
 * that would pass silently, so an event with no honest dispatch returns
 * undefined and the caller skips instead.
 *
 * `useUserEvent` is false for route specs: renderRouter calls jest.useFakeTimers()
 * internally, and userEvent's press timing under fake timers is not something
 * this emitter can vouch for. fireEvent has no timers in it.
 */
export function emitNativeDispatch(
  event: string,
  target: NativeTarget,
  el: string,
  useUserEvent: boolean,
): string | undefined {
  const press = (kind: "press" | "longPress"): string =>
    useUserEvent && target.self ? `await user.${kind}(${el})` : `fireEvent(${el}, ${j(kind)})`;
  switch (event) {
    case "onPress":
      return press("press");
    case "onLongPress":
      return press("longPress");
    case "onPressIn":
      return `fireEvent(${el}, "pressIn")`;
    case "onPressOut":
      return `fireEvent(${el}, "pressOut")`;
    case "onChangeText":
      return `fireEvent.changeText(${el}, SAMPLE_TEXT)`;
    case "onChange":
      // RN's TextInput onChange payload is a DOCUMENTED shape, so this is a
      // specification rather than an invented event object.
      return `fireEvent(${el}, "change", { nativeEvent: { text: SAMPLE_TEXT } })`;
    case "onSubmitEditing":
      return `fireEvent(${el}, "submitEditing")`;
    case "onEndEditing":
      return `fireEvent(${el}, "endEditing")`;
    case "onValueChange":
      return `fireEvent(${el}, "valueChange", true)`;
    case "onFocus":
      return `fireEvent(${el}, "focus")`;
    case "onBlur":
      return `fireEvent(${el}, "blur")`;
    default:
      // onRefresh and onScroll land here: neither is reachable by any rung of the
      // ladder above, so there is no element to drive them on.
      return undefined;
  }
}

/** Elements that render no text, re-exported so the emitter can explain a skip. */
export { TEXTLESS_ELEMENTS };

/**
 * The async form of a locator: `getAllBy*` -> `findAllBy*`.
 *
 * A screen that loads in a focus effect renders its empty state first and its
 * rows only after the awaited fetch resolves. Querying synchronously at mount
 * then fails with "Unable to find an element with text: …" — which reads as a
 * missing element and is really a missing await. Three of the dogfood app's
 * screens failed exactly this way.
 *
 * Applied only where the component actually awaits something, so a screen with
 * no data loading keeps the synchronous query and its faster failure.
 */
export function awaitNativeSelector(locator: string): string {
  // The parentheses are the whole point. `await screen.findAllByText(x)[0]`
  // indexes the PROMISE, not the resolved array, so el is undefined and every
  // assertion after it fails — 30 tests, from a rewrite that looked right.
  const async = locator.replace(/screen\.get(All)?By/, (_m, all) => `screen.find${all ?? ""}By`);
  const suffix = /\)(\[\d+\])$/.exec(async)?.[1];
  if (suffix !== undefined) return `(await ${async.slice(0, -suffix.length)})${suffix}`;
  return `await ${async}`;
}
