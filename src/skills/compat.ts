// Claude Code compatibility for the install: the real file lands in
// `.agents/skills/<name>/` (the cross-client convention — see SKILLS_SUBDIR) and
// `.claude/skills/<name>` is a link to that same directory, because Claude Code
// is the one mainstream host that does not read the standard path.
//
// A link rather than a copy so there is one file to edit and no way for the two
// views to disagree; per-skill rather than one link over `skills/` because Codex
// writes its own `.system/` in there and other CLIs expect a real directory.
//
// Nothing here may fail an install. The canonical write already succeeded; a
// compatibility entry is a convenience, and losing it says so and moves on.
//
// And nothing here is ever DELETED. A real directory under `.claude/skills` may
// be a skill somebody wrote, or another tool's, so it is reported and left alone
// — including under `--force`, which governs files we own, not ones we did not
// create. (crust lets its `--force` replace the directory; this is the one place
// we deliberately differ, so the rule is written where the difference lives
// rather than in a flag description.)
import { lstat, mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  claudeBaseDir,
  claudeSkillDir,
  type EmbeddedSkill,
  skillDir,
  skillsBaseDir,
} from "./data.ts";

export type CompatOutcome =
  /** Link created now. */
  | { kind: "linked" }
  /** Already a link to the canonical directory — nothing to do. */
  | { kind: "current" }
  /** A copy written instead of a link. `reason` names the flag or the errno. */
  | { kind: "copied"; reason: string }
  /** A real directory, or a plain file, is here. Untouched, and reported. */
  | { kind: "occupied" }
  /** A link, but to somewhere else — the user put it there. Untouched. */
  | { kind: "foreign"; target: string }
  /** Could not tell or act. Reported; the canonical file is still installed. */
  | { kind: "failed"; error: string };

/** The link target, written relative so a moved project or a synced `$HOME` keeps working. */
export function compatLinkTarget(name: string, global: boolean, cwd?: string): string {
  const link = claudeSkillDir(name, global, cwd);
  return relative(dirname(link), skillDir(skillsBaseDir(global, cwd), name));
}

/**
 * Make `.claude/skills/<name>` point at the installed skill.
 *
 * `copy` asks for a copy instead of a link (an agent that does not follow
 * symlinks, or a filesystem in the way). Symlinks being refused by the system —
 * Windows without Developer Mode — falls back to a copy on its own and says so.
 */
export async function ensureCompatEntry(
  skill: EmbeddedSkill,
  global: boolean,
  copy: boolean,
  cwd?: string,
): Promise<CompatOutcome> {
  const link = claudeSkillDir(skill.name, global, cwd);
  const canonical = skillDir(skillsBaseDir(global, cwd), skill.name);
  try {
    const st = await lstat(link);
    if (st.isSymbolicLink()) {
      const target = await readlink(link);
      return resolve(dirname(link), target) === resolve(canonical)
        ? { kind: "current" }
        : { kind: "foreign", target };
    }
    // A real directory or a plain file. It is not ours, so it is not touched —
    // not here, and not by --force either. The warning tells the user what to
    // remove if they want the link.
    return { kind: "occupied" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return { kind: "failed", error: (err as Error).message };
    }
  }

  try {
    await mkdir(dirname(link), { recursive: true });
  } catch (err) {
    return { kind: "failed", error: (err as Error).message };
  }

  if (!copy) {
    try {
      await symlink(relative(dirname(link), canonical), link, "dir");
      return { kind: "linked" };
    } catch (err) {
      // Only a filesystem that cannot do symlinks is worth working around; any
      // other failure is the real cause and goes to the report.
      if (!isSymlinkUnsupported(err)) return { kind: "failed", error: (err as Error).message };
      return writeCopy(skill, link, (err as Error).message);
    }
  }
  return writeCopy(skill, link, "--copy");
}

async function writeCopy(
  skill: EmbeddedSkill,
  link: string,
  reason: string,
): Promise<CompatOutcome> {
  try {
    // The link path is a DIRECTORY holding SKILL.md — both hosts discover a skill
    // as a directory, not a loose file — so the copy needs the directory made too.
    await mkdir(link, { recursive: true });
    await writeFile(`${link}/SKILL.md`, skill.content, { mode: 0o644 });
    return { kind: "copied", reason };
  } catch (err) {
    return { kind: "failed", error: (err as Error).message };
  }
}

/** Windows without Developer Mode answers EPERM; some filesystems say ENOTSUP. */
function isSymlinkUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EOPNOTSUPP";
}

/** One line for the install summary, plus anything the user should act on. */
export function summarizeCompat(
  results: Array<{ name: string; outcome: CompatOutcome }>,
  global: boolean,
  cwd?: string,
): { summary: string | null; warnings: string[] } {
  const kinds = (kind: CompatOutcome["kind"]) => results.filter((r) => r.outcome.kind === kind);
  const linked = kinds("linked").length;
  const copied = kinds("copied").length;
  const made = [linked > 0 ? `linked ${linked}` : null, copied > 0 ? `copied ${copied}` : null]
    .filter((s): s is string => s !== null)
    .join(", ");
  const claude = claudeBaseDir(global, cwd);
  const summary = made === "" ? null : `${made} into ${claude} for Claude Code`;

  const warnings: string[] = [];
  const occupied = kinds("occupied");
  if (occupied.length > 0) {
    const one = occupied.length === 1;
    warnings.push(
      `! ${occupied.length} real ${one ? "directory" : "directories"} under ${claude} ` +
        `flawless-react did not write — left untouched. Remove ${one ? "it" : "them"} by hand ` +
        `if you want the link instead (--force does not delete what we did not create):\n` +
        occupied.map((r) => `    ${claudeSkillDir(r.name, global, cwd)}\n`).join(""),
    );
  }
  for (const r of kinds("foreign")) {
    if (r.outcome.kind === "foreign") {
      warnings.push(
        `! ${claudeSkillDir(r.name, global, cwd)} links to ${r.outcome.target}, not to flawless-react's copy — left alone\n`,
      );
    }
  }
  for (const r of kinds("failed")) {
    if (r.outcome.kind === "failed") {
      warnings.push(
        `! could not write ${claudeSkillDir(r.name, global, cwd)} (${r.outcome.error}) — the skill is installed; Claude Code may not find it\n`,
      );
    }
  }
  return { summary, warnings };
}
