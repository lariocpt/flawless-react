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
 */
export function readPrologueDirective(file: string): string | undefined {
  try {
    const head = readFileSync(file, "utf8").slice(0, 4096);
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

/** Where a re-export chase landed: the declaring file and its parse. */
export interface RelocatedExport<T> {
  sf: ts.SourceFile;
  file: string;
  decl: T;
}

/** Barrel chains beyond this are machine-generated or cyclic; stop looking. */
const MAX_RELOCATION_FILES = 32;

/**
 * Find `name`'s declaration starting at `file`, chasing barrel re-exports:
 * on a miss, named re-exports (`export { A as B } from "./x"`, rename-aware)
 * and star re-exports (`export * from "./x"`) are followed in declaration
 * order, first hit wins. `export * as ns from` exports one namespace object,
 * never the names behind it, and is not followed.
 *
 * Bounded by a visited set (file::name, capped), deliberately NOT the props
 * hop budget: component → barrel → types.ts would exhaust MAX_HOPS before a
 * single member resolved, and relocation is finding where a name LIVES, not
 * a semantic resolution hop. Cycles (a→b→a) terminate on the visited set.
 */
export function findExportedDecl<T>(
  file: string,
  name: string,
  cache: SourceFileCache,
  resolver: { resolve(spec: string, importer: string): string | undefined } | undefined,
  find: (sf: ts.SourceFile, name: string) => T | undefined,
): RelocatedExport<T> | undefined {
  const visited = new Set<string>();
  const walk = (f: string, wanted: string): RelocatedExport<T> | undefined => {
    const key = `${f}::${wanted}`;
    if (visited.has(key) || visited.size >= MAX_RELOCATION_FILES) return undefined;
    visited.add(key);
    const sf = cache.get(f);
    if (!sf) return undefined;
    const hit = find(sf, wanted);
    if (hit !== undefined) return { sf, file: f, decl: hit };
    for (const stmt of sf.statements) {
      if (!ts.isExportDeclaration(stmt)) continue;
      if (!stmt.moduleSpecifier || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
      if (stmt.exportClause && !ts.isNamedExports(stmt.exportClause)) continue;
      const target = resolver?.resolve(stmt.moduleSpecifier.text, f);
      if (!target) continue;
      if (stmt.exportClause) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text !== wanted) continue;
          const relocated = walk(target, (el.propertyName ?? el.name).text);
          if (relocated) return relocated;
        }
        continue;
      }
      const relocated = walk(target, wanted);
      if (relocated) return relocated;
    }
    return undefined;
  };
  return walk(file, name);
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
