import { readFileSync } from "node:fs";
import ts from "typescript";
import type { PropsShape, PropValue, SourcePosition } from "../types.ts";
import type { ImportBinding } from "./parseFile.ts";
import { posOf } from "./pos.ts";
import type { ModuleResolver } from "./resolveModule.ts";

export interface ExtractedProps {
  propsShape: PropsShape;
  variants: PropsShape[];
  unresolvedProps: string[];
  /** Declaration site of every member seen on the props type (resolved or not). */
  propPositions: Record<string, SourcePosition>;
  /** Props declared as Promise<...> — synthesised unwrapped; wrap at render time. */
  promiseProps: string[];
}

const EMPTY: ExtractedProps = {
  propsShape: {},
  variants: [],
  unresolvedProps: [],
  propPositions: {},
  promiseProps: [],
};

export function extractProps(
  sourceFile: ts.SourceFile,
  propsTypeRef: ts.TypeReferenceNode | undefined,
  propsTypeLiteral?: ts.TypeLiteralNode,
  imports?: Map<string, ImportBinding>,
  entryFile?: string,
  resolver?: ModuleResolver,
): ExtractedProps {
  if (propsTypeLiteral) {
    return walkMembers(propsTypeLiteral.members, sourceFile, "<inline>");
  }
  if (!propsTypeRef) return EMPTY;
  if (!ts.isIdentifier(propsTypeRef.typeName)) return EMPTY;
  const typeName = propsTypeRef.typeName.text;

  const decl = findTypeDecl(sourceFile, typeName);
  if (decl) return walkDecl(decl, sourceFile);

  // One-file-deep resolution of an imported props type. No recursion past one hop.
  if (imports && entryFile && resolver) {
    const binding = imports.get(typeName);
    if (binding) {
      const targetPath = resolver.resolve(binding.specifier, entryFile);
      if (targetPath) {
        try {
          const src = readFileSync(targetPath, "utf8");
          const targetSf = ts.createSourceFile(
            targetPath,
            src,
            ts.ScriptTarget.ES2022,
            true,
            ts.ScriptKind.TSX,
          );
          const targetDecl = findTypeDecl(targetSf, binding.importedName ?? typeName);
          if (targetDecl) return walkDecl(targetDecl, targetSf);
        } catch {
          // Unreadable target — fall through to unresolved.
        }
      }
    }
  }

  return { ...EMPTY, unresolvedProps: [typeName] };
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

function walkDecl(
  decl: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  sf: ts.SourceFile,
): ExtractedProps {
  const members = ts.isInterfaceDeclaration(decl)
    ? decl.members
    : ts.isTypeLiteralNode(decl.type)
      ? decl.type.members
      : undefined;
  if (!members) return { ...EMPTY, unresolvedProps: [decl.name.text] };
  return walkMembers(members, sf, decl.name.text);
}

function walkMembers(
  members: ts.NodeArray<ts.TypeElement>,
  sf: ts.SourceFile,
  _declName: string,
): ExtractedProps {
  const propsShape: PropsShape = {};
  const variantOptions: Record<string, PropValue[]> = {};
  const unresolved: string[] = [];
  const propPositions: Record<string, SourcePosition> = {};
  const promiseProps: string[] = [];

  for (const m of members) {
    if (!ts.isPropertySignature(m)) continue;
    if (!ts.isIdentifier(m.name)) continue;
    const name = m.name.text;
    propPositions[name] = posOf(m, sf);
    const t = m.type;
    if (!t) {
      unresolved.push(name);
      continue;
    }

    // Promise<T> (Next.js 15 params/searchParams): synthesise T, mark for wrapping.
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === "Promise") {
      const inner = t.typeArguments?.[0];
      const r = inner ? mapType(inner) : { kind: "unresolved" as const };
      if (r.kind === "scalar" || r.kind === "variants") {
        propsShape[name] = r.value;
        promiseProps.push(name);
        continue;
      }
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
    propPositions,
    promiseProps,
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
