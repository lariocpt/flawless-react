import type { ClickHandler, InteractionInfo, LabelSource } from "../types.ts";

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
  // not, and querying it silently yields null.
  if (isHostTag(h.tag)) return `container.querySelector(${JSON.stringify(h.tag)})!`;
  return undefined;
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
      return `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(h.label.value)} })`;
    }
    if (h.label.kind === "text-partial") {
      return `page.getByRole(${JSON.stringify(role)}, { name: ${partialRegex(h.label.value)} })`;
    }
    if (h.label.kind === "prop") {
      return `page.getByRole(${JSON.stringify(role)}, { name: String(DEFAULTS[${JSON.stringify(h.label.propName)}] ?? "") })`;
    }
  }
  if (h.hints.id) return `page.locator(${JSON.stringify(`#${h.hints.id}`)})`;
  if (h.label.kind === "text") return `page.getByText(${JSON.stringify(h.label.value)})`;
  if (h.label.kind === "text-partial") return `page.getByText(${partialRegex(h.label.value)})`;
  if (isHostTag(h.tag)) return `page.locator(${JSON.stringify(h.tag)}).first()`;
  return undefined;
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
export function emitPlaywrightClickTarget(info: InteractionInfo | undefined): string | undefined {
  if (!info) return undefined;
  const target = info.clicks.find((c) => c.event === "onClick");
  if (!target) return undefined;
  const locator = emitPlaywrightSelector(target);
  if (!locator) return undefined;
  return locator.endsWith(".first()") ? locator : `${locator}.first()`;
}

/** Map an event attribute to the Testing-Library / user-event call for an element expression. */
export function emitVitestDispatch(
  event: string,
  elementExpr: string,
  opts?: { typeValue?: string },
): string {
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
    case "onFocus":
      return `${elementExpr}.focus()`;
    case "onBlur":
      return `${elementExpr}.focus();${elementExpr}.blur()`;
    case "onSubmit":
      return `await userEvent.click(${elementExpr})`;
    default:
      return `await userEvent.click(${elementExpr})`;
  }
}

export function emitPlaywrightDispatch(
  event: string,
  locatorExpr: string,
  opts?: { typeValue?: string },
): string {
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
