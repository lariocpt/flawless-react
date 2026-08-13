import type { ClickHandler, InteractionInfo } from "../types.ts";

const TAG_TO_ROLE: Record<string, string> = {
  button: "button",
  a: "link",
  input: "textbox",
  textarea: "textbox",
  select: "combobox",
};

/** Emit a Vitest/Testing-Library expression that resolves to the target element. */
export function emitVitestSelector(h: ClickHandler): string {
  if (h.hints.testid) return `screen.getByTestId(${JSON.stringify(h.hints.testid)})`;
  if (h.hints.ariaLabel) {
    return `screen.getAllByLabelText(${JSON.stringify(h.hints.ariaLabel)})[0] as HTMLElement`;
  }
  const role = roleFor(h);
  if (role) {
    if (h.label.kind === "text") {
      return `screen.getAllByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(h.label.value)} })[0] as HTMLElement`;
    }
    if (h.label.kind === "prop") {
      return `screen.getAllByRole(${JSON.stringify(role)}, { name: String(DEFAULTS[${JSON.stringify(h.label.propName)}] ?? "") })[0] as HTMLElement`;
    }
  }
  if (h.hints.id) return `container.querySelector(${JSON.stringify(`#${h.hints.id}`)})!`;
  if (h.label.kind === "text")
    return `screen.getAllByText(${JSON.stringify(h.label.value)})[0] as HTMLElement`;
  return `container.querySelector(${JSON.stringify(h.tag)})!`;
}

/** Emit a Playwright Locator expression for the target element. */
export function emitPlaywrightSelector(h: ClickHandler): string {
  if (h.hints.testid) return `page.getByTestId(${JSON.stringify(h.hints.testid)})`;
  if (h.hints.ariaLabel) {
    return `page.getByLabel(${JSON.stringify(h.hints.ariaLabel)})`;
  }
  const role = roleFor(h);
  if (role) {
    if (h.label.kind === "text") {
      return `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(h.label.value)} })`;
    }
    if (h.label.kind === "prop") {
      return `page.getByRole(${JSON.stringify(role)}, { name: String(DEFAULTS[${JSON.stringify(h.label.propName)}] ?? "") })`;
    }
  }
  if (h.hints.id) return `page.locator(${JSON.stringify(`#${h.hints.id}`)})`;
  if (h.label.kind === "text") return `page.getByText(${JSON.stringify(h.label.value)})`;
  return `page.locator(${JSON.stringify(h.tag)}).first()`;
}

/** Returns the first targetable click locator for the perf suite, or undefined to keep skip. */
export function emitPlaywrightClickTarget(info: InteractionInfo | undefined): string | undefined {
  if (!info) return undefined;
  const target = info.clicks.find((c) => c.event === "onClick");
  if (!target) return undefined;
  return emitPlaywrightSelector(target);
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

function roleFor(h: ClickHandler): string | undefined {
  if (h.hints.role) return h.hints.role;
  if (h.tag === "input") {
    const t = h.hints.type;
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "submit" || t === "button") return "button";
    return "textbox";
  }
  // Custom components (uppercase): assume they expose a button role.
  if (/^[A-Z]/.test(h.tag)) return "button";
  return TAG_TO_ROLE[h.tag];
}
