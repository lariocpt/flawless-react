import { fillKind, isFillableTag } from "../analyse/htmlContentModel.ts";
import type { ClickHandler, FieldInfo, FormInfo, InteractionInfo, LabelSource } from "../types.ts";

const TAG_TO_ROLE: Record<string, string> = {
  button: "button",
  a: "link",
  input: "textbox",
  textarea: "textbox",
  select: "combobox",
};

/**
 * A Vitest/Testing-Library expression resolving to the target element, or
 * undefined when nothing in the source identifies it.
 *
 * undefined is load-bearing. The old last resort was
 * `container.querySelector("<TagName>")`, which for an uppercase component tag
 * matches no element at all: userEvent.click(null) is a no-op, so the test
 * PASSED while doing nothing. A skip that names the gap is worth more than a
 * green test that never touched the DOM.
 */
export function emitVitestSelector(h: ClickHandler): string | undefined {
  if (h.hints.testid) return `screen.getByTestId(${JSON.stringify(h.hints.testid)})`;
  if (h.hints.ariaLabel) {
    return `screen.getAllByLabelText(${JSON.stringify(h.hints.ariaLabel)})[0] as HTMLElement`;
  }
  const role = roleFor(h);
  if (role) {
    if (h.label.kind === "text") {
      return `screen.getAllByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(h.label.value)} })[0] as HTMLElement`;
    }
    if (h.label.kind === "text-partial") {
      return `screen.getAllByRole(${JSON.stringify(role)}, { name: ${partialRegex(h.label.value)} })[0] as HTMLElement`;
    }
    if (h.label.kind === "prop") {
      return `screen.getAllByRole(${JSON.stringify(role)}, { name: String(DEFAULTS[${JSON.stringify(h.label.propName)}] ?? "") })[0] as HTMLElement`;
    }
  }
  if (h.hints.id) return `container.querySelector(${JSON.stringify(`#${h.hints.id}`)})!`;
  if (h.label.kind === "text")
    return `screen.getAllByText(${JSON.stringify(h.label.value)})[0] as HTMLElement`;
  if (h.label.kind === "text-partial")
    return `screen.getAllByText(${partialRegex(h.label.value)})[0] as HTMLElement`;
  // A lowercase host tag is a real CSS selector; an uppercase component name is
  // not, and querying it silently yields null. It still only NAMES the element
  // when it is the only one of its kind in the render.
  if (isHostTag(h.tag) && !h.ambiguousTag) {
    return `container.querySelector(${JSON.stringify(h.tag)})!`;
  }
  return undefined;
}

/** Why a handler could not be addressed, for the skip that replaces its test. */
export function describeUnlocatable(h: ClickHandler): string {
  return h.ambiguousTag
    ? `more than one <${h.tag}> renders here and nothing distinguishes this one`
    : `nothing in the source identifies the <${h.tag}> it is bound to`;
}

/** Emit a Playwright Locator expression for the target element. */
export function emitPlaywrightSelector(h: ClickHandler): string | undefined {
  if (h.hints.testid) return `page.getByTestId(${JSON.stringify(h.hints.testid)})`;
  if (h.hints.ariaLabel) {
    return `page.getByLabel(${JSON.stringify(h.hints.ariaLabel)})`;
  }
  const role = roleFor(h);
  if (role) {
    if (h.label.kind === "text") {
      // exact: true for the same reason getByText needs it — Playwright's `name`
      // is a case-insensitive SUBSTRING match by default, so { name: "Add" }
      // also claims "Add member" and "Add building". Testing Library's
      // equivalent defaults the other way, which is why the unit emitter says
      // nothing here and this one has to.
      return `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(h.label.value)}, exact: true })`;
    }
    if (h.label.kind === "text-partial") {
      return `page.getByRole(${JSON.stringify(role)}, { name: ${partialRegex(h.label.value)} })`;
    }
    if (h.label.kind === "prop") {
      return `page.getByRole(${JSON.stringify(role)}, { name: String(DEFAULTS[${JSON.stringify(h.label.propName)}] ?? ""), exact: true })`;
    }
  }
  if (h.hints.id) return `page.locator(${JSON.stringify(`#${h.hints.id}`)})`;
  // exact: true, because Playwright's default text match is a case-insensitive
  // SUBSTRING one. getByText("Try again") also matched the paragraph reading
  // "We couldn't load this page. Please try again." and failed on strict mode.
  // A `text` label is the element's whole literal copy, so exactness is what the
  // source actually claims; `text-partial` is a fragment and keeps its regex.
  if (h.label.kind === "text")
    return `page.getByText(${JSON.stringify(h.label.value)}, { exact: true })`;
  if (h.label.kind === "text-partial") return `page.getByText(${partialRegex(h.label.value)})`;
  if (isHostTag(h.tag) && !h.ambiguousTag) return `page.locator(${JSON.stringify(h.tag)}).first()`;
  return undefined;
}

/**
 * The browser-spec form of a click target: always resolved to one element.
 *
 * Playwright locators are strict. A control rendered inside `.map()` resolves to
 * as many elements as there are rows, and "strict mode violation: getByText
 * ('Remove') resolved to 2 elements" describes the list, not a defect. The perf
 * scaffolder learned this; the browser scaffolder called the raw selector and
 * inherited every one of those failures.
 */
export function firstOf(locator: string): string {
  return locator.endsWith(".first()") ? locator : `${locator}.first()`;
}

/**
 * The first targetable click locator for the perf suite, or undefined to keep
 * the scenario skipped.
 *
 * Always `.first()`: Playwright locators are strict, and a `.map()`-rendered
 * control resolves to as many elements as there are rows — "strict mode
 * violation: getByText('Remove') resolved to 2 elements" is a property of the
 * list, not a defect in the component being profiled.
 */
export interface ClickTarget {
  /** Locator expression, already resolved to a single element. */
  locator: string;
  /** Statement that opens the disclosure this target lives behind, if any. */
  prelude?: string;
  /** Why no target could be derived, when `locator` is absent. */
  reason?: string;
}

export function emitPlaywrightClickTarget(info: InteractionInfo | undefined): ClickTarget {
  if (!info || info.clicks.length === 0) {
    return { locator: "", reason: "the analyser found no click handler on this component" };
  }
  // A disabled control never becomes clickable, and Playwright's actionability
  // wait runs to the test timeout before saying so.
  const target = info.clicks.find((c) => c.event === "onClick" && c.hints.disabled !== "always");
  if (!target) {
    return { locator: "", reason: "every clickable target is disabled at these props" };
  }
  const locator = emitPlaywrightSelector(target);
  if (!locator) return { locator: "", reason: describeUnlocatable(target) };
  // A menu item inside a portal does not exist until its trigger opens it. The
  // unit and browser emitters learned this; the profile one clicked into an
  // empty page and reported the component as having no clickable target.
  const trigger = target.gatedBy ? emitPlaywrightDisclosure(target.gatedBy) : undefined;
  return {
    locator: firstOf(locator),
    // Guarded, because the trigger may not be there either. UserMenu returns
    // null until a store hook supplies a session, so an unguarded
    // `await trigger.click()` waited out the full 30s timeout for an element
    // the component had decided not to render — and did it BEFORE the count
    // check below could report the absence.
    ...(trigger
      ? {
          prelude: `const __trigger = ${firstOf(trigger)};
  if ((await __trigger.count()) > 0) await __trigger.click();`,
        }
      : {}),
  };
}

/** Playwright form of a disclosure trigger. Shared by the browser and profile specs. */
export function emitPlaywrightDisclosure(label: LabelSource): string | undefined {
  switch (label.kind) {
    case "testid":
      return `page.getByTestId(${JSON.stringify(label.value)})`;
    case "aria":
      return `page.getByLabel(${JSON.stringify(label.value)})`;
    case "text":
      return `page.getByText(${JSON.stringify(label.value)}, { exact: true })`;
    default:
      return undefined;
  }
}

/**
 * Map an event attribute to the Testing-Library / user-event call for an element
 * expression, or undefined when the event cannot be driven on that element.
 *
 * The undefined case is a change/input handler bound to something that holds no
 * text. React's onChange bubbles, so `<form onChange={...}>` is idiomatic — and
 * driving it literally emitted `page.locator("form").fill("x")`, which Playwright
 * rejects outright. The fields inside that form are covered by the form test;
 * describing the form itself as a text box was never true.
 */
export function emitVitestDispatch(
  event: string,
  elementExpr: string,
  opts?: { typeValue?: string; tag?: string },
): string | undefined {
  if ((event === "onChange" || event === "onInput") && opts?.tag && !isFillableTag(opts.tag)) {
    return undefined;
  }
  switch (event) {
    case "onClick":
      return `await userEvent.click(${elementExpr})`;
    case "onChange":
    case "onInput":
      return `await userEvent.type(${elementExpr}, ${JSON.stringify(opts?.typeValue ?? "x")})`;
    case "onMouseDown":
    case "onPointerDown":
      return `await userEvent.pointer({ keys: "[MouseLeft>]", target: ${elementExpr} })`;
    case "onKeyDown":
    case "onKeyPress":
      return `await userEvent.keyboard("{Enter}")`;
    // Parenthesised: the locator expression ENDS in `as HTMLElement`, and an
    // unparenthesised member access parses the dot against the TYPE —
    // `el[0] as HTMLElement.focus()` is a syntax error, not a cast-then-call.
    case "onFocus":
      return `(${elementExpr}).focus()`;
    case "onBlur":
      return `(${elementExpr}).focus();(${elementExpr}).blur()`;
    case "onSubmit":
      return `await userEvent.click(${elementExpr})`;
    default:
      return `await userEvent.click(${elementExpr})`;
  }
}

export function emitPlaywrightDispatch(
  event: string,
  locatorExpr: string,
  opts?: { typeValue?: string; tag?: string },
): string | undefined {
  if ((event === "onChange" || event === "onInput") && opts?.tag && !isFillableTag(opts.tag)) {
    return undefined;
  }
  switch (event) {
    case "onClick":
    case "onSubmit":
      return `await ${locatorExpr}.click()`;
    case "onChange":
    case "onInput":
      return `await ${locatorExpr}.fill(${JSON.stringify(opts?.typeValue ?? "x")})`;
    case "onKeyDown":
    case "onKeyPress":
      return `await ${locatorExpr}.press("Enter")`;
    case "onFocus":
      return `await ${locatorExpr}.focus()`;
    case "onBlur":
      return `await ${locatorExpr}.evaluate((el) => (el as HTMLElement).blur())`;
    default:
      return `await ${locatorExpr}.click()`;
  }
}

/**
 * The DOM shape of "the button that submits this form", used when the source
 * names a submit control but not its copy.
 *
 * `button:not([type])` is in there because HTML's default type for a button
 * inside a form IS submit — the attribute's absence is the common case, not an
 * edge one.
 */
const SUBMIT_WITHIN_FORM = "button[type=submit], button:not([type]), input[type=submit]";

/** Playwright locator for a form's submit control, or undefined when none was found. */
export function emitPlaywrightSubmit(form: FormInfo): string | undefined {
  const control = form.submitControl;
  if (!control) return undefined;
  const byLabel = playwrightButtonByLabel(control.label);
  if (byLabel) return firstOf(byLabel);
  return `page.locator("form").first().locator(${JSON.stringify(SUBMIT_WITHIN_FORM)}).first()`;
}

/** Testing-Library expression for a form's submit control. */
export function emitVitestSubmit(form: FormInfo): string | undefined {
  const control = form.submitControl;
  if (!control) return undefined;
  switch (control.label.kind) {
    case "text":
      return `screen.getAllByRole("button", { name: ${JSON.stringify(control.label.value)} })[0] as HTMLElement`;
    case "text-partial":
      return `screen.getAllByRole("button", { name: ${partialRegex(control.label.value)} })[0] as HTMLElement`;
    case "aria":
      return `screen.getAllByLabelText(${JSON.stringify(control.label.value)})[0] as HTMLElement`;
    case "testid":
      return `screen.getByTestId(${JSON.stringify(control.label.value)})`;
    default:
      return `container.querySelector(${JSON.stringify(
        SUBMIT_WITHIN_FORM.split(", ")
          .map((s) => `form ${s}`)
          .join(", "),
      )}) as HTMLElement`;
  }
}

function playwrightButtonByLabel(label: LabelSource): string | undefined {
  switch (label.kind) {
    case "text":
      return `page.getByRole("button", { name: ${JSON.stringify(label.value)}, exact: true })`;
    case "text-partial":
      return `page.getByRole("button", { name: ${partialRegex(label.value)} })`;
    case "aria":
      return `page.getByLabel(${JSON.stringify(label.value)})`;
    case "testid":
      return `page.getByTestId(${JSON.stringify(label.value)})`;
    default:
      return undefined;
  }
}

/**
 * A statement that puts a value into one form field, or undefined when the field
 * is not something a user supplies.
 *
 * The old emitter typed into everything with a name, which produced
 * `.fill()` against a checkbox ("Input of type checkbox cannot be filled"),
 * against a hidden input, and against sixteen checkboxes sharing one name at
 * once. The field's own `type` says which of those it is.
 */
export function emitPlaywrightFill(field: FieldInfo): string | undefined {
  const kind = fillKind(field.tag, field.type);
  if (kind === "skip") return undefined;
  const locator = fieldLocator(field, "playwright");
  if (!locator) return undefined;
  const target = firstOf(locator);
  if (kind === "toggle") return `await ${target}.check();`;
  if (kind === "select") return `await ${target}.selectOption({ index: 1 });`;
  return `await ${target}.fill(${JSON.stringify(sampleValue(field))});`;
}

/** The Testing-Library equivalent, including the same type-awareness. */
export function emitVitestFill(field: FieldInfo): string | undefined {
  const kind = fillKind(field.tag, field.type);
  if (kind === "skip") return undefined;
  const locator = fieldLocator(field, "vitest");
  if (!locator) return undefined;
  if (kind === "toggle") return `await userEvent.click(${locator} as HTMLElement);`;
  if (kind === "select") {
    return `await userEvent.selectOptions(${locator} as HTMLElement, (${locator} as HTMLSelectElement).options[1]?.value ?? "");`;
  }
  return `await userEvent.type(${locator} as HTMLElement, ${JSON.stringify(sampleValue(field))});`;
}

/**
 * The assertion that the value actually landed, or undefined when there is
 * nothing to check.
 *
 * Without it a form test only proves that filling and clicking threw no error —
 * true of a form whose inputs are all `readOnly`. `toHaveValue` is the cheapest
 * statement that distinguishes the two.
 */
export function emitVitestFillAssertion(field: FieldInfo): string | undefined {
  if (fillKind(field.tag, field.type) !== "text") return undefined;
  const locator = fieldLocator(field, "vitest");
  if (!locator) return undefined;
  const value = sampleValue(field);
  // A number input's value comes back as a number, not the string typed into it.
  const expected = field.type === "number" ? value : JSON.stringify(value);
  return `expect(${locator} as HTMLElement).toHaveValue(${expected});`;
}

function sampleValue(field: FieldInfo): string {
  switch (field.type) {
    case "email":
      return "user@example.com";
    case "password":
      return "pa55word!";
    case "number":
      return "42";
    case "tel":
      return "0123456789";
    case "url":
      return "https://example.com";
    default:
      return field.label ?? field.name ?? "value";
  }
}

function fieldLocator(field: FieldInfo, flavour: "playwright" | "vitest"): string | undefined {
  const pw = flavour === "playwright";
  if (field.label) {
    return pw
      ? `page.getByLabel(${JSON.stringify(field.label)})`
      : `screen.getAllByLabelText(${JSON.stringify(field.label)})[0]`;
  }
  if (field.placeholder) {
    return pw
      ? `page.getByPlaceholder(${JSON.stringify(field.placeholder)})`
      : `screen.getAllByPlaceholderText(${JSON.stringify(field.placeholder)})[0]`;
  }
  if (field.id) {
    return pw
      ? `page.locator(${JSON.stringify(`#${field.id}`)})`
      : `container.querySelector(${JSON.stringify(`#${field.id}`)})!`;
  }
  if (field.name) {
    // Single-quoted inside the CSS so the emitted JS string needs no escaping —
    // "[name=\"x\"]" is correct but unreadable in a spec someone has to review.
    const css = `[name='${field.name.replace(/'/g, "\\'")}']`;
    return pw
      ? `page.locator(${JSON.stringify(css)})`
      : `container.querySelector(${JSON.stringify(css)})!`;
  }
  return undefined;
}

/**
 * The expression that finds a disclosure trigger so a spec can open it.
 * undefined when the trigger has no handle worth clicking.
 */
export function emitTriggerSelector(label: LabelSource): string | undefined {
  switch (label.kind) {
    case "testid":
      return `screen.getByTestId(${JSON.stringify(label.value)})`;
    case "aria":
      return `screen.getAllByLabelText(${JSON.stringify(label.value)})[0] as HTMLElement`;
    case "text":
      return `screen.getAllByText(${JSON.stringify(label.value)})[0] as HTMLElement`;
    default:
      return undefined;
  }
}

/**
 * The awaiting form of a selector, for an element that only mounts after a
 * trigger is clicked. Testing-Library's findBy* retries until it appears; getBy*
 * asserts against the DOM as it stands the instant the click returns, which is
 * before the menu has mounted its items.
 */
export function awaitSelector(selector: string): string {
  if (/^screen\.getAllBy/.test(selector)) {
    const inner = selector.replace(/^screen\.getAllBy/, "screen.findAllBy");
    return `(await ${inner.replace(/\)\[0\] as HTMLElement$/, "))[0] as HTMLElement")}`;
  }
  if (/^screen\.getBy/.test(selector)) {
    return `await ${selector.replace(/^screen\.getBy/, "screen.findBy")}`;
  }
  // A container.querySelector target is synchronous by nature; nothing to await.
  return selector;
}

/**
 * A regex literal for a label we only know a fragment of. Both
 * Testing-Library's `name` and Playwright's `name` accept a RegExp and match it
 * against the WHOLE accessible name, so the fragment is left unanchored: it is a
 * substring claim, which is all the source supports.
 */
function partialRegex(value: string): string {
  return `/${value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/`;
}

/** JSX lowercases host elements; anything capitalised is a component reference. */
function isHostTag(tag: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(tag);
}

function roleFor(h: ClickHandler): string | undefined {
  if (h.hints.role) return h.hints.role;
  if (h.tag === "input") {
    const t = h.hints.type;
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "submit" || t === "button") return "button";
    return "textbox";
  }
  // A component tag says nothing about the role it renders: <DropdownMenuItem>
  // is role="menuitem", <SelectTrigger> is "combobox". Assuming "button" made
  // every such query fail with a confident, wrong name. Callers fall back to
  // matching the element's text, which is true regardless of role.
  return TAG_TO_ROLE[h.tag];
}
