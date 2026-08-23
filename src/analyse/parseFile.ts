import path from "node:path";
import ts from "typescript";
import type { ModuleImportInfo, SourcePosition } from "../types.ts";
import { posOf } from "./pos.ts";

export type ImportBindingKind = "default" | "named" | "namespace";

export interface ImportBinding {
  /** Module specifier as written: "./Card.tsx", "@/components/ui", "react". */
  specifier: string;
  kind: ImportBindingKind;
  /** For `import { X as Y }`: the exported name "X" (local name is the map key). */
  importedName?: string;
  isTypeOnly: boolean;
  pos: SourcePosition;
}

export interface ParsedComponentUnit {
  componentName: string;
  /** The arrow/function node whose body holds the JSX + hooks. */
  bodyNode: ts.Node;
  /**
   * Raw first-param type (or FC type argument) exactly as written — an
   * intersection, a qualified reference, anything. `propsTypeRef` /
   * `propsTypeLiteral` keep their narrow meanings for existing callers; this
   * is what the type resolver dispatches on.
   */
  propsTypeNode: ts.TypeNode | undefined;
  /** Props type reference (`React.FC<Props>` arg or first-param type). */
  propsTypeRef: ts.TypeReferenceNode | undefined;
  /** Inline first-param object type: `({a}: {a: string})`. */
  propsTypeLiteral: ts.TypeLiteralNode | undefined;
  /** First param when it is a plain identifier ("props"). */
  paramName: string | undefined;
  /** Local names bound by a destructured first param. */
  destructuredProps: string[];
  /** local → original prop name for `{a: b}` destructuring aliases. */
  destructuredAliases: Map<string, string>;
  exportKind: "default" | "named" | "none";
  isAsync: boolean;
  wrappers: Array<"memo" | "forwardRef">;
  pos: SourcePosition;
}

export interface ParsedFile {
  sourceFile: ts.SourceFile;
  filePath: string;
  isClientComponent: boolean;
  /** Local-name → import binding, for JSX child + props-type resolution. */
  imports: Map<string, ImportBinding>;
  /** All detected components, primary first. */
  components: ParsedComponentUnit[];
  /** Top-level imports classified for scaffolding (vi.mock candidates etc.). */
  moduleImports: ModuleImportInfo[];
}

export async function parseFile(entry: string): Promise<ParsedFile> {
  const src = await Bun.file(entry).text();
  const sourceFile = ts.createSourceFile(
    entry,
    src,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );

  const imports = collectImports(sourceFile);
  const components = findComponents(sourceFile);
  if (components.length === 0) {
    throw new Error(
      `parseFile: could not locate a React component in ${entry}. ` +
        `Expected an exported function/arrow component or a \`const Name: React.FC<...> = ...\` declaration.`,
    );
  }
  orderPrimaryFirst(components, entry);

  return {
    sourceFile,
    filePath: entry,
    isClientComponent: hasUseClientDirective(sourceFile),
    imports,
    components,
    moduleImports: collectModuleImports(sourceFile, imports),
  };
}

function hasUseClientDirective(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt) || !ts.isStringLiteral(stmt.expression)) break;
    if (stmt.expression.text === "use client") return true;
  }
  return false;
}

function collectImports(sf: ts.SourceFile): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) continue;
    const declTypeOnly = clause.isTypeOnly;
    const pos = posOf(stmt, sf);
    if (clause.name) {
      out.set(clause.name.text, { specifier, kind: "default", isTypeOnly: declTypeOnly, pos });
    }
    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          out.set(el.name.text, {
            specifier,
            kind: "named",
            importedName: el.propertyName?.text ?? el.name.text,
            isTypeOnly: declTypeOnly || el.isTypeOnly,
            pos,
          });
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        out.set(clause.namedBindings.name.text, {
          specifier,
          kind: "namespace",
          isTypeOnly: declTypeOnly,
          pos,
        });
      }
    }
  }
  return out;
}

function collectModuleImports(
  sf: ts.SourceFile,
  imports: Map<string, ImportBinding>,
): ModuleImportInfo[] {
  // Which local names appear as JSX tag roots anywhere in the file?
  const jsxRoots = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName;
      if (ts.isIdentifier(tag)) jsxRoots.add(tag.text);
      else if (ts.isPropertyAccessExpression(tag)) {
        let root: ts.Expression = tag.expression;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        if (ts.isIdentifier(root)) jsxRoots.add(root.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);

  const out: ModuleImportInfo[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) {
      // Side-effect import ("./globals.css").
      out.push({
        specifier,
        names: [],
        kind: "value",
        isTypeOnly: false,
        hasDefault: false,
        pos: posOf(stmt, sf),
      });
      continue;
    }
    const names: string[] = [];
    let hasDefault = false;
    if (clause.name) {
      names.push(clause.name.text);
      hasDefault = true;
    }
    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) names.push(el.name.text);
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        names.push(clause.namedBindings.name.text);
      }
    }
    const isTypeOnly =
      clause.isTypeOnly ||
      (names.length > 0 && names.every((n) => imports.get(n)?.isTypeOnly === true));
    out.push({
      specifier,
      names,
      kind: names.some((n) => jsxRoots.has(n)) ? "component" : "value",
      isTypeOnly,
      hasDefault,
      pos: posOf(stmt, sf),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Component detection
// ---------------------------------------------------------------------------

function findComponents(sf: ts.SourceFile): ParsedComponentUnit[] {
  const units: ParsedComponentUnit[] = [];
  const byName = new Map<string, ParsedComponentUnit>();
  const renderHooks = renderHookNames(sf);

  const add = (unit: ParsedComponentUnit): void => {
    units.push(unit);
    byName.set(unit.componentName, unit);
  };

  // Pass 1 — candidates from function declarations and variable statements.
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && /^[A-Z]/.test(stmt.name.text)) {
      if (!stmt.body || !looksLikeComponentBody(stmt, renderHooks)) continue;
      const mods = stmt.modifiers ?? [];
      const hasExport = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const hasDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      add({
        componentName: stmt.name.text,
        bodyNode: stmt,
        ...propsFromParams(stmt),
        exportKind: hasDefault ? "default" : hasExport ? "named" : "none",
        isAsync: mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
        wrappers: [],
        pos: posOf(stmt, sf),
      });
      continue;
    }

    if (ts.isVariableStatement(stmt)) {
      const hasExport = (stmt.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !/^[A-Z]/.test(decl.name.text)) continue;
        if (!decl.initializer) continue;
        const unit = unitFromInitializer(decl.name.text, decl, decl.initializer, sf, byName, renderHooks);
        if (!unit) continue;
        unit.exportKind = hasExport ? "named" : "none";
        add(unit);
      }
    }
  }

  // Pass 2 — export fixups.
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const expr = stmt.expression;
      if (ts.isIdentifier(expr)) {
        const unit = byName.get(expr.text);
        if (unit) unit.exportKind = "default";
        continue;
      }
      const unwrapped = unwrapWrappers(expr);
      if (unwrapped.inner && ts.isIdentifier(unwrapped.inner)) {
        const unit = byName.get(unwrapped.inner.text);
        if (unit) {
          unit.exportKind = "default";
          unit.wrappers = [...unwrapped.wrappers, ...unit.wrappers];
        }
        continue;
      }
      const fn = unwrapped.inner ?? expr;
      if (
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
        looksLikeComponentBody(fn, renderHooks)
      ) {
        const name = componentNameFromFilename(sf.fileName);
        add({
          componentName: name,
          bodyNode: fn,
          ...propsFromParams(fn),
          exportKind: "default",
          isAsync: (fn.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
          wrappers: unwrapped.wrappers,
          pos: posOf(stmt, sf),
        });
      }
      continue;
    }

    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const localName = el.propertyName?.text ?? el.name.text;
        const unit = byName.get(localName);
        if (!unit) continue;
        if (el.name.text === "default") unit.exportKind = "default";
        else if (unit.exportKind === "none") unit.exportKind = "named";
      }
    }
  }

  return units;
}

function unitFromInitializer(
  name: string,
  decl: ts.VariableDeclaration,
  init: ts.Expression,
  sf: ts.SourceFile,
  byName: Map<string, ParsedComponentUnit>,
  renderHooks: Set<string>,
): ParsedComponentUnit | undefined {
  // const X: React.FC<Props> = arrow | fnexpr
  const typeRef = decl.type && ts.isTypeReferenceNode(decl.type) ? decl.type : undefined;
  const looksLikeFC =
    typeRef &&
    ((ts.isQualifiedName(typeRef.typeName) &&
      ts.isIdentifier(typeRef.typeName.right) &&
      (typeRef.typeName.right.text === "FC" ||
        typeRef.typeName.right.text === "FunctionComponent")) ||
      (ts.isIdentifier(typeRef.typeName) &&
        (typeRef.typeName.text === "FC" || typeRef.typeName.text === "FunctionComponent")));

  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    if (!looksLikeFC && !looksLikeComponentBody(init, renderHooks)) return undefined;
    const fcPropsArg = looksLikeFC ? typeRef?.typeArguments?.[0] : undefined;
    const fromParams = propsFromParams(init);
    const propsTypeRef =
      fcPropsArg && ts.isTypeReferenceNode(fcPropsArg) ? fcPropsArg : fromParams.propsTypeRef;
    const propsTypeLiteral =
      fcPropsArg && ts.isTypeLiteralNode(fcPropsArg) ? fcPropsArg : fromParams.propsTypeLiteral;
    // `React.FC<Props>` states the props type more precisely than the
    // destructured parameter, so it wins when both are present.
    const propsTypeNode = fcPropsArg ?? fromParams.propsTypeNode;
    return {
      componentName: name,
      bodyNode: init,
      propsTypeNode,
      propsTypeRef,
      propsTypeLiteral,
      paramName: fromParams.paramName,
      destructuredProps: fromParams.destructuredProps,
      destructuredAliases: fromParams.destructuredAliases,
      exportKind: "none",
      isAsync: (init.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      wrappers: [],
      pos: posOf(decl, sf),
    };
  }

  // const X = memo(...) / forwardRef(...) — possibly nested.
  const unwrapped = unwrapWrappers(init);
  if (unwrapped.wrappers.length === 0 || !unwrapped.inner) return undefined;
  const inner = unwrapped.inner;
  if (ts.isIdentifier(inner)) {
    const target = byName.get(inner.text);
    if (target) {
      target.wrappers = [...unwrapped.wrappers, ...target.wrappers];
    }
    return undefined;
  }
  if (
    (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) &&
    looksLikeComponentBody(inner, renderHooks)
  ) {
    return {
      componentName: name,
      bodyNode: inner,
      ...propsFromParams(inner),
      exportKind: "none",
      isAsync: (inner.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      wrappers: unwrapped.wrappers,
      pos: posOf(decl, sf),
    };
  }
  return undefined;
}

/** Peel memo()/forwardRef() (bare or React.-qualified), outermost-first. */
function unwrapWrappers(expr: ts.Expression): {
  wrappers: Array<"memo" | "forwardRef">;
  inner: ts.Expression | undefined;
} {
  const wrappers: Array<"memo" | "forwardRef"> = [];
  let current: ts.Expression = expr;
  for (;;) {
    if (!ts.isCallExpression(current)) break;
    const callee = current.expression;
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
        ? callee.name.text
        : undefined;
    if (calleeName !== "memo" && calleeName !== "forwardRef") break;
    wrappers.push(calleeName);
    const arg = current.arguments[0];
    if (!arg) return { wrappers, inner: undefined };
    current = arg;
  }
  return { wrappers, inner: wrappers.length > 0 ? current : undefined };
}

function propsFromParams(fn: { parameters: ts.NodeArray<ts.ParameterDeclaration> }): {
  propsTypeNode: ts.TypeNode | undefined;
  propsTypeRef: ts.TypeReferenceNode | undefined;
  propsTypeLiteral: ts.TypeLiteralNode | undefined;
  paramName: string | undefined;
  destructuredProps: string[];
  destructuredAliases: Map<string, string>;
} {
  const first = fn.parameters[0];
  const empty = {
    propsTypeNode: undefined,
    propsTypeRef: undefined,
    propsTypeLiteral: undefined,
    paramName: undefined,
    destructuredProps: [] as string[],
    destructuredAliases: new Map<string, string>(),
  };
  if (!first) return empty;

  const propsTypeRef = first.type && ts.isTypeReferenceNode(first.type) ? first.type : undefined;
  const propsTypeLiteral = first.type && ts.isTypeLiteralNode(first.type) ? first.type : undefined;

  let paramName: string | undefined;
  const destructuredProps: string[] = [];
  const destructuredAliases = new Map<string, string>();
  if (ts.isIdentifier(first.name)) {
    paramName = first.name.text;
  } else if (ts.isObjectBindingPattern(first.name)) {
    for (const el of first.name.elements) {
      if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
      destructuredProps.push(el.name.text);
      if (el.propertyName && ts.isIdentifier(el.propertyName)) {
        destructuredAliases.set(el.name.text, el.propertyName.text);
      }
    }
  }
  return {
    propsTypeNode: first.type,
    propsTypeRef,
    propsTypeLiteral,
    paramName,
    destructuredProps,
    destructuredAliases,
  };
}

/**
 * A body renders even without JSX in two decidable shapes: every one of its
 * OWN returns is the `null` literal (an effect-only component — it renders
 * nothing by construction), or a return is a call to a render hook like
 * base-ui's useRender, where the element comes out of the hook. Both triggers
 * are syntactic; anything less certain still requires JSX.
 */
function looksLikeComponentBody(
  fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  renderHooks: Set<string>,
): boolean {
  if (containsJsx(fn)) return true;

  const isRenderHookCall = (e: ts.Expression | undefined): boolean =>
    e !== undefined &&
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    renderHooks.has(e.expression.text);

  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    return isRenderHookCall(fn.body) || fn.body.kind === ts.SyntaxKind.NullKeyword;
  }
  if (!fn.body || !ts.isBlock(fn.body)) return false;

  const returns = ownReturns(fn.body);
  if (returns.length === 0) return false;
  if (returns.every((r) => r.expression?.kind === ts.SyntaxKind.NullKeyword)) return true;
  return returns.some((r) => isRenderHookCall(r.expression));
}

/** The block's own return statements — a nested function's returns are its own. */
function ownReturns(body: ts.Block): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n)
    ) {
      return;
    }
    if (ts.isReturnStatement(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/**
 * Local names bound to render hooks: an import named useRender, or anything
 * imported from a module specifier ending in /use-render.
 */
function renderHookNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const fromUseRenderModule = /\/use-render$/.test(stmt.moduleSpecifier.text);
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (imported === "useRender" || fromUseRenderModule) names.add(el.name.text);
    }
  }
  return names;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export function componentNameFromFilename(fileName: string): string {
  let base = path.basename(fileName).replace(/\.(tsx|ts|jsx|js)$/, "");
  if (base === "index") base = path.basename(path.dirname(fileName));
  return base
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join("");
}

/** Primary = default export → PascalCase(filename) match → first exported → first. */
function orderPrimaryFirst(units: ParsedComponentUnit[], filePath: string): void {
  const pick =
    units.find((u) => u.exportKind === "default") ??
    units.find(
      (u) => u.exportKind !== "none" && u.componentName === componentNameFromFilename(filePath),
    ) ??
    units.find((u) => u.exportKind !== "none") ??
    units[0];
  if (!pick) return;
  const idx = units.indexOf(pick);
  if (idx > 0) {
    units.splice(idx, 1);
    units.unshift(pick);
  }
}
