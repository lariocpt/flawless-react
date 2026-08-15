import ts from "typescript";
import { extractRootTag } from "./extractRootTag.ts";
import type { ImportBinding } from "./parseFile.ts";
import { parseFile } from "./parseFile.ts";
import type { ModuleResolver } from "./resolveModule.ts";

/**
 * What host element each component tag in a render actually produces.
 *
 * This exists to replace a naming convention. Deciding whether a bare
 * `page.locator("button")` names one element meant counting how many things in
 * the render could answer to it, and a `<Button>` obviously can — but "obviously"
 * was implemented as `tag.toLowerCase().endsWith("button")`, which is a guess in
 * a codebase whose rule is to bail rather than guess. `<LinkButton>` may well
 * render an `<a>`.
 *
 * The evidence is one hop away: resolve the tag to its module, parse it, and
 * read the root tag the analyser already computes for every component. Same-file
 * components resolve without any I/O at all.
 *
 * Unresolved tags are simply absent from the map. The caller falls back to the
 * convention for those, which only ever makes it MORE cautious — a false
 * positive costs a test, a false negative clicks the wrong element.
 */
export async function resolveTagRootTags(
  bodyNode: ts.Node,
  sameFile: ts.SourceFile,
  imports: Map<string, ImportBinding>,
  fromPath: string,
  resolver: ModuleResolver,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const tags = componentTagsIn(bodyNode);
  if (tags.size === 0) return out;

  // Same-file first: no resolution, no read.
  const localBodies = componentBodiesIn(sameFile);
  for (const tag of tags) {
    const body = localBodies.get(tag);
    if (!body) continue;
    const root = extractRootTag(body);
    if (root) out.set(tag, root);
  }

  for (const tag of tags) {
    if (out.has(tag)) continue;
    const binding = imports.get(tag);
    if (!binding || binding.isTypeOnly) continue;
    const target = resolver.resolve(binding.specifier, fromPath);
    // Bare package specifiers resolve to undefined by design — node_modules is
    // never walked, so a third-party <Button> stays unknown rather than guessed.
    if (!target) continue;
    try {
      const parsed = await parseFile(target);
      const wanted = binding.importedName ?? tag;
      const unit =
        parsed.components.find((c) => c.componentName === wanted) ??
        (binding.kind === "default" ? parsed.components[0] : undefined);
      if (!unit) continue;
      const root = extractRootTag(unit.bodyNode);
      if (root) out.set(tag, root);
    } catch {
      // Unparseable target: absent from the map, so the caller stays cautious.
    }
  }
  return out;
}

/** Capitalised JSX tag names used anywhere in this render. */
function componentTagsIn(root: ts.Node): Set<string> {
  const tags = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      if (ts.isIdentifier(n.tagName) && /^[A-Z]/.test(n.tagName.text)) tags.add(n.tagName.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return tags;
}

/** Component name → body node, for the components declared in this same file. */
function componentBodiesIn(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body && /^[A-Z]/.test(n.name.text)) {
      out.set(n.name.text, n.body);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /^[A-Z]/.test(n.name.text)) {
      const init = n.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        out.set(n.name.text, init.body);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return out;
}
