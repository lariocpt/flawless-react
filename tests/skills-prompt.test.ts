import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { hasBun, shouldAsk } from "../scripts/postinstall.mjs";
import type { ClackPrompts } from "../src/prompt.ts";
import { offerSkills, type SkillsIO } from "../src/skills/cli.ts";
import { hasFlawlessSkills, skillPath, skillsBaseDir } from "../src/skills/data.ts";
import { parseSkillsCommand } from "../src/skills/spec.ts";

/**
 * The prompt's two halves: a question asked at most once per project, and a gate
 * that keeps it silent where it would be a nuisance or a hazard. The gate is the
 * half with blast radius — prompt in CI and the job waits on stdin until it times
 * out; skip the cwd check and files land inside node_modules — so every branch of
 * it is pinned here rather than discovered by running an install for real.
 */

/** A scripted clack: `answer` is what confirm resolves, `count` observes the ask. */
function fakeClack(answer: boolean | symbol, count?: { asked: number }): ClackPrompts {
  return {
    intro: () => {},
    outro: () => {},
    text: async () => "",
    multiselect: async () => [],
    confirm: async () => {
      if (count) count.asked++;
      return answer;
    },
    isCancel: (v: unknown) => typeof v === "symbol",
    cancel: () => {},
  };
}

function capture(): { io: SkillsIO; out: () => string } {
  const lines: string[] = [];
  return {
    io: {
      log: (l?: string) => lines.push(l ?? ""),
      warn: (l: string) => lines.push(l),
      isTTY: true,
    },
    out: () => lines.join("\n"),
  };
}

async function scratch(): Promise<string> {
  return mkdtemp(path.join(import.meta.dir, ".tmp", "prompt-"));
}

/** The conditions under which asking is possible at all. */
const ready = { stdinTty: true, stdoutTty: true, bunAvailable: true };

describe("shouldAsk — the npm postinstall gate", () => {
  test("asks in a plain interactive install", async () => {
    const cwd = await scratch();
    try {
      expect(shouldAsk({ env: { INIT_CWD: cwd }, ...ready })).toEqual({ ask: true, dir: cwd });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // One test, every silence: each line is a way to hang a build, write somewhere
  // wrong, or shout at somebody who cannot answer.
  test("stays silent on CI, non-tty, global, or with no usable directory", () => {
    const here = import.meta.dir; // a real project directory, for the checks after it
    const at = (INIT_CWD: string, env: Record<string, string> = {}) =>
      shouldAsk({ env: { INIT_CWD, ...env }, ...ready });
    expect(at(here, { CI: "true" }).reason).toBe("CI");
    expect(at(here, { npm_config_global: "true" }).reason).toMatch(/global install/);
    expect(at("/repo/node_modules/flawless-react").reason).toMatch(/node_modules/);
    expect(at("/nonexistent-flawless-dir").reason).toMatch(/gone/);
    expect(shouldAsk({ env: {}, ...ready }).reason).toMatch(/INIT_CWD/);
    expect(shouldAsk({ env: { INIT_CWD: here }, ...ready, stdinTty: false }).reason).toMatch(
      /terminal/,
    );
    expect(shouldAsk({ env: { INIT_CWD: here }, ...ready, stdoutTty: false }).reason).toMatch(
      /terminal/,
    );
    expect(shouldAsk({ env: { INIT_CWD: here }, ...ready, bunAvailable: false }).reason).toMatch(
      /bun/,
    );
  });

  // The opt-out beats a terminal, because a terminal is exactly where someone
  // reaches for the switch.
  test("FLAWLESS_NO_SKILLS beats every other condition", () => {
    expect(shouldAsk({ env: { FLAWLESS_NO_SKILLS: "1", INIT_CWD: "/tmp/x" }, ...ready }).ask).toBe(
      false,
    );
  });

  test("an existing skill in either root counts as already done", async () => {
    const ours = await scratch();
    const theirs = await scratch();
    try {
      mkdirSync(path.join(ours, ".claude/skills/flawless-react"), { recursive: true });
      expect(shouldAsk({ env: { INIT_CWD: ours }, ...ready }).reason).toMatch(/already installed/);
      // Someone else's skill is not ours: the prefix is the whole ownership rule.
      mkdirSync(path.join(theirs, ".agents/skills/review-native"), { recursive: true });
      expect(shouldAsk({ env: { INIT_CWD: theirs }, ...ready }).ask).toBe(true);
    } finally {
      await rm(ours, { recursive: true, force: true });
      await rm(theirs, { recursive: true, force: true });
    }
  });
});

describe("hasFlawlessSkills — one ownership rule, two implementations", () => {
  // The npm postinstall is Node-only .mjs and the CLI is TypeScript, so the prefix
  // rule exists twice by necessity. This is what stops those two definitions
  // meaning different things about the same tree.
  test("agrees with the postinstall's own copy", async () => {
    for (const layout of [".claude/skills/flawless-react", ".agents/skills/flawless-expo"]) {
      const cwd = await scratch();
      try {
        mkdirSync(path.join(cwd, layout), { recursive: true });
        expect(hasFlawlessSkills(false, cwd)).toBe(true);
        expect(shouldAsk({ env: { INIT_CWD: cwd }, ...ready }).reason).toMatch(/already installed/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  test("a link counts, an unrelated prefix does not, an absent root is no", async () => {
    const cwd = await scratch();
    try {
      expect(hasFlawlessSkills(false, cwd)).toBe(false);
      mkdirSync(path.join(cwd, ".claude/skills"), { recursive: true });
      writeFileSync(path.join(cwd, ".claude/skills/review-native.md"), "not ours\n");
      expect(hasFlawlessSkills(false, cwd)).toBe(false);
      await symlink(path.join(cwd, "somewhere"), path.join(cwd, ".claude/skills/flawless-api"));
      expect(hasFlawlessSkills(false, cwd)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("the postinstall's runner probe", () => {
  test("is no when bun cannot be executed", () => {
    expect(hasBun((() => ({ error: new Error("ENOENT"), status: null })) as never)).toBe(false);
    expect(hasBun((() => ({ error: undefined, status: 1 })) as never)).toBe(false);
    expect(hasBun((() => ({ error: undefined, status: 0 })) as never)).toBe(true);
    // The real probe, on the machine that runs these tests: bun is how this repo
    // runs at all, so a false here means the probe itself is broken.
    expect(hasBun()).toBe(true);
  });
});

describe("offerSkills — the question at the end of an interactive run", () => {
  test("yes installs every skill into the project", async () => {
    const cwd = await scratch();
    try {
      const c = capture();
      await offerSkills(c.io, { cwd, env: {}, prompts: fakeClack(true) });
      expect(existsSync(skillPath(skillsBaseDir(false, cwd), "flawless-react"))).toBe(true);
      // The compat link too, or Claude Code would see nothing: read through the
      // link, which is what an agent does.
      expect(existsSync(path.join(cwd, ".claude/skills/flawless-react/SKILL.md"))).toBe(true);
      expect(c.out()).toContain("installed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("no writes nothing and says how to do it later", async () => {
    const cwd = await scratch();
    try {
      const c = capture();
      await offerSkills(c.io, { cwd, env: {}, prompts: fakeClack(false) });
      expect(existsSync(path.join(cwd, ".agents"))).toBe(false);
      expect(c.out()).toContain("flawless-react skills install");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a cancel is not a failure and writes nothing", async () => {
    const cwd = await scratch();
    try {
      await offerSkills(capture().io, { cwd, env: {}, prompts: fakeClack(Symbol("cancel")) });
      expect(existsSync(path.join(cwd, ".agents"))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // What makes "asked once" true without storing a decline anywhere: answering yes
  // puts a skill on disk, and a skill on disk is the reason not to ask again.
  test("does not ask a project that already has one", async () => {
    const cwd = await scratch();
    try {
      mkdirSync(path.join(cwd, ".claude/skills/flawless-regen"), { recursive: true });
      const asked = { asked: 0 };
      await offerSkills(capture().io, { cwd, env: {}, prompts: fakeClack(true, asked) });
      expect(asked.asked).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("FLAWLESS_NO_SKILLS ends the asking", async () => {
    const cwd = await scratch();
    try {
      const asked = { asked: 0 };
      await offerSkills(capture().io, {
        cwd,
        env: { FLAWLESS_NO_SKILLS: "1" },
        prompts: fakeClack(true, asked),
      });
      expect(asked.asked).toBe(0);
      expect(existsSync(path.join(cwd, ".agents"))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // The yes-answer reaches the installer through the same parser as the command,
  // so it cannot install anything the CLI would refuse. A second offer — after the
  // first said yes — has to find the skills already current and write nothing.
  test("a yes is exactly `skills install --all`", async () => {
    const cwd = await scratch();
    try {
      await offerSkills(capture().io, { cwd, env: {}, prompts: fakeClack(true) });
      const second = capture();
      expect(parseSkillsCommand(["install", "--all"]).all).toBe(true);
      expect(hasFlawlessSkills(false, cwd)).toBe(true);
      await offerSkills(second.io, { cwd, env: {}, prompts: fakeClack(true) });
      expect(second.out()).toBe("");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
