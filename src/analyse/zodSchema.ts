import ts from "typescript";
import type { PropValue, SourcePosition } from "../types.ts";
import { collectImports, type ImportBinding } from "./parseFile.ts";
import { posOf } from "./pos.ts";
import { findExportedDecl, type SourceFileCache } from "./sourceCache.ts";

/**
 * B-9: `z.infer<typeof schema>` / `z.input` / `z.output` aliases resolved by
 * reading the zod schema initializer's AST. Zod is never installed, imported
 * or executed — this is syntax, which is why the policy is TYPE-level
 * honesty: refinements that do not change the TypeScript type (.min, .email,
 * .trim, .regex, …) are ignored, because the house value is still a member
 * of the declared type; constructs whose OUTPUT type is not
 * JSON-representable (z.date, z.bigint, z.map, …) bail, because
 * JSON.stringify at emission would produce a value that lies about the
 * type; and any construct or modifier outside the recognised set bails —
 * .transform/.refine change semantics, .merge/.pick/.omit/.strict are
 * evidence-gated follow-ups (no corpus sightings yet), and inventing is
 * worse than a TODO.
 */

/** Exact set — `zod-form-data` and friends export a `z` that is not zod's. */
const ZOD_SPECIFIERS = new Set(["zod", "zod/v3", "zod/v4"]);

const INFER_HEADS = new Set(["infer", "input", "output"]);

/** Type-invariant refinements and metadata: safe to ignore, value unchanged. */
const NOOP_MODIFIERS = new Set([
  "optional",
  "nullable",
  "nullish",
  "int",
  "min",
  "max",
  "length",
  "positive",
  "nonnegative",
  "trim",
  "toLowerCase",
  "email",
  "url",
  "uuid",
  "regex",
  "describe",
]);

/** Ctx shape structurally satisfied by extractProps' PropsResolveCtx. */
export interface ZodResolveCtx {
  sf: ts.SourceFile;
  file: string;
  imports: Map<string, ImportBinding>;
  resolver: { resolve(spec: string, importer: string): string | undefined } | undefined;
  cache: SourceFileCache | undefined;
  hops: number;
  visited: Set<string>;
}

export interface ZodObjectField {
  name: string;
  value: PropValue;
  /** Present iff the field's base construct is an enum — feeds variantOptions. */
  options?: PropValue[];
  /** The PropertyAssignment's position in the SCHEMA file. */
  pos: SourcePosition;
}

export type ZodSchemaResult =
  | { kind: "object"; fields: ZodObjectField[] }
  | { kind: "enum"; values: PropValue[] }
  | { kind: "value"; value: PropValue };

/**
 * Is this type reference provably zod's infer/input/output alias? Pure
 * syntax: `<head>.infer<typeof <Identifier>>` where `<head>`'s import
 * binding comes from a zod specifier. Never resolves anything.
 */
export function asZodInferRef(
  node: ts.TypeReferenceNode,
  imports: Map<string, ImportBinding>,
): { schemaName: string; typeKind: "output" | "input" } | undefined {
  const name = node.typeName;
  if (!ts.isQualifiedName(name)) return undefined;
  if (!ts.isIdentifier(name.left)) return undefined;
  if (!INFER_HEADS.has(name.right.text)) return undefined;
  if (!isZodBinding(imports.get(name.left.text))) return undefined;
  if (node.typeArguments?.length !== 1) return undefined;
  const arg = node.typeArguments[0];
  if (!arg || !ts.isTypeQueryNode(arg)) return undefined;
  // `typeof schemas.Foo` (namespace value refs): unseen in the corpus, bail.
  if (!ts.isIdentifier(arg.exprName)) return undefined;
  return {
    schemaName: arg.exprName.text,
    typeKind: name.right.text === "input" ? "input" : "output",
  };
}

function isZodBinding(binding: ImportBinding | undefined): boolean {
  if (!binding || !ZOD_SPECIFIERS.has(binding.specifier)) return false;
  if (binding.kind === "namespace" || binding.kind === "default") return true;
  return binding.importedName === "z";
}

/**
 * Resolve `schemaName` to its const initializer (local statements first,
 * non-exported included — module-local schemas referenced by exported ones
 * are the PasswordSchema idiom; then imports + resolver + barrel chase with
 * an export-enforcing matcher) and read it. undefined = bail.
 */
export function resolveZodSchemaConst(
  schemaName: string,
  seed: string,
  ctx: ZodResolveCtx,
): ZodSchemaResult | undefined {
  // Namespaced: the dominant idiom pairs `const X` and `type X` in one
  // file, and the TYPE lookup has already seeded `${file}::X` before the
  // alias RHS reaches this reader — a shared key would false-bail it.
  const key = `${ctx.file}::zodconst:${schemaName}`;
  if (ctx.visited.has(key)) return undefined;
  const next: ZodResolveCtx = { ...ctx, visited: new Set([...ctx.visited, key]) };

  const local = findSchemaConst(ctx.sf, schemaName, false);
  if (local?.initializer) return resolveZodExpr(local.initializer, seed, next);

  const binding = ctx.imports.get(schemaName);
  if (!binding || ctx.hops <= 0) return undefined;
  const target = ctx.resolver?.resolve(binding.specifier, ctx.file);
  if (!target || !ctx.cache) return undefined;
  const located = findExportedDecl(
    target,
    binding.importedName ?? schemaName,
    ctx.cache,
    ctx.resolver,
    findSchemaConst,
    true,
  );
  if (!located?.decl.initializer) return undefined;
  return resolveZodExpr(located.decl.initializer, seed, {
    ...next,
    sf: located.sf,
    file: located.file,
    imports: collectImports(located.sf),
    hops: ctx.hops - 1,
  });
}

/** Collapse a result to one fixture value. */
export function zodResultToValue(r: ZodSchemaResult): PropValue {
  if (r.kind === "object") {
    const out: { [k: string]: PropValue } = {};
    for (const f of r.fields) out[f.name] = f.value;
    return out;
  }
  if (r.kind === "enum") return r.values[0] as PropValue;
  return r.value;
}

/**
 * Top-level `const <name> = …` in `sf`. `let` is rejected (reassignable),
 * and files reached through a re-export chain vouch only for their EXPORTED
 * consts — same rule as findExportedTypeDecl.
 */
function findSchemaConst(
  sf: ts.SourceFile,
  name: string,
  viaReexport: boolean,
): ts.VariableDeclaration | undefined {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    if (viaReexport) {
      const exported =
        ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      if (!exported) continue;
    }
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d;
    }
  }
  return undefined;
}

/** One chain link: `.name(args)`, peeled outermost-first. */
interface ChainLink {
  name: string;
  args: readonly ts.Expression[];
}

/**
 * Read a zod schema expression. The chain is peeled to its base — a call
 * rooted at the zod binding (`z.enum(…)`, `z.coerce.number()`), or a bare
 * schema-const reference (`RsvpStatusSchema`, `Base.partial()`) — then the
 * remaining links are applied innermost→outermost against the modifier
 * allowlist. Any unrecognised base or modifier is undefined.
 */
function resolveZodExpr(
  expr: ts.Expression,
  seed: string,
  ctx: ZodResolveCtx,
): ZodSchemaResult | undefined {
  let e = unwrapExpr(expr);

  if (ts.isIdentifier(e)) return resolveZodSchemaConst(e.text, seed, ctx);

  // Peel `.name(args)` links until the callee root.
  const chain: ChainLink[] = [];
  while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    chain.push({ name: e.expression.name.text, args: e.arguments });
    e = unwrapExpr(e.expression.expression);
  }

  let result: ZodSchemaResult | undefined;
  let modifiers: ChainLink[];
  if (ts.isIdentifier(e) && isZodBinding(ctx.imports.get(e.text))) {
    // Innermost link is the base construct: z.<base>(…).
    const base = chain.pop();
    if (!base) return undefined;
    result = resolveZodBase(base.name, base.args, seed, ctx);
    modifiers = chain.reverse();
  } else if (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    isZodBinding(ctx.imports.get(e.expression.text)) &&
    e.name.text === "coerce"
  ) {
    // z.coerce.<kind>(…): the innermost link names the coerced OUTPUT type.
    const base = chain.pop();
    if (!base) return undefined;
    result = resolveCoerceBase(base.name, seed);
    modifiers = chain.reverse();
  } else if (ts.isIdentifier(e)) {
    // Schema-const base: every link is a modifier on the resolved schema.
    result = resolveZodSchemaConst(e.text, seed, ctx);
    modifiers = chain.reverse();
  } else {
    return undefined;
  }

  for (const mod of modifiers) {
    if (result === undefined) return undefined;
    result = applyModifier(result, mod, seed, ctx);
  }
  return result;
}

function unwrapExpr(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

function resolveZodBase(
  name: string,
  args: readonly ts.Expression[],
  seed: string,
  ctx: ZodResolveCtx,
): ZodSchemaResult | undefined {
  switch (name) {
    case "string":
      return { kind: "value", value: `flawless-${seed}` };
    case "number":
      return { kind: "value", value: 1 };
    case "boolean":
      return { kind: "value", value: true };
    case "null":
      return { kind: "value", value: null };
    case "literal": {
      const lit = staticLiteral(args[0]);
      return lit === undefined ? undefined : { kind: "value", value: lit };
    }
    case "enum": {
      const values = enumValues(args[0]);
      return values ? { kind: "enum", values } : undefined;
    }
    case "object": {
      const fields = objectFields(args[0], ctx);
      return fields ? { kind: "object", fields } : undefined;
    }
    case "array": {
      const arg = args[0];
      if (!arg) return undefined;
      const el = resolveZodExpr(arg, seed, ctx);
      return el === undefined ? undefined : { kind: "value", value: [zodResultToValue(el)] };
    }
    default:
      // z.date/bigint/map/set/any/unknown/union/discriminatedUnion/tuple/
      // record/nativeEnum/lazy/…: not JSON-representable, or a guess.
      return undefined;
  }
}

function resolveCoerceBase(name: string, seed: string): ZodSchemaResult | undefined {
  // The coerced OUTPUT type is what the fixture must inhabit. z.coerce.date
  // outputs a Date, which JSON.stringify would flatten into a lying string.
  switch (name) {
    case "string":
      return { kind: "value", value: `flawless-${seed}` };
    case "number":
      return { kind: "value", value: 1 };
    case "boolean":
      return { kind: "value", value: true };
    default:
      return undefined;
  }
}

function applyModifier(
  result: ZodSchemaResult,
  mod: ChainLink,
  seed: string,
  ctx: ZodResolveCtx,
): ZodSchemaResult | undefined {
  if (NOOP_MODIFIERS.has(mod.name)) return result;
  if (mod.name === "default") {
    const lit = staticLiteral(mod.args[0]);
    // Non-static default (a function, an object): the inner value is
    // type-legal either way — keep it.
    if (lit === undefined) return result;
    if (result.kind === "value") return { kind: "value", value: lit };
    if (result.kind === "enum") {
      // The declared default leads; a default OUTSIDE the enum is suspect.
      if (!result.values.includes(lit)) return undefined;
      return { kind: "enum", values: [lit, ...result.values.filter((v) => v !== lit)] };
    }
    // Object defaults are object literals — non-static; keep the fields.
    return result;
  }
  if (mod.name === "partial") {
    // All-optional fields, values still included (the optional-members rule).
    return result.kind === "object" ? result : undefined;
  }
  if (mod.name === "extend") {
    if (result.kind !== "object") return undefined;
    const extension = extendFields(mod.args[0], seed, ctx);
    if (!extension) return undefined;
    const merged = new Map<string, ZodObjectField>();
    for (const f of result.fields) merged.set(f.name, f);
    for (const f of extension) merged.set(f.name, f);
    return { kind: "object", fields: [...merged.values()] };
  }
  // .transform/.refine/.superRefine/.pipe/.brand/.catch/.merge/.pick/
  // .omit/.strict/.passthrough/…: semantics change or evidence-gated.
  return undefined;
}

/** `.extend({...})` or `.extend(OtherSchema.shape)`. */
function extendFields(
  arg: ts.Expression | undefined,
  seed: string,
  ctx: ZodResolveCtx,
): ZodObjectField[] | undefined {
  if (!arg) return undefined;
  const e = unwrapExpr(arg);
  if (ts.isObjectLiteralExpression(e)) return objectFields(e, ctx);
  if (
    ts.isPropertyAccessExpression(e) &&
    ts.isIdentifier(e.expression) &&
    e.name.text === "shape"
  ) {
    const other = resolveZodSchemaConst(e.expression.text, seed, ctx);
    return other?.kind === "object" ? other.fields : undefined;
  }
  return undefined;
}

/** Inline string-literal array only — a const-ref member list is unreadable
 * here and a partial union would be fabricated, not resolved. */
function enumValues(arg: ts.Expression | undefined): PropValue[] | undefined {
  if (!arg) return undefined;
  const e = unwrapExpr(arg);
  if (!ts.isArrayLiteralExpression(e)) return undefined;
  const out: PropValue[] = [];
  for (const el of e.elements) {
    if (!ts.isStringLiteral(el)) return undefined;
    out.push(el.text);
  }
  return out.length > 0 ? out : undefined;
}

/** Every field resolves or the whole object bails — no silent holes. */
function objectFields(
  arg: ts.Expression | undefined,
  ctx: ZodResolveCtx,
): ZodObjectField[] | undefined {
  if (!arg) return undefined;
  const e = unwrapExpr(arg);
  if (!ts.isObjectLiteralExpression(e)) return undefined;
  const out: ZodObjectField[] = [];
  for (const prop of e.properties) {
    if (!ts.isPropertyAssignment(prop)) return undefined;
    if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name)) return undefined;
    const name = prop.name.text;
    const r = resolveZodExpr(prop.initializer, name, ctx);
    if (r === undefined) return undefined;
    out.push({
      name,
      value: zodResultToValue(r),
      options: r.kind === "enum" ? r.values : undefined,
      pos: posOf(prop, ctx.sf),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** JSON-only static literal: string/number/boolean/null, prefix-minus. */
function staticLiteral(arg: ts.Expression | undefined): PropValue | undefined {
  if (!arg) return undefined;
  const e = unwrapExpr(arg);
  if (ts.isStringLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) {
    const n = Number(e.text);
    return Number.isFinite(n) ? n : undefined;
  }
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
    const inner = staticLiteral(e.operand);
    return typeof inner === "number" ? -inner : undefined;
  }
  return undefined;
}
