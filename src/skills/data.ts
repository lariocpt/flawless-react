// The agent skills, embedded into the binary by static text imports.
//
// Embedding rather than reading the repo at run time is what lets `flawless-react
// skills install` work from an installed package or a compiled binary, on a
// machine that has no checkout of this repo anywhere on it.
//
// The sources are the tracked files under `.agents/skills` — the same bytes
// tests/docsLint.test.ts lints against the CLI — so what ships is exactly what
// was checked. That makes this repo its own installer dogfood, with one rule
// doing the safety work: a file on disk that differs from the embedded copy is
// `edited`, and `edited` is refused without `--force`. A stale binary therefore
// cannot quietly roll back a SKILL.md you just changed here.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import flawlessA11y from "../../.agents/skills/flawless-a11y/SKILL.md" with { type: "text" };
import flawlessApi from "../../.agents/skills/flawless-api/SKILL.md" with { type: "text" };
import flawlessApiFixtures from "../../.agents/skills/flawless-api-fixtures/SKILL.md" with {
  type: "text",
};
import flawlessE2E from "../../.agents/skills/flawless-e2e/SKILL.md" with { type: "text" };
import flawlessExpo from "../../.agents/skills/flawless-expo/SKILL.md" with { type: "text" };
import flawlessFindings from "../../.agents/skills/flawless-findings/SKILL.md" with {
  type: "text",
};
import flawlessLoad from "../../.agents/skills/flawless-load/SKILL.md" with { type: "text" };
import flawlessNextjs from "../../.agents/skills/flawless-nextjs/SKILL.md" with { type: "text" };
import flawlessPerfHarness from "../../.agents/skills/flawless-perf-harness/SKILL.md" with {
  type: "text",
};
import flawlessPerfStatic from "../../.agents/skills/flawless-perf-static/SKILL.md" with {
  type: "text",
};
import flawlessReact from "../../.agents/skills/flawless-react/SKILL.md" with { type: "text" };
import flawlessReactRules from "../../.agents/skills/flawless-react-rules/SKILL.md" with {
  type: "text",
};
import flawlessRegen from "../../.agents/skills/flawless-regen/SKILL.md" with { type: "text" };
import flawlessUnitBrowser from "../../.agents/skills/flawless-unit-browser/SKILL.md" with {
  type: "text",
};
import { SKILL_CHOICES } from "./spec.ts";

export interface EmbeddedSkill {
  name: string;
  content: string;
}

/**
 * The names live in spec.ts and this maps them onto bytes, which makes the two
 * agree by type rather than by test: the Record has to cover every name and
 * nothing else, so a skill added without being listed — or listed without being
 * embedded — is a compile error.
 */
const CONTENT: Record<(typeof SKILL_CHOICES)[number], string> = {
  "flawless-react": flawlessReact,
  "flawless-nextjs": flawlessNextjs,
  "flawless-unit-browser": flawlessUnitBrowser,
  "flawless-perf-harness": flawlessPerfHarness,
  "flawless-perf-static": flawlessPerfStatic,
  "flawless-a11y": flawlessA11y,
  "flawless-react-rules": flawlessReactRules,
  "flawless-findings": flawlessFindings,
  "flawless-e2e": flawlessE2E,
  "flawless-load": flawlessLoad,
  "flawless-api-fixtures": flawlessApiFixtures,
  "flawless-regen": flawlessRegen,
  "flawless-api": flawlessApi,
  "flawless-expo": flawlessExpo,
};

/** Order is display order: the umbrella first, since it is the router. */
export const EMBEDDED_SKILLS: EmbeddedSkill[] = SKILL_CHOICES.map((name) => ({
  name,
  content: CONTENT[name],
}));

/**
 * Where the real files land, relative to a project root or to `$HOME`.
 *
 * `.agents/skills` is the cross-client convention: Codex reads **only** that
 * path, Cursor and OpenCode read it alongside their own vendor directories, and
 * Claude Code reads only `.claude/skills`. So this is the canonical half and
 * {@link CLAUDE_SUBDIR} is the compatibility half — a per-skill link, not a
 * second copy, because two copies drift and one edited file becomes two
 * questions.
 */
export const SKILLS_SUBDIR = ".agents/skills";

/** Claude Code's own discovery path, which does not read {@link SKILLS_SUBDIR}. */
export const CLAUDE_SUBDIR = ".claude/skills";

/**
 * What identifies a skill as ours on disk. The install gate uses it to decide
 * "this user has already done this", and a future `skills uninstall` uses it to
 * find what we own without a manifest — the embedded set plus this prefix.
 */
export const SKILL_PREFIX = "flawless-";

/** Root of a scope: the project cwd, or the user's home when `global`. */
export function skillsRoot(global: boolean, cwd = process.cwd()): string {
  return global ? homeDir() : cwd.replace(/\/+$/, "");
}

/**
 * The user's home, honouring `$HOME` when it is set.
 *
 * Bun's `os.homedir()` reads the passwd entry and ignores `$HOME`; in a
 * container, where the passwd entry is root's and the process runs with
 * `HOME=/home/deploy`, that difference decides whether a `--global` install
 * lands where the agent will actually look for it. POSIX convention is that
 * `$HOME` wins when present, and it also makes the global scope testable without
 * pretending to be another user.
 */
export function homeDir(): string {
  const fromEnv = process.env.HOME?.trim();
  return fromEnv ? fromEnv.replace(/\/+$/, "") : homedir();
}

/** `<root>/.agents/skills` — the canonical directory for this scope. */
export function skillsBaseDir(global: boolean, cwd?: string): string {
  return `${skillsRoot(global, cwd)}/${SKILLS_SUBDIR}`;
}

/** `<root>/.claude/skills` — Claude Code's discovery directory for this scope. */
export function claudeBaseDir(global: boolean, cwd?: string): string {
  return `${skillsRoot(global, cwd)}/${CLAUDE_SUBDIR}`;
}

/** The directory one skill owns: `<base>/<name>`. */
export function skillDir(baseDir: string, name: string): string {
  return `${baseDir}/${name}`;
}

export function skillPath(baseDir: string, name: string): string {
  return `${skillDir(baseDir, name)}/SKILL.md`;
}

/** `<root>/.claude/skills/<name>` — where the link to {@link skillDir} belongs. */
export function claudeSkillDir(name: string, global: boolean, cwd?: string): string {
  return `${claudeBaseDir(global, cwd)}/${name}`;
}

/**
 * `missing` — nothing installed. `current` — byte-identical to the embedded
 * copy. `edited` — present and DIFFERENT, which is the one state an install must
 * not silently overwrite, and so the one the menu draws in yellow.
 */
export type SkillStatus = "missing" | "current" | "edited";

export interface SkillStatuses {
  project: SkillStatus;
  global: SkillStatus;
}

async function statusAt(file: string, content: string): Promise<SkillStatus> {
  const f = Bun.file(file);
  if (!(await f.exists())) return "missing";
  return (await f.text()) === content ? "current" : "edited";
}

/**
 * Both scopes in one pass, because the only caller is `skills list`, which shows
 * the two columns side by side. Passing `cwd` (rather than letting it default) is
 * what lets the tests run against a scratch project without chdir'ing the runner.
 */
export async function skillStatuses(skill: EmbeddedSkill, cwd?: string): Promise<SkillStatuses> {
  return {
    project: await statusAt(skillPath(skillsBaseDir(false, cwd), skill.name), skill.content),
    global: await statusAt(skillPath(skillsBaseDir(true, cwd), skill.name), skill.content),
  };
}

/**
 * Whether ANY of our skills is already on disk for a scope — "this has been done"
 * for the two questions (npm's postinstall and the one after an interactive run),
 * and the reason neither needs a marker file: the installed skills ARE the marker.
 *
 * Both roots of the scope are checked, and {@link SKILL_PREFIX} is the only rule,
 * which is what keeps a third-party `.claude/skills/review-react` from counting as
 * ours while one of ours, installed before `.agents` existed, still does.
 */
export function hasFlawlessSkills(global: boolean, cwd?: string): boolean {
  return [skillsBaseDir(global, cwd), claudeBaseDir(global, cwd)].some((dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).some(
        (e) => e.name.startsWith(SKILL_PREFIX) && (e.isDirectory() || e.isSymbolicLink()),
      );
    } catch {
      return false;
    }
  });
}
