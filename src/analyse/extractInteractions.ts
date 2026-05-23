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

const EVENT_PATTERN = /^on(Click|MouseDown|PointerDown|Submit|Change|Input|Focus|Blur|KeyDown|KeyPress)$/;
const FORM_FIELD_TAGS = new Set(["input", "select", "textarea"]);

export function extractInteractions(
  bodyNode: ts.Node,
  propsShape: PropsShape,
  unresolvedProps: string[] = [],
): InteractionInfo {
  // Handler props are function-typed, which extractProps cannot synthesise and
  // routes to unresolvedProps. Union both so the classifier sees them.
  const propNames = new Set([...Object.keys(propsShape), ...unresolvedProps]);
  const clicks: ClickHandler[] = [];
  const forms: FormInfo[] = [];
  const propUsage: Array<{ propName: string; tag: string }> = [];

  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = readTagName(n.tagName);
      if (tag !== "<dynamic>") {
        const enclosing = enclosingElement(n);
        const hints = collectHints(n.attributes);
        const label = extractLabel(enclosing, hints, propNames);

        if (tag === "form") {
          forms.push(buildForm(enclosing, n.attributes, propNames));
        }

        for (const attr of n.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          if (!ts.isIdentifier(attr.name)) continue;
          const event = attr.name.text;
          if (!EVENT_PATTERN.test(event)) continue;
          if (tag === "form" && event === "onSubmit") continue;
          const binding = classifyBinding(attr.initializer, propNames);
          clicks.push({ event, tag, label, hints, binding });
        }

        if (enclosing) recordPropUsage(enclosing, tag, propNames, propUsage);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);

  return { clicks, forms, propUsage };
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

function extractLabel(
  parent: ts.JsxElement | undefined,
  hints: ElementHints,
  propNames: Set<string>,
): LabelSource {
  if (parent) {
    for (const child of parent.children) {
      if (ts.isJsxText(child)) {
        const trimmed = child.text.trim();
        if (trimmed) return { kind: "text", value: trimmed };
      } else if (ts.isJsxExpression(child) && child.expression) {
        if (ts.isStringLiteral(child.expression)) {
          return { kind: "text", value: child.expression.text };
        }
        if (ts.isIdentifier(child.expression) && propNames.has(child.expression.text)) {
          return { kind: "prop", propName: child.expression.text };
        }
      }
    }
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
  const fields = parent ? collectFields(parent) : [];
  return { submit, fields, hints };
}

function collectFields(parent: ts.JsxElement): FieldInfo[] {
  const fields: FieldInfo[] = [];
  const labelsByHtmlFor = new Map<string, string>();

  // First pass: harvest <label htmlFor="x"> text-content keyed by htmlFor.
  const collectLabels = (n: ts.Node): void => {
    if (ts.isJsxElement(n)) {
      const opening = n.openingElement;
      if (ts.isIdentifier(opening.tagName) && opening.tagName.text === "label") {
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
        const label =
          (hints.id && labelsByHtmlFor.get(hints.id)) ?? hints.placeholder ?? undefined;
        fields.push({
          tag: tag as FieldInfo["tag"],
          type: hints.type,
          name: hints.name,
          id: hints.id,
          placeholder: hints.placeholder,
          label,
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(parent, visit);
  return fields;
}

function jsxTextOf(el: ts.JsxElement): string | undefined {
  for (const child of el.children) {
    if (ts.isJsxText(child)) {
      const t = child.text.trim();
      if (t) return t;
    } else if (ts.isJsxExpression(child) && child.expression && ts.isStringLiteral(child.expression)) {
      return child.expression.text;
    }
  }
  return undefined;
}

function recordPropUsage(
  el: ts.JsxElement,
  tag: string,
  propNames: Set<string>,
  out: Array<{ propName: string; tag: string }>,
): void {
  for (const child of el.children) {
    if (ts.isJsxExpression(child) && child.expression && ts.isIdentifier(child.expression)) {
      const name = child.expression.text;
      if (propNames.has(name)) out.push({ propName: name, tag });
    }
  }
}
