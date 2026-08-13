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
} from "../types.ts";
import { posOf } from "./pos.ts";
import { emptyEnv, initialRenderExpression, type RenderEnv, reachability } from "./renderPath.ts";

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

  const visit = (n: ts.Node): void => {
    // "no" means provably not rendered at these props; "unknown" is kept, since
    // dropping it would lose every .map row and render-prop target.
    if (initial && n !== initial.expr && reachability(n, initial.expr, scope) === "no") return;
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = readTagName(n.tagName);
      if (tag !== "<dynamic>") {
        const enclosing = enclosingElement(n);
        const hints = collectHints(n.attributes);
        const label = extractLabel(enclosing, hints, propNames);

        if (tag === "form") {
          forms.push(
            buildForm(enclosing, n.attributes, propNames, posOf(n, sourceFile), sourceFile),
          );
        }

        for (const attr of n.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          if (!ts.isIdentifier(attr.name)) continue;
          const event = attr.name.text;
          if (!EVENT_PATTERN.test(event)) continue;
          if (tag === "form" && event === "onSubmit") continue;
          const binding = classifyBinding(attr.initializer, propNames);
          clicks.push({ event, tag, label, hints, binding, pos: posOf(attr, sourceFile) });
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

function collectHints(attrs: ts.JsxAttributes): ElementHints {
  const hints: ElementHints = {};
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    const name = ts.isIdentifier(a.name) ? a.name.text : undefined;
    if (!name) continue;
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
  return { submit, fields, hints, pos };
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
  return fields;
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
