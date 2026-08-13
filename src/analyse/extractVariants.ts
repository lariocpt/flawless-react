import ts from "typescript";
import type { PropValue, SourcePosition } from "../types.ts";
import type { ImportBinding } from "./parseFile.ts";
import { posOf } from "./pos.ts";

/**
 * `cva()` / `tv()` variant tables read straight from the source.
 *
 * This is the highest-value inference for shadcn-style codebases: a component
 * typed `VariantProps<typeof buttonVariants>` has no discoverable props at all
 * without it, but the variant keys and their option names are sitting in a
 * plain object literal one declaration above.
 *
 * Option values ARE read, but only to compare them with each other. They are
 * Tailwind class strings, and cn()/tailwind-merge drops base classes that a
 * later variant conflicts with — verified against the real DOM — so asserting a
 * specific token is a false-failure waiting to happen. What IS sound is that two
 * options whose class strings differ must render differently.
 */

export interface VariantDefinition {
  /** Local const name: "buttonVariants". */
  name: string;
  factory: "cva" | "tv";
  /** key → literal options, in source order. */
  options: Record<string, PropValue[]>;
  /** From defaultVariants. */
  defaults: Record<string, PropValue>;
  keyPositions: Record<string, SourcePosition>;
  /** key → option → its class string, for distinctness checks only. */
  classes: Record<string, Record<string, string>>;
  pos: SourcePosition;
}

const FACTORY_SPECIFIER: Record<string, "cva" | "tv"> = {
  "class-variance-authority": "cva",
  "tailwind-variants": "tv",
};

/** Beyond these a config is machine-generated and reading it is guessing. */
const MAX_KEYS = 12;
const MAX_OPTIONS_PER_KEY = 24;

/** Top-level cva()/tv() consts declared in `sf`, keyed by local const name. */
export function extractVariantDefs(
  sf: ts.SourceFile,
  imports: Map<string, ImportBinding>,
): Map<string, VariantDefinition> {
  const out = new Map<string, VariantDefinition>();

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const init = decl.initializer;
      if (!init || !ts.isCallExpression(init)) continue;

      // Provenance: the callee must actually be cva/tv from its real package.
      // Alias-safe — `import { cva as classes }` keeps importedName "cva".
      if (!ts.isIdentifier(init.expression)) continue;
      const binding = imports.get(init.expression.text);
      if (!binding) continue;
      const factory = FACTORY_SPECIFIER[binding.specifier];
      if (!factory) continue;
      const importedName = binding.importedName ?? init.expression.text;
      if (factory === "cva" && importedName !== "cva") continue;
      if (factory === "tv" && importedName !== "tv") continue;

      // cva(base, config) vs tv(config)
      const configArg = factory === "cva" ? init.arguments[1] : init.arguments[0];
      if (!configArg || !ts.isObjectLiteralExpression(configArg)) continue;

      const def = readConfig(decl.name.text, factory, configArg, sf, posOf(decl, sf));
      if (def) out.set(decl.name.text, def);
    }
  }
  return out;
}

function readConfig(
  name: string,
  factory: "cva" | "tv",
  config: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  pos: SourcePosition,
): VariantDefinition | undefined {
  let variantsObj: ts.ObjectLiteralExpression | undefined;
  let defaultsObj: ts.ObjectLiteralExpression | undefined;

  for (const p of config.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = propertyName(p.name);
    // A tv() slots config changes the option-value shape and the prop
    // semantics entirely — bail on the whole definition rather than guess.
    if (key === "slots") return undefined;
    if (key === "variants" && ts.isObjectLiteralExpression(p.initializer)) {
      variantsObj = p.initializer;
    }
    if (key === "defaultVariants" && ts.isObjectLiteralExpression(p.initializer)) {
      defaultsObj = p.initializer;
    }
  }
  if (!variantsObj) return undefined;

  const options: Record<string, PropValue[]> = {};
  const keyPositions: Record<string, SourcePosition> = {};
  const classes: Record<string, Record<string, string>> = {};

  for (const prop of variantsObj.properties) {
    if (Object.keys(options).length >= MAX_KEYS) break;
    // A spread or computed key means we cannot know the full option set for
    // that key — skip the key, keep the rest.
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyName(prop.name);
    if (!key) continue;
    if (!ts.isObjectLiteralExpression(prop.initializer)) continue;

    const names: string[] = [];
    const classFor: Record<string, string> = {};
    let poisoned = false;
    for (const opt of prop.initializer.properties) {
      if (!ts.isPropertyAssignment(opt) && !ts.isShorthandPropertyAssignment(opt)) {
        poisoned = true;
        break;
      }
      const optName = propertyName(opt.name);
      if (!optName) {
        poisoned = true;
        break;
      }
      names.push(optName);
      if (ts.isPropertyAssignment(opt)) {
        const cls = literalValue(opt.initializer);
        if (typeof cls === "string") classFor[optName] = cls.replace(/\s+/g, " ").trim();
      }
    }
    if (poisoned || names.length === 0) continue;
    if (names.length > MAX_OPTIONS_PER_KEY) continue;

    options[key] = asOptionValues(names);
    keyPositions[key] = posOf(prop, sf);
    classes[key] = classFor;
  }

  if (Object.keys(options).length === 0) return undefined;

  const defaults: Record<string, PropValue> = {};
  for (const p of defaultsObj?.properties ?? []) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = propertyName(p.name);
    if (!key || !(key in options)) continue;
    const v = literalValue(p.initializer);
    if (v !== undefined) defaults[key] = v;
  }

  return { name, factory, options, defaults, keyPositions, classes, pos };
}

/** A key whose options are exactly true/false is a real boolean prop. */
function asOptionValues(names: string[]): PropValue[] {
  const isBoolean = names.every((n) => n === "true" || n === "false");
  if (isBoolean) {
    const seen = new Set(names);
    const out: PropValue[] = [];
    if (seen.has("true")) out.push(true);
    if (seen.has("false")) out.push(false);
    return out;
  }
  return names;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  // "icon-xs" and friends are string literals, and they are real option names.
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function literalValue(node: ts.Expression): PropValue | undefined {
  if (ts.isStringLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  return undefined;
}
