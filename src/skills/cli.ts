// `flawless-react skills list | install` — the runner.
//
// The order of operations is the contract, and it is the one thing here that is
// not obvious from any single function:
//
//   1. write `.agents/skills/<name>/SKILL.md`  — the promise
//   2. link `.claude/skills/<name>` at it      — the convenience
//   3. report                                  — including what was refused
//
// The canonical write comes first and the exit code follows it alone. A compat
// entry that could not be made costs Claude Code the discovery of one skill and
// is reported; it does not turn a completed install into a failed one, and it
// never deletes anything that might be somebody else's.
import { mkdir, writeFile } from "node:fs/promises";
import type { ClackPrompts } from "../prompt.ts";
import { loadClack } from "../prompt.ts";
import { type CompatOutcome, ensureCompatEntry, summarizeCompat } from "./compat.ts";
import {
  EMBEDDED_SKILLS,
  type EmbeddedSkill,
  hasFlawlessSkills,
  SKILLS_SUBDIR,
  type SkillStatus,
  skillDir,
  skillPath,
  skillStatuses,
  skillsBaseDir,
} from "./data.ts";
import { defaultSelection, pickSkills } from "./menu.ts";
import { parseSkillsCommand, renderSkillsHelp, type SkillsCommand } from "./spec.ts";

/** Everything the runner writes to, so a test can read the same text the user does. */
export interface SkillsIO {
  log: (line?: string) => void;
  warn: (line: string) => void;
  isTTY: boolean;
}

export function defaultSkillsIO(): SkillsIO {
  return {
    log: (line?: string) => console.log(line ?? ""),
    warn: (line: string) => console.warn(line),
    isTTY: process.stdout.isTTY === true,
  };
}

/** The status that matters for an install: the one for the scope being written to. */
export function targetStatus(statuses: Awaited<ReturnType<typeof skillStatuses>>, global: boolean) {
  return global ? statuses.global : statuses.project;
}

interface Chosen {
  skill: EmbeddedSkill;
  status: SkillStatus;
}

/**
 * Which skills this run acts on, and what state each is already in for the
 * target scope.
 *
 * The menu appears only when the user asked for nothing specific and has a
 * terminal. Piped, CI, or `--all`, it installs everything — an installer that
 * waits on a keyboard nobody is holding is a hung build, not a helpful tool.
 */
async function chooseSkills(
  cmd: SkillsCommand,
  cwd: string,
  io: SkillsIO,
): Promise<{ chosen: Chosen[]; aborted: boolean; fromMenu: boolean }> {
  const withStatus: Chosen[] = [];
  for (const skill of EMBEDDED_SKILLS) {
    withStatus.push({ skill, status: targetStatus(await skillStatuses(skill, cwd), cmd.global) });
  }

  if (cmd.select.length > 0) {
    return {
      chosen: withStatus.filter((c) => cmd.select.includes(c.skill.name)),
      aborted: false,
      fromMenu: false,
    };
  }
  if (cmd.all || !io.isTTY) return { chosen: withStatus, aborted: false, fromMenu: false };

  const picked = await pickSkills(
    skillsBaseDir(cmd.global, cwd),
    withStatus.map((c) => ({ name: c.skill.name, hint: hintFor(c.status) })),
    defaultSelection(withStatus.map((c) => ({ name: c.skill.name, status: c.status }))),
  );
  if (picked === undefined) return { chosen: [], aborted: true, fromMenu: true };
  return {
    chosen: withStatus.filter((c) => picked.includes(c.skill.name)),
    aborted: false,
    fromMenu: true,
  };
}

function hintFor(status: SkillStatus): string {
  if (status === "current") return "installed, up to date";
  if (status === "edited") return "installed, edited locally — --force to overwrite";
  return "not installed";
}

/** Write the canonical SKILL.md. False means it could not be written. */
async function installCanonical(chosen: Chosen, cmd: SkillsCommand, cwd: string): Promise<boolean> {
  const base = skillsBaseDir(cmd.global, cwd);
  try {
    await mkdir(skillDir(base, chosen.skill.name), { recursive: true });
    await writeFile(skillPath(base, chosen.skill.name), chosen.skill.content, { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}

async function runList(io: SkillsIO, cwd: string): Promise<number> {
  const width = Math.max(...EMBEDDED_SKILLS.map((s) => s.name.length));
  io.log("flawless-react agent skills, embedded in this binary:");
  io.log();
  for (const skill of EMBEDDED_SKILLS) {
    const s = await skillStatuses(skill, cwd);
    io.log(`  ${skill.name.padEnd(width)}  ${s.project.padEnd(7)}  ${s.global}`);
  }
  io.log();
  io.log("  columns are ./.agents/skills and ~/.agents/skills — current means the file");
  io.log("  matches this binary, edited that it differs and was left as written.");
  io.log("  install with: flawless-react skills install");
  return 0;
}

async function runInstall(cmd: SkillsCommand, cwd: string, io: SkillsIO): Promise<number> {
  const { chosen, aborted, fromMenu } = await chooseSkills(cmd, cwd, io);
  if (aborted) return 0;
  if (!fromMenu && !cmd.all && cmd.select.length === 0 && chosen.length > 0) {
    io.log("not a terminal — installing every skill (use the menu on a tty, or --select)");
  }

  const base = skillsBaseDir(cmd.global, cwd);
  const written: string[] = [];
  const refused: string[] = [];
  const failed: string[] = [];
  for (const c of chosen) {
    if (c.status === "edited" && !cmd.force) {
      refused.push(c.skill.name);
      continue;
    }
    // `current` is not rewritten: the bytes on disk already equal the bytes in
    // this binary, so writing them again would only refresh mtime and make a
    // user's own `git status`-by-mtime habits lie.
    if (c.status === "current") continue;
    if (await installCanonical(c, cmd, cwd)) written.push(c.skill.name);
    else failed.push(c.skill.name);
  }

  // Only skills whose canonical file is actually in place get a compat entry: a
  // refused or failed one would otherwise leave a link pointing at nothing.
  const compat: Array<{ name: string; outcome: CompatOutcome }> = [];
  for (const c of chosen) {
    if (refused.includes(c.skill.name) || failed.includes(c.skill.name)) continue;
    compat.push({
      name: c.skill.name,
      outcome: await ensureCompatEntry(c.skill, cmd.global, cmd.copy, cwd),
    });
  }
  const report = summarizeCompat(compat, cmd.global, cwd);

  const upToDate = chosen.length - written.length - refused.length - failed.length;
  if (written.length === 0 && refused.length === 0 && failed.length === 0 && upToDate > 0) {
    io.log(
      `✔ ${chosen.length} ${chosen.length === 1 ? "skill" : "skills"} already current → ${base}`,
    );
  } else if (written.length + upToDate > 0) {
    const parts = [];
    if (written.length > 0) parts.push(`installed ${written.length}`);
    if (upToDate > 0) parts.push(`up-to-date ${upToDate}`);
    io.log(`✔ ${parts.join(", ")} → ${base}`);
  }
  if (report.summary) io.log(`  ${report.summary}`);
  for (const w of report.warnings) io.warn(w);

  if (refused.length > 0) {
    io.warn(
      `! ${refused.length} ${refused.length === 1 ? "skill" : "skills"} edited locally, kept:\n` +
        refused.map((n) => `    ${skillPath(base, n)}`).join("\n") +
        "\n  re-run with --force to overwrite them",
    );
  }
  if (failed.length > 0) {
    io.warn(
      `! could not write ${failed.length} ${failed.length === 1 ? "skill" : "skills"}: ${failed.join(", ")}`,
    );
  }
  return refused.length > 0 || failed.length > 0 ? 1 : 0;
}

/**
 * Run the subcommand. Returns the process exit code: 0 done — including a
 * cancelled menu and a compat miss, which is reported and best-effort — 1
 * something the user asked for was not installed, 2 bad usage (parseSkillsCommand).
 */
export async function runSkillsCommand(
  cmd: SkillsCommand,
  io: SkillsIO = defaultSkillsIO(),
  cwd = process.cwd(),
): Promise<number> {
  if (cmd.verb === "help") {
    io.log(renderSkillsHelp());
    return 0;
  }
  if (cmd.verb === "list") return runList(io, cwd);
  return runInstall(cmd, cwd, io);
}

/**
 * The one question asked at the end of an interactive run: want the skills?
 *
 * Three things make this the right place and stop it being a nag. It is asked
 * only on the interactive path — `--no-interactive`, `--json` and CI mean do not
 * speak to me, and this is not a machine's errand. It is asked only while the
 * project has no `flawless-*` skill anywhere, and answering YES is what makes it
 * stop asking: the installed skills are the marker, so no state file has to
 * follow the user around. And answering NO costs nothing but the same question
 * next time, which is a fair price for never storing a decision nobody made.
 *
 * `FLAWLESS_NO_SKILLS` silences it outright, and is the same switch the npm
 * postinstall honours, so one environment variable ends all asking.
 */
export async function offerSkills(
  io: SkillsIO,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; prompts?: ClackPrompts } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  if (env.FLAWLESS_NO_SKILLS) return;
  if (hasFlawlessSkills(false, cwd)) return;

  const p = opts.prompts ?? (await loadClack());
  const yes = await p.confirm({
    message: `Install the ${EMBEDDED_SKILLS.length} agent skills into ${SKILLS_SUBDIR}?`,
    initialValue: true,
  });
  if (p.isCancel(yes) || !yes) {
    io.log("  skipped — `flawless-react skills install` does it later, any time.");
    return;
  }
  // The same code path as the command, reached through the same parser, so the
  // yes-answer cannot install something the CLI itself would refuse to.
  await runSkillsCommand(parseSkillsCommand(["install", "--all"]), io, cwd);
}
