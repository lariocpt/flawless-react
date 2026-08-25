// The six .claude/skills entries, checked as the shipped documentation they are.
//
// They are what a coding agent reads to drive this tool, and round 8 found one
// documenting a `throw` the tool never emits. Their fenced examples are linted
// by tests/docsLint.test.ts along with the rest of the prose; this file covers
// what is specific to a skill — its frontmatter, and the cross-references it
// makes to its siblings.
//
// The crust sibling's tests/skills.test.ts also exercises an install/--force
// path. flawless-react has none: these are plain repo files, not embedded in
// the binary, so there is nothing to install and nothing to guard against
// overwriting.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, readProse } from "./helpers/docs.ts";

const SKILLS_DIR = path.join(REPO_ROOT, ".claude", "skills");
const skillNames = readdirSync(SKILLS_DIR).sort();

describe("skill frontmatter", () => {
  // A canary: a refactor that stops finding skills must fail, not pass quietly.
  test("all six skills are present", () => {
    expect(skillNames.length).toBeGreaterThanOrEqual(6);
  });

  test.each(skillNames)("%s", async (name) => {
    const text = await readProse(`.claude/skills/${name}/SKILL.md`);
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
      const text = await readProse(`.claude/skills/${name}/SKILL.md`);
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
    const text = await readProse(".claude/skills/flawless-react/SKILL.md");
    const desc = /^description: (.+)$/m.exec(text);
    if (desc === null) throw new Error("flawless-react: no description");
    const named = [...(desc[1] as string).matchAll(/flawless-[a-z0-9-]+/g)]
      .map((m) => m[0])
      .filter((n) => n !== "flawless-react");
    expect(named.length).toBeGreaterThanOrEqual(5);
    expect(named.filter((n) => !skillNames.includes(n)).join(", ")).toBe("");
  });
});
