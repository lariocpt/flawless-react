import ts from "typescript";
import type { LabelSource } from "../types.ts";

/**
 * Elements that only exist in the DOM after something is clicked.
 *
 * A menu, dialog or popover mounts its content lazily, so a spec that queries an
 * item straight after render finds nothing — and the failure looks like a wrong
 * selector rather than a missing step. The shape is the same across
 * base-ui/radix/shadcn and is recognisable by structure alone:
 *
 *   <DropdownMenu>                       <- disclosure root
 *     <DropdownMenuTrigger>…</…>         <- the thing to click
 *     <DropdownMenuContent>              <- gated subtree
 *       <DropdownMenuItem>Light</…>      <- only mounted once open
 *
 * A `*Trigger` with a sibling subtree rooted at `*Content` / `*Popup` / `*Panel`
 * / `*Portal` / `*Popover` — that is the whole rule. No package allowlist, so it
 * also covers a project's own wrappers.
 */

const TRIGGER_TAG = /Trigger$/;
const GATED_ROOT_TAG = /(Content|Popup|Panel|Portal|Overlay|Popover)$/;

export interface Disclosure {
  /** How a spec finds the element to click first. */
  trigger: LabelSource;
  /** Every node that only mounts after that click. */
  gated: Set<ts.Node>;
}

export function findDisclosures(root: ts.Node): Disclosure[] {
  const out: Disclosure[] = [];

  const visit = (n: ts.Node): void => {
    const tag = openingTagName(n);
    if (tag && TRIGGER_TAG.test(tag)) {
      const found = disclosureFor(n, root);
      if (found) out.push(found);
    }
    ts.forEachChild(n, visit);
  };
  visit(root);

  return out;
}

/** The gated subtrees that sit beside `trigger`, and how to click it. */
function disclosureFor(trigger: ts.Node, root: ts.Node): Disclosure | undefined {
  const handle = triggerHandle(trigger);
  if (handle.kind === "none") return undefined;

  for (let a = trigger.parent; a && a !== root.parent; a = a.parent) {
    if (!ts.isJsxElement(a) && !ts.isJsxFragment(a)) continue;
    const gatedRoots = a.children.filter((child) => {
      if (contains(child, trigger)) return false;
      const tag = openingTagName(child);
      return tag !== undefined && GATED_ROOT_TAG.test(tag);
    });
    if (gatedRoots.length === 0) continue;

    const gated = new Set<ts.Node>();
    for (const subtree of gatedRoots) collectAll(subtree, gated);
    return { trigger: handle, gated };
  }
  return undefined;
}

/**
 * Something a spec can use to click the trigger.
 *
 * Literal text is taken from anywhere in the trigger's subtree, INCLUDING the
 * JSX inside attributes: base-ui's `render={<Button/>}` slot and shadcn's
 * `<span className="sr-only">` both put the only human-readable label somewhere
 * a direct-children scan never looks. Clicking that span bubbles to the button,
 * so it is a valid handle.
 */
function triggerHandle(trigger: ts.Node): LabelSource {
  const attrs = jsxAttributes(trigger);
  const testid = stringAttr(attrs, "data-testid");
  if (testid) return { kind: "testid", value: testid };
  const aria = stringAttr(attrs, "aria-label");
  if (aria) return { kind: "aria", value: aria };

  const texts: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      const t = n.text.replace(/\s+/g, " ").trim();
      if (t) texts.push(t);
    }
    ts.forEachChild(n, visit);
  };
  visit(trigger);

  // More than one candidate and we cannot tell which identifies the trigger.
  const unique = [...new Set(texts)];
  const only = unique.length === 1 ? unique[0] : undefined;
  return only && only.length >= 2 ? { kind: "text", value: only } : { kind: "none" };
}

function contains(haystack: ts.Node, needle: ts.Node): boolean {
  for (let n: ts.Node | undefined = needle; n; n = n.parent) {
    if (n === haystack) return true;
  }
  return false;
}

function collectAll(n: ts.Node, into: Set<ts.Node>): void {
  into.add(n);
  ts.forEachChild(n, (c) => collectAll(c, into));
}

function openingTagName(n: ts.Node): string | undefined {
  const tagName = ts.isJsxElement(n)
    ? n.openingElement.tagName
    : ts.isJsxSelfClosingElement(n)
      ? n.tagName
      : undefined;
  return tagName && ts.isIdentifier(tagName) ? tagName.text : undefined;
}

function jsxAttributes(n: ts.Node): ts.JsxAttributes | undefined {
  if (ts.isJsxElement(n)) return n.openingElement.attributes;
  if (ts.isJsxSelfClosingElement(n)) return n.attributes;
  return undefined;
}

function stringAttr(attrs: ts.JsxAttributes | undefined, name: string): string | undefined {
  if (!attrs) return undefined;
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a)) continue;
    if (!ts.isIdentifier(a.name) || a.name.text !== name) continue;
    const init = a.initializer;
    if (init && ts.isStringLiteral(init)) return init.text;
    if (
      init &&
      ts.isJsxExpression(init) &&
      init.expression &&
      ts.isStringLiteral(init.expression)
    ) {
      return init.expression.text;
    }
  }
  return undefined;
}
