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
   *  it came from and the name that module uses (`useY` for `useZ`). The same
   *  entry is recorded for a name the file imported and handed back out with a
   *  module-less `export { … }`. */
  named: Map<string, { specifier: string; imported: string }[]>;
  /** The bare `export * from './m'` specifiers, which carry every name. */
  stars: string[];
}

const EMPTY: ReexportTable = { named: new Map(), stars: [] };

/**
 * Read a source file's hand-offs. Forms that are NOT a hand-off of one of the
 * target's names: `export * as ns from './m'`, which exposes the namespace
 * rather than a member, `export type { T } from './m'`, which is erased, and
 * `export { useLocal }` of a name the file declares, which is its own.
 * The bare star is the clauseless form in this parser (typescript 5.9.3,
 * probed); a NamespaceExport with an empty name is the same thing written the
 * other way, so both are read as a star.
 */
export function reexportTableOf(sourceFile: ts.SourceFile): ReexportTable {
  const named = new Map<string, { specifier: string; imported: string }[]>();
  const stars: string[] = [];
  const add = (exported: string, hop: { specifier: string; imported: string }) => {
    const arr = named.get(exported);
    if (arr) arr.push(hop);
    else named.set(exported, [hop]);
  };
  // The local name → where it came from, read only if the file has a
  // module-less `export { … }` clause to answer for.
  let imported: Map<string, { specifier: string; imported: string }> | undefined;
  const importedBindings = () => {
    if (!imported) {
      imported = new Map();
      for (const stmt of sourceFile.statements) {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const bindings = stmt.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const el of bindings.elements) {
          imported.set(el.name.text, {
            specifier: stmt.moduleSpecifier.text,
            imported: (el.propertyName ?? el.name).text,
          });
        }
      }
    }
    return imported;
  };
  for (const stmt of sourceFile.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.isTypeOnly) continue;
    const ref = stmt.moduleSpecifier;
    const clause = stmt.exportClause;
    if (!ref) {
      // `import { Card } from './card'; export { Card }` — ESM counts that as an
      // export of this module, and it is how a package republishes a component
      // it does not own. Only a name the file IMPORTED is a hand-off.
      if (!clause || !ts.isNamedExports(clause)) continue;
      const byLocal = importedBindings();
      for (const spec of clause.elements) {
        const hop = byLocal.get((spec.propertyName ?? spec.name).text);
        if (hop) add(spec.name.text, hop);
      }
      continue;
    }
    if (!ts.isStringLiteral(ref)) continue;
    if (!clause || (ts.isNamespaceExport(clause) && !clause.name.text)) {
      if (!stars.includes(ref.text)) stars.push(ref.text);
      continue;
    }
    if (!ts.isNamedExports(clause)) continue;
    for (const spec of clause.elements) {
      add(spec.name.text, {
        specifier: ref.text,
        imported: spec.propertyName?.text ?? spec.name.text,
      });
    }
  }
  // A file with no hand-offs — which is most files — shares one empty table
  // instead of allocating a map per parse.
  return named.size === 0 && stars.length === 0 ? EMPTY : { named, stars };
}

/** What `followHandoff` needs from its caller: read a file's syntax tree,
 *  resolve a specifier the way the importer would, and say whether a file
 *  declares a name. A component and a hook are found by different lookups, so
 *  the caller decides. */
export interface HandoffReader {
  read: (file: string) => Promise<ts.SourceFile | undefined> | ts.SourceFile | undefined;
  resolve: (specifier: string, fromFile: string) => string | undefined;
  declares: (file: string, name: string) => Promise<boolean> | boolean;
}

/**
 * Follow `name` from `file` through its hand-offs to the module that DECLARES
 * it — the caller checks its own file first, this answers only for the hop.
 *
 * Named hand-offs are exact, so they go first and a star is consulted only when
 * no named hop carries the name. A hop whose module does not resolve, or whose
 * target does not answer for the name, ends that hop rather than the search:
 * `export * from './ui'` pointing at nothing must not lose the sibling that
 * does hold it. The seen-set makes a barrel cycle cost one visit.
 */
export async function followHandoff(
  file: string,
  name: string,
  reader: HandoffReader,
): Promise<{ file: string; name: string } | undefined> {
  const seen = new Set<string>();
  const search = async (
    file: string,
    name: string,
  ): Promise<{ file: string; name: string } | undefined> => {
    const key = `${file}::${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const source = await reader.read(file);
    if (!source) return undefined;
    const table = reexportTableOf(source);
    const hops = table.named.get(name) ?? [];
    for (const hop of hops) {
      const target = reader.resolve(hop.specifier, file);
      if (!target) continue;
      if (await reader.declares(target, hop.imported)) return { file: target, name: hop.imported };
      const deeper = await search(target, hop.imported);
      if (deeper) return deeper;
    }
    if (hops.length > 0) return undefined;
    for (const spec of table.stars) {
      const target = reader.resolve(spec, file);
      if (!target) continue;
      if (await reader.declares(target, name)) return { file: target, name };
      const deeper = await search(target, name);
      if (deeper) return deeper;
    }
    return undefined;
  };
  return search(file, name);
}
