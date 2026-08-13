import ts from "typescript";
import type { PropValue } from "../types.ts";

/**
 * Values for props whose type could not be resolved, recovered from how the
 * component indexes with them.
 *
 * `currentStatus: JobStatus` where `JobStatus = z.infer<typeof Schema>` is
 * genuinely unresolvable without a type checker, so it arrives as undefined and
 * `ALLOWED_TRANSITIONS[currentStatus].length` throws before anything renders.
 * But the same file usually declares a lookup keyed by exactly that union:
 *
 *   const STATUS_LABEL: Record<JobStatus, string> = { requested: "Requested", … };
 *   …
 *   STATUS_LABEL[currentStatus]
 *
 * Those keys ARE the union, written out literally. Taking the first is evidence,
 * not inference — and the whole key list makes a real variant matrix.
 *
 * Deliberately narrow: the indexed object must be a top-level const in the same
 * file with an object-literal initialiser and only literal keys. An imported
 * table, a computed key, or a spread inside the literal gives up, because a
 * partial key list would produce a default that is not actually in the union.
 */
export interface IndexKeyResolution {
  /** Prop name → its first observed key. */
  defaults: Record<string, PropValue>;
  /** Prop name → every key, for the variant matrix. */
  options: Record<string, PropValue[]>;
}

export function resolveIndexKeyProps(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  unresolvedProps: string[],
): IndexKeyResolution {
  const out: IndexKeyResolution = { defaults: {}, options: {} };
  if (unresolvedProps.length === 0) return out;
  const wanted = new Set(unresolvedProps);

  const tables = topLevelObjectLiterals(sourceFile);
  if (tables.size === 0) return out;

  const visit = (n: ts.Node): void => {
    if (
      ts.isElementAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      ts.isIdentifier(n.argumentExpression) &&
      wanted.has(n.argumentExpression.text)
    ) {
      const keys = tables.get(n.expression.text);
      const prop = n.argumentExpression.text;
      if (keys && keys.length > 0 && out.defaults[prop] === undefined) {
        out.defaults[prop] = keys[0] as PropValue;
        out.options[prop] = [...keys];
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(bodyNode);

  return out;
}

/** Top-level `const X = { a: …, b: … }` → its literal key list. */
function topLevelObjectLiterals(sourceFile: ts.SourceFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const init = decl.initializer;
      if (!init || !ts.isObjectLiteralExpression(init)) continue;
      const keys = literalKeys(init);
      if (keys) out.set(decl.name.text, keys);
    }
  }
  return out;
}

/** Every key as written, or undefined when any of them is not a literal. */
function literalKeys(obj: ts.ObjectLiteralExpression): string[] | undefined {
  const keys: string[] = [];
  for (const prop of obj.properties) {
    // A spread means the real key set is larger than what is written here, so
    // the first key might not be the first member of the union.
    if (ts.isSpreadAssignment(prop)) return undefined;
    if (!prop.name) return undefined;
    if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
      keys.push(prop.name.text);
      continue;
    }
    return undefined;
  }
  return keys.length > 0 ? keys : undefined;
}
