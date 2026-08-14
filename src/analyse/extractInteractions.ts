import ts from "typescript";
import type {
  ClickHandler,
  ElementHints,
  FieldInfo,
  FormInfo,
  HandlerBinding,
  InteractionInfo,
  LabelSource,
  PropsShape,
  SubmitControl,
} from "../types.ts";
import { findDisclosures } from "./extractDisclosures.ts";
import { posOf } from "./pos.ts";
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
const FORM_FIELD_TAGS = new Set(["input", "select", "textarea"]);

export function extractInteractions(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  propsShape: PropsShape,
  unresolvedProps: string[] = [],
  env: RenderEnv = emptyEnv(),
): InteractionInfo {
  // Handler props are function-typed, which extractProps cannot synthesise and
  // routes to unresolvedProps. Union both so the classifier sees them.
  const propNames = new Set([...Object.keys(propsShape), ...unresolvedProps]);
  const clicks: ClickHandler[] = [];
  const forms: FormInfo[] = [];

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
  const tagCounts = countHostTags(initial ? initial.expr : bodyNode);

  const visit = (n: ts.Node): void => {
    // "no" means provably not rendered at these props; "unknown" is kept, since
    // dropping it would lose every .map row and render-prop target.
    if (initial && n !== initial.expr && reachability(n, initial.expr, scope) === "no") return;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = readTagName(n.tagName);
      if (tag !== "<dynamic>") {
        const enclosing = enclosingElement(n);
        const hints = collectHints(n.attributes, scope);
        const label = extractLabel(enclosing, hints, propNames);

        if (tag === "form") {
          forms.push(
            buildForm(enclosing, n.attributes, propNames, posOf(n, sourceFile), sourceFile, scope),
          );
        }

        for (const attr of n.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          if (!ts.isIdentifier(attr.name)) continue;
          const event = attr.name.text;
          if (!EVENT_PATTERN.test(event)) continue;
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
 * Two things count towards `button`: a `<button>`, and a component tag whose
 * name ends in Button. The second is a naming convention rather than proof —
 * but it is only ever used to make the generator MORE cautious, downgrading a
 * fallback locator to a skip, so a false positive costs a test and a false
 * negative costs a wrong element. VoteCard is exactly that shape: one mapped
 * `<button>` carrying the handler and one `<Button>` rendering "Cast vote",
 * which `page.locator("button").first()` resolved to instead.
 *
 * An element inside `.map()` is counted once — the source shows one, the DOM may
 * show none or twenty. That is enough to answer the only question being asked:
 * does this locator have competition.
 */
function countHostTags(root: ts.Node): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (tag: string): void => {
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = readTagName(n.tagName);
      bump(tag);
      if (/^[A-Z]/.test(tag)) {
        const lower = tag.toLowerCase();
        // No `lower !== host` guard: <Button> lowercases to exactly "button",
        // which is the single most common case this rule exists for. The
        // component tag was already counted under its own name above.
        for (const host of ["button", "input", "textarea", "select", "form"]) {
          if (lower.endsWith(host)) bump(host);
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

function collectHints(attrs: ts.JsxAttributes, env: RenderEnv = emptyEnv()): ElementHints {
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
    const value = readStringInitializer(a.initializer);
    if (value === undefined) continue;
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

    for (const child of parent.children) {
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
      // An icon element, an interpolation, a call: text we cannot predict, so
      // whatever ran up to here is a fragment of the real accessible name.
      hasDynamic = true;
      endRun();
    }
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
): FormInfo {
  let submit: HandlerBinding | undefined;
  const hints: { testid?: string; ariaLabel?: string; id?: string } = {};
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const name = ts.isIdentifier(a.name) ? a.name.text : undefined;
    if (name === "onSubmit") submit = classifyBinding(a.initializer, propNames);
    if (name === "data-testid") hints.testid = readStringInitializer(a.initializer);
    if (name === "aria-label") hints.ariaLabel = readStringInitializer(a.initializer);
    if (name === "id") hints.id = readStringInitializer(a.initializer);
  }
  const fields = parent ? collectFields(parent, sourceFile) : [];
  const submitControl = parent ? findSubmitControl(parent, propNames, env) : undefined;
  return { submit, fields, ...(submitControl ? { submitControl } : {}), hints, pos };
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
