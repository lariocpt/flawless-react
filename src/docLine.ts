// Turning a line of documentation into an argv.
//
// A documented example is not a bare argv: it carries a runner (`bunx`), env
// prefixes (`FLAWLESS_E2E_ID=…`), shell quoting (`"src/**/*.tsx"`), and prose
// after a `#`. Every one of those has to come off before parseArgs can have an
// opinion, and the same peeling has to happen identically in three places —
// `--check`, tests/docsLint.test.ts, and the website's lint script — or the
// three disagree about what was even checked.
//
// Deliberately importless. `--check` and `--flags` must answer without pulling
// in core.ts and the TypeScript compiler behind it (FR-031).

/** Runner words a documented invocation may be prefixed with. */
const RUNNERS = new Set(["bun", "bunx", "npx", "npm", "pnpm", "yarn", "sudo", "time", "env"]);

/** How this CLI is spelled when a doc invokes it. */
const SELF_ENTRIES = new Set(["src/cli.ts", "src/bin.ts"]);

const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a command line into argv, honouring quotes and dropping them.
 *
 * `--props='{"a":1}'` has to arrive at parseArgs as `--props={"a":1}`, quotes
 * gone, or parsePropsJson rejects JSON that is perfectly valid in the doc.
 *
 * Throws on an unterminated quote: by the time a line reaches here the caller
 * has already joined continuations, so an open quote is a real defect in the
 * example rather than an artefact of how it was extracted.
 */
export function shellSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote !== null) {
      if (c === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && c === "\\" && i + 1 < line.length) {
        cur += line[++i] as string;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (started) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    started = true;
    cur += c;
  }
  if (quote !== null) throw new Error(`unterminated ${quote} quote`);
  if (started) out.push(cur);
  return out;
}

/**
 * Drop an UNQUOTED trailing `#` comment.
 *
 * A `#` inside quotes is data — `--props '{"tag":"#a"}'` — so the scan has to
 * track quoting rather than indexOf("#").
 */
export function stripTrailingComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote !== null) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** Is this token the way a doc spells this CLI? */
function isSelf(token: string): boolean {
  const base = token.split("/").pop() ?? token;
  if (base === "flawless-react") return true;
  return SELF_ENTRIES.has(token) || SELF_ENTRIES.has(token.replace(/^\.\//, ""));
}

/**
 * The argv of a documented flawless-react invocation, or null when the line
 * invokes something else.
 *
 * Returning null rather than failing is the whole point: docs are full of
 * `bun run test`, `playwright test --grep …` and crust pipes, and a lint that
 * treated those as flawless invocations would report failures that are not
 * about this tool. The cost is that a caller must assert it checked a MINIMUM
 * number of lines — silence here is indistinguishable from a broken extractor.
 */
export function flawlessArgv(line: string): string[] | null {
  const tokens = shellSplit(line);
  let i = 0;
  while (i < tokens.length && ENV_PREFIX.test(tokens[i] as string)) i++;
  while (i < tokens.length && RUNNERS.has(tokens[i] as string)) {
    i++;
    // `bun run <script>` / `npm run <script>`: the script name is not this CLI
    // under any spelling we can resolve, so let the isSelf check below reject.
    if (tokens[i] === "run") i++;
  }
  const cmd = tokens[i];
  if (cmd === undefined || !isSelf(cmd)) return null;
  return tokens.slice(i + 1);
}
