import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isAuthLibSpecifier } from "../analyse/authShims.ts";
import { ModuleResolver } from "../analyse/resolveModule.ts";
import { readPrologueDirective } from "../analyse/sourceCache.ts";
import type { NextjsContext } from "../types.ts";

/**
 * Next.js app-router layouts are usually async server components importing
 * next/font, next/headers, or server-only modules — none of which can run
 * under jsdom. Even a sync layout renders the <html>/<body> document shell,
 * which nests a second <html> inside RTL's container div and wedges React's
 * event dispatch. When the auto-detected app resolver is such a layout, we
 * derive a client-safe provider wrapper from the JSX chain that encloses
 * `{children}` and emit it once as <outDir>/provider.tsx.
 */

const SERVER_ONLY_SPECIFIERS = /^(next\/font(\/|$)|next\/headers$|server-only$)/;

/** A file is usable as a unit-test provider iff its default export is a sync component and it pulls in no server-only modules. */
export function isUsableUnitProvider(file: string): boolean {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX,
    );
  } catch {
    return false;
  }

  // A root layout renders <html> — a document shell. RTL mounts into a <div>
  // inside jsdom's own <body>, so importing it as the provider nests a second
  // <html> in the tree (React's "In HTML, <html> cannot be a child of <div>").
  // jsdom's node-list invariants break under that nesting, and React's
  // continuous-event dispatch (pointer) walks them — the dispatch never
  // terminates and the worker burns 100% CPU forever. Mount only specs that
  // never fire pointer events survive; any click test wedges the whole run.
  // Deriving the client provider chain instead keeps what tests need.
  if (rendersDocumentShell(sf)) return false;

  // A pages-router `_app` is not a provider: it renders the route element with
  // `AppProps`, which a spec cannot supply and a wrapper cannot fake. Derive
  // the chain it wraps instead, anchored on `<Component />`.
  if (rendersRouteElement(sf)) return false;

  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      SERVER_ONLY_SPECIFIERS.test(stmt.moduleSpecifier.text)
    ) {
      return false;
    }
    if (ts.isFunctionDeclaration(stmt)) {
      const mods = stmt.modifiers ?? [];
      const isDefault =
        mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
        mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (isDefault && mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const expr = stmt.expression;
      if (
        (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) &&
        (expr.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        return false;
      }
    }
  }
  return true;
}

interface RootShellWalker {
  found: boolean;
}

/** True when the file's JSX opens a <html> element — the root-layout marker. */
function rendersDocumentShell(sf: ts.SourceFile): boolean {
  const marker: RootShellWalker = { found: false };
  const walk = (n: ts.Node): void => {
    if (marker.found) return;
    if (
      (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
      ts.isIdentifier(n.tagName) &&
      n.tagName.text === "html"
    ) {
      marker.found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return marker.found;
}

export interface ProviderWrapperResult {
  /** Absolute path of the wrapper to use as --provider. */
  path: string;
  /** False when the file already existed and was left untouched. */
  created: boolean;
  /** Local names of the providers included in the wrapper. */
  included: string[];
  /** Providers the layout's chain has and the wrapper does NOT mount. */
  dropped: Array<{ name: string; reason: DropReason }>;
}

/** Why a provider in the layout's chain could not be mounted, and what to say about it. */
const DROP_REASONS = {
  auth: {
    short: "auth-gated",
    long:
      "imports an auth library, and the unit plane replaces those libraries with a signed-out " +
      "stub — mounted, a provider that gates its children on a session renders nothing, and every " +
      "wrapped spec inherits the blank tree",
  },
  server: {
    short: "not a client module",
    long: 'is not a "use client" module, so its own render cannot run under jsdom',
  },
  unresolved: {
    short: "unresolved import",
    long: "does not resolve to a readable module in this repo (a package export, or an alias the workspace map does not cover)",
  },
} as const;
export type DropReason = keyof typeof DROP_REASONS;

/**
 * Specifiers whose JSX is React's own coordination machinery, not an app
 * provider: `<Suspense>`, `<Fragment>`, `<StrictMode>`. They appear in layout
 * chains the same way providers do and resolve to node_modules, so without this
 * filter every suite's drop list opened with "Suspense — unresolved import",
 * which is neither a provider nor a thing the reader can act on.
 */
const REACT_OWN_COMPONENTS = /^react(-dom)?(\/|$)/;

/** Short label for a drop reason, for the run summary (the file itself spells it out). */
export function dropReasonLabel(reason: DropReason): string {
  return DROP_REASONS[reason].short;
}

/**
 * Derive `<outDir>/provider.tsx` from the layout's `{children}`-enclosing JSX
 * chain. Only client components ("use client" target files) are kept; literal
 * attributes are copied; everything else is dropped with a TODO comment.
 * Refreshed by --force, so a change to the layout's provider chain reaches an
 * existing suite. The values you supply live in provider.fixtures.ts beside it,
 * which is never regenerated under any flag.
 */
export function ensureClientProviderWrapper(
  ctx: NextjsContext,
  outDir: string,
  layoutFile?: string,
  force = false,
): ProviderWrapperResult | undefined {
  const layout = layoutFile ?? ctx.appResolver;
  if (!layout || !existsSync(layout)) return undefined;

  const outPath = path.join(outDir, "provider.tsx");
  // provider.tsx is derived from the layout, so --force may refresh it when the
  // layout's provider chain changes. provider.fixtures.ts beside it is not
  // regenerated under any flag — see renderFixtures.
  if (existsSync(outPath) && !force) {
    return { path: outPath, created: false, included: [], dropped: [] };
  }

  const sf = ts.createSourceFile(
    layout,
    readFileSync(layout, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );

  const chain = childrenEnclosingChain(sf);
  const resolver = new ModuleResolver();
  const imports = collectImportLines(sf);

  const included: Array<{
    name: string;
    importLine: string;
    attrs: string;
    dropped: DroppedAttr[];
  }> = [];
  /** Providers in the chain that will NOT be mounted, in chain order. */
  const dropped: Array<{ name: string; specifier: string; reason: DropReason }> = [];

  for (const el of chain) {
    const tagName = el.tagText;
    if (!/^[A-Z]/.test(tagName)) continue; // html/body/div — skip intrinsics
    const root = tagName.split(".")[0] as string;
    const imp = imports.get(root);
    if (!imp) continue;
    // React's own coordination components sit in the same JSX chain as app
    // providers and own no app context: naming "Suspense — unresolved import"
    // above a real drop buries the one line the reader came for.
    if (REACT_OWN_COMPONENTS.test(imp.specifier)) continue;
    // The auth library IS the provider in the tutorial-shaped apps: a pages
    // `_app` wrapping its tree in `<SessionContextProvider>` from
    // @supabase/auth-helpers-react. Asking that specifier to resolve walks
    // node_modules and reports "not a client module", which is true of the
    // dist file and misses the point — the unit plane stubs this package
    // signed-out, so the accurate reason, and the one with a remedy, is auth.
    if (isAuthLibSpecifier(imp.specifier)) {
      dropped.push({ name: tagName, specifier: imp.specifier, reason: "auth" });
      continue;
    }
    const target = resolver.resolve(imp.specifier, layout);
    if (!target) {
      dropped.push({ name: tagName, specifier: imp.specifier, reason: "unresolved" });
      continue;
    }
    if (!fileStartsWithUseClient(target)) {
      dropped.push({ name: tagName, specifier: imp.specifier, reason: "server" });
      continue;
    }
    if (moduleImportsAuthLib(target)) {
      dropped.push({ name: tagName, specifier: imp.specifier, reason: "auth" });
      continue;
    }

    const { attrs, dropped: droppedAttrs } = literalAttrs(el.attributes, sf);
    included.push({ name: tagName, importLine: imp.line, attrs, dropped: droppedAttrs });
  }

  const holes = included.flatMap((i) =>
    i.dropped.filter((d) => d.name !== "...spread").map((d) => ({ owner: i.name, ...d })),
  );

  mkdirSync(outDir, { recursive: true });

  // The asymmetry is the whole design. provider.tsx is DERIVED from the layout,
  // so --force may refresh it. provider.fixtures.ts holds values a human typed
  // and nothing can reconstruct, so --force must not touch it.
  const fixturesPath = path.join(outDir, "provider.fixtures.ts");
  if (holes.length > 0 && !existsSync(fixturesPath)) {
    writeFileSync(fixturesPath, renderFixtures(layout, holes, imports));
  }

  writeFileSync(outPath, renderWrapper(layout, included, holes.length > 0, dropped));
  return {
    path: outPath,
    created: true,
    included: included.map((i) => i.name),
    dropped: dropped.map((d) => ({ name: d.name, reason: d.reason })),
  };
}

interface ChainElement {
  tagText: string;
  attributes: ts.JsxAttributes;
}

/**
 * The pages-router `_app` marker: the file renders the ROUTE element
 * (`<Component {...pageProps} />`) rather than `{children}`. Such a file cannot
 * be mounted as a provider at all — a spec passes `{children}`, so `Component`
 * is `undefined` and React fails with "Element type is invalid" before an
 * assertion runs, and the wrapper cannot supply `AppProps` either. Its provider
 * chain is still worth mounting, with the route element as the anchor.
 */
function routeElementAnchor(sf: ts.SourceFile): ts.Node | undefined {
  let found: ts.Node | undefined;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      ts.isIdentifier(n.tagName) &&
      n.tagName.text === "Component"
    ) {
      found = n;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

/** True when the file renders a route element and never `{children}`. */
function rendersRouteElement(sf: ts.SourceFile): boolean {
  let usesChildren = false;
  const walk = (n: ts.Node): void => {
    if (usesChildren) return;
    if (
      ts.isJsxExpression(n) &&
      n.expression &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "children"
    )
      usesChildren = true;
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return !usesChildren && routeElementAnchor(sf) !== undefined;
}

/**
 * The JSX elements that enclose the file's rendered content, outermost first.
 * `{children}` is the anchor for a layout or provider; a pages-router `_app`
 * has none, so its `<Component />` route element stands in.
 */
function childrenEnclosingChain(sf: ts.SourceFile): ChainElement[] {
  let anchor: ts.Node | undefined;
  const find = (n: ts.Node): void => {
    if (anchor) return;
    if (ts.isJsxExpression(n) && n.expression && ts.isIdentifier(n.expression)) {
      if (n.expression.text === "children") {
        anchor = n;
        return;
      }
    }
    ts.forEachChild(n, find);
  };
  find(sf);
  if (!anchor) anchor = routeElementAnchor(sf);
  if (!anchor) return [];

  const chain: ChainElement[] = [];
  let cur: ts.Node | undefined = anchor.parent;
  while (cur) {
    if (ts.isJsxElement(cur)) {
      const opening = cur.openingElement;
      chain.unshift({ tagText: opening.tagName.getText(sf), attributes: opening.attributes });
    }
    cur = cur.parent;
  }
  return chain;
}

function collectImportLines(sf: ts.SourceFile): Map<string, { specifier: string; line: string }> {
  const out = new Map<string, { specifier: string; line: string }>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) {
      out.set(clause.name.text, {
        specifier,
        line: `import ${clause.name.text} from "${specifier}";`,
      });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const orig = el.propertyName?.text;
        const spec = orig ? `${orig} as ${el.name.text}` : el.name.text;
        out.set(el.name.text, {
          specifier,
          line: `import { ${spec} } from "${specifier}";`,
        });
      }
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      out.set(clause.namedBindings.name.text, {
        specifier,
        line: `import * as ${clause.namedBindings.name.text} from "${specifier}";`,
      });
    }
  }
  return out;
}

function fileStartsWithUseClient(file: string): boolean {
  return readPrologueDirective(file) === "use client";
}

/**
 * True when the module directly imports a provider-bound auth library
 * (analyse/authShims.ts). The unit plane stubs those libraries globally with
 * a signed-out snapshot, and an app's auth-aggregate provider (Clerk/Convex
 * or next-auth SessionProvider chains) then turns the derived wrapper into an
 * auth wall: signed-out, its Authenticated/SignedIn gates render nothing, so
 * every wrapped spec mounts an empty tree and every child assertion fails —
 * while the stubs already satisfy the context reads auth-consuming components
 * actually make. Including such a provider buys the unit mount nothing and
 * wedges it (miro-clone: ConvexClientProvider constructs a ConvexReactClient
 * at module scope AND gates children behind auth).
 */
function moduleImportsAuthLib(file: string): boolean {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX,
    );
  } catch {
    return false;
  }
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (isAuthLibSpecifier(stmt.moduleSpecifier.text)) return true;
    }
    // `export { SessionProvider } from "next-auth/react"` binds just as well.
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      isAuthLibSpecifier(stmt.moduleSpecifier.text)
    ) {
      return true;
    }
  }
  return false;
}

/** A prop the layout passed that is not literal-composable, and its source text. */
export interface DroppedAttr {
  name: string;
  exprText: string;
  line: number;
}

function literalAttrs(
  attrs: ts.JsxAttributes,
  sf: ts.SourceFile,
): { attrs: string; dropped: DroppedAttr[] } {
  const kept: string[] = [];
  const dropped: DroppedAttr[] = [];
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  for (const a of attrs.properties) {
    if (ts.isJsxSpreadAttribute(a)) {
      dropped.push({
        name: "...spread",
        exprText: `{...${a.expression.getText(sf)}}`,
        line: lineOf(a),
      });
      continue;
    }
    if (!ts.isJsxAttribute(a) || !ts.isIdentifier(a.name)) continue;
    const name = a.name.text;
    const init = a.initializer;
    if (!init) {
      kept.push(name);
      continue;
    }
    if (ts.isStringLiteral(init)) {
      kept.push(`${name}=${JSON.stringify(init.text)}`);
      continue;
    }
    if (ts.isJsxExpression(init) && init.expression) {
      const e = init.expression;
      if (ts.isStringLiteral(e)) {
        kept.push(`${name}=${JSON.stringify(e.text)}`);
        continue;
      }
      if (ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword) {
        kept.push(`${name}={${e.getText(sf)}}`);
        continue;
      }
    }
    dropped.push({ name, exprText: init ? init.getText(sf) : name, line: lineOf(a) });
  }
  return { attrs: kept.length > 0 ? ` ${kept.join(" ")}` : "", dropped };
}

function renderWrapper(
  layoutFile: string,
  included: Array<{ name: string; importLine: string; attrs: string; dropped: DroppedAttr[] }>,
  hasFixtures: boolean,
  droppedLayers: Array<{ name: string; specifier: string; reason: DropReason }> = [],
): string {
  const importLines = [...new Set(included.map((i) => i.importLine))].join("\n");
  const layoutRel = path.basename(layoutFile);

  let open = "";
  let close = "";
  const todos: string[] = [];
  for (const [idx, el] of included.entries()) {
    const indent = `      ${"  ".repeat(idx)}`;
    // A non-literal prop becomes a typed hole in provider.fixtures.ts rather
    // than a comment: an editor red-squiggle naming the exact shape to supply is
    // worth more than a TODO nobody sees.
    const fixtureAttrs = el.dropped
      .filter((d) => d.name !== "...spread")
      .map((d) => ` ${d.name}={providerFixtures.${d.name}}`)
      .join("");
    for (const d of el.dropped.filter((x) => x.name === "...spread")) {
      todos.push(
        `${indent}{/* TODO(flawless): layout spread ${commentSafe(d.exprText)} into <${el.name}> — not reconstructable */}`,
      );
    }
    open += `${indent}<${el.name}${el.attrs}${fixtureAttrs}>\n`;
    close = `${indent}</${el.name}>\n${close}`;
  }
  const inner = `      ${"  ".repeat(included.length)}{children}`;

  const tree =
    included.length > 0
      ? `${todos.length > 0 ? `${todos.join("\n")}\n` : ""}${open}${inner}\n${close}`.replace(
          /\n$/,
          "",
        )
      : "      <>{children}</>";

  // A dropped layer is the loudest thing in this file and was silent: an empty
  // wrapper whose specs all fail on "could not find X in the context" reads as a
  // broken component, not as a provider chain the generator declined to mount.
  // Name each one, why, and where the fix goes (here is not a durable place).
  const droppedNote =
    droppedLayers.length === 0
      ? ""
      : `\n// DROPPED from ${layoutRel}'s provider chain — specs mount WITHOUT these:\n${droppedLayers
          .map(
            (d) =>
              `//   ${d.name}, from ${commentSafe(d.specifier)}, ${DROP_REASONS[d.reason].long}.`,
          )
          .join(
            "\n",
          )}\n// A spec that needs one of these contexts wants its own --provider: this file is\n// derived from the layout and regenerated by --force, so editing it here does not stick.\n`;

  return `"use client";
// flawless-react provider wrapper — auto-derived from ${layoutRel}, which cannot
// be mounted as it stands: an async or server-only module, the <html> document
// shell, or a pages \`_app\` that renders the route element instead of
// {children}. REGENERATED by --force: put values you want to keep in
// provider.fixtures.ts, which is never rewritten.${droppedNote}
import type { ReactNode } from "react";
${importLines}${hasFixtures ? '\nimport { providerFixtures } from "./provider.fixtures";' : ""}

export default function FlawlessProvider({ children }: { children: ReactNode }) {
  return (
    <>
${tree}
    </>
  );
}
`;
}

/**
 * Typed holes for the props the layout passed that could not be copied.
 *
 * Typing each against `ComponentProps<typeof Provider>[prop]` costs nothing —
 * the import line was already captured — and turns "fill this in" into a red
 * squiggle naming the exact shape. The alternative considered was synthesising a
 * plausible session object; that is precisely the guessing this project refuses,
 * and a wrong-shaped fixture is worse than an empty one because the specs go
 * green against a fiction.
 */
/**
 * Quoted source is illustrative only, but it sits inside a comment — and a
 * star-slash pair in it (globs: "**" + "/*") would terminate that comment and
 * break the emitted file. A zero-width space between the two keeps the text
 * readable while making the pair inert. Applies to both comment forms: the
 * fixtures' doc comments and the wrapper's JSX spread TODOs.
 */
function commentSafe(text: string): string {
  return text.replaceAll("*/", "*\u200b/");
}

/** Source text on one line and comment-inert, so it can sit inside a doc comment. */
function flatten(text: string): string {
  const one = text
    .replace(/^\{|\}$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return commentSafe(one.length > 90 ? `${one.slice(0, 87)}…` : one);
}

function renderFixtures(
  layoutFile: string,
  holes: Array<{ owner: string; name: string; exprText: string; line: number }>,
  imports: Map<string, { specifier: string; line: string }>,
): string {
  const layoutRel = path.basename(layoutFile);
  const importLines = [
    ...new Set(
      holes
        .map((h) => imports.get(h.owner.split(".")[0] as string)?.line)
        .filter((l): l is string => l !== undefined),
    ),
  ].join("\n");

  const entries = holes
    .map(
      (h) =>
        `  /** ${layoutRel}:${h.line} passed ${h.name}={${flatten(h.exprText)}} to <${h.owner}>. */\n` +
        `  ${h.name}: {} as ComponentProps<typeof ${h.owner.split(".")[0]}>[${JSON.stringify(h.name)}],`,
    )
    .join("\n\n");

  return `// Fixtures for the props flawless-react could not copy out of ${layoutRel},
// because they are computed rather than literal.
//
// Owned by you: flawless-react writes this file once and never again — not even
// with --force. provider.tsx beside it IS regenerated, so keep values here.
import type { ComponentProps } from "react";
${importLines}

export const providerFixtures = {
${entries}
};
`;
}
