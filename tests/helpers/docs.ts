// Pulling command lines out of the project's own prose.
//
// The shipped docs are hand-maintained: README.md, docs/*.md, the seven
// .claude/skills entries and (when the checkout is beside this one) the
// website's mdx corpus all carry copies of the same invocations, with no
// generation step between them and the code. That is the thing that rots, and
// round 8 proved it does — a skill documented a throw the tool never emits, an
// exit-code table was wrong, the --ci field list was two fields stale. None of
// it was caught by a gate, because no test in this repo had ever opened a
// prose file.
//
// The extraction is the risky half. If it silently stops finding examples the
// lint keeps passing while checking nothing, so every consumer of this module
// asserts a MINIMUM count as well as zero failures.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/** Fences whose contents are shell, as opposed to ts/tsx/json/diff payloads. */
const SHELL_LANGS = new Set(["bash", "sh", "shell", "console", "text"]);

interface OpenState {
  quote: '"' | "'" | null;
  depth: number;
}

/**
 * Strip an unquoted top-level `#` comment and report whether the line leaves
 * quotes or brackets open, so a `\`-continued invocation and a multi-line
 * `--props '{ … }'` are joined with their continuation rather than parsed as
 * fragments.
 */
export function scanLine(line: string, open: OpenState): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (open.quote !== null) {
      out += c;
      if (open.quote === '"' && c === "\\" && i + 1 < line.length) {
        out += line[++i] as string;
        continue;
      }
      if (c === open.quote) open.quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      open.quote = c;
      out += c;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") open.depth++;
    if (c === ")" || c === "}" || c === "]") open.depth--;
    if (c === "#" && open.depth === 0) break;
    out += c;
  }
  return out;
}

/**
 * A synopsis is documentation shape, not a command.
 *
 * `flawless-react <entry.tsx> [options]` is the CLI reference's heading, and
 * feeding it to a parser would report a fictional failure about a file called
 * "<entry.tsx>". Placeholder angle brackets and a bare `[options]` are
 * unambiguous — neither appears in a real invocation.
 */
function isSynopsis(line: string): boolean {
  return (
    /<[A-Za-z][\w.|-]*>/.test(line) ||
    /\[options\]/.test(line) ||
    // `flawless-react                       (interactive menu)` — a trailing
    // parenthetical is an annotation; no real invocation of this CLI has one.
    /\s\([^)]*\)\s*$/.test(line)
  );
}

/** Every shell command line in a markdown or mdx document, continuations joined. */
export function commandLines(markdown: string): string[] {
  const lines: string[] = [];
  for (const m of markdown.matchAll(/```([a-z]*)\n([\s\S]*?)```/g)) {
    if (!SHELL_LANGS.has(m[1] as string)) continue;
    const body = m[2] as string;
    if (body.includes("<<")) continue; // heredoc payload, not a command line
    const open: OpenState = { quote: null, depth: 0 };
    let buf = "";
    for (const raw of body.replace(/\s*\\\n\s*/g, " ").split("\n")) {
      const trimmed = raw.trim();
      if (buf === "" && (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("$"))) {
        continue;
      }
      buf += (buf === "" ? "" : " ") + scanLine(raw, open).trim();
      if (open.quote !== null || open.depth > 0) continue;
      const line = buf.trim();
      buf = "";
      if (line !== "" && !isSynopsis(line)) lines.push(line);
    }
  }
  return lines;
}

/**
 * Every prose file this project ships: the README, the docs, and the skills.
 *
 * docs/reviews/ is deliberately absent. Those are dated ledgers describing what
 * was true at the time — linting them against today's code would demand that
 * history be rewritten whenever a finding is fixed.
 */
export function proseFiles(): string[] {
  const files = ["README.md"];
  for (const f of readdirSync(path.join(REPO_ROOT, "docs"))) {
    if (f.endsWith(".md")) files.push(`docs/${f}`);
  }
  for (const d of readdirSync(path.join(REPO_ROOT, ".claude", "skills"))) {
    files.push(`.claude/skills/${d}/SKILL.md`);
  }
  return files;
}

/**
 * The sibling website checkout, when this machine has one.
 *
 * The site hand-copies invocations and flag names from this repo and has no CI
 * of its own — the same rot the rest of this file exists to refuse, at its
 * largest surface. It is linted when present (dev machines, the mesh) and
 * skipped when not (a clean clone, CI of third parties): a docs gate must not
 * make this repo's test suite require an unrelated repository.
 */
const WEBSITE_DOCS =
  process.env.FLAWLESS_WEBSITE_DOCS ??
  path.join(REPO_ROOT, "..", "flawless-react-website", "src", "pages", "docs");

export function websiteProseFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}${e.name}/`);
      else if (e.name.endsWith(".mdx")) out.push(`website:${rel}${e.name}`);
    }
  };
  if (existsSync(WEBSITE_DOCS)) walk(WEBSITE_DOCS, "");
  return out;
}

export function readProse(rel: string): Promise<string> {
  if (rel.startsWith("website:")) {
    return Bun.file(path.join(WEBSITE_DOCS, rel.slice("website:".length))).text();
  }
  return Bun.file(path.join(REPO_ROOT, rel)).text();
}
