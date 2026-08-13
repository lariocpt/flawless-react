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
      if (stmt.name) out.add(stmt.name.text);
      continue;
    }
    // `export { a, b as c }` — the exported name is what importers bind to.
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) out.add(el.name.text);
    }
  }
  return [...out].sort();
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
