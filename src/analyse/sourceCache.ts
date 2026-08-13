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
