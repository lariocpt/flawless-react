import ts from "typescript";
import type { PropsShape, PropValue, SourcePosition } from "../types.ts";
import { extractVariantDefs, type VariantDefinition } from "./extractVariants.ts";
import { hostPropsFor, isHostTagRecognised } from "./hostProps.ts";
import type { ImportBinding } from "./parseFile.ts";
import { posOf } from "./pos.ts";
import type { ModuleResolver } from "./resolveModule.ts";
import type { SourceFileCache } from "./sourceCache.ts";

export interface ExtractedProps {
  propsShape: PropsShape;
  variants: PropsShape[];
  /** Props seen but not synthesisable — real prop names only. */
  unresolvedProps: string[];
  /** Type expressions we gave up on: "Omit", "ButtonPrimitive.Props". */
  unresolvedTypes: string[];
  /** Declaration site of every member seen (resolved or not). */
  propPositions: Record<string, SourcePosition>;
  /** Props declared as Promise<...> — synthesised unwrapped; wrap at render time. */
  promiseProps: string[];
  /** prop → full literal option list. */
  variantOptions: Record<string, PropValue[]>;
  /** prop → option → its cva class string, for distinctness checks. */
  variantClasses: Record<string, Record<string, string>>;
  /** Host element the props type anchors to, when unambiguous. */
  hostElement?: string;
  acceptsChildren: boolean;
}

/**
 * Where a member came from. Higher precedence wins a name conflict when
 * intersection operands are merged: the type literal written at the
 * declaration site is the author's most specific statement, and the curated
 * DOM table is the least.
 */
type MemberOrigin = "literal" | "variant" | "interface" | "component" | "host";

const ORIGIN_RANK: Record<MemberOrigin, number> = {
  literal: 5,
  variant: 4,
  interface: 3,
  component: 2,
  host: 1,
};

interface PartialProps {
  shape: PropsShape;
  variantOptions: Record<string, PropValue[]>;
  variantClasses: Record<string, Record<string, string>>;
  origin: Record<string, MemberOrigin>;
  propPositions: Record<string, SourcePosition>;
  promiseProps: string[];
  unresolvedProps: string[];
  unresolvedTypes: string[];
  hostElement?: string;
  acceptsChildren: boolean;
}

interface PropsResolveCtx {
  sf: ts.SourceFile;
  /** Absolute path of `sf`. */
  file: string;
  imports: Map<string, ImportBinding>;
  resolver: ModuleResolver | undefined;
  cache: SourceFileCache | undefined;
  /** Remaining cross-file / cross-component hops. */
  hops: number;
  /** `${file}::${name}` cycle guard. */
  visited: Set<string>;
  /** cva/tv definitions declared in `sf`, built lazily. */
  variantDefs?: Map<string, VariantDefinition>;
}

/** Intersections beyond this are machine-generated; resolving them is guessing. */
const MAX_INTERSECTION_OPERANDS = 8;
const MAX_HOPS = 2;

function emptyPartial(): PartialProps {
  return {
    shape: {},
    variantOptions: {},
    variantClasses: {},
    origin: {},
    propPositions: {},
    promiseProps: [],
    unresolvedProps: [],
    unresolvedTypes: [],
    acceptsChildren: false,
  };
}

const EMPTY: ExtractedProps = {
  propsShape: {},
  variants: [],
  unresolvedProps: [],
  unresolvedTypes: [],
  propPositions: {},
  promiseProps: [],
  variantOptions: {},
  variantClasses: {},
  acceptsChildren: false,
};

export function extractProps(
  sourceFile: ts.SourceFile,
  propsTypeNode: ts.TypeNode | undefined,
  propsTypeLiteral?: ts.TypeLiteralNode,
  imports?: Map<string, ImportBinding>,
  entryFile?: string,
  resolver?: ModuleResolver,
  cache?: SourceFileCache,
): ExtractedProps {
  const node = propsTypeNode ?? propsTypeLiteral;
  if (!node) return EMPTY;

  const ctx: PropsResolveCtx = {
    sf: sourceFile,
    file: entryFile ?? sourceFile.fileName,
    imports: imports ?? new Map(),
    resolver,
    cache,
    hops: MAX_HOPS,
    visited: new Set(),
  };

  const partial = resolveTypeNode(node, ctx);
  return finalise(partial);
}

function finalise(p: PartialProps): ExtractedProps {
  // `children` is a boolean capability, never a prop value: propsShape is
  // JSON-stringified into the spec's DEFAULTS and spread, so a `children`
  // entry would emit <X children="…" /> instead of real JSX.
  const acceptsChildren = p.acceptsChildren || "children" in p.propPositions;
  delete p.shape.children;
  delete p.variantOptions.children;
  const unresolvedProps = p.unresolvedProps.filter((n) => n !== "children" && !(n in p.shape));

  return {
    propsShape: p.shape,
    variants: cartesian(p.variantOptions, p.shape),
    unresolvedProps: [...new Set(unresolvedProps)],
    unresolvedTypes: [...new Set(p.unresolvedTypes)],
    propPositions: p.propPositions,
    promiseProps: [...new Set(p.promiseProps)],
    variantOptions: p.variantOptions,
    variantClasses: p.variantClasses,
    ...(p.hostElement ? { hostElement: p.hostElement } : {}),
    acceptsChildren,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function resolveTypeNode(node: ts.TypeNode, ctx: PropsResolveCtx): PartialProps {
  if (ts.isParenthesizedTypeNode(node)) return resolveTypeNode(node.type, ctx);

  if (ts.isIntersectionTypeNode(node)) {
    const operands = flattenIntersection(node);
    if (operands.length > MAX_INTERSECTION_OPERANDS) {
      const p = emptyPartial();
      p.unresolvedTypes.push(`<intersection:${MAX_INTERSECTION_OPERANDS + 1}+>`);
      return p;
    }
    return mergePartials(operands.map((o) => resolveTypeNode(o, ctx)));
  }

  if (ts.isTypeLiteralNode(node)) {
    return walkMembers(node.members, ctx.sf, "literal");
  }

  if (ts.isTypeReferenceNode(node)) {
    return resolveTypeReference(node, ctx);
  }

  const p = emptyPartial();
  p.unresolvedTypes.push(printHead(node, ctx.sf));
  return p;
}

function flattenIntersection(node: ts.IntersectionTypeNode): ts.TypeNode[] {
  const out: ts.TypeNode[] = [];
  const walk = (n: ts.TypeNode): void => {
    if (ts.isParenthesizedTypeNode(n)) {
      walk(n.type);
      return;
    }
    if (ts.isIntersectionTypeNode(n)) {
      for (const t of n.types) walk(t);
      return;
    }
    out.push(n);
  };
  walk(node);
  return out;
}

/** A short, stable label for a type we could not resolve. */
function printHead(node: ts.TypeNode, sf: ts.SourceFile): string {
  if (ts.isTypeReferenceNode(node)) return entityNameText(node.typeName);
  let text: string;
  try {
    text = node.getText(sf);
  } catch {
    return "<type>";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 60);
}

function entityNameText(name: ts.EntityName): string {
  if (ts.isIdentifier(name)) return name.text;
  return `${entityNameText(name.left)}.${name.right.text}`;
}

function lastSegment(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function mergePartials(parts: PartialProps[]): PartialProps {
  const acc = emptyPartial();
  let hostSeen: string | undefined;
  let hostConflict = false;

  for (const part of parts) {
    for (const [name, value] of Object.entries(part.shape)) {
      const incoming = part.origin[name] ?? "literal";
      const current = acc.origin[name];
      // Later operand wins ties; higher-precedence origin always wins.
      const wins = current === undefined || ORIGIN_RANK[incoming] >= ORIGIN_RANK[current];
      if (!wins) continue;
      acc.shape[name] = value;
      acc.origin[name] = incoming;
      const pos = part.propPositions[name];
      if (pos) acc.propPositions[name] = pos;
      // Option lists are replaced wholesale — unioning two literal sets would
      // invent a union the author never wrote.
      const opts = part.variantOptions[name];
      if (opts) acc.variantOptions[name] = opts;
      else delete acc.variantOptions[name];
      const cls = part.variantClasses[name];
      if (cls) acc.variantClasses[name] = cls;
      else delete acc.variantClasses[name];
    }
    for (const [name, pos] of Object.entries(part.propPositions)) {
      acc.propPositions[name] ??= pos;
    }
    acc.promiseProps.push(...part.promiseProps);
    acc.unresolvedProps.push(...part.unresolvedProps);
    acc.unresolvedTypes.push(...part.unresolvedTypes);
    acc.acceptsChildren ||= part.acceptsChildren;

    if (part.hostElement) {
      if (hostSeen && hostSeen !== part.hostElement) hostConflict = true;
      hostSeen ??= part.hostElement;
    }
  }

  if (hostConflict) {
    // Keep the merged members; drop only the tag claim.
    acc.unresolvedTypes.push("<host-conflict>");
  } else if (hostSeen) {
    acc.hostElement = hostSeen;
  }

  // A name resolved by one operand is not unresolved just because another failed.
  acc.unresolvedProps = acc.unresolvedProps.filter((n) => !(n in acc.shape));
  return acc;
}

// ---------------------------------------------------------------------------
// Type references
// ---------------------------------------------------------------------------

const COMPONENT_PROPS_HEADS = new Set([
  "ComponentProps",
  "ComponentPropsWithoutRef",
  "ComponentPropsWithRef",
]);

/** `ButtonHTMLAttributes<…>` names its own tag; the type argument is noise. */
const HTML_ATTR_TO_TAG: Record<string, string> = {
  HTMLAttributes: "div",
  ButtonHTMLAttributes: "button",
  InputHTMLAttributes: "input",
  AnchorHTMLAttributes: "a",
  FormHTMLAttributes: "form",
  TextareaHTMLAttributes: "textarea",
  SelectHTMLAttributes: "select",
  LabelHTMLAttributes: "label",
  ImgHTMLAttributes: "img",
};

function resolveTypeReference(node: ts.TypeReferenceNode, ctx: PropsResolveCtx): PartialProps {
  const head = lastSegment(node.typeName);

  if (head === "PropsWithChildren") {
    const inner = node.typeArguments?.[0];
    const p = inner ? resolveTypeNode(inner, ctx) : emptyPartial();
    p.acceptsChildren = true;
    return p;
  }

  if (COMPONENT_PROPS_HEADS.has(head) && isReactProvenance(node.typeName, ctx)) {
    return resolveComponentProps(node, ctx);
  }

  const attrTag = HTML_ATTR_TO_TAG[head];
  if (attrTag && isReactProvenance(node.typeName, ctx)) {
    return hostPartial(attrTag, node, ctx);
  }

  if (head === "VariantProps") {
    return resolveVariantProps(node, ctx);
  }

  // A local interface / type alias.
  if (ts.isIdentifier(node.typeName)) {
    const local = findTypeDecl(ctx.sf, node.typeName.text);
    if (local) return resolveTypeDecl(local, ctx);
  }

  // An imported props type — one hop through the resolver.
  const imported = resolveImportedTypeDecl(node.typeName, ctx);
  if (imported) return imported;

  const p = emptyPartial();
  p.unresolvedTypes.push(entityNameText(node.typeName));
  return p;
}

/**
 * `ComponentProps` must actually be React's. A project-local type of the same
 * name would make the host table a lie, so anything we cannot attribute to
 * react is refused.
 */
function isReactProvenance(name: ts.EntityName, ctx: PropsResolveCtx): boolean {
  if (ts.isQualifiedName(name)) {
    const root = ts.isIdentifier(name.left) ? name.left.text : undefined;
    if (!root) return false;
    if (root === "React") return true;
    return ctx.imports.get(root)?.specifier === "react";
  }
  const binding = ctx.imports.get(name.text);
  // Not imported at all → the global JSX namespace. Imported → must be react.
  return binding === undefined || binding.specifier === "react";
}

function resolveComponentProps(node: ts.TypeReferenceNode, ctx: PropsResolveCtx): PartialProps {
  const arg = node.typeArguments?.[0];
  if (!arg) {
    const p = emptyPartial();
    p.unresolvedTypes.push(entityNameText(node.typeName));
    return p;
  }

  // ComponentProps<"button">
  if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
    const tag = arg.literal.text;
    if (/^[a-z][a-z0-9]*$/.test(tag)) return hostPartial(tag, node, ctx);
  }

  // ComponentProps<typeof LocalComponent>
  if (ts.isTypeQueryNode(arg)) {
    return resolveComponentPropsOfEntity(arg.exprName, node, ctx);
  }

  const p = emptyPartial();
  p.unresolvedTypes.push(printHead(node, ctx.sf));
  return p;
}

function hostPartial(tag: string, node: ts.TypeNode, ctx: PropsResolveCtx): PartialProps {
  const host = hostPropsFor(tag);
  const p = emptyPartial();
  const pos = posOf(node, ctx.sf);
  for (const [k, v] of Object.entries(host.shape)) {
    p.shape[k] = v;
    p.origin[k] = "host";
    p.propPositions[k] = pos;
  }
  for (const [k, opts] of Object.entries(host.variantOptions ?? {})) {
    p.variantOptions[k] = opts;
  }
  p.hostElement = tag;
  p.acceptsChildren = host.acceptsChildren;
  if (!isHostTagRecognised(tag)) {
    // Still safe: className/id exist on every element and the void-element
    // list is a closed HTML fact. Recorded so the limit stays visible.
    p.unresolvedTypes.push(`<host:${tag}>`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// ComponentProps<typeof X>
// ---------------------------------------------------------------------------

function resolveComponentPropsOfEntity(
  exprName: ts.EntityName,
  node: ts.TypeReferenceNode,
  ctx: PropsResolveCtx,
): PartialProps {
  const bail = (): PartialProps => {
    const p = emptyPartial();
    p.unresolvedTypes.push(printHead(node, ctx.sf));
    return p;
  };
  if (ctx.hops <= 0) return bail();

  const localName = ts.isIdentifier(exprName) ? exprName.text : lastSegment(exprName);
  const rootName = ts.isIdentifier(exprName)
    ? exprName.text
    : ts.isIdentifier(exprName.left)
      ? exprName.left.text
      : undefined;
  if (!rootName) return bail();

  // Same file first.
  if (ts.isIdentifier(exprName)) {
    const key = `${ctx.file}::${localName}`;
    if (ctx.visited.has(key)) return bail();
    const typeNode = findComponentPropsTypeNode(ctx.sf, localName);
    if (typeNode) {
      const next: PropsResolveCtx = {
        ...ctx,
        hops: ctx.hops - 1,
        visited: new Set([...ctx.visited, key]),
      };
      return withOrigin(resolveTypeNode(typeNode, next), "component");
    }
  }

  // Imported component.
  const binding = ctx.imports.get(rootName);
  if (!binding || binding.isTypeOnly) return bail();
  const target = ctx.resolver?.resolve(binding.specifier, ctx.file);
  if (!target) return bail();
  const targetSf = ctx.cache?.get(target);
  if (!targetSf) return bail();

  const wanted = ts.isIdentifier(exprName) ? (binding.importedName ?? localName) : localName;
  const key = `${target}::${wanted}`;
  if (ctx.visited.has(key)) return bail();

  const typeNode =
    findComponentPropsTypeNode(targetSf, wanted) ??
    (binding.kind === "default" ? findPrimaryComponentPropsTypeNode(targetSf) : undefined);
  if (!typeNode) return bail();

  const next: PropsResolveCtx = {
    sf: targetSf,
    file: target,
    imports: collectImportsSync(targetSf),
    resolver: ctx.resolver,
    cache: ctx.cache,
    hops: ctx.hops - 1,
    visited: new Set([...ctx.visited, key]),
  };
  return withOrigin(resolveTypeNode(typeNode, next), "component");
}

function withOrigin(p: PartialProps, origin: MemberOrigin): PartialProps {
  for (const name of Object.keys(p.shape)) p.origin[name] = origin;
  return p;
}

/** First-param (or FC arg) type node of a component named `name` in `sf`. */
function findComponentPropsTypeNode(sf: ts.SourceFile, name: string): ts.TypeNode | undefined {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      return stmt.parameters[0]?.type;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue;
        const typeRef = decl.type && ts.isTypeReferenceNode(decl.type) ? decl.type : undefined;
        const fcArg = typeRef?.typeArguments?.[0];
        if (fcArg) return fcArg;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          return init.parameters[0]?.type;
        }
      }
    }
  }
  return undefined;
}

/** Props of the file's default-exported component, for `import X from "…"`. */
function findPrimaryComponentPropsTypeNode(sf: ts.SourceFile): ts.TypeNode | undefined {
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue;
    const mods = stmt.modifiers ?? [];
    const isDefault =
      mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (isDefault) return stmt.parameters[0]?.type;
  }
  return undefined;
}

/** Synchronous import map for a cached secondary file. */
function collectImportsSync(sf: ts.SourceFile): Map<string, ImportBinding> {
  const out = new Map<string, ImportBinding>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifier = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) continue;
    const pos = posOf(stmt, sf);
    if (clause.name) {
      out.set(clause.name.text, {
        specifier,
        kind: "default",
        isTypeOnly: clause.isTypeOnly,
        pos,
      });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        out.set(el.name.text, {
          specifier,
          kind: "named",
          importedName: el.propertyName?.text ?? el.name.text,
          isTypeOnly: clause.isTypeOnly || el.isTypeOnly,
          pos,
        });
      }
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      out.set(clause.namedBindings.name.text, {
        specifier,
        kind: "namespace",
        isTypeOnly: clause.isTypeOnly,
        pos,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// VariantProps<typeof xVariants>
// ---------------------------------------------------------------------------

const VARIANT_SPECIFIERS = new Set(["class-variance-authority", "tailwind-variants"]);

function resolveVariantProps(node: ts.TypeReferenceNode, ctx: PropsResolveCtx): PartialProps {
  const bail = (): PartialProps => {
    const p = emptyPartial();
    p.unresolvedTypes.push("VariantProps");
    return p;
  };

  // Provenance: a project-local `VariantProps` would make this a name guess.
  if (ts.isQualifiedName(node.typeName)) {
    const root = ts.isIdentifier(node.typeName.left) ? node.typeName.left.text : undefined;
    const spec = root ? ctx.imports.get(root)?.specifier : undefined;
    if (!spec || !VARIANT_SPECIFIERS.has(spec)) return bail();
  } else {
    const binding = ctx.imports.get(node.typeName.text);
    if (!binding || !VARIANT_SPECIFIERS.has(binding.specifier)) return bail();
    if (binding.importedName && binding.importedName !== "VariantProps") return bail();
  }

  const arg = node.typeArguments?.[0];
  if (!arg || !ts.isTypeQueryNode(arg) || !ts.isIdentifier(arg.exprName)) return bail();
  const constName = arg.exprName.text;

  ctx.variantDefs ??= extractVariantDefs(ctx.sf, ctx.imports);
  let def = ctx.variantDefs.get(constName);

  if (!def && ctx.hops > 0) {
    // `import { buttonVariants } from "@/components/ui/button"` is real.
    const binding = ctx.imports.get(constName);
    const target = binding ? ctx.resolver?.resolve(binding.specifier, ctx.file) : undefined;
    const targetSf = target ? ctx.cache?.get(target) : undefined;
    if (targetSf) {
      const defs = extractVariantDefs(targetSf, collectImportsSync(targetSf));
      def = defs.get(binding?.importedName ?? constName);
    }
  }
  if (!def) return bail();

  const p = emptyPartial();
  for (const [key, options] of Object.entries(def.options)) {
    const first = options[0];
    if (first === undefined) continue;
    p.shape[key] = def.defaults[key] ?? first;
    p.variantOptions[key] = options;
    const cls = def.classes[key];
    if (cls) p.variantClasses[key] = cls;
    p.origin[key] = "variant";
    const pos = def.keyPositions[key];
    if (pos) p.propPositions[key] = pos;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

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

function resolveTypeDecl(
  decl: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  ctx: PropsResolveCtx,
): PartialProps {
  if (ts.isTypeAliasDeclaration(decl)) {
    // `type Props = A & B` now works, where it used to bail.
    return resolveTypeNode(decl.type, ctx);
  }

  // `interface Props extends ComponentProps<"button"> { … }` is an implicit
  // intersection: bases first, own members last (they are more specific).
  const parts: PartialProps[] = [];
  for (const heritage of decl.heritageClauses ?? []) {
    if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const t of heritage.types) {
      const synthetic = asTypeNode(t);
      if (synthetic) parts.push(resolveTypeNode(synthetic, ctx));
      else {
        const p = emptyPartial();
        p.unresolvedTypes.push(printHead(t.expression as unknown as ts.TypeNode, ctx.sf));
        parts.push(p);
      }
    }
  }
  parts.push(walkMembers(decl.members, ctx.sf, "interface"));
  return mergePartials(parts);
}

/** An `extends` entry is a call-ish node; reuse it as a type reference. */
function asTypeNode(t: ts.ExpressionWithTypeArguments): ts.TypeNode | undefined {
  const expr = t.expression;
  if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return undefined;
  return t as unknown as ts.TypeNode;
}

function walkMembers(
  members: ts.NodeArray<ts.TypeElement>,
  sf: ts.SourceFile,
  origin: MemberOrigin,
): PartialProps {
  const p = emptyPartial();

  for (const m of members) {
    if (!ts.isPropertySignature(m)) continue;
    // String-literal names ('"data-variant": string') are real members and map
    // like identifiers; the emitted DEFAULTS is JSON.stringify'd, so the quoted
    // key survives emission. Computed/numeric/private names stay out.
    if (!ts.isIdentifier(m.name) && !ts.isStringLiteral(m.name)) continue;
    const name = m.name.text;
    p.propPositions[name] = posOf(m, sf);
    const t = m.type;
    if (!t) {
      p.unresolvedProps.push(name);
      continue;
    }

    // Promise<T> (Next.js 15 params/searchParams): synthesise T, mark for wrapping.
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === "Promise") {
      const inner = t.typeArguments?.[0];
      const r = inner ? mapType(inner) : { kind: "unresolved" as const };
      if (r.kind === "scalar" || r.kind === "variants") {
        p.shape[name] = r.value;
        p.origin[name] = origin;
        p.promiseProps.push(name);
        continue;
      }
      p.unresolvedProps.push(name);
      continue;
    }

    const r = mapType(t);
    if (r.kind === "unresolved") {
      p.unresolvedProps.push(name);
      continue;
    }
    p.shape[name] = r.value;
    p.origin[name] = origin;
    if (r.kind === "variants") p.variantOptions[name] = r.values;
  }

  return p;
}

/** Props type imported from another module — one hop, no recursion past it. */
function resolveImportedTypeDecl(
  name: ts.EntityName,
  ctx: PropsResolveCtx,
): PartialProps | undefined {
  if (!ts.isIdentifier(name)) return undefined;
  if (ctx.hops <= 0) return undefined;
  const binding = ctx.imports.get(name.text);
  if (!binding) return undefined;
  const target = ctx.resolver?.resolve(binding.specifier, ctx.file);
  if (!target) return undefined;
  const targetSf = ctx.cache?.get(target);
  if (!targetSf) return undefined;
  const decl = findTypeDecl(targetSf, binding.importedName ?? name.text);
  if (!decl) return undefined;

  const key = `${target}::${decl.name.text}`;
  if (ctx.visited.has(key)) return undefined;

  return resolveTypeDecl(decl, {
    sf: targetSf,
    file: target,
    imports: collectImportsSync(targetSf),
    resolver: ctx.resolver,
    cache: ctx.cache,
    hops: ctx.hops - 1,
    visited: new Set([...ctx.visited, key]),
  });
}

// ---------------------------------------------------------------------------
// Type → default value
// ---------------------------------------------------------------------------

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
