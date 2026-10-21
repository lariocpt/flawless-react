import ts from "typescript";

/**
 * What a file hands to another module instead of declaring: the re-export
 * table. Feature-Sliced apps are built out of these — a slice's `index.ts` is
 * `export * from './model'`, and the model index is
 * `export { useRateQuery } from './queries'` — so the name a component imports
 * is usually not one the imported file declares.
 */
export interface ReexportTable {
  /** `export { useX, useY as useZ } from './m'`: the EXPORTED name → the module
   *  it came from and the name that module uses (`useY` for `useZ`). */
  named: Map<string, { specifier: string; imported: string }[]>;
  /** The bare `export * from './m'` specifiers, which carry every name. */
  stars: string[];
}

const EMPTY: ReexportTable = { named: new Map(), stars: [] };

/**
 * Read a source file's hand-offs. Forms that are NOT a hand-off of one of the
 * target's names: `export * as ns from './m'`, which exposes the namespace
 * rather than a member, and `export type { T } from './m'`, which is erased.
 * The bare star is the clauseless form in this parser (typescript 5.9.3,
 * probed); a NamespaceExport with an empty name is the same thing written the
 * other way, so both are read as a star.
 */
export function reexportTableOf(sourceFile: ts.SourceFile): ReexportTable {
  const named = new Map<string, { specifier: string; imported: string }[]>();
  const stars: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.isTypeOnly) continue;
    const ref = stmt.moduleSpecifier;
    if (!ref || !ts.isStringLiteral(ref)) continue;
    const clause = stmt.exportClause;
    if (!clause || (ts.isNamespaceExport(clause) && !clause.name.text)) {
      if (!stars.includes(ref.text)) stars.push(ref.text);
      continue;
    }
    if (!ts.isNamedExports(clause)) continue;
    for (const spec of clause.elements) {
      const hop = { specifier: ref.text, imported: spec.propertyName?.text ?? spec.name.text };
      const arr = named.get(spec.name.text);
      if (arr) arr.push(hop);
      else named.set(spec.name.text, [hop]);
    }
  }
  // A file with no hand-offs — which is most files — shares one empty table
  // instead of allocating a map per parse.
  return named.size === 0 && stars.length === 0 ? EMPTY : { named, stars };
}
