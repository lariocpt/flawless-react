import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * Parsed-source cache for the secondary files the analyser reads while
 * resolving types across modules. Without it, every `ComponentProps<typeof X>`
 * and every imported props type re-reads and re-parses the same file — the
 * shadcn pattern makes that happen dozens of times per run.
 *
 * Failures are cached as misses too, so an unreadable path is attempted once.
 */
/**
 * The leading prologue directive of a module, tolerating a license header or
 * any run of comments before it. Shared so "use client" and "use server" cannot
 * drift apart.
 *
 * The scan is head-bounded, deliberately: this runs once per IMPORTED module
 * in a sweep, not once per file, and full-parsing to find a one-line directive
 * would multiply the parse count by the import fan-out. 64KB covers any
 * realistic license banner (the longest common ones run ~2–4KB) with slack; a
 * directive hidden behind a LARGER header is the acknowledged miss of the
 * bound — misclassified as not carrying it — and would need the bound raised,
 * not the regex changed.
 */
export function readPrologueDirective(file: string): string | undefined {
  try {
    const head = readFileSync(file, "utf8").slice(0, 65536);
    const m = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']([^"']+)["']\s*;?/.exec(head);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Top-level export names of a module.
 *
 * Needed to stub a "use server" module for the browser bundle: exporting only
 * the names a component imports directly leaves a transitive importer — the
 * zustand store importing logoutAction, say — with "No matching export", and the
 * bundle fails just as hard as it did unstubbed.
 */
export function exportedNames(sf: ts.SourceFile): string[] {
  const out = new Set<string>();
  for (const stmt of sf.statements) {
    const exported = ts.canHaveModifiers(stmt)
      ? ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (ts.isVariableStatement(stmt) && exported) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.add(d.name.text);
      }
      continue;
    }
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && exported) {
      // `export default function doSave()` exports "default", not "doSave" —
      // the name is only local. Recording the name handed the server-action
      // stub a named export the module never had, so a real default import
      // failed to bind against it.
      const isDefault = ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (isDefault) out.add("default");
      else if (stmt.name) out.add(stmt.name.text);
      continue;
    }
    // `export { a, b as c }` — the exported name is what importers bind to.
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) out.add(el.name.text);
    }
  }
  return [...out].sort();
}

/**
 * The module and module-side name a local binding was imported under.
 *
 * `import type { User as U } from "./x"` looked up as "U" gives
 * `{ specifier: "./x", importedName: "User" }`. Default and namespace imports
 * are not reported: neither names a single exported declaration this chase can
 * continue to.
 */
function importedFrom(
  sf: ts.SourceFile,
  local: string,
): { specifier: string; importedName: string } | undefined {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.name.text !== local) continue;
      return {
        specifier: stmt.moduleSpecifier.text,
        importedName: (el.propertyName ?? el.name).text,
      };
    }
  }
  return undefined;
}

/** Where a re-export chase landed: the declaring file and its parse. */
export interface RelocatedExport<T> {
  sf: ts.SourceFile;
  file: string;
  decl: T;
}

/** Barrel chains deeper than this are machine-generated; stop looking. */
const MAX_RELOCATION_DEPTH = 8;
/** Runaway backstop across the whole walk — cycles are caught by `visited`,
 * so this only stops pathological generated fan-outs. It counts file::name
 * pairs, NOT breadth per level: a wide shadcn-style barrel (40+ star arms)
 * must still reach its last arm. */
const MAX_RELOCATION_FILES = 512;

/**
 * Find `name`'s declaration starting at `file`, chasing barrel re-exports.
 * ESM semantics drive the order inside each file: a matching declaration
 * first, then local export clauses (`export { Real as Renamed };` — the
 * clause itself makes the local declaration exported), then explicit
 * re-export clauses (`export { A as B } from "./x"`, rename-aware — these
 * SHADOW star exports), then star re-exports (`export * from "./x"`) in
 * declaration order. `export * as ns from` exports one namespace object,
 * never the names behind it, and is not followed.
 *
 * `find` receives `viaReexport: true` for every file reached through a
 * re-export chain — matchers use it to refuse non-exported declarations,
 * which a star chase must never bind (a private same-named interface in an
 * earlier arm would silently produce a wrong-shape fixture).
 *
 * Depth-bounded and cycle-guarded, deliberately NOT the props hop budget:
 * component → barrel → types.ts would exhaust MAX_HOPS before a single
 * member resolved, and relocation is finding where a name LIVES, not a
 * semantic resolution hop.
 */
export function findExportedDecl<T>(
  file: string,
  name: string,
  cache: SourceFileCache,
  resolver: { resolve(spec: string, importer: string): string | undefined } | undefined,
  find: (sf: ts.SourceFile, name: string, viaReexport: boolean) => T | undefined,
  // For lookups reached through an IMPORT binding, the root file must vouch
  // only for its exports too: TS never binds a private declaration to an
  // import, so a private same-named decl in the directly-resolved module
  // shadowing a star re-export would produce a type-illegal result. Local
  // export clauses stay permissive — the clause itself vouches.
  requireExportAtRoot = false,
): RelocatedExport<T> | undefined {
  const visited = new Set<string>();
  const walk = (f: string, wanted: string, depth: number): RelocatedExport<T> | undefined => {
    const key = `${f}::${wanted}`;
    if (visited.has(key) || depth > MAX_RELOCATION_DEPTH || visited.size >= MAX_RELOCATION_FILES)
      return undefined;
    visited.add(key);
    const sf = cache.get(f);
    if (!sf) return undefined;
    const hit = find(sf, wanted, depth > 0 || requireExportAtRoot);
    if (hit !== undefined) return { sf, file: f, decl: hit };

    const localClauses: ts.NamedExports[] = [];
    const named: Array<{ clause: ts.NamedExports; spec: string }> = [];
    const stars: string[] = [];
    for (const stmt of sf.statements) {
      if (!ts.isExportDeclaration(stmt)) continue;
      if (!stmt.moduleSpecifier) {
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          localClauses.push(stmt.exportClause);
        }
        continue;
      }
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      if (stmt.exportClause) {
        if (ts.isNamedExports(stmt.exportClause)) {
          named.push({ clause: stmt.exportClause, spec: stmt.moduleSpecifier.text });
        }
        continue;
      }
      stars.push(stmt.moduleSpecifier.text);
    }

    for (const clause of localClauses) {
      for (const el of clause.elements) {
        if (el.name.text !== wanted) continue;
        const local = (el.propertyName ?? el.name).text;
        const localHit = find(sf, local, false);
        if (localHit !== undefined) return { sf, file: f, decl: localHit };
        // No local DECLARATION of that name — but the file may have imported it
        // and re-exported the binding:
        //
        //   import type { User } from "@scope/shared";
        //   export type { User };
        //
        // ESM treats that as an export of this module, and it is how a package
        // republishes a type it does not own. The chase stopped here, so a
        // function annotated `Promise<User>` behind such a file resolved to
        // nothing — which on the dogfood app is every export of lib/dal.ts.
        const from = importedFrom(sf, local);
        if (from) {
          const target = resolver?.resolve(from.specifier, f);
          if (target) {
            const relocated = walk(target, from.importedName, depth + 1);
            if (relocated) return relocated;
          }
        }
      }
    }
    for (const { clause, spec } of named) {
      for (const el of clause.elements) {
        if (el.name.text !== wanted) continue;
        const target = resolver?.resolve(spec, f);
        if (!target) continue;
        const relocated = walk(target, (el.propertyName ?? el.name).text, depth + 1);
        if (relocated) return relocated;
      }
    }
    for (const spec of stars) {
      const target = resolver?.resolve(spec, f);
      if (!target) continue;
      const relocated = walk(target, wanted, depth + 1);
      if (relocated) return relocated;
    }
    return undefined;
  };
  return walk(file, name, 0);
}

export class SourceFileCache {
  private files = new Map<string, ts.SourceFile | null>();
  private directives = new Map<string, string | null>();

  /**
   * True iff `abs` opens with the given prologue directive. Reads the file head
   * only — full-parsing every imported module to answer this would multiply the
   * parse count by the import fan-out of every entry file in a sweep.
   */
  hasPrologueDirective(abs: string, directive: string): boolean {
    let hit = this.directives.get(abs);
    if (hit === undefined) {
      hit = readPrologueDirective(abs) ?? null;
      this.directives.set(abs, hit);
    }
    return hit === directive;
  }

  /** Parse `abs` as TSX. Undefined on any read/parse failure. */
  get(abs: string): ts.SourceFile | undefined {
    const hit = this.files.get(abs);
    if (hit !== undefined) return hit ?? undefined;
    let sf: ts.SourceFile | null = null;
    try {
      sf = ts.createSourceFile(
        abs,
        readFileSync(abs, "utf8"),
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.TSX,
      );
    } catch {
      sf = null;
    }
    this.files.set(abs, sf);
    return sf ?? undefined;
  }
}
