import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { checkLines } from "../src/cli.ts";
import { runSkillsCommand, type SkillsIO } from "../src/skills/cli.ts";
import { compatLinkTarget } from "../src/skills/compat.ts";
import { EMBEDDED_SKILLS, skillPath, skillsBaseDir } from "../src/skills/data.ts";
import { defaultSelection, pickSkills } from "../src/skills/menu.ts";
import {
  parseSkillsCommand,
  renderSkillsHelp,
  SKILL_FLAGS,
  SKILL_NAMES,
} from "../src/skills/spec.ts";

const SKILLS_SOURCE = path.resolve(import.meta.dir, "..", ".agents", "skills");
const contentOf = (name: string): string =>
  EMBEDDED_SKILLS.find((s) => s.name === name)?.content ?? "";
const claudeDir = (cwd: string, name: string): string => path.join(cwd, ".claude", "skills", name);

/** Collected output, because the runner's report IS its contract with the user. */
function capture(tty = false): { io: SkillsIO; out: () => string; err: () => string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: { log: (l?: string) => o.push(l ?? ""), warn: (l: string) => e.push(l), isTTY: tty },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

async function scratch(): Promise<string> {
  return mkdtemp(path.join(import.meta.dir, ".tmp", "skills-"));
}

/** Parse then run, exactly as main() does — into a scratch project, not cwd. */
async function run(
  cwd: string,
  argv: string[],
  tty = false,
): Promise<{ code: number; out: string; err: string }> {
  const c = capture(tty);
  const code = await runSkillsCommand(parseSkillsCommand(argv), c.io, cwd);
  return { code, out: c.out(), err: c.err() };
}

async function cleanup(cwd: string): Promise<void> {
  await rm(cwd, { recursive: true, force: true });
}

describe("the embedded set", () => {
  test("covers exactly the skills in .agents/skills, byte for byte", () => {
    // The direction that matters: what ships is what the docs lint read. A skill
    // added to the tree without being embedded would be invisible to every
    // install, and a stale embedded copy would overwrite an edit nobody meant to
    // publish — either way the only witness is this comparison.
    expect(SKILL_NAMES.length).toBe(EMBEDDED_SKILLS.length);
    for (const name of SKILL_NAMES) {
      expect(contentOf(name)).toBe(
        readFileSync(path.join(SKILLS_SOURCE, name, "SKILL.md"), "utf8"),
      );
    }
  });

  test("every embedded SKILL.md is frontmatter-named after its own directory", () => {
    for (const skill of EMBEDDED_SKILLS) {
      const fm = skill.content.match(/^---\n([\s\S]*?)\n---/);
      expect(fm, `${skill.name} has no frontmatter`).not.toBeNull();
      const name = fm?.[1]
        ?.split("\n")
        .find((l) => l.startsWith("name:"))
        ?.slice("name:".length)
        .trim();
      expect(name).toBe(skill.name);
    }
  });

  // spec.ts owns the list and data.ts maps it onto files with a Record, so a
  // mismatch is a compile error. What only a test can say is that the umbrella
  // comes first — it is the router, so it is what a reader should be handed.
  test("the umbrella is first, and every name carries the prefix", () => {
    expect(SKILL_NAMES[0]).toBe("flawless-react");
    for (const n of SKILL_NAMES) expect(n.startsWith("flawless-")).toBe(true);
  });
});

describe("parseSkillsCommand", () => {
  test("verbs and flags", () => {
    expect(parseSkillsCommand([]).verb).toBe("help");
    expect(parseSkillsCommand(["help"]).verb).toBe("help");
    expect(parseSkillsCommand(["list"]).verb).toBe("list");
    expect(parseSkillsCommand(["install", "--all"]).all).toBe(true);
    expect(parseSkillsCommand(["install", "--global"]).global).toBe(true);
    expect(parseSkillsCommand(["install", "-g"]).global).toBe(true);
    expect(parseSkillsCommand(["install", "--copy"]).copy).toBe(true);
    expect(parseSkillsCommand(["install", "--force", "-f"].slice(0, 2)).force).toBe(true);
    expect(parseSkillsCommand(["install", "-f"]).force).toBe(true);
    expect(parseSkillsCommand(["install", "--help"]).verb).toBe("help");
  });

  test("an unknown verb names itself and the choices", () => {
    expect(() => parseSkillsCommand(["istall"])).toThrow(/unknown skills verb: istall/);
  });

  test("--select reads both comma-separated and repeated", () => {
    expect(parseSkillsCommand(["install", "--select=flawless-api,flawless-expo"]).select).toEqual([
      "flawless-api",
      "flawless-expo",
    ]);
    expect(
      parseSkillsCommand(["install", "--select", "flawless-api", "--select", "flawless-expo"])
        .select,
    ).toEqual(["flawless-api", "flawless-expo"]);
  });

  test("an unknown skill is refused with the list attached", () => {
    expect(() => parseSkillsCommand(["install", "--select=flawless-nope"])).toThrow(
      /unknown skill: flawless-nope\. Available: /,
    );
  });

  test("--all and --select are not both", () => {
    expect(() => parseSkillsCommand(["install", "--all", "--select=flawless-api"])).toThrow(
      /mutually exclusive/,
    );
  });

  // A flag that does nothing is worse than a refusal: it reads as if the scope it
  // names had been honoured. `list` needs no scope — it prints both as columns — and
  // the check refuses ANY flag, so `--force` joining this list is the regression this
  // test exists for: it is the one a hand-maintained subset used to let through.
  test("skills list takes no flags", () => {
    for (const flag of ["--global", "--all", "--copy", "--force", "--select=flawless-api"]) {
      expect(() => parseSkillsCommand(["list", flag])).toThrow(/skills list takes no flags/);
    }
    expect(() => parseSkillsCommand(["list", "--global"])).toThrow(/both scopes/);
  });

  test("an unknown flag names itself", () => {
    expect(() => parseSkillsCommand(["install", "--no-interactive"])).toThrow(
      /unknown flag for 'skills install': --no-interactive/,
    );
  });

  test("a stray positional is refused rather than read as a glob", () => {
    expect(() => parseSkillsCommand(["install", "src/**/*.tsx"])).toThrow(
      /unexpected argument after 'skills install'/,
    );
  });

  // The direction the main parser already proves for itself: every flag the switch
  // branches on has to be documented somewhere, or it ships undocumented.
  test("every flag the parser branches on is documented", async () => {
    const text = await Bun.file(path.resolve(import.meta.dir, "../src/skills/spec.ts")).text();
    const branched = new Set<string>();
    for (const m of text.matchAll(/a === "(--[a-z][a-z-]*)"|a\.startsWith\("(--[a-z][a-z-]*)=/g)) {
      branched.add((m[1] ?? m[2]) as string);
    }
    const documented = new Set([...SKILL_FLAGS.map((f) => f.name), "--force", "--help"]);
    expect([...branched].filter((f) => !documented.has(f)).join(", ")).toBe("");
  });

  test("the help lists every flag", () => {
    const help = renderSkillsHelp();
    for (const f of SKILL_FLAGS) expect(help).toContain(f.name);
    expect(help).toContain("--force");
    expect(help).toContain(".claude/skills");
  });
});

describe("--check knows the subcommand grammar", () => {
  test("a documented skills line parses", () => {
    const r = checkLines("flawless-react skills install --all\nflawless-react skills list");
    expect(r.problems.map((p) => p.problem)).toEqual([]);
    expect(r.checked).toBe(2);
  });

  // Before this routing, --check read `install` as an entry glob and `--all` as an
  // unknown flag, so a working README example was reported broken — and a renamed
  // flag survived in prose because nothing parsed it.
  test("a stale skills flag is caught, not passed through", () => {
    const r = checkLines("flawless-react skills install --every");
    expect(r.problems[0]?.problem).toMatch(/unknown flag for 'skills install': --every/);
  });

  test("--flags is a bare switch, and only that", () => {
    expect(checkLines("flawless-react --flags").problems).toEqual([]);
    expect(checkLines("flawless-react --flags --json").problems[0]?.problem).toMatch(
      /--flags takes no arguments/,
    );
  });
});

describe("skills list", () => {
  test("names every skill and both scopes", async () => {
    const cwd = await scratch();
    try {
      const { code, out } = await run(cwd, ["list"]);
      expect(code).toBe(0);
      for (const n of SKILL_NAMES) expect(out).toContain(n);
      expect(out).toContain("missing");
    } finally {
      await cleanup(cwd);
    }
  });
});

describe("skills install", () => {
  test("writes .agents/skills and links .claude/skills at it", async () => {
    const cwd = await scratch();
    try {
      const { code, out } = await run(cwd, ["install", "--all"]);
      expect(code).toBe(0);
      expect(out).toContain(`installed ${SKILL_NAMES.length}`);
      expect(out).toContain("for Claude Code");
      for (const name of SKILL_NAMES) {
        const canonical = skillPath(skillsBaseDir(false, cwd), name);
        expect(readFileSync(canonical, "utf8")).toBe(contentOf(name));
        // A link, not a copy: two copies are two files that can disagree. It links
        // the skill's DIRECTORY (that is what a host discovers), and reading
        // through it is the only proof the relative target is the right one.
        expect(lstatSync(claudeDir(cwd, name)).isSymbolicLink()).toBe(true);
        expect(readFileSync(`${claudeDir(cwd, name)}/SKILL.md`, "utf8")).toBe(contentOf(name));
      }
      // Per-skill links, never one over the whole directory: Codex writes its own
      // .system/ in there and a wholesale link would hide it.
      expect(lstatSync(path.join(cwd, ".claude/skills")).isSymbolicLink()).toBe(false);
    } finally {
      await cleanup(cwd);
    }
  });

  test("the link target is relative, and identical in shape for both scopes", () => {
    // Two levels down on both sides of every root, so the same relative string
    // works in a project and in $HOME — which is the point of writing it relative.
    expect(compatLinkTarget("flawless-api", false, "/tmp/p")).toBe(
      "../../.agents/skills/flawless-api",
    );
    expect(compatLinkTarget("flawless-api", true)).toBe("../../.agents/skills/flawless-api");
  });

  test("a second run writes nothing and says so", async () => {
    const cwd = await scratch();
    try {
      await run(cwd, ["install", "--all"]);
      const before = lstatSync(skillPath(skillsBaseDir(false, cwd), "flawless-api"));
      const again = await run(cwd, ["install", "--all"]);
      expect(again.code).toBe(0);
      expect(again.out).toContain(`${SKILL_NAMES.length} skills already current`);
      // Idempotence is "the file was not rewritten", not merely "the bytes match".
      expect(lstatSync(skillPath(skillsBaseDir(false, cwd), "flawless-api")).mtimeMs).toBe(
        before.mtimeMs,
      );
      expect(again.err).toBe("");
    } finally {
      await cleanup(cwd);
    }
  });

  test("--select installs only the named skills", async () => {
    const cwd = await scratch();
    try {
      const { code } = await run(cwd, ["install", "--select=flawless-api,flawless-expo"]);
      expect(code).toBe(0);
      expect(existsSync(skillPath(skillsBaseDir(false, cwd), "flawless-api"))).toBe(true);
      expect(existsSync(skillPath(skillsBaseDir(false, cwd), "flawless-expo"))).toBe(true);
      expect(existsSync(skillPath(skillsBaseDir(false, cwd), "flawless-react"))).toBe(false);
      expect(existsSync(claudeDir(cwd, "flawless-react"))).toBe(false);
    } finally {
      await cleanup(cwd);
    }
  });

  // The rule that makes this repo its own installer dogfood safe: a SKILL.md that
  // differs from the embedded copy is edited, and edited is never silently rolled
  // back — which is exactly the case of a stale binary run in the source tree.
  test("a locally edited SKILL.md is kept, and the run is not a success", async () => {
    const cwd = await scratch();
    try {
      const file = skillPath(skillsBaseDir(false, cwd), "flawless-api");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "---\nname: flawless-api\ndescription: mine\n---\nmine\n");
      const { code, err } = await run(cwd, ["install", "--all"]);
      expect(code).toBe(1);
      expect(err).toContain("edited locally, kept");
      expect(err).toContain("--force");
      expect(readFileSync(file, "utf8")).toContain("mine");
      // The refused skill gets no compat link either: a link to a file we did not
      // install would advertise a skill the canonical tree does not contain.
      expect(existsSync(claudeDir(cwd, "flawless-api"))).toBe(false);
      // And the others still landed: one refusal does not stop the run.
      expect(readFileSync(skillPath(skillsBaseDir(false, cwd), "flawless-react"), "utf8")).toBe(
        contentOf("flawless-react"),
      );
    } finally {
      await cleanup(cwd);
    }
  });

  test("--force overwrites an edited SKILL.md", async () => {
    const cwd = await scratch();
    try {
      const file = skillPath(skillsBaseDir(false, cwd), "flawless-api");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "mine\n");
      const { code } = await run(cwd, ["install", "--select=flawless-api", "--force"]);
      expect(code).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(contentOf("flawless-api"));
    } finally {
      await cleanup(cwd);
    }
  });

  // The deliberate divergence from crust, whose --force replaces a real
  // .claude/skills/<name> directory: ours never deletes what it did not create.
  test("a real directory in .claude/skills is reported and left alone, even with --force", async () => {
    const cwd = await scratch();
    try {
      const dir = claudeDir(cwd, "flawless-api");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), "somebody else's skill\n");
      const { code, err } = await run(cwd, ["install", "--select=flawless-api", "--force"]);
      expect(code).toBe(0);
      expect(err).toMatch(/real directory .* flawless-react did not write — left untouched/s);
      expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe("somebody else's skill\n");
      expect(lstatSync(dir).isSymbolicLink()).toBe(false);
      // The canonical half is still written: a compat conflict is not an install failure.
      expect(existsSync(skillPath(skillsBaseDir(false, cwd), "flawless-api"))).toBe(true);
    } finally {
      await cleanup(cwd);
    }
  });

  test("a link that points somewhere else is not followed, even with --force", async () => {
    const cwd = await scratch();
    try {
      mkdirSync(path.join(cwd, "elsewhere"), { recursive: true });
      mkdirSync(path.dirname(claudeDir(cwd, "flawless-api")), { recursive: true });
      const link = claudeDir(cwd, "flawless-api");
      await symlink(path.join(cwd, "elsewhere"), link);
      const { code, err } = await run(cwd, ["install", "--select=flawless-api", "--force"]);
      expect(code).toBe(0);
      expect(err).toMatch(/links to .*elsewhere.*left alone/s);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(path.join(cwd, "elsewhere"));
    } finally {
      await cleanup(cwd);
    }
  });

  test("--copy writes a real file instead of a link", async () => {
    const cwd = await scratch();
    try {
      const { code, out } = await run(cwd, ["install", "--select=flawless-api", "--copy"]);
      expect(code).toBe(0);
      expect(out).toContain("copied 1");
      const dir = claudeDir(cwd, "flawless-api");
      expect(lstatSync(dir).isSymbolicLink()).toBe(false);
      expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(contentOf("flawless-api"));
    } finally {
      await cleanup(cwd);
    }
  });

  // HOME is read at call time, which is what makes the global scope testable
  // without touching the real ~/.agents. Swapped and restored in one stretch so
  // no other test in this process can observe it.
  test("--global targets $HOME and writes nothing into the project", async () => {
    const home = await scratch();
    const cwd = await scratch();
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const { code, out } = await run(cwd, ["install", "--all", "--global"]);
      expect(code).toBe(0);
      expect(out).toContain(`${home}/.agents/skills`);
      expect(existsSync(skillPath(skillsBaseDir(true), "flawless-api"))).toBe(true);
      expect(lstatSync(path.join(home, ".claude/skills/flawless-api")).isSymbolicLink()).toBe(true);
      expect(existsSync(path.join(cwd, ".agents"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
      await cleanup(home);
      await cleanup(cwd);
    }
  });

  test("a project that already has an unrelated .claude directory keeps it", async () => {
    const cwd = await scratch();
    try {
      mkdirSync(path.join(cwd, ".claude"), { recursive: true });
      writeFileSync(path.join(cwd, ".claude", "settings.json"), "{}\n");
      await run(cwd, ["install", "--select=flawless-api"]);
      expect(readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8")).toBe("{}\n");
      expect(lstatSync(path.join(cwd, ".claude", "skills")).isSymbolicLink()).toBe(false);
    } finally {
      await cleanup(cwd);
    }
  });
});

describe("the menu", () => {
  // The default answer to Enter has to be the useful one: what is missing, and
  // what the user probably wants replaced — not everything, and not nothing.
  test("preselects what is not already current", () => {
    expect(
      defaultSelection([
        { name: "a", status: "missing" },
        { name: "b", status: "current" },
        { name: "c", status: "edited" },
      ]),
    ).toEqual(["a", "c"]);
  });

  test("a cancelled menu answers undefined — the caller installs nothing", async () => {
    const fake = {
      intro: () => {},
      outro: () => {},
      text: async () => "",
      multiselect: async () => Symbol("cancel"),
      confirm: async () => false,
      isCancel: (v: unknown) => typeof v === "symbol",
      cancel: () => {},
    };
    expect(
      await pickSkills("/tmp/x", [{ name: "flawless-api" }], ["flawless-api"], fake),
    ).toBeUndefined();
  });

  test("what the user picks is what the caller gets", async () => {
    const fake = {
      intro: () => {},
      outro: () => {},
      text: async () => "",
      multiselect: async () => ["flawless-api"],
      confirm: async () => false,
      isCancel: (v: unknown) => typeof v === "symbol",
      cancel: () => {},
    };
    expect(await pickSkills("/tmp/x", [{ name: "flawless-api" }], [], fake)).toEqual([
      "flawless-api",
    ]);
  });
});

describe("the published package can run the verb", () => {
  // `flawless-react skills install` reads the markdown from the package on disk, so
  // a `files` entry that forgets `.agents/skills` ships a CLI whose only new command
  // crashes. Same for the postinstall script and for what the Jenkins npm stage
  // copies — this is the packaging contract, in the repo that can check it.
  const pkg = JSON.parse(readFileSync(path.join(import.meta.dir, "../package.json"), "utf8"));
  const jenkins = readFileSync(path.join(import.meta.dir, "../Jenkinsfile"), "utf8");

  test("package.json ships the skills, the script and the script's directory", () => {
    expect(pkg.files).toContain(".agents/skills");
    expect(pkg.files).toContain("scripts");
    expect(pkg.scripts.postinstall).toBe("node scripts/postinstall.mjs");
  });

  test("the npm stage copies the skills too", () => {
    const line = jenkins.split("\n").find((l) => l.includes("cp -r bin src"));
    expect(line ?? "").toContain(".agents");
    expect(line ?? "").toContain("scripts");
  });

  test("every embedded skill is inside a shipped directory", () => {
    // `files` are prefixes, so a skill path has to sit under one of them.
    for (const skill of EMBEDDED_SKILLS) {
      const path = `.agents/skills/${skill.name}/SKILL.md`;
      const covered = (pkg.files as string[]).some(
        (dir) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`),
      );
      expect(covered).toBe(true);
    }
  });
});
