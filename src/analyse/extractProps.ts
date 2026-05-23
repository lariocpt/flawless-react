import ts from "typescript";
import type { PropsShape, PropValue } from "../types.ts";

export interface ExtractedProps {
  propsShape: PropsShape;
  variants: PropsShape[];
  unresolvedProps: string[];
}

const EMPTY: ExtractedProps = { propsShape: {}, variants: [], unresolvedProps: [] };

export function extractProps(
  sourceFile: ts.SourceFile,
  propsTypeRef: ts.TypeReferenceNode | undefined,
): ExtractedProps {
  if (!propsTypeRef) return EMPTY;
  if (!ts.isIdentifier(propsTypeRef.typeName)) return EMPTY;
  const typeName = propsTypeRef.typeName.text;

  const decl = findTypeDecl(sourceFile, typeName);
  if (!decl) {
    return { propsShape: {}, variants: [], unresolvedProps: [typeName] };
  }
  return walkMembers(decl);
}

function findTypeDecl(
  sf: ts.SourceFile,
  name: string,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined {
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return stmt;
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) return stmt;
  }
  return undefined;
}

function walkMembers(decl: ts.InterfaceDeclaration | ts.TypeAliasDeclaration): ExtractedProps {
  const members = ts.isInterfaceDeclaration(decl)
    ? decl.members
    : ts.isTypeLiteralNode(decl.type)
      ? decl.type.members
      : undefined;

  if (!members) return { propsShape: {}, variants: [], unresolvedProps: [decl.name.text] };

  const propsShape: PropsShape = {};
  const variantOptions: Record<string, PropValue[]> = {};
  const unresolved: string[] = [];

  for (const m of members) {
    if (!ts.isPropertySignature(m)) continue;
    if (!ts.isIdentifier(m.name)) continue;
    const name = m.name.text;
    const t = m.type;
    if (!t) {
      unresolved.push(name);
      continue;
    }
    const r = mapType(t);
    if (r.kind === "unresolved") {
      unresolved.push(name);
      continue;
    }
    propsShape[name] = r.value;
    if (r.kind === "variants") variantOptions[name] = r.values;
  }

  return {
    propsShape,
    variants: cartesian(variantOptions, propsShape),
    unresolvedProps: unresolved,
  };
}

type MapResult =
  | { kind: "scalar"; value: PropValue }
  | { kind: "variants"; value: PropValue; values: PropValue[] }
  | { kind: "unresolved" };

function mapType(t: ts.TypeNode): MapResult {
  switch (t.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { kind: "scalar", value: "" };
    case ts.SyntaxKind.NumberKeyword:
      return { kind: "scalar", value: 0 };
    case ts.SyntaxKind.BooleanKeyword:
      return { kind: "scalar", value: false };
    case ts.SyntaxKind.NullKeyword:
      return { kind: "scalar", value: null };
  }
  if (ts.isArrayTypeNode(t)) return { kind: "scalar", value: [] };
  if (ts.isTypeLiteralNode(t)) {
    const inner: PropsShape = {};
    for (const m of t.members) {
      if (!ts.isPropertySignature(m) || !ts.isIdentifier(m.name) || !m.type) continue;
      const r = mapType(m.type);
      if (r.kind === "scalar" || r.kind === "variants") inner[m.name.text] = r.value;
    }
    return { kind: "scalar", value: inner };
  }
  if (ts.isLiteralTypeNode(t)) {
    const lit = t.literal;
    if (ts.isStringLiteral(lit)) return { kind: "scalar", value: lit.text };
    if (ts.isNumericLiteral(lit)) return { kind: "scalar", value: Number(lit.text) };
    if (lit.kind === ts.SyntaxKind.TrueKeyword) return { kind: "scalar", value: true };
    if (lit.kind === ts.SyntaxKind.FalseKeyword) return { kind: "scalar", value: false };
    if (lit.kind === ts.SyntaxKind.NullKeyword) return { kind: "scalar", value: null };
    return { kind: "unresolved" };
  }
  if (ts.isUnionTypeNode(t)) {
    const literals: PropValue[] = [];
    for (const u of t.types) {
      const r = mapType(u);
      if (r.kind === "scalar") literals.push(r.value);
      else return { kind: "unresolved" };
    }
    if (literals.length === 0) return { kind: "unresolved" };
    const first = literals[0] as PropValue;
    return { kind: "variants", value: first, values: literals };
  }
  return { kind: "unresolved" };
}

function cartesian(options: Record<string, PropValue[]>, base: PropsShape): PropsShape[] {
  const keys = Object.keys(options);
  if (keys.length === 0) return [];
  // Pairwise: hold all-but-one at defaults, vary the chosen key across its options.
  const out: PropsShape[] = [];
  for (const k of keys) {
    const values = options[k];
    if (!values) continue;
    for (const v of values) {
      out.push({ ...base, [k]: v });
    }
  }
  return out;
}
