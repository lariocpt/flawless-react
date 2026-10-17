// The `flawless-react skills` subcommand's grammar, in one pure function.
//
// Two consumers need this to agree with the shipped prose, and neither of them
// runs anything: main() dispatches on it, and `--check` parses the
// `flawless-react skills install …` lines in the README, the skills and the
// website so a flag that was renamed cannot survive in documentation. That is
// also why it lives apart from cli.ts rather than inside it — a subcommand that
// only main() understands is a subcommand the docs lint cannot see.
//
// Without this file, `flawless-react skills install --all` would parse as
// entry glob = `skills` and then fail on an unknown `--install`… or worse, in a
// docs lint, pass for the wrong reason.
import { type FlagDoc, renderBlock } from "../cliFlags.ts";

export const SKILLS_SUBCOMMAND = "skills";

/** True when argv is a subcommand invocation rather than a generation run. */
export function isSkillsArgv(argv: readonly string[]): boolean {
  return argv[0] === SKILLS_SUBCOMMAND;
}

export type SkillsVerb = "list" | "install" | "help";

export interface SkillsCommand {
  verb: SkillsVerb;
  /** Every skill, no menu. Implied when stdout is not a terminal. */
  all: boolean;
  /** Only these skills. Repeatable AND comma-separated, because it reads both ways. */
  select: string[];
  /** `$HOME`-scoped instead of project-scoped. */
  global: boolean;
  /** Overwrite a canonical file that differs from the embedded copy. */
  force: boolean;
  /** Copy into the compat directory instead of linking it. */
  copy: boolean;
}

/**
 * Flags of the `install` verb, as documentation.
 *
 * `--force` is deliberately NOT repeated here: it is already a run flag with the
 * same word for the same idea (overwrite what a run would otherwise keep), so
 * listing it twice would give the inventory two entries for one spelling.
 */
export const SKILL_FLAGS: readonly FlagDoc[] = [
  {
    name: "--all",
    summary: "Every skill, no menu.",
  },
  {
    name: "--select",
    value: "<names>",
    summary: ["Only the named skills, comma-separated or", "repeated. Unknown names exit 2."],
  },
  {
    name: "--global",
    alias: "-g",
    summary: [
      "Install into ~/.agents/skills (and link into",
      "~/.claude/skills) instead of the project's.",
    ],
  },
  {
    name: "--copy",
    summary: [
      "Copy into .claude/skills instead of linking.",
      "Automatic when the system refuses symlinks.",
    ],
  },
];

/**
 * What exists, in display order: the umbrella first, because it is the router.
 *
 * A literal tuple, not derived from the embedded files, so that this module —
 * the grammar — is importable without importing the ~70 KB of markdown. main()'s
 * parse-only surfaces (`--help`, `--flags`, `--check`) and the docs lint pay for
 * the words only; the bytes come in with the runner. data.ts maps these names
 * onto file contents with a Record, so the two cannot drift.
 */
export const SKILL_CHOICES = [
  "flawless-react",
  "flawless-unit-browser",
  "flawless-e2e-load",
  "flawless-findings",
  "flawless-regen",
  "flawless-expo",
  "flawless-api",
] as const;

/** The names a `--select` may use. */
export const SKILL_NAMES: readonly string[] = SKILL_CHOICES;

const USAGE = `flawless-react skills <list|install> [options]

Agent skills that teach a coding agent to drive flawless-react — the same files
this repo lints against the CLI, embedded in the binary.

  skills list                    list the embedded skills and their status
  skills install                 on a terminal: pick which ones to install;
                                 otherwise (piped, CI): install every one
  skills install --all           every skill, no menu
  skills install --select a,b    only the named skills (repeatable)
  skills install --global        target ~/.agents/skills instead of ./.agents/skills
  skills install --force         overwrite a SKILL.md you have edited locally
  skills install --copy          copy into .claude/skills instead of linking it

Each skill is written once, to .agents/skills/<name>/SKILL.md — the cross-client
location Codex, Cursor and OpenCode read — and linked into
.claude/skills/<name>, because Claude Code is the one mainstream host that does
not read the standard path. A real directory there was not written by
flawless-react, so it is reported and left alone: remove it by hand if you want
the link. A locally-edited SKILL.md is refused without --force.

Options for 'install':
`;

/**
 * The `skills --help` text. `--force` and `--help` are rendered from the same
 * table as the rest, so the left column aligns by the same rule as the main
 * help rather than by a padEnd copied into a second place.
 */
export function renderSkillsHelp(): string {
  const rows: FlagDoc[] = [
    ...SKILL_FLAGS,
    {
      name: "--force",
      alias: "-f",
      summary: [
        "Overwrite a SKILL.md you have edited locally.",
        "Never deletes a .claude/skills directory.",
      ],
    },
    { name: "--help", alias: "-h", summary: "Show this help." },
  ];
  return `${USAGE}${renderBlock(rows)}`;
}

function splitNames(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * Parse the arguments AFTER the `skills` word (main() strips the subcommand).
 *
 * Throws on anything invalid, with the message naming the offender and the
 * choices, because "bad usage → exit 2" is only useful if it says what was bad.
 */
export function parseSkillsCommand(argv: readonly string[]): SkillsCommand {
  const first = argv[0];
  if (first === undefined || first === "help" || first === "-h" || first === "--help") {
    return { verb: "help", all: false, select: [], global: false, force: false, copy: false };
  }
  if (first !== "list" && first !== "install") {
    throw new Error(`unknown skills verb: ${first}. Available: list, install`);
  }
  const cmd: SkillsCommand = {
    verb: first,
    all: false,
    select: [],
    global: false,
    force: false,
    copy: false,
  };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--all") cmd.all = true;
    else if (a.startsWith("--select=")) cmd.select.push(...splitNames(a.slice("--select=".length)));
    else if (a === "--select") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--select requires skill names");
      cmd.select.push(...splitNames(v));
    } else if (a === "--global" || a === "-g") cmd.global = true;
    else if (a === "--force" || a === "-f") cmd.force = true;
    else if (a === "--copy") cmd.copy = true;
    else if (a === "-h" || a === "--help") {
      cmd.verb = "help";
      break;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag for 'skills ${cmd.verb}': ${a}`);
    } else {
      throw new Error(`unexpected argument after 'skills ${cmd.verb}': ${a}`);
    }
  }

  // `skills list --global` used to be accepted and ignored. A flag that does
  // nothing is worse than a refusal: it reads as if the scope it names had been
  // honoured. `list` needs no scope because it reports BOTH of them as columns, and
  // every install flag is meaningless for it — which is why the check below is
  // "any flag at all", not a hand-maintained subset that a new flag could slip past.
  if (cmd.verb === "list") {
    const ignored = [
      cmd.all && "--all",
      cmd.select.length > 0 && "--select",
      cmd.global && "--global",
      cmd.force && "--force",
      cmd.copy && "--copy",
    ].filter((s): s is string => s !== false);
    if (ignored.length > 0) {
      throw new Error(
        `skills list takes no flags (${ignored.join(", ")}): it reports every embedded skill, with its status in both scopes`,
      );
    }
    return cmd;
  }

  if (cmd.all && cmd.select.length > 0) {
    throw new Error("--all and --select are mutually exclusive: say which you mean");
  }

  const unknown = cmd.select.filter((n) => !(SKILL_CHOICES as readonly string[]).includes(n));
  if (unknown.length > 0) {
    throw new Error(`unknown skill: ${unknown.join(", ")}. Available: ${SKILL_CHOICES.join(", ")}`);
  }
  return cmd;
}
