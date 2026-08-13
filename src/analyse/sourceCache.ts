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
export class SourceFileCache {
  private files = new Map<string, ts.SourceFile | null>();

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
