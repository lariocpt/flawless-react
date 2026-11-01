import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { ModuleResolver, type TsconfigGlobEntry } from "./analyse/resolveModule.ts";
import { ignoreRootFor } from "./nextjs/detect.ts";

/**
 * Merge the suite directory into the TARGET project's tsconfig `exclude`.
 *
 * The generator writes files into the app and the app's own build then chokes
 * on them: after a run, `next build` died type-checking `flawless/host/
 * registry.ts` and the Expo app's `bunx tsc --noEmit` failed with
 * `TS2708: Cannot use namespace 'jest' as a value` across `flawless/unit/
 * *.flawless.test.tsx` — the suite dir sits inside the app's TypeScript
 * program, and the suite's files are Bun/jest/vitest code the app's compiler
 * options were never meant to compile. Both went green by hand by adding
 * `"flawless"` to the app tsconfig's `exclude`; this file makes the tool do
 * it, the same way `packageJson.ts` merges scripts: merge, never clobber, and
 * report what was merged.
 *
 * The file being edited is USER-owned — unlike the harness tsconfig
 * (`flawless/tsconfig.json`), which the tool owns and may rewrite. So the bar
 * here is: a line-level edit when one suffices, existing entries never
 * reordered or reformatted, comments and trailing commas survive, and the
 * file is byte-identical when the answer is already in place.
 */

export interface TsconfigExcludeEdit {
  /** The tsconfig that was (or would be) edited. */
  file: string;
  /** The exclude entry, relative to the config's own dir, POSIX separators. */
  entry: string;
  /** "added" = the file changed; "kept" = already excluded, nothing written. */
  status: "added" | "kept";
}

/**
 * Ensure the suite directory is excluded from the TypeScript program that
 * would otherwise compile it, editing the nearest tsconfig that actually
 * claims it. Returns undefined when nothing was edited — no tsconfig in the
 * project, none whose program sees the suite, or an unparseable candidate.
 *
 * Which config gets the edit is the whole design question, and the answer is
 * "the one whose program breaks": walk UP from the suite dir's parent and
 * take the first tsconfig whose EFFECTIVE include covers the suite dir and
 * whose EFFECTIVE exclude does not already cover it. Nearest-first is what
 * makes the monorepo case fall out — `apps/web` and `apps/mobile` each own a
 * tsconfig, and the suite inside `apps/web` is `apps/web/tsconfig.json`'s
 * problem, never the root's. A config whose `include` does not reach the
 * suite is skipped rather than edited: an exclude entry for files that were
 * never in the program is noise a reviewer rightly objects to, and the walk
 * continues in case a higher config (a repo-root tsconfig with a default
 * include) does claim the dir. No tsconfig at all means no edit — creating a
 * config the project never had is a bigger intrusion than the defect.
 *
 * "Effective" is measured through the `extends` chain via ModuleResolver: a
 * base config that already excludes the suite must not provoke a duplicate
 * in the child, and inherited patterns stay anchored to the config that
 * declared them.
 */
export function ensureSuiteExcluded(
  outDir: string,
  resolver = new ModuleResolver(),
): TsconfigExcludeEdit | undefined {
  const suiteDir = path.resolve(outDir);
  if (!existsSync(suiteDir)) return undefined;
  // The same boundary the gitignore pass uses: never edit above the project.
  const boundary = ignoreRootFor(outDir);
  let dir = path.dirname(suiteDir);
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (existsSync(candidate)) {
      const edit = ensureExcludedIn(candidate, suiteDir, resolver);
      if (edit) return edit;
    }
    if (dir === boundary) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function ensureExcludedIn(
  configPath: string,
  suiteDir: string,
  resolver: ModuleResolver,
): TsconfigExcludeEdit | undefined {
  // JSONC is legal here (comments, trailing commas) — ts.readConfigFile is
  // the parser the repo already ships for exactly this, and it is also the
  // bail signal: an unparseable tsconfig is not rewritten, ever.
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return undefined;
  const { exclude, include } = resolver.topLevelFor(configPath);
  const entry = suiteEntry(configPath, suiteDir);
  if (exclude && excludeCovers(exclude, suiteDir))
    return { file: configPath, entry, status: "kept" };
  if (include && !includeCovers(include, suiteDir)) return undefined;
  const source = readFileSync(configPath, "utf8");
  const merged = addExcludeEntry(source, entry);
  if (merged.changed) writeFileSync(configPath, merged.text);
  return { file: configPath, entry, status: merged.changed ? "added" : "kept" };
}

/** The suite dir as an exclude entry, relative to the config's dir. */
function suiteEntry(configPath: string, suiteDir: string): string {
  return path.relative(path.dirname(configPath), suiteDir).split(path.sep).join("/");
}

/** Normalize an exclude/include pattern: forward slashes, no leading "./". */
function normalizePattern(entry: string): string {
  return entry.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Does any effective exclude pattern cover the suite dir? TS exclude entries
 * are globs relative to the declaring config; the forms that matter here are
 * a plain dir (which excludes everything under it), a trailing-star dir
 * (`flawless` + `/**`) and a double-star basename pattern. Anything
 * more exotic is not matched — the conservative direction adds an entry the
 * user can prune, rather than silently leaving the program broken.
 */
export function excludeCovers(entries: TsconfigGlobEntry[], suiteDir: string): boolean {
  for (const { entry, baseDir } of entries) {
    const norm = normalizePattern(entry);
    if (!norm) continue;
    if (norm.startsWith("**/")) {
      const rest = norm.slice(3).replace(/\/+$/, "");
      if (!rest.includes("*") && path.basename(suiteDir) === rest) return true;
      continue;
    }
    const star = norm.indexOf("*");
    const prefix = (star === -1 ? norm : norm.slice(0, star)).replace(/\/+$/, "");
    if (prefix === "") continue;
    const abs = path.resolve(baseDir, prefix);
    if (suiteDir === abs || suiteDir.startsWith(abs + path.sep)) return true;
  }
  return false;
}

/**
 * Does any effective include pattern reach the suite dir? When no config in
 * the chain declares `include`, TS includes everything under the config's
 * dir — the caller models that default by treating an undefined include as
 * covering. A pattern covers the dir when it names it, names an ancestor of
 * it (`src`, a `**` glob), or sits inside it (`flawless/specs/` + `**`).
 */
export function includeCovers(entries: TsconfigGlobEntry[], suiteDir: string): boolean {
  for (const { entry, baseDir } of entries) {
    const norm = normalizePattern(entry);
    if (!norm) continue;
    const star = norm.indexOf("*");
    const prefix = (star === -1 ? norm : norm.slice(0, star)).replace(/\/+$/, "");
    const abs = prefix === "" ? baseDir : path.resolve(baseDir, prefix);
    if (
      suiteDir === abs ||
      suiteDir.startsWith(abs + path.sep) ||
      abs.startsWith(suiteDir + path.sep)
    )
      return true;
  }
  return false;
}

/**
 * Add `entry` to the top-level `exclude` array of a JSONC tsconfig, by line
 * level edit, preserving the file's own formatting.
 *
 * The array is located by a scanner that skips strings and both comment
 * forms, so a `"exclude"` inside a nested object or a comment cannot be
 * mistaken for the top-level key. When the key exists, the entry is inserted
 * after the array's last element — same line for a single-line array, a new
 * line at the last element's indent for a multi-line one — and nothing else
 * moves: comments inside the array, trailing commas, and every other byte
 * survive. When the key is absent, one key line is inserted before the last
 * closing brace at the file's own indent; the file is NOT re-serialised,
 * because re-serialising JSONC drops the comments.
 *
 * Byte-identical (changed: false) when the entry is already present verbatim.
 */
export function addExcludeEntry(source: string, entry: string): { text: string; changed: boolean } {
  const scan = scanTopLevel(source);
  if (scan.excludeKey) {
    // An `exclude` that is not an array is a shape this tool will not guess
    // at — leave the file exactly as it is.
    if (scan.excludeOpen === -1) return { text: source, changed: false };
    if (scan.excludeEntries.includes(entry)) return { text: source, changed: false };
    const inner = source.slice(scan.excludeOpen + 1, scan.excludeClose);
    const multiline = inner.includes("\n");
    const insertAt = scan.lastElementEnd === -1 ? scan.excludeOpen + 1 : scan.lastElementEnd + 1;
    let text: string;
    if (scan.lastElementEnd === -1) {
      text = multiline
        ? `\n${lineIndentOf(source, scan.excludeOpen)}${INDENT_FALLBACK}"${entry}"`
        : `"${entry}"`;
    } else {
      text = multiline
        ? `,\n${lineIndentOf(source, scan.lastElementEnd)}"${entry}"`
        : `, "${entry}"`;
    }
    return {
      text: source.slice(0, insertAt) + text + source.slice(insertAt),
      changed: true,
    };
  }
  if (scan.finalBrace === -1) return { text: source, changed: false };
  const indent = scan.keyIndent || INDENT_FALLBACK;
  const last = lastMeaningfulPos(source, scan.finalBrace, scan.firstBrace);
  if (last === -1) {
    // `{}` (or only comments): open the object onto its own lines.
    const braceIndent = lineIndentOf(source, scan.finalBrace);
    const insert = `\n${indent}"exclude": ["${entry}"]\n${braceIndent}`;
    return {
      text: source.slice(0, scan.finalBrace) + insert + source.slice(scan.finalBrace),
      changed: true,
    };
  }
  // Insert directly after the last member (and its trailing comma, if it
  // carries one) rather than before the closing brace, so whatever newline
  // already sits there is kept instead of doubled into a blank line.
  const comma = source[last] === "," ? "" : ",";
  const insert = `${comma}\n${indent}"exclude": ["${entry}"]`;
  return {
    text: source.slice(0, last + 1) + insert + source.slice(last + 1),
    changed: true,
  };
}

const INDENT_FALLBACK = "  ";

interface TopLevelScan {
  excludeKey: boolean;
  /** Span of the top-level `exclude` array value when it is one; -1 otherwise. */
  excludeOpen: number;
  excludeClose: number;
  /** Index of the closing quote of the array's last string element, or -1. */
  lastElementEnd: number;
  /** Raw string values already in the array. */
  excludeEntries: string[];
  /** Index of the final top-level `}`. */
  finalBrace: number;
  /** Index of the opening top-level `{` — the backward member scan's floor. */
  firstBrace: number;
  /** Leading whitespace of the line holding the first top-level key. */
  keyIndent: string;
  hasMember: boolean;
}

/**
 * One pass over the file tracking string and comment state, so the top-level
 * `exclude` array and the final closing brace can be located by position.
 * Only the shapes the merge needs are recorded; anything unparseable simply
 * yields -1s and the caller leaves the file alone.
 */
function scanTopLevel(src: string): TopLevelScan {
  const out: TopLevelScan = {
    excludeKey: false,
    excludeOpen: -1,
    excludeClose: -1,
    lastElementEnd: -1,
    excludeEntries: [],
    finalBrace: -1,
    firstBrace: -1,
    keyIndent: "",
    hasMember: false,
  };
  const stack: string[] = [];
  let pendingKey: string | undefined;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const n = src.indexOf("\n", i);
      i = n === -1 ? src.length : n + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const n = src.indexOf("*/", i + 2);
      i = n === -1 ? src.length : n + 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        j++;
      }
      const value = src.slice(i + 1, j);
      if (stack.length === 1 && stack[0] === "{") {
        const next = nextMeaningful(src, j + 1);
        if (src[next] === ":") {
          pendingKey = value;
          out.hasMember = true;
          if (!out.keyIndent) out.keyIndent = lineIndentOf(src, i);
          if (value === "exclude") out.excludeKey = true;
        }
      } else if (
        stack.length === 2 &&
        stack[0] === "{" &&
        stack[1] === "[" &&
        pendingKey === "exclude"
      ) {
        out.excludeEntries.push(value);
        out.lastElementEnd = j;
      }
      i = j + 1;
      continue;
    }
    if (c === "{" || c === "[") {
      if (stack.length === 0 && c === "{") out.firstBrace = i;
      if (stack.length === 1 && stack[0] === "{" && c === "[" && pendingKey === "exclude") {
        out.excludeOpen = i;
      }
      stack.push(c);
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      if (
        stack.length === 2 &&
        stack[0] === "{" &&
        stack[1] === "[" &&
        c === "]" &&
        pendingKey === "exclude"
      ) {
        out.excludeClose = i;
      }
      stack.pop();
      if (stack.length === 0 && c === "}") out.finalBrace = i;
      i++;
      continue;
    }
    i++;
  }
  return out;
}

/** Leading whitespace of the line containing index `at`. */
function lineIndentOf(src: string, at: number): string {
  const lineStart = src.lastIndexOf("\n", at - 1) + 1;
  const m = /^[ \t]*/.exec(src.slice(lineStart, at));
  return m ? m[0] : "";
}

/** Index of the next non-whitespace char at or after `from`, skipping comments. */
function nextMeaningful(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const n = src.indexOf("\n", i);
      i = n === -1 ? src.length : n + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const n = src.indexOf("*/", i + 2);
      i = n === -1 ? src.length : n + 2;
      continue;
    }
    return i;
  }
  return i;
}

/**
 * Index of the last meaningful character before the final `}` — the member
 * content a new key must follow — or -1 when the object holds no members
 * (whitespace, comments, and the opening `{` itself do not count).
 */
function lastMeaningfulPos(src: string, finalBrace: number, firstBrace: number): number {
  let i = finalBrace - 1;
  while (i > firstBrace) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i--;
      continue;
    }
    if (c === "/" && src[i - 1] === "/") {
      i = src.lastIndexOf("\n", i - 2);
      continue;
    }
    if (c === "/" && src[i - 1] === "*") {
      i = src.lastIndexOf("/*", i - 2);
      if (i === -1) return -1;
      i--;
      continue;
    }
    return i;
  }
  return -1;
}
