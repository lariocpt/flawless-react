// The skill entries under .agents/skills, checked as the shipped documentation
// they are. (.claude/skills holds a symlink per skill into this same corpus, so
// there is one set of bytes to lint, not two.)
//
// They are what a coding agent reads to drive this tool, and round 8 found one
// documenting a `throw` the tool never emits. Their fenced examples are linted
// by tests/docsLint.test.ts along with the rest of the prose; this file covers
// what is specific to a skill — its frontmatter, and the cross-references it
// makes to its siblings.
//
// The crust sibling's tests/skills.test.ts also exercises an install/--force
// path. So does ours — but that half lives in tests/skills.test.ts, which drives
// `flawless-react skills install` against the corpus embedded in the binary. This
// file covers what is specific to a skill file: its frontmatter, the
// cross-references it makes to its siblings, and the compat links beside it.

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { SKILL_CHOICES } from "../src/skills/spec.ts";
import { REPO_ROOT, readProse } from "./helpers/docs.ts";

const SKILLS_DIR = path.join(REPO_ROOT, ".agents", "skills");
const COMPAT_DIR = path.join(REPO_ROOT, ".claude", "skills");
const skillNames = readdirSync(SKILLS_DIR).sort();

describe("skill frontmatter", () => {
  // A canary: a refactor that stops finding skills must fail, not pass quietly.
  test("the whole skill corpus is found", () => {
    expect(skillNames.length).toBeGreaterThanOrEqual(14);
  });

  // The gap this closes: a SKILL.md added under .agents/skills that nobody adds
  // to SKILL_CHOICES passes every other skill test and simply never ships,
  // because `skills install` cannot offer what the binary does not carry.
  test("every skill on disk is in the embedded set", () => {
    expect(skillNames).toEqual([...SKILL_CHOICES].sort());
  });

  test("the compat root holds a link per skill, and only those", () => {
    // The compat layer is the one thing an agent notices when it is missing: it
    // reads `.claude/skills`, finds nothing, and answers that this tool has no
    // skills. A new skill added without its link, or a leftover link after a
    // rename, is invisible until that happens.
    expect(readdirSync(COMPAT_DIR).sort()).toEqual(skillNames);
    for (const name of skillNames) {
      const compat = path.join(COMPAT_DIR, name);
      // lstat, not stat: stat follows the link and reports the directory it
      // points at, which would make this assertion pass for a real directory too.
      expect(lstatSync(compat).isSymbolicLink()).toBe(true);
      // A relative link, so the pair survives a moved checkout; and it must
      // land on the canonical directory, not on a sibling that shares its name.
      expect(readlinkSync(compat)).toBe(`../../.agents/skills/${name}`);
      expect(realpathSync(compat)).toBe(realpathSync(path.join(SKILLS_DIR, name)));
      expect(existsSync(path.join(compat, "SKILL.md"))).toBe(true);
    }
  });

  test.each(skillNames)("%s", async (name) => {
    const text = await readProse(`.agents/skills/${name}/SKILL.md`);
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (fm === null) throw new Error(`${name}: no frontmatter block`);
    const block = fm[1] as string;
    // The directory IS the address an agent invokes; a name that disagrees with
    // it means the skill answers to something nobody can type.
    expect(block).toContain(`name: ${name}`);
    const desc = /^description: (.+)$/m.exec(block);
    if (desc === null) throw new Error(`${name}: no description`);
    expect((desc[1] as string).length).toBeGreaterThan(20);
  });
});

describe("skill cross-references", () => {
  test("every sibling skill a skill names exists", async () => {
    const real = new Set(skillNames);
    const dangling = new Set<string>();
    for (const name of skillNames) {
      const text = await readProse(`.agents/skills/${name}/SKILL.md`);
      for (const m of text.matchAll(/\bflawless-[a-z0-9-]+\b/g)) {
        const ref = m[0];
        // "flawless-react" is both a skill and the tool's own name, and the
        // rest of the prose is full of the latter. Only treat a reference as a
        // skill claim when it is not simply this project being named.
        if (ref === "flawless-react" || real.has(ref)) continue;
        if (/^flawless-(api|e2e|load|regen|findings|unit|browser)/.test(ref))
          dangling.add(`${ref} (${name})`);
      }
    }
    expect([...dangling].join("\n")).toBe("");
  });

  // The umbrella skill's description promises five deeper siblings by name.
  // That list is a claim like any other, and nothing had ever checked it.
  test("the umbrella skill's named siblings all exist", async () => {
    const text = await readProse(".agents/skills/flawless-react/SKILL.md");
    const desc = /^description: (.+)$/m.exec(text);
    if (desc === null) throw new Error("flawless-react: no description");
    const named = [...(desc[1] as string).matchAll(/flawless-[a-z0-9-]+/g)]
      .map((m) => m[0])
      .filter((n) => n !== "flawless-react");
    expect(named.length).toBeGreaterThanOrEqual(5);
    expect(named.filter((n) => !skillNames.includes(n)).join(", ")).toBe("");
  });
});
