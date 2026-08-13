import ts from "typescript";
import type { StateInfo } from "../types.ts";
import type { ExtractedProps } from "./extractProps.ts";
import type { ParsedComponentUnit } from "./parseFile.ts";

/**
 * Shared identifier-reference machinery for the usage/state/hook extractors.
 * Purely syntactic: no symbol table, no type checker. Known accepted limit:
 * shadowing inside nested closures is not tracked (declaration names are
 * excluded, but later reads of a shadow are misattributed to the outer name).
 */

export interface ComponentScope {
  /** Prop names as declared on the props type (shape keys ∪ unresolved). */
  propNames: Set<string>;
  /** local name → original prop name (destructuring aliases, body `const {a} = props`). */
  propAliases: Map<string, string>;
  /** First param identifier when the component takes a bare props object. */
  paramName: string | undefined;
  stateVars: Set<string>;
  setterNames: Set<string>;
  refNames: Set<string>;
  /** `const x = useMemo(...)` / `useCallback(...)` result names. */
  memoResultNames: Set<string>;
  /** Other top-level body bindings: name → whether the value is function-like. */
  derivedNames: Map<string, { isFunctionValued: boolean }>;
}

export function buildComponentScope(
  unit: ParsedComponentUnit,
  props: ExtractedProps,
  state: StateInfo[],
  bodyNode: ts.Node,
): ComponentScope {
  const propNames = new Set<string>([...Object.keys(props.propsShape), ...props.unresolvedProps]);
  const propAliases = new Map<string, string>(unit.destructuredAliases);

  const stateVars = new Set<string>();
  const setterNames = new Set<string>();
  const refNames = new Set<string>();
  for (const s of state) {
    if (s.kind === "useRef") refNames.add(s.varName);
    else stateVars.add(s.varName);
    if (s.setterName) setterNames.add(s.setterName);
  }

  const memoResultNames = new Set<string>();
  const derivedNames = new Map<string, { isFunctionValued: boolean }>();
  const claimed = (name: string): boolean =>
    propNames.has(name) ||
    propAliases.has(name) ||
    stateVars.has(name) ||
    setterNames.has(name) ||
    refNames.has(name);

  for (const stmt of bodyStatements(bodyNode)) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      if (!claimed(stmt.name.text)) derivedNames.set(stmt.name.text, { isFunctionValued: true });
      continue;
    }
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      // `const { a, b: c } = props` → aliases onto the props object.
      if (
        ts.isObjectBindingPattern(decl.name) &&
        decl.initializer &&
        ts.isIdentifier(decl.initializer) &&
        unit.paramName !== undefined &&
        decl.initializer.text === unit.paramName
      ) {
        for (const el of decl.name.elements) {
          if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
          const original =
            el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : el.name.text;
          propAliases.set(el.name.text, original);
        }
        continue;
      }
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (claimed(name)) continue;
      const init = decl.initializer;
      if (init && ts.isCallExpression(init)) {
        const callee = hookCalleeName(init.expression);
        if (callee === "useMemo" || callee === "useCallback") {
          memoResultNames.add(name);
          continue;
        }
      }
      const isFunctionValued =
        init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
      derivedNames.set(name, { isFunctionValued });
    }
  }

  return {
    propNames,
    propAliases,
    paramName: unit.paramName,
    stateVars,
    setterNames,
    refNames,
    memoResultNames,
    derivedNames,
  };
}

/** Statements of the component's function body (block or none for concise arrows). */
export function bodyStatements(bodyNode: ts.Node): readonly ts.Statement[] {
  const fn = bodyNode as ts.FunctionLikeDeclaration;
  if (fn.body && ts.isBlock(fn.body)) return fn.body.statements;
  return [];
}

export interface CollectedRef {
  /** Canonical name from the requested set. */
  name: string;
  node: ts.Identifier;
  /** Reference reached through `props.x` rather than a bare identifier. */
  viaParam: boolean;
}

/**
 * All identifier references to `names` inside `root`, excluding non-reference
 * positions (declaration names, property keys, JSX attribute names, member
 * names, import/export specifiers, signature names). When `paramName` is set,
 * `props.x` property accesses count as references to `x` if `x` ∈ names.
 */
export function collectRefs(
  root: ts.Node,
  _sf: ts.SourceFile,
  names: Set<string>,
  paramName: string | undefined,
): CollectedRef[] {
  const out: CollectedRef[] = [];

  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && names.has(n.text) && isReferencePosition(n)) {
      out.push({ name: n.text, node: n, viaParam: false });
    }
    if (
      paramName !== undefined &&
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === paramName &&
      ts.isIdentifier(n.name) &&
      names.has(n.name.text)
    ) {
      out.push({ name: n.name.text, node: n.name, viaParam: true });
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

function isReferencePosition(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return true;

  // x.title — `title` is a member name, not a reference (the receiver is visited separately).
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  // { title: value } — non-shorthand property key.
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  // Declaration names of any kind.
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  // JSX attribute names.
  if (ts.isJsxAttribute(parent) && parent.name === id) return false;
  // Import / export specifiers.
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  // Type-position property/method signature names.
  if ((ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) && parent.name === id) {
    return false;
  }
  return true;
}

export function hookCalleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
  return undefined;
}
