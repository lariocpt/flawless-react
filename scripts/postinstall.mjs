// flawless-react — npm postinstall.
//
// Asks, once, in a terminal: want the agent skills? Everything here is a
// best-effort fast path. Install scripts are unreliable by design (npm 12 blocks
// them by default, `--ignore-scripts` skips them, a proxy can swallow stdout), so
// the real surface is the CLI itself: an interactive run makes the same offer, and
// `flawless-react skills install` is always there. What this file owns is the
// moment a user has just decided to use the tool and has not run it yet.
//
// Kept deliberately small: node built-ins only, and it can never fail an install.
// The gate is `shouldAsk` below — a pure function, so tests cover every reason to
// stay silent rather than only the one that is easy to trigger.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** Keep in step with SKILL_PREFIX in src/skills/data.ts — the prefix IS ownership. */
const SKILL_PREFIX = "flawless-";

/** Whether the picker can actually be run: the CLI is a bun script. */
export function hasBun(run = spawnSync) {
  const probe = run("bun", ["--version"]);
  return !probe.error && probe.status === 0;
}

/**
 * Should this install ask? Returns `{ ask, dir }` to ask in, or `{ ask, reason }`.
 *
 * The order matters and so does each test. `CI` and a missing TTY come first,
 * because an unanswered question in a build pipeline is a hung job. A global
 * install asks nothing: the cwd is wherever npm happened to run, not a project.
 * `INIT_CWD` is npm's own "where the user ran this" and the only reliable answer,
 * because a dependency's postinstall runs with cwd set to the package directory,
 * which is inside node_modules — writing `.agents/skills` there would bury the
 * files where no agent looks. Anything under node_modules is refused outright.
 * The bun probe is last because it costs a subprocess: the checks before it are
 * free, and if bun is absent the picker cannot run anyway.
 */
export function shouldAsk({
  env,
  stdinTty,
  stdoutTty,
  bunAvailable = true,
  exists = existsSync,
}) {
  if (env.FLAWLESS_NO_SKILLS) return { ask: false, reason: "FLAWLESS_NO_SKILLS is set" };
  if (env.CI) return { ask: false, reason: "CI" };
  if (env.npm_config_global === "true") return { ask: false, reason: "global install" };
  if (!stdinTty || !stdoutTty) return { ask: false, reason: "not a terminal" };

  const dir = env.INIT_CWD && path.resolve(env.INIT_CWD);
  if (!dir) return { ask: false, reason: "no INIT_CWD" };
  if (dir.includes(`${path.sep}node_modules${path.sep}`) || dir.endsWith("node_modules")) {
    return { ask: false, reason: "inside node_modules" };
  }
  if (!exists(dir)) return { ask: false, reason: "project directory is gone" };

  // A project that already has one of ours was set up on purpose; the skills
  // themselves are the marker, so neither question needs to store a decline.
  for (const base of [".agents/skills", ".claude/skills"]) {
    let entries = [];
    try {
      entries = readdirSync(path.join(dir, base), { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.name.startsWith(SKILL_PREFIX) && (e.isDirectory() || e.isSymbolicLink()))) {
      return { ask: false, reason: "already installed", dir };
    }
  }

  if (!bunAvailable) return { ask: false, reason: "no bun on PATH to run the picker" };
  return { ask: true, dir };
}

/**
 * Hand the terminal to the picker. Nothing is decided here about WHICH skills: the
 * menu owns that, and running it in-process would mean duplicating the installer in
 * plain JavaScript. So this spawns the CLI with inherited stdio — which also means
 * the one question in the whole install is clack's, not a second prompt that then
 * has to hand a half-used stdin to a child.
 */
export function askSkills({ bin, bun = "bun", spawnFn = spawn, log = console.error }) {
  return new Promise((resolve) => {
    const gate = shouldAsk({
      env: process.env,
      stdinTty: Boolean(process.stdin.isTTY),
      stdoutTty: Boolean(process.stdout.isTTY),
      bunAvailable: hasBun(),
    });
    if (!gate.ask) {
      resolve(gate.reason ?? "not asked");
      return;
    }
    log("");
    log("  flawless-react ships agent skills: guides that teach Claude Code, Codex,");
    log("  Cursor and OpenCode how to drive this tool instead of guessing at it.");
    log(`  Pick what to install into ${gate.dir}/.agents/skills (Esc installs nothing):`);

    const child = spawnFn(bun, [bin, "skills", "install"], {
      cwd: gate.dir,
      stdio: "inherit",
    });
    child.on("error", (err) =>
      log(`  flawless-react: could not run the skills picker (${err.message}). Later:`),
    );
    child.on("close", (code) => {
      if (code) {
        log(`  flawless-react: the skills picker exited ${code}. Run it yourself any time:`);
      }
      log("    bunx flawless-react skills install");
      resolve(code === null ? "killed" : `exit ${code}`);
    });
  });
}

// npm runs this file directly. Errors are swallowed on purpose: a broken prompt is
// not a reason to fail an install, and a postinstall that throws takes the user's
// dependency tree down with it.
if (import.meta.main) {
  try {
    await askSkills({ bin: new URL("../bin/flawless-react", import.meta.url).pathname });
  } catch {
    // Declining on the user's behalf is better than aborting their install.
  }
  process.exit(0);
}
