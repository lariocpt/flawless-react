/**
 * The depth census: the ruler D0 builds before any depth claim is cut (PLAN-00).
 *
 * "Broad and shallow" is a reading; this file turns it into a measurement. It
 * reads EMITTED spec text — the suite is the source of truth and cannot be told
 * its own tier by the emitter — and classifies every test by the assertion
 * constructors its body actually contains, exactly as PLAN-00's normative tier
 * table defines T0–T3:
 *
 * - T0 mount-only: true of nearly any component; falsifies almost nothing.
 * - T1 shape and copy: falsified by markup and copy changes.
 * - T2 derived interaction effect: falsified by behaviour changes, not markup.
 * - T3 state and payload: falsified by data-flow changes.
 *
 * The tier of a test is the strongest assertion in it; the tier of a spec is
 * the strongest over its tests; the census is the distribution over specs.
 *
 * Two anti-lying rules from PLAN-00 are enforced here, not left to the reader:
 *
 * 1. A test whose only assertions are a `TODO(flawless)` marker plus a vacuous
 *    tail (the `waitFor(() => expect(document.body).toBeTruthy())` filler, the
 *    `expect(calls).toBeGreaterThan(0)` fetch floor) is T0 AND is counted as
 *    `unclaimed` — a placeholder the tool admitted it could not derive, not a
 *    silently-passing claim.
 * 2. A `test.skip` / `ctx.skip` / `t.skip` gets NO tier. Skips are already
 *    counted by reason in verdict.ts; the census counts what actually runs.
 *
 * Deliberately conservative: an assertion shape the table does not name stays
 * T0. The classifier may under-read (a future shape lands T0 until the table
 * grows); it must never over-read (no shape invents a tier the table denies).
 *
 * Pure: no fs, no I/O, no imports from the emitters. Deterministic: every list
 * is sorted, no timestamps, no Object.keys insertion-order leaks.
 */

export type Tier = "T0" | "T1" | "T2" | "T3";

const TIER_ORDER: readonly Tier[] = ["T0", "T1", "T2", "T3"];

function stronger(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/** One test declaration site, as classified. */
export interface TestClassification {
  /** The declared test name as written; a loop-generated test keeps its template text. */
  name: string;
  /** null = skipped: the census counts what runs (PLAN-00 rule 2). */
  tier: Tier | null;
  /** One entry per assertion site that decided or contributed to the tier. */
  evidence: string[];
}

export interface SpecClassification {
  /** Strongest tier over the tests that run; null when nothing runs. */
  tier: Tier | null;
  perTest: TestClassification[];
  /** Tests at T0 whose body carries a TODO(flawless) marker (PLAN-00 rule 1). */
  unclaimed: number;
  /** Declarations excluded from the census because they never run. */
  skipped: number;
  /** True when the file contains no test declaration at all. */
  unclassified: boolean;
}

export interface SpecInput {
  path: string;
  source: string;
}

/**
 * The verdict/report shape of a census: the numbers a reader needs, without
 * the per-spec rows. This is what rides on a TaskResult and lands in
 * VERDICT.json's `depth` field — the field is ABSENT when a task emitted no
 * specs (verdict.ts's contract: absent means unmeasured, never zero).
 */
export interface DepthBlock {
  /** Spec files fed to the census (the out-dir suite this run emitted). */
  specs: number;
  T0: number;
  T1: number;
  T2: number;
  T3: number;
  testsClassified: number;
  testsUnclaimed: number;
  testsSkipped: number;
}

/** Project a census onto the verdict shape. Pure, total. */
export function depthBlock(c: DepthCensus): DepthBlock {
  return {
    specs: c.specs,
    T0: c.distribution.T0,
    T1: c.distribution.T1,
    T2: c.distribution.T2,
    T3: c.distribution.T3,
    testsClassified: c.testsClassified,
    testsUnclaimed: c.testsUnclaimed,
    testsSkipped: c.testsSkipped,
  };
}

/**
 * The out-dir plane directories the tier table describes, with the filename
 * rule for each. Shared by scripts/depth-census.ts and the unit-browser task
 * so the census, the verdict and the report read exactly one file set —
 * one census, three views. A colocated `*.flawless.test.tsx` under the unit
 * dir belongs to the colocated copy, not the out-dir suite (the census
 * script classifies it as crossCheck), so the unit rule excludes it.
 */
export const DEPTH_PLANES: readonly {
  dir: "unit" | "browser" | "native";
  match: (base: string) => boolean;
}[] = [
  {
    dir: "unit",
    match: (b) => /\.test\.tsx?$/.test(b) && !/\.flawless\.test\.tsx?$/.test(b),
  },
  { dir: "browser", match: (b) => /\.spec\.tsx?$/.test(b) },
  { dir: "native", match: (b) => /\.spec\.tsx?$/.test(b) },
];

export interface CensusSpecRow {
  path: string;
  tier: Tier | null;
  tests: number;
  unclaimed: number;
  skipped: number;
}

export interface DepthCensus {
  /** Spec files fed to the census. */
  specs: number;
  /** Spec files counted in `distribution` (at least one test runs). */
  specsClassified: number;
  distribution: Record<Tier, number>;
  /** Specs whose strongest tier is T0 — the mount-only floor, named. */
  specsStrongestT0: number;
  /** Files with no test declaration at all: the census failed to read them. */
  specsUnclassified: string[];
  /** Files whose every test is a skip: nothing runs, honestly reported. */
  specsAllSkipped: string[];
  testsClassified: number;
  testsUnclaimed: number;
  testsSkipped: number;
  /** Sorted by path; the census's own row per spec. */
  perSpec: CensusSpecRow[];
}

// ---------------------------------------------------------------------------
// Source scanning (string/comment aware, offset-preserving)
// ---------------------------------------------------------------------------

/**
 * Replace comment bodies with spaces so offsets stay identical to the raw
 * source: assertion scanning runs on the stripped text while test names and
 * the TODO(flawless) marker are read from the raw text at the same offsets.
 */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to && j < out.length; j++) {
      if (out[j] !== "\n") out[j] = " ";
    }
  };
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Index just past the string/template that starts at `start`. */
function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      i = skipBraces(src, i + 1);
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return src.length;
}

/** Index just past the `}` that closes the `{` at `start` (template ${...}). */
function skipBraces(src: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

/** Index just past the bracket that closes the opener at `start`. */
function skipBracket(src: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

// ---------------------------------------------------------------------------
// Test declaration parsing
// ---------------------------------------------------------------------------

interface TestDecl {
  name: string;
  skipped: boolean;
  /** Body start index (the `{`), in both raw and stripped source. */
  bodyStart: number;
  bodyEnd: number; // index of the closing `}`
}

/**
 * Find every `test(...)` / `it(...)` declaration (including `.skip` forms and
 * declarations nested in `describe` or in `for` loops). Runs on the
 * comment-stripped source so a `test(` mentioned in prose is never a test.
 */
function findTests(raw: string, stripped: string): TestDecl[] {
  const decls: TestDecl[] = [];
  const declRe = /(?:^|\n)[ \t]*(test|it)(\.skip)?\s*\(/g;
  let m = declRe.exec(stripped);
  while (m !== null) {
    const open = m.index + m[0].length - 1;
    const skipped = m[2] !== undefined;
    const name = readFirstArg(raw, stripped, open + 1);
    if (name !== undefined) {
      const bodyStart = findBodyStart(stripped, name.end);
      if (bodyStart !== -1) {
        const bodyEnd = skipBracket(stripped, bodyStart);
        decls.push({ name: name.text, skipped, bodyStart, bodyEnd: bodyEnd - 1 });
        declRe.lastIndex = bodyEnd;
      }
    }
    m = declRe.exec(stripped);
  }
  return decls;
}

/** The first argument of a call whose `(` is at `open`: its raw text + end index. */
function readFirstArg(
  raw: string,
  stripped: string,
  after: number,
): { text: string; end: number } | undefined {
  let i = after;
  while (i < stripped.length && /\s/.test(stripped[i] as string)) i++;
  const c = stripped[i];
  if (c === undefined) return undefined;
  if (c === '"' || c === "'" || c === "`") {
    const end = skipString(stripped, i);
    // The raw slice keeps the template/quotes as written — names are reported
    // verbatim, which is what makes the output reproducible from the file.
    return { text: raw.slice(i, end).replace(/\s+/g, " ").trim(), end };
  }
  // Every emitted test name is a string or template literal. Anything else
  // (`test.skip(true, …)` as a runtime call inside a body) is not a declaration.
  return undefined;
}

/** The `{` opening the callback that follows the first argument. */
function findBodyStart(stripped: string, from: number): number {
  let i = from;
  while (i < stripped.length) {
    const c = stripped[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(stripped, i);
      continue;
    }
    if (c === "{") return i;
    if (c === "(") {
      i = skipBracket(stripped, i);
      continue;
    }
    i++;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Assertion sites
// ---------------------------------------------------------------------------

interface Site {
  /** Index of the `expect` keyword in the comment-stripped source. */
  offset: number;
  /** The expect(...) argument text, comments stripped. */
  arg: string;
  /** The matcher name without the `not.` prefix, e.g. "toBe". */
  matcher: string;
  not: boolean;
  rejects: boolean;
  /** The matcher's own first argument text ("" when absent). */
  matcherArg: string;
}

/** Every `expect(...).matcher(...)` site in a comment-stripped body. */
function findSites(strippedBody: string): Site[] {
  const sites: Site[] = [];
  const re = /\bexpect\s*\(/g;
  let m = re.exec(strippedBody);
  while (m !== null) {
    const open = m.index + m[0].length - 1;
    const afterArg = skipBracket(strippedBody, open);
    const arg = strippedBody.slice(open + 1, afterArg - 1).trim();
    const rest = strippedBody.slice(afterArg);
    const mm = /^\s*(?:\.(rejects|resolves))?(?:\.not)?\s*\.\s*(to[A-Za-z]+)\s*\(/.exec(rest);
    if (mm) {
      const matcherOpen = afterArg + (mm.index ?? 0) + mm[0].length - 1;
      const afterMatcherArg = skipBracket(strippedBody, matcherOpen);
      const matcherArg = strippedBody.slice(matcherOpen + 1, afterMatcherArg - 1).trim();
      sites.push({
        offset: m.index,
        arg,
        matcher: mm[2] as string,
        not: mm[1] !== undefined || mm[0].includes(".not"),
        rejects: mm[1] === "rejects",
        matcherArg,
      });
      re.lastIndex = afterMatcherArg;
    }
    m = re.exec(strippedBody);
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Literal binding map (loop copy and named constants are literals too)
// ---------------------------------------------------------------------------

/**
 * Identifiers the spec itself binds to string literals: `const CHILD_TEXT =
 * "…"` and `for (const t of ["…", …])`. A text query over one of these asserts
 * literal copy (T1); a text query over any other identifier asserts a value
 * the spec cannot name — a fixture (T3).
 */
function literalBindings(stripped: string): Set<string> {
  const bound = new Set<string>();
  const constRe =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*[;\n]/g;
  let m = constRe.exec(stripped);
  while (m !== null) {
    bound.add(m[1] as string);
    m = constRe.exec(stripped);
  }
  const loopRe = /\bfor\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+\[/g;
  m = loopRe.exec(stripped);
  while (m !== null) {
    const open = stripped.indexOf("[", (m.index ?? 0) + m[0].length - 1);
    const list = stripped.slice(open + 1, skipBracket(stripped, open) - 1);
    // Bound only when EVERY element is a literal: a mixed list is data, not copy.
    const parts = splitTopLevel(list);
    if (parts.length > 0 && parts.every((p) => isStringLiteral(p.trim()))) {
      bound.add(m[1] as string);
    }
    m = loopRe.exec(stripped);
  }
  return bound;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(list, i);
      cur += list.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

function isStringLiteral(s: string): boolean {
  return (
    /^"(?:[^"\\]|\\.)*"$/.test(s) || /^'(?:[^'\\]|\\.)*'$/.test(s) || /^`(?:[^`\\]|\\.)*`$/.test(s)
  );
}

function isNumericLiteral(s: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(s);
}

/** A matcher argument that is a literal value, not a derived expression. */
function isLiteralArg(s: string): boolean {
  return isStringLiteral(s) || isNumericLiteral(s) || s === "true" || s === "false" || s === "null";
}

// ---------------------------------------------------------------------------
// The tier rules — one site at a time, straight from PLAN-00's table
// ---------------------------------------------------------------------------

const TEXT_QUERY = /\b(?:getByText|getAllByText|queryAllByText|queryByText|findAllByText)\s*\(/;

function textQueryArg(arg: string): string | undefined {
  const m = new RegExp(`${TEXT_QUERY.source}\\s*([^,)]+)`).exec(arg);
  return m?.[1]?.trim();
}

function classifySite(
  site: Site,
  body: string,
  bound: Set<string>,
): { tier: Tier; evidence: string } {
  const { matcher, not, rejects, arg, matcherArg } = site;
  const textQuery = TEXT_QUERY.test(arg);

  // --- T3: falsified by data-flow changes (PLAN-00 T3 row) ---
  if (matcher === "toHaveBeenCalledWith" && !not) {
    if (isLiteralArg(matcherArg)) {
      // The router-target shape: the literal is copy the source itself names,
      // so this is the T2 "routerMock.push assertions" row, not a payload claim.
      // The parent plan's T3 is `toHaveBeenCalledWith` on a DERIVED argument.
      return { tier: "T2", evidence: `toHaveBeenCalledWith(${matcherArg}) — literal target` };
    }
    return {
      tier: "T3",
      evidence: `toHaveBeenCalledWith(${short(matcherArg)}) — derived argument`,
    };
  }
  if (matcher === "toHaveBeenCalledTimes" && !not) {
    if (isNumericLiteral(matcherArg) && Number(matcherArg) > 1) {
      return { tier: "T3", evidence: `toHaveBeenCalledTimes(${matcherArg})` };
    }
    return { tier: "T2", evidence: `toHaveBeenCalledTimes(${matcherArg})` };
  }
  if (/mock\.calls\.length/.test(arg) && !not) {
    if (
      matcher === "toBe" ||
      matcher === "toBeGreaterThan" ||
      matcher === "toBeGreaterThanOrEqual"
    ) {
      // The inversion legs' call-count pair (templates.ts emitPredicateInversion
      // Tests counters). PLAN-00's T3 row names "call-count deltas between two
      // legs", but the T2 row owns "inversion legs" and the parent plan defines
      // T3 as data-flow (rendered results, payloads, derived arguments) — a
      // control-flow count is not data-flow. Read as T2; see the D0a receipt.
      return {
        tier: "T2",
        evidence: `mock.calls.length ${matcher}(${short(matcherArg)}) — inversion leg`,
      };
    }
  }

  // --- T2: falsified by behaviour changes (PLAN-00 T2 row) ---
  if (matcher === "toHaveBeenCalled" && !not)
    return { tier: "T2", evidence: "spy toHaveBeenCalled" };
  if (matcher === "toThrow" && rejects)
    return { tier: "T2", evidence: "rejects.toThrow — guard path" };
  if (matcher === "toBeDisabled" && !not) return { tier: "T2", evidence: "toBeDisabled" };
  if (matcher === "toBe" && /getPathname\s*\(\s*\)/.test(arg)) {
    return { tier: "T2", evidence: "getPathname().toBe — router claim" };
  }
  if (matcher === "toContain" && not) {
    return { tier: "T2", evidence: `absence leg: not.toContain(${short(matcherArg)})` };
  }

  // --- T1: falsified by markup/copy changes (PLAN-00 T1 row) ---
  if (textQuery && !not && (matcher === "toBeGreaterThan" || matcher === "toBe")) {
    const q = textQueryArg(arg);
    if (q !== undefined) {
      if (isStringLiteral(q)) return { tier: "T1", evidence: `literal text witness: ${short(q)}` };
      if (/^[A-Za-z_$][\w$]*$/.test(q)) {
        if (bound.has(q)) return { tier: "T1", evidence: `loop/const-bound literal copy: ${q}` };
        return { tier: "T3", evidence: `text witness over an unnamed value: ${q}` };
      }
      return { tier: "T1", evidence: "text witness" };
    }
  }
  if (matcher === "toBeInTheDocument" && !not)
    return { tier: "T1", evidence: "toBeInTheDocument — text witness" };
  if ((matcher === "toHaveValue" || matcher === "toHaveDisplayValue") && !not) {
    return { tier: "T1", evidence: `${matcher} — value read-back` };
  }
  if (matcher === "toContain" && !not) {
    if (isStringLiteral(matcherArg) || bound.has(matcherArg)) {
      return { tier: "T1", evidence: `literal copy: ${short(matcherArg)}` };
    }
    return { tier: "T1", evidence: `toContain(${short(matcherArg)})` };
  }
  if (matcher === "toBeNull" && not) {
    if (/querySelector\s*\(/.test(arg)) return { tier: "T1", evidence: "named element query" };
    if (/querySelector\s*\(/.test(body)) {
      return { tier: "T1", evidence: "non-null over a queried element (variant witness)" };
    }
    return { tier: "T0", evidence: "non-null existence" };
  }
  if (matcher === "toBe" && /new Set\s*\(/.test(arg)) {
    return { tier: "T1", evidence: "variant distinctness matrix" };
  }

  // --- T0 and the conservative default ---
  if (matcher === "toBeTruthy") return { tier: "T0", evidence: "toBeTruthy — vacuous tail" };
  if (matcher === "toThrow" && not) return { tier: "T0", evidence: "not.toThrow — mount-only" };
  if (matcher === "toBeGreaterThan" && !not && /\b(calls|rootHtml|innerHTML)/.test(arg)) {
    return { tier: "T0", evidence: `${short(arg)} > ${matcherArg} — non-empty/made-a-request` };
  }
  return { tier: "T0", evidence: `${not ? "not." : ""}${matcher} — uncatalogued, default T0` };
}

function short(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 40 ? `${one.slice(0, 37)}...` : one;
}

// ---------------------------------------------------------------------------
// classifySpec / census
// ---------------------------------------------------------------------------

const RUNTIME_SKIP = /\b(?:ctx|t)\.skip\s*\(|\btest\.skip\s*\(\s*true\b/;

/**
 * Classify one emitted spec file. `perTest` is sorted by declared name and
 * includes skipped declarations (tier null) so the file's accounting is
 * complete; the tier itself only ever reflects tests that run.
 */
export function classifySpec(source: string): SpecClassification {
  const stripped = stripComments(source);
  const decls = findTests(source, stripped);
  const bound = literalBindings(stripped);

  let tier: Tier | null = null;
  let unclaimed = 0;
  let skipped = 0;
  const perTest: TestClassification[] = [];

  for (const d of decls) {
    const rawBody = source.slice(d.bodyStart, d.bodyEnd + 1);
    const body = stripped.slice(d.bodyStart, d.bodyEnd + 1);
    if (d.skipped) {
      skipped++;
      perTest.push({ name: d.name, tier: null, evidence: ["test.skip — never runs"] });
      continue;
    }
    const sites = findSites(body);
    if (sites.length === 0) {
      if (RUNTIME_SKIP.test(body)) {
        skipped++;
        perTest.push({ name: d.name, tier: null, evidence: ["runtime skip — never runs"] });
        continue;
      }
      tier = tier === null ? "T0" : stronger(tier, "T0");
      if (rawBody.includes("TODO(flawless)")) unclaimed++;
      perTest.push({ name: d.name, tier: "T0", evidence: ["no assertions — placeholder"] });
      continue;
    }
    let testTier: Tier = "T0";
    const evidence: string[] = [];
    for (const s of sites) {
      const c = classifySite(s, body, bound);
      testTier = stronger(testTier, c.tier);
      evidence.push(c.evidence);
    }
    if (testTier === "T0" && rawBody.includes("TODO(flawless)")) {
      unclaimed++;
      evidence.push("TODO(flawless) marker — unclaimed placeholder");
    }
    tier = tier === null ? testTier : stronger(tier, testTier);
    perTest.push({ name: d.name, tier: testTier, evidence });
  }

  perTest.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { tier, perTest, unclaimed, skipped, unclassified: decls.length === 0 };
}

/**
 * Classify the assertion site that starts on a given 1-based line of a spec
 * file. This is the mutation probe's question (scripts/depth-probe.ts): a
 * spec went red at line N — what TIER is the assertion that failed, by the
 * same table the census uses? Returns null when no `expect(...)` site starts
 * on that line (the failure was thrown before/outside an assertion, or the
 * reported line names a helper call — the probe then falls back to the
 * failing test's own tier and says so).
 *
 * Same contract as classifySpec: comment-stripped scanning, conservative
 * default, no I/O.
 */
export function classifyAssertionAtLine(
  source: string,
  line: number,
): { tier: Tier; evidence: string } | null {
  const stripped = stripComments(source);
  // Start offset of the 1-based line, and of the line after it.
  let lineStart = 0;
  for (let i = 0, l = 1; l < line && i < stripped.length; i++) {
    if (stripped[i] === "\n") {
      lineStart = i + 1;
      l++;
    }
  }
  if (line > 1 && lineStart === 0) return null;
  let lineEnd = stripped.indexOf("\n", lineStart);
  if (lineEnd === -1) lineEnd = stripped.length;
  const bound = literalBindings(stripped);
  let best: { tier: Tier; evidence: string } | null = null;
  for (const site of findSites(stripped)) {
    if (site.offset < lineStart || site.offset >= lineEnd) continue;
    const c = classifySite(site, stripped, bound);
    if (best === null || TIER_ORDER.indexOf(c.tier) > TIER_ORDER.indexOf(best.tier)) best = c;
  }
  return best;
}

/**
 * The census over a set of emitted spec files: distribution over specs, the
 * mount-only count, the unclaimed tally, and the two failure buckets
 * (unclassified files, all-skipped files) reported by path.
 */
export function census(specs: readonly SpecInput[]): DepthCensus {
  const distribution: Record<Tier, number> = { T0: 0, T1: 0, T2: 0, T3: 0 };
  const perSpec: CensusSpecRow[] = [];
  const specsUnclassified: string[] = [];
  const specsAllSkipped: string[] = [];
  let testsClassified = 0;
  let testsUnclaimed = 0;
  let testsSkipped = 0;

  for (const spec of specs) {
    const c = classifySpec(spec.source);
    const classifiedTests = c.perTest.length - c.skipped;
    testsClassified += classifiedTests;
    testsUnclaimed += c.unclaimed;
    testsSkipped += c.skipped;
    if (c.unclassified) specsUnclassified.push(spec.path);
    else if (c.tier === null) specsAllSkipped.push(spec.path);
    else distribution[c.tier]++;
    perSpec.push({
      path: spec.path,
      tier: c.tier,
      tests: classifiedTests,
      unclaimed: c.unclaimed,
      skipped: c.skipped,
    });
  }

  perSpec.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  specsUnclassified.sort();
  specsAllSkipped.sort();

  return {
    specs: specs.length,
    specsClassified: specs.length - specsUnclassified.length - specsAllSkipped.length,
    distribution,
    specsStrongestT0: distribution.T0,
    specsUnclassified,
    specsAllSkipped,
    testsClassified,
    testsUnclaimed,
    testsSkipped,
    perSpec,
  };
}
