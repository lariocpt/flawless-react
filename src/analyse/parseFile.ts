import path from "node:path";
import ts from "typescript";
import type { ModuleImportInfo, SourcePosition } from "../types.ts";
import { ownReturns } from "./ownReturns.ts";
import { posOf } from "./pos.ts";
import type { SourceFileCache } from "./sourceCache.ts";

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

/**
 * With a `cache`, the parsed SourceFile comes from it (same parse settings) —
 * a leaf shared by many entries in a sweep is then parsed once, not once per
 * entry. Component detection still runs per call: its results are mutated by
 * export fixups and would go stale if shared.
 */
export async function parseFile(entry: string, cache?: SourceFileCache): Promise<ParsedFile> {
  const sourceFile = cache
    ? cache.get(entry)
    : ts.createSourceFile(
        entry,
        await Bun.file(entry).text(),
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TSX,
      );
  if (!sourceFile) {
    throw new Error(`parseFile: could not read ${entry}.`);
  }

  // A file TypeScript could not parse cleanly is a file whose AST is a GUESS.
  //
  // ts.createSourceFile is error-tolerant by design: `return <div>` with no
  // closing tag still yields a tree, and every extractor downstream reads it as
  // if it were the source. Before this check, that file was analysed, described,
  // and reported as `ok: true, 0 findings` — a clean run over something that
  // does not compile. That is the silent-pass class this project scores itself
  // on removing, and it was hiding in plain sight: `parseDiagnostics` is asserted
  // in FIVE test files, every one of them on the tool's own OUTPUT, and nowhere
  // on its input.
  //
  // Throwing routes it into the caller's existing unparseable channel (core.ts),
  // which warns and records the file in REPORT.md's accounting — so it is
  // reported rather than silently dropped, exactly as an unreadable file is.
  //
  // Measured before shipping: 111 fixture files and 241 real component files
  // across both dogfood apps produce ZERO diagnostics, so this fires only on
  // genuinely broken input.
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    const first = diagnostics[0] as ts.Diagnostic;
    const where =
      first.start === undefined
        ? ""
        : ` at line ${sourceFile.getLineAndCharacterOfPosition(first.start).line + 1}`;
    throw new Error(
      `parseFile: ${entry} has ${diagnostics.length} syntax error(s) and cannot be analysed ` +
        `honestly — the first is "${ts.flattenDiagnosticMessageText(first.messageText, " ")}"${where}. ` +
        `Fix the file, or exclude it with --exclude.`,
    );
  }

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

export function collectImports(sf: ts.SourceFile): Map<string, ImportBinding> {
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
    // Aligned with `names`; consumers key decisions (like the pure-utility mock
    // exemption) on the module-side name, which aliasing hides from `names`.
    const importedNames: string[] = [];
    let hasDefault = false;
    if (clause.name) {
      names.push(clause.name.text);
      importedNames.push(clause.name.text);
      hasDefault = true;
    }
    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          names.push(el.name.text);
          importedNames.push((el.propertyName ?? el.name).text);
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        names.push(clause.namedBindings.name.text);
        importedNames.push(clause.namedBindings.name.text);
      }
    }
    const isTypeOnly =
      clause.isTypeOnly ||
      (names.length > 0 && names.every((n) => imports.get(n)?.isTypeOnly === true));
    out.push({
      specifier,
      names,
      importedNames,
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
      // No name passed: the SCREAMING_CASE guard exists for value constants
      // (`const NOOP = () => null`), and a function DECLARATION is not a value
      // constant — `function SEO() { …; return null; }` is the canonical
      // effect-only head-manager component and must stay detected.
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

    if (ts.isClassDeclaration(stmt) && stmt.name) {
      const unit = classComponentUnit(stmt, sf);
      if (unit) {
        add(unit);
        continue;
      }
    }

    if (ts.isVariableStatement(stmt)) {
      const hasExport = (stmt.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !/^[A-Z]/.test(decl.name.text)) continue;
        if (!decl.initializer) continue;
        const unit = unitFromInitializer(
          decl.name.text,
          decl,
          decl.initializer,
          sf,
          byName,
          renderHooks,
        );
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
  renderHooks: RenderHookImports,
): ParsedComponentUnit | undefined {
  // `(arrow) satisfies FC<Props>` / `as FC<Props>` states the props type just
  // like a declared `const X: FC<Props>` does — the cast wrappers cannot change
  // what the initializer evaluates to, so they are peeled before dispatch and
  // their FC type argument feeds the same props-type path.
  let castFcRef: ts.TypeReferenceNode | undefined;
  for (let e: ts.Expression = init; ; ) {
    if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
      castFcRef ??= fcTypeRef(e.type);
      e = e.expression;
    } else if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
    } else {
      break;
    }
  }
  const peeled = unwrapTrivialExpression(init);

  // const X: React.FC<Props> = arrow | fnexpr — the declared type wins over a cast.
  const fcRef = fcTypeRef(decl.type) ?? castFcRef;
  const looksLikeFC = fcRef !== undefined;

  if (ts.isArrowFunction(peeled) || ts.isFunctionExpression(peeled)) {
    if (!looksLikeFC && !looksLikeComponentBody(peeled, renderHooks, name)) return undefined;
    const fcPropsArg = fcRef?.typeArguments?.[0];
    const fromParams = propsFromParams(peeled);
    const propsTypeRef =
      fcPropsArg && ts.isTypeReferenceNode(fcPropsArg) ? fcPropsArg : fromParams.propsTypeRef;
    const propsTypeLiteral =
      fcPropsArg && ts.isTypeLiteralNode(fcPropsArg) ? fcPropsArg : fromParams.propsTypeLiteral;
    // `React.FC<Props>` states the props type more precisely than the
    // destructured parameter, so it wins when both are present.
    const propsTypeNode = fcPropsArg ?? fromParams.propsTypeNode;
    return {
      componentName: name,
      bodyNode: peeled,
      propsTypeNode,
      propsTypeRef,
      propsTypeLiteral,
      paramName: fromParams.paramName,
      destructuredProps: fromParams.destructuredProps,
      destructuredAliases: fromParams.destructuredAliases,
      exportKind: "none",
      isAsync: (peeled.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword),
      wrappers: [],
      pos: posOf(decl, sf),
    };
  }

  // const X = memo(...) / forwardRef(...) — possibly nested.
  const unwrapped = unwrapWrappers(peeled);
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
    (looksLikeFC || looksLikeComponentBody(inner, renderHooks, name))
  ) {
    // The props type, most-specific first: a declared `const X: FC<Props>`
    // (or cast), then the wrapper's own generics (memo<P> / forwardRef<E, P>),
    // then whatever the inner function's first parameter says. The wrapper
    // sources were silently dropped before (FR-011) — an empty shape with
    // empty unresolved records, invisible in every report.
    const fromParams = propsFromParams(inner);
    const declared = fcRef?.typeArguments?.[0] ?? unwrapped.propsTypeArg;
    const propsTypeRef =
      declared && ts.isTypeReferenceNode(declared) ? declared : fromParams.propsTypeRef;
    const propsTypeLiteral =
      declared && ts.isTypeLiteralNode(declared) ? declared : fromParams.propsTypeLiteral;
    return {
      componentName: name,
      bodyNode: inner,
      ...fromParams,
      propsTypeNode: declared ?? fromParams.propsTypeNode,
      propsTypeRef,
      propsTypeLiteral,
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
  /**
   * The props type the wrapper calls declare — memo<P>'s first argument,
   * forwardRef<E, P>'s second. Innermost wins: it sits closest to the
   * function whose props it types. Dropping these was FR-011 — a
   * forwardRef<E, Props> component extracted an empty shape with nothing
   * even recorded as unresolved.
   */
  propsTypeArg: ts.TypeNode | undefined;
} {
  const wrappers: Array<"memo" | "forwardRef"> = [];
  let propsTypeArg: ts.TypeNode | undefined;
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
    const arg = calleeName === "memo" ? current.typeArguments?.[0] : current.typeArguments?.[1];
    if (arg) propsTypeArg = arg;
    const first = current.arguments[0];
    if (!first) return { wrappers, inner: undefined, propsTypeArg };
    current = first;
  }
  return { wrappers, inner: wrappers.length > 0 ? current : undefined, propsTypeArg };
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
 * Peels wrappers that cannot change what an expression evaluates to:
 * parentheses, `as` / `satisfies` casts, and non-null assertions. Exported for
 * other detectors that must not be fooled by `(null)` or `x satisfies T`.
 */
export function unwrapTrivialExpression(e: ts.Expression): ts.Expression {
  let current = e;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

/**
 * `t` as an FC/FunctionComponent type reference (bare or React.-qualified),
 * undefined for anything else. One test for the declared-type and cast forms,
 * so they cannot drift apart.
 */
function fcTypeRef(t: ts.TypeNode | undefined): ts.TypeReferenceNode | undefined {
  if (!t || !ts.isTypeReferenceNode(t)) return undefined;
  const n = t.typeName;
  const name = ts.isQualifiedName(n)
    ? ts.isIdentifier(n.right)
      ? n.right.text
      : undefined
    : n.text;
  return name === "FC" || name === "FunctionComponent" ? t : undefined;
}

/**
 * A body renders even without JSX in two decidable shapes: every one of its
 * OWN returns is the `null` literal (an effect-only component — it renders
 * nothing by construction), or a return is a call to a render hook like
 * base-ui's useRender, where the element comes out of the hook. Both triggers
 * are syntactic; anything less certain still requires JSX. A SCREAMING_CASE
 * name marks a value constant (`const NOOP = () => null`), so under such a
 * name the null-only trigger stands down — JSX and render hooks still count.
 */
function looksLikeComponentBody(
  fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  renderHooks: RenderHookImports,
  componentName?: string,
): boolean {
  if (containsJsx(fn)) return true;

  const screamingCase = componentName !== undefined && /^[A-Z][A-Z0-9_]+$/.test(componentName);

  const isRenderHookCall = (e: ts.Expression): boolean => {
    if (!ts.isCallExpression(e)) return false;
    const callee = e.expression;
    if (ts.isIdentifier(callee)) return renderHooks.names.has(callee.text);
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      renderHooks.namespaces.has(callee.expression.text) &&
      callee.name.text === "useRender"
    );
  };

  // A ternary renders through the hook when ANY branch is a hook call — the
  // other branch (typically null) renders nothing, which is fine.
  const returnsRenderHook = (e: ts.Expression | undefined): boolean => {
    if (e === undefined) return false;
    const inner = unwrapTrivialExpression(e);
    if (isRenderHookCall(inner)) return true;
    return (
      ts.isConditionalExpression(inner) &&
      (returnsRenderHook(inner.whenTrue) || returnsRenderHook(inner.whenFalse))
    );
  };

  const isNullLiteral = (e: ts.Expression | undefined): boolean =>
    e !== undefined && unwrapTrivialExpression(e).kind === ts.SyntaxKind.NullKeyword;

  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
    return returnsRenderHook(fn.body) || (!screamingCase && isNullLiteral(fn.body));
  }
  if (!fn.body || !ts.isBlock(fn.body)) return false;

  const returns = ownReturns(fn.body);
  if (returns.length === 0) return false;
  if (!screamingCase && returns.every((r) => isNullLiteral(r.expression))) return true;
  return returns.some((r) => returnsRenderHook(r.expression));
}

interface RenderHookImports {
  /** Locals that ARE a render hook: `useRender(...)` called bare. */
  names: Set<string>;
  /** Namespace/default locals of use-render modules: `NS.useRender(...)`. */
  namespaces: Set<string>;
}

/**
 * Local names bound to render hooks: an import named useRender, or anything
 * imported from a module specifier ending in /use-render. Namespace and
 * default imports of such modules live in a separate set and match only the
 * `NS.useRender(...)` property-access form — a default import CALLED as a bare
 * identifier is not detected (no such module shape has been seen in the wild;
 * detection stays syntactic rather than guessing).
 */
function renderHookNames(sf: ts.SourceFile): RenderHookImports {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    const fromUseRenderModule = /\/use-render$/.test(stmt.moduleSpecifier.text);
    if (clause.name && fromUseRenderModule) namespaces.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (imported === "useRender" || fromUseRenderModule) names.add(el.name.text);
      }
    } else if (ts.isNamespaceImport(bindings) && fromUseRenderModule) {
      namespaces.add(bindings.name.text);
    }
  }
  return { names, namespaces };
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

/**
 * A React CLASS component, or undefined.
 *
 * findComponents handled function declarations and variable statements only, so
 * `class X extends React.Component` was skipped and parseFile threw "could not
 * locate a React component" — caught by core.ts as a silent warning and exit 0.
 * sourceCache has counted an exported class as an export since it was written,
 * so the two layers disagreed about the same file.
 *
 * Detected from EVIDENCE, not a name: it must extend Component or PureComponent
 * (bare, or through a namespace as `React.Component`) AND its render() must
 * contain JSX. A class that extends something else is not a React component, and
 * this refuses to guess that it might be.
 */
function classComponentUnit(
  stmt: ts.ClassDeclaration,
  sf: ts.SourceFile,
): ParsedComponentUnit | undefined {
  if (!stmt.name) return undefined;
  const base = (stmt.heritageClauses ?? [])
    .filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
    .flatMap((h) => h.types)[0];
  if (!base) return undefined;
  const baseName = ts.isIdentifier(base.expression)
    ? base.expression.text
    : ts.isPropertyAccessExpression(base.expression) && ts.isIdentifier(base.expression.name)
      ? base.expression.name.text
      : undefined;
  if (baseName !== "Component" && baseName !== "PureComponent") return undefined;

  const render = stmt.members.find(
    (m): m is ts.MethodDeclaration =>
      ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === "render",
  );
  if (!render?.body || !containsJsx(render)) return undefined;

  const mods = ts.getModifiers(stmt) ?? [];
  // `class X extends Component<Props, State>` — the props type is the FIRST type
  // argument, which is the class analogue of a function's first parameter.
  const propsArg = base.typeArguments?.[0];
  return {
    componentName: stmt.name.text,
    // render(), not the class: it is where the JSX is, and every downstream
    // extractor walks bodyNode looking for exactly that.
    bodyNode: render,
    propsTypeNode: propsArg,
    propsTypeRef: propsArg && ts.isTypeReferenceNode(propsArg) ? propsArg : undefined,
    propsTypeLiteral: propsArg && ts.isTypeLiteralNode(propsArg) ? propsArg : undefined,
    // A class reads `this.props.x`. There is no parameter to name and nothing is
    // destructured, and saying otherwise would have the prop extractors look for
    // bindings that are not there.
    paramName: undefined,
    destructuredProps: [],
    destructuredAliases: new Map<string, string>(),
    exportKind: mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
      ? "default"
      : mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ? "named"
        : "none",
    isAsync: false,
    wrappers: [],
    pos: posOf(stmt, sf),
  };
}
