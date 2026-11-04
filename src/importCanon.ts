/**
 * Canonical import emission — the emitted suite must be a fixed point of the
 * project's own biome organizeImports, on hosts where no style pass runs to
 * sort after the fact. The rules here are not invented: they are biome 2.5.1's
 * organizeImports algorithm, ported from its sources (tag @biomejs/biome@2.5.1):
 *
 * - crates/biome_string_case/src/lib.rs            (Collator::cmp, the two
 *   collation tables, ascii_collation_weight_from — which INVERTS the table:
 *   weight[collation[i]] = i, so uppercase sorts before its lowercase:
 *   A < a < B < b.)
 * - crates/biome_rule_options/src/organize_imports/import_source.rs
 *   (ImportSourceKind order Unknown < Url < ProtocolPackage < Package <
 *   Alias < Path; Path proximity: / < ../.. < .. < . < ./x, natural digits.)
 * - crates/biome_js_analyze/src/assist/source/organize_imports.rs
 *   (chunks: a bare import is its own chunk, a non-import statement ends a
 *   chunk, a comment followed by a blank line is detached and starts a chunk,
 *   a file-header comment is always detached; attached comments travel with
 *   their import; within a chunk sort by source, then attributes-first, then
 *   statement kind; named specifiers sort by local name.)
 *
 * The weight tables below were parsed out of those sources and inverted by
 * the same rule; the unit tests in tests/importCanon.test.ts pin them against
 * the shipped Rust unit tests and against every reorder the 2.5.1 binary
 * performs on the emitted corpus.
 */

const CLDR_WEIGHTS: number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 28, 29, 30, 31, 32, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 33, 39, 43, 55, 65, 56, 54, 42, 44, 45, 51, 59, 36, 35, 41, 52, 66, 67, 68,
  69, 70, 71, 72, 73, 74, 75, 38, 37, 60, 61, 62, 40, 50, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94,
  96, 98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 46, 53, 47, 58, 34,
  57, 77, 79, 81, 83, 85, 87, 89, 91, 93, 95, 97, 99, 101, 103, 105, 107, 109, 111, 113, 115, 117,
  119, 121, 123, 125, 127, 48, 63, 49, 64, 27, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137,
  138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156,
  157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175,
  176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194,
  195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213,
  214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232,
  233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251,
  252, 253, 254, 255,
];

const SOURCE_WEIGHTS: number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 28, 29, 30, 31, 32, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, 26, 44, 49, 64, 36, 51, 50, 38, 63, 52, 53, 48, 47, 40, 46, 43, 33, 66, 67, 68,
  69, 70, 71, 72, 73, 74, 75, 42, 39, 58, 37, 59, 35, 41, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94,
  96, 98, 100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 54, 34, 55, 61, 45,
  65, 77, 79, 81, 83, 85, 87, 89, 91, 93, 95, 97, 99, 101, 103, 105, 107, 109, 111, 113, 115, 117,
  119, 121, 123, 125, 127, 56, 60, 57, 62, 27, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137,
  138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156,
  157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 173, 174, 175,
  176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194,
  195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213,
  214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232,
  233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251,
  252, 253, 254, 255,
];

/**
 * Port of biome_string_case::Collator::cmp: per-byte weight comparison with
 * natural-number runs (9 < 10), prefix sorts first.
 */
function collate(weights: number[], a: string, b: string): number {
  let i = 0;
  let j = 0;
  let prev: number | undefined;
  const digit = (c: number) => (c >= 48 && c <= 57 ? c : undefined);
  for (;;) {
    const c1 = i < a.length ? a.charCodeAt(i) : undefined;
    const c2 = j < b.length ? b.charCodeAt(j) : undefined;
    if (c1 === undefined && c2 === undefined) return 0;
    if (c1 === undefined) return -1;
    if (c2 === undefined) return 1;
    if (c1 === c2) {
      prev = c1;
      i++;
      j++;
      continue;
    }
    let numberOrdering = 0;
    let x1 = c1;
    let x2 = c2;
    for (;;) {
      const d1 = digit(x1);
      const d2 = digit(x2);
      if (d1 === undefined && d2 === undefined) {
        if (numberOrdering === 0) break;
        return numberOrdering;
      }
      if (d1 === undefined && d2 !== undefined) {
        if (prev !== undefined && digit(prev) !== undefined) return -1;
        break;
      }
      if (d1 !== undefined && d2 === undefined) {
        if (prev !== undefined && digit(prev) !== undefined) return 1;
        break;
      }
      if (d1 !== undefined && d2 !== undefined) {
        numberOrdering = numberOrdering || Math.sign(d1 - d2);
      }
      i++;
      j++;
      const n1 = i < a.length ? a.charCodeAt(i) : undefined;
      const n2 = j < b.length ? b.charCodeAt(j) : undefined;
      if (n1 === undefined && n2 === undefined) return numberOrdering;
      // (both-undefined returned above; the narrowing is belt for the type checker)
      if (n1 === undefined)
        return n2 !== undefined && digit(n2) !== undefined ? -1 : numberOrdering || -1;
      if (n2 === undefined)
        return n1 !== undefined && digit(n1) !== undefined ? 1 : numberOrdering || 1;
      prev = x1;
      x1 = n1;
      x2 = n2;
    }
    const ord = Math.sign((weights[x1] ?? x1) - (weights[x2] ?? x2));
    if (ord !== 0) return ord;
    prev = x1;
    i++;
    j++;
  }
}

/** Identifier order (named specifiers): CldrAsciiCollator — A < a < B < b. */
export function cldrCmp(a: string, b: string): number {
  return collate(CLDR_WEIGHTS, a, b);
}

/** Module-source order within one kind: ImportSourceAsciiCollator. */
export function sourceCollate(a: string, b: string): number {
  return collate(SOURCE_WEIGHTS, a, b);
}

/** ImportSourceKind, in biome's enum order (lower sorts first). */
export type SourceKind = "unknown" | "url" | "protocol" | "package" | "alias" | "path";
const KIND_ORDER: Record<SourceKind, number> = {
  unknown: 0,
  url: 1,
  protocol: 2,
  package: 3,
  alias: 4,
  path: 5,
};

/** Port of ImportSourceKind::from_source. */
export function classifySource(src: string): SourceKind {
  const c = (k: number) => (k < src.length ? src.charCodeAt(k) : -1);
  const isLower = (v: number) =>
    (v >= 97 && v <= 122) || (v >= 48 && v <= 57) || v === 45 || v === 95;
  const first = c(0);
  if (first === 64) {
    const second = c(1);
    if (second === 47 || second === -1) return "alias";
    if ((second >= 97 && second <= 122) || (second >= 48 && second <= 57) || second === 45)
      return "package";
    return "unknown";
  }
  if (first === 35 || first === 126 || first === 36 || first === 37) return "alias";
  if (first === 47) return "path";
  if (first === 46) {
    const second = c(1);
    if (second === 46) {
      const third = c(2);
      return third === -1 || third === 47 ? "path" : "unknown";
    }
    return second === -1 || second === 47 ? "path" : "unknown";
  }
  if (isLower(first)) {
    for (let k = 1; k < src.length; k++) {
      const v = src.charCodeAt(k);
      if ((v >= 97 && v <= 122) || (v >= 48 && v <= 57) || v === 45 || v === 95 || v === 46)
        continue;
      if (v === 58) {
        const next = c(k + 1);
        if (next === 47) return "url";
        if (next === 64 || isLower(next)) return "protocol";
        return "unknown";
      }
      if (v === 47) return "package";
      return "unknown";
    }
    return "package";
  }
  return "unknown";
}

/**
 * Path proximity order for Path-kind sources (port of PathComponents):
 * components pairwise; ParentDir(n) before CurDir before Normal; more parent
 * dirs sort FIRST (../.. < ..); Normal components use the source collator.
 * A leading ./ is dropped before ../ (./.. normalizes to ..).
 */
function pathCmp(a: string, b: string): number {
  type Comp = { t: "root" | "parent" | "cur" | "norm"; n: number; s: string };
  const comps = (p: string): Comp[] => {
    const out: Comp[] = [];
    const parts = p.split("/");
    let k = 0;
    if (parts[0] === "") {
      out.push({ t: "root", n: 1, s: "" });
      k = 1;
    }
    while (k < parts.length) {
      const part = parts[k] ?? "";
      if (part === "..") {
        let n = 0;
        while (k < parts.length && parts[k] === "..") {
          n++;
          k++;
        }
        out.push({ t: "parent", n, s: "" });
        continue;
      }
      if (part === ".") {
        out.push({ t: "cur", n: 1, s: "" });
        k++;
        continue;
      }
      if (part === "") {
        k++;
        continue;
      }
      out.push({ t: "norm", n: 1, s: part });
      k++;
    }
    // ./.. normalizes to .. : a CurDir immediately followed by ParentDir drops.
    for (let i = 0; i < out.length - 1; i++) {
      if (out[i]?.t === "cur" && out[i + 1]?.t === "parent") {
        out.splice(i, 1);
        i--;
      }
    }
    return out;
  };
  const ca = comps(a);
  const cb = comps(b);
  const rank = (t: string) => (t === "root" ? 0 : t === "parent" ? 1 : t === "cur" ? 2 : 3);
  for (let k = 0; k < Math.max(ca.length, cb.length); k++) {
    const x = ca[k];
    const y = cb[k];
    if (!x && !y) return 0;
    if (!x) return -1;
    if (!y) return 1;
    if (x.t !== y.t) return rank(x.t) - rank(y.t);
    if (x.t === "parent") {
      if (x.n !== y.n) return y.n - x.n;
      continue;
    }
    if (x.t === "norm") {
      const o = sourceCollate(x.s, y.s);
      if (o !== 0) return o;
    }
  }
  return 0;
}

/** Full source order: kind first, then proximity (Path) or collation. */
export function importSourceCmp(a: string, b: string): number {
  const ka = classifySource(a);
  const kb = classifySource(b);
  if (ka !== kb) return KIND_ORDER[ka] - KIND_ORDER[kb];
  if (ka === "path") {
    const p = pathCmp(a, b);
    if (p !== 0) return p;
  }
  return sourceCollate(a, b);
}

/**
 * Statement kinds in biome's ImportStatementKind bitflag order (lower first).
 */
const STMT_KIND = {
  bare: 0,
  namespaceType: 1,
  defaultType: 2,
  namedType: 3,
  namespace: 4,
  defaultNamespace: 5,
  default: 6,
  defaultNamed: 7,
  named: 8,
} as const;

interface ParsedSpecifier {
  text: string;
  local: string;
  typeOnly: boolean;
}

interface ImportStatement {
  /** Statement text alone; specifier offsets below are relative to it. */
  text: string;
  source: string;
  stmtKind: number;
  hasAttrs: boolean;
  /** Specifier list content offsets within `text`, -1 without a named clause. */
  specStart: number;
  specEnd: number;
  specifiers: ParsedSpecifier[];
}

const BARE_RE = /^import\s+(["'])([^"']+)\1(\s+with\s+\{[^}]*\})?\s*;?\s*$/s;
const CLAUSE_RE =
  /^import\s+(type\s+)?(?:(\*\s+as\s+([A-Za-z_$][\w$]*))|([A-Za-z_$][\w$]*)\s*(?:,\s*(\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\}))?|\{([^}]*)\})\s*from\s+(["'])([^"']+)\9(\s+with\s+\{[^}]*\})?\s*;?\s*$/s;
const SPEC_RE = /^(type\s+)?([A-Za-z_$][\w$]*)(\s+as\s+([A-Za-z_$][\w$]*))?$/;

/**
 * Parse one import statement's clause. Returns null for forms this emitter
 * never produces (the caller then leaves the statement untouched); a parsed
 * statement with stmtKind -1 is a clause this parser cannot reorder safely.
 */
function parseStatement(text: string): ImportStatement | null {
  const bare = text.match(BARE_RE);
  if (bare) {
    const bareSrc = bare[2];
    if (bareSrc === undefined) return null;
    return {
      text,
      source: bareSrc,
      stmtKind: STMT_KIND.bare,
      hasAttrs: bare[3] !== undefined,
      specStart: -1,
      specEnd: -1,
      specifiers: [],
    };
  }
  const m = text.match(CLAUSE_RE);
  if (!m) return null;
  const typeTok = m[1];
  const nsAs = m[2];
  const defNs = m[5];
  const defNamed = m[7];
  const named = m[8];
  const source = m[10];
  if (source === undefined) return null;
  const hasAttrs = m[11] !== undefined;
  let stmtKind: number;
  let specStart = -1;
  let specEnd = -1;
  let specText: string | undefined;
  if (named !== undefined) {
    stmtKind = typeTok !== undefined ? STMT_KIND.namedType : STMT_KIND.named;
    specText = named;
    specStart = text.indexOf("{") + 1;
    specEnd = text.lastIndexOf("}");
  } else if (defNamed !== undefined) {
    stmtKind = STMT_KIND.defaultNamed;
    specText = defNamed;
    specStart = text.indexOf("{") + 1;
    specEnd = text.lastIndexOf("}");
  } else if (nsAs !== undefined) {
    stmtKind = typeTok !== undefined ? STMT_KIND.namespaceType : STMT_KIND.namespace;
  } else if (defNs !== undefined) {
    stmtKind = STMT_KIND.defaultNamespace;
  } else {
    stmtKind = typeTok !== undefined ? STMT_KIND.defaultType : STMT_KIND.default;
  }
  const specifiers: ParsedSpecifier[] = [];
  if (specText !== undefined) {
    for (const raw of specText.split(",")) {
      const piece = raw.trim();
      if (piece === "") continue;
      const sm = piece.match(SPEC_RE);
      const local = sm ? (sm[4] ?? sm[2]) : undefined;
      if (!sm || local === undefined) {
        return {
          text,
          source,
          stmtKind: -1,
          hasAttrs,
          specStart: -1,
          specEnd: -1,
          specifiers: [],
        };
      }
      specifiers.push({ text: piece, local, typeOnly: sm[1] !== undefined });
    }
  }
  return { text, source, stmtKind, hasAttrs, specStart, specEnd, specifiers };
}

interface RunItem {
  /** Prefix (blank line + attached comments) + statement text. */
  text: string;
  /** The statement text alone (specifier offsets are relative to this). */
  block: string;
  parsed: ImportStatement | null;
  /** True when the item's prefix starts with a blank line. */
  blankBefore: boolean;
}

interface StmtLoc {
  /** Start of the attached prefix: optional blank line + comment lines. */
  prefixStart: number;
  blankBefore: boolean;
  /** First attached-comment line (== start when none). */
  commentStart: number;
  start: number;
  end: number;
  bare: boolean;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

function isImportStart(line: string): boolean {
  return /^import[\s({"']/.test(line);
}

/**
 * Rewrite `text` so every import run is a fixed point of biome's
 * organizeImports:
 *
 * - Statements sort within each contiguous run (source kind + source,
 *   attributes first, statement kind, stable). A bare (side-effect) import
 *   forms its own run and stays put; the emitters must emit it adjacent to
 *   other imports only where biome accepts that.
 * - A blank line and the comment block directly above an import attach to it
 *   and travel with it; a leading blank line at the very top of the run (file
 *   start) is dropped, matching the binary.
 * - Named specifiers sort by local name.
 * - A blank line is enforced after a file-header comment (only when the
 *   block was rewritten) and between the import block and the following code.
 *
 * Everything else is preserved byte-for-byte.
 */
export function canonicalizeImportText(text: string): string {
  const lines = text.split("\n");
  const at = (k: number): string => lines[k] ?? "";
  // Locate import statements with their attached prefixes. A comment block
  // attaches to the following statement only when no blank line separates
  // them; a file-header comment (before the first statement) is always
  // detached. A blank line directly above an attached comment block (or an
  // import with no comment) attaches to that statement's prefix.
  const stmts: StmtLoc[] = [];
  let commentRun = -1;
  let lastBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const line = at(i);
    if (line.trim() === "") {
      lastBlank = true;
      commentRun = -1;
      continue;
    }
    if (isCommentLine(line)) {
      if (commentRun < 0) commentRun = i;
      lastBlank = false;
      continue;
    }
    if (isImportStart(line)) {
      let end = i;
      while (end < lines.length && !at(end).trimEnd().endsWith(";")) end++;
      const attached = lastBlank || stmts.length === 0 ? -1 : commentRun;
      const commentStart = attached >= 0 ? attached : i;
      const blankBefore =
        commentStart > 0 && at(commentStart - 1).trim() === "" && stmts.length > 0;
      stmts.push({
        prefixStart: blankBefore ? commentStart - 1 : commentStart,
        blankBefore,
        commentStart,
        start: i,
        end,
        bare: /^import\s+["']/.test(line),
      });
      commentRun = -1;
      lastBlank = false;
      i = end;
      continue;
    }
    commentRun = -1;
    lastBlank = false;
  }
  // Group into runs. A bare import is its own run and breaks the surrounding
  // runs. A statement continues the previous run when the gap between them
  // (previous end+1 .. next prefixStart) is empty or blank-only.
  const runs: StmtLoc[][] = [];
  for (const s of stmts) {
    const last = runs[runs.length - 1];
    const prev = last?.[last.length - 1];
    if (s.bare || !last || !prev || prev.bare) {
      runs.push([s]);
      continue;
    }
    let gapOk = true;
    for (let g = prev.end + 1; g < s.prefixStart; g++) {
      if (at(g).trim() === "") continue;
      gapOk = false;
      break;
    }
    if (gapOk) last.push(s);
    else runs.push([s]);
  }
  const out: string[] = [];
  let cursor = 0;
  let reordered = false;
  for (const run of runs) {
    const first = run[0];
    const lastS = run[run.length - 1];
    if (!first || !lastS) continue;
    for (let i = cursor; i < first.prefixStart; i++) out.push(at(i));
    cursor = lastS.end + 1;
    // Build items: each statement (prefix + statement) is one sortable item;
    // extra blank-only gap lines collapse (the prefix carries at most one).
    const items: RunItem[] = [];
    for (const s of run) {
      const blockText = lines.slice(s.start, s.end + 1).join("\n");
      const prefix = lines.slice(s.prefixStart, s.start).join("\n");
      items.push({
        text: prefix === "" ? blockText : `${prefix}\n${blockText}`,
        block: blockText,
        parsed: parseStatement(blockText),
        blankBefore: s.blankBefore,
      });
    }
    // Sort the import items stably into their slots.
    const slotIdx: number[] = [];
    const slotItems: RunItem[] = [];
    for (const [k, item] of items.entries()) {
      if (item.parsed && item.parsed.stmtKind >= 0) {
        slotIdx.push(k);
        slotItems.push(item);
      }
    }
    const ordered = [...slotItems].sort((a, b) => {
      const pa = a.parsed;
      const pb = b.parsed;
      if (!pa || !pb) return 0;
      const sc = importSourceCmp(pa.source, pb.source);
      if (sc !== 0) return sc;
      if (pa.hasAttrs !== pb.hasAttrs) return pa.hasAttrs ? -1 : 1;
      if (pa.stmtKind !== pb.stmtKind) return pa.stmtKind - pb.stmtKind;
      return 0; // Array#sort is stable (ES2019): original order breaks ties.
    });
    for (const [k, item] of ordered.entries()) {
      const idx = slotIdx[k];
      if (idx === undefined) continue;
      if (items[idx] !== item) reordered = true;
      items[idx] = item;
    }
    // A leading blank line at the top of the file (or right after the header
    // comment / an already-blank region) is dropped by the binary.
    const firstItem = items[0];
    if (firstItem?.blankBefore) {
      const preceded = out.some((l) => l.trim() !== "");
      if (!preceded || (out[out.length - 1] ?? "").trim() === "") {
        items[0] = {
          ...firstItem,
          text: firstItem.text.replace(/^\n/, ""),
          blankBefore: false,
        };
      }
    }
    // Sort named specifiers within each statement, rewriting only the block
    // portion so attached prefixes are never touched.
    for (const it of items) {
      const p = it.parsed;
      if (!p || p.specStart < 0 || p.specifiers.length < 2) continue;
      const sortedSpecs = [...p.specifiers].sort((x, y) => cldrCmp(x.local, y.local));
      if (sortedSpecs.map((s) => s.text).join(",") === p.specifiers.map((s) => s.text).join(","))
        continue;
      const inner = it.block.slice(p.specStart, p.specEnd);
      const rebuilt = inner.includes("\n")
        ? `\n${sortedSpecs.map((s) => `  ${s.text},`).join("\n")}\n`
        : ` ${sortedSpecs.map((s) => s.text).join(", ")} `;
      const prefixLen = it.text.length - it.block.length;
      it.block = it.block.slice(0, p.specStart) + rebuilt + it.block.slice(p.specEnd);
      it.text = `${it.text.slice(0, prefixLen)}${it.block}`;
    }
    for (const it of items) out.push(it.text);
  }
  for (let i = cursor; i < lines.length; i++) out.push(at(i));
  let result = out.join("\n");
  if (reordered) {
    // When organizeImports rewrites the import block it also separates the
    // file-header comment from the imports with a blank line; a specifier-only
    // fix leaves the header alone. Mirror that conditionality.
    result = result.replace(/^((?:(?:\/\/|\/\*)[^\n]*\n)+)(?=import )/, "$1\n");
  }
  return enforceImportChunkBlanks(result);
}

/**
 * organizeImports enforces a blank line between an import chunk and the code
 * around it (both sides); attached comments and bare-adjacent imports need
 * none. Operates on final text with a fresh scan.
 */
function enforceImportChunkBlanks(text: string): string {
  const lines = text.split("\n");
  const at = (k: number): string => lines[k] ?? "";
  const starts = new Set<number>();
  const ends = new Set<number>();
  const importLine = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!isImportStart(at(i))) continue;
    let end = i;
    while (end < lines.length && !at(end).trimEnd().endsWith(";")) end++;
    starts.add(i);
    ends.add(end);
    for (let k = i; k <= end; k++) importLine.add(k);
    i = end;
  }
  const leadsToImport = (from: number): boolean => {
    for (let k = from; k < lines.length; k++) {
      if (at(k).trim() === "") return false;
      if (importLine.has(k)) return true;
      if (!isCommentLine(at(k))) return false;
    }
    return false;
  };
  const joined: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const prev = joined[joined.length - 1];
    if (
      starts.has(i) &&
      prev !== undefined &&
      prev.trim() !== "" &&
      !importLine.has(i - 1) &&
      !isCommentLine(prev)
    ) {
      joined.push("");
    }
    joined.push(at(i));
    if (
      ends.has(i) &&
      i + 1 < lines.length &&
      at(i + 1).trim() !== "" &&
      !importLine.has(i + 1) &&
      !leadsToImport(i + 1)
    ) {
      joined.push("");
    }
  }
  return joined.join("\n");
}

/**
 * useImportType (isolated-mode form): when a name imported as a value is only
 * ever referenced in type position — every `name` occurrence outside the
 * import block is a `typeof name` — biome rewrites the specifier to
 * `type name`. The emitters cannot know this statically (vi is value-used
 * exactly when a vi.mock block is emitted), so the finalizer marks it on the
 * rendered text. Only touches a plain `name` specifier; an already-marked
 * `type name` is left alone.
 */
export function markTypeOnlySpecifier(text: string, name: string): string {
  // Strip import statements (single- and multi-line); the remainder is usage.
  const stripped = text.replace(/^import[\s\S]*?;/gm, "");
  const uses = [...stripped.matchAll(new RegExp(`\\b${name}\\b`, "g"))];
  if (uses.length === 0) return text;
  const typeOnly = uses.every((m) => /typeof\s+$/.test(stripped.slice(0, m.index)));
  if (!typeOnly) return text;
  // Rewrite `name` to `type name` inside the import that declares it.
  return text.replace(/^import[\s\S]*?;/gm, (stmt) => {
    if (!new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}`).test(stmt)) return stmt;
    if (new RegExp(`\\btype\\s+${name}\\b`).test(stmt)) return stmt;
    return stmt.replace(
      new RegExp(`(\\{\\s*|\\{[^}]*?[,{]\\s*)${name}(\\s*[,}])`),
      `$1type ${name}$2`,
    );
  });
}

/**
 * Final pass for every emitted TypeScript file: mark type-only specifiers the
 * emitters cannot know about, then sort imports into biome's canonical form.
 * Idempotent — safe to run again after stamping or formatting.
 */
export function finalizeEmittedImports(text: string): string {
  return canonicalizeImportText(markTypeOnlySpecifier(text, "vi"));
}
