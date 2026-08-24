import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { VERSION } from "../version.ts";

/**
 * Provenance stamps for colocated specs — the files written beside the user's
 * sources, where hand-hardening is the whole point. The first line records a
 * hash of everything BELOW it, so `--force` can tell "still exactly what we
 * generated" (safe to rewrite) from "someone worked on this" (never clobber).
 *
 * The hash excludes the stamp line for the obvious fixed-point reason, and is
 * recomputed after the host project's formatter runs (restampGenerated below):
 * a stamp of the raw render would mismatch the formatted bytes on disk, and
 * every untouched spec would read as hand-edited on the next --force.
 *
 * Deleting the stamp line demotes a file to "pre-stamp": kept by --force and
 * reported separately. That is deliberate — the escape hatch for both states
 * is the same: delete the file to regenerate it.
 */

/** First line only; the terminator tolerates files converted to CRLF. */
export const STAMP_RE = /^\/\/ @flawless-generated sha256:([0-9a-f]{16}) flawless-react@(\S+)\r?\n/;

/** First 16 sha256 hex chars — collision-proof enough for "did a human touch this". */
export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export function stamp(body: string, version: string = VERSION): string {
  return `// @flawless-generated sha256:${hashBody(body)} flawless-react@${version}\n${body}`;
}

export interface SplitStamp {
  hash?: string;
  version?: string;
  /** Everything below the stamp line; the whole text when there is none. */
  body: string;
}

export function splitStamp(text: string): SplitStamp {
  const m = text.match(STAMP_RE);
  if (!m) return { body: text };
  return { hash: m[1], version: m[2], body: text.slice(m[0].length) };
}

export function classifyStamped(text: string): "untouched" | "edited" | "stampless" {
  const { hash, body } = splitStamp(text);
  if (hash === undefined) return "stampless";
  return hashBody(body) === hash ? "untouched" : "edited";
}

/**
 * Re-align stamps with what is actually on disk, after a formatter may have
 * rewritten the freshly written files. Only files whose FIRST line is a stamp
 * are touched, so callers pass the whole written set unfiltered; the stamp's
 * own version field is preserved because the restamp is bookkeeping, not a
 * regeneration. Returns how many files were rewritten.
 */
export async function restampGenerated(paths: string[]): Promise<number> {
  let restamped = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const { hash, version, body } = splitStamp(await readFile(p, "utf8"));
    if (hash === undefined || version === undefined) continue;
    const fresh = hashBody(body);
    if (fresh === hash) continue;
    // The stamp line follows the body's own line-ending convention: a host
    // formatter set to CRLF converted the whole file, and writing "\n" here
    // would hand that formatter a mixed-EOL file to churn straight back.
    const eol = body.includes("\r\n") ? "\r\n" : "\n";
    await writeFile(
      p,
      `// @flawless-generated sha256:${fresh} flawless-react@${version}${eol}${body}`,
    );
    restamped++;
  }
  return restamped;
}
