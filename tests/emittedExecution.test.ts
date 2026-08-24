import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { runCore } from "../src/core.ts";
import { scaffold } from "../src/scaffold/index.ts";
import { extractRoutes, loadApiSpec } from "../src/scaffold/openapi.ts";
import { type RenderedFile, renderSuite } from "../src/scaffold/templates.ts";
import { e2eRoutes } from "../src/tasks/e2eRoutes.ts";
import { type LoadTarget, loadPipes, renderPipes } from "../src/tasks/loadPipes.ts";
import type { MockRoute, RunContext, TaskId } from "../src/types.ts";

/**
 * The files this tool writes that something OTHER than TypeScript runs.
 *
 * tests/emittedSyntax.test.ts parses the emitted .ts/.tsx — its filter is
 * literally `/\.tsx?$/`, so the shell script, the node script, the crust pipes
 * and the JSON are all invisible to it. This file runs them the way a user does.
 *
 * The bug that made the case: load/env.sh located itself with BASH_SOURCE, which
 * is empty under zsh, so every LOAD_<PARAM> went unset and 22 of 33 load pipes
 * measured the app's 404 handler while reporting the application as failing.
 * Rendering passed. Parsing passed. Running it under bash passed. Only sourcing
 * it from a different shell exposed it.
 *
 * Two rules keep this file from going the way of a check that renders the
 * default fixtures and proves nothing:
 *
 *  - Deliberate inputs. params.json below is chosen to hit every branch — a
 *    camelCase id, a blank default rescued by a per-route override, a blank
 *    override that must not clobber a filled default, a value with a space.
 *  - Every group guards its own guard: the harness is shown failing on a
 *    deliberately broken artefact, so a green run means the artefact is good
 *    rather than the check being dead.
 */

const tmpRoot = (): Promise<string> => mkdtemp(path.join(tmpdir(), "flawless-exec-"));
const fixture = (rel: string): string => path.resolve(__dirname, "fixtures", rel);

/**
 * Missing interpreter is a broken environment, not a reason to skip.
 *
 * A skipped zsh case in CI recreates exactly the blind spot this file exists to
 * close, so it fails loudly instead. The Jenkinsfile Test stage installs these.
 */
function requireInterpreter(name: string): string {
  const found = Bun.which(name);
  if (found === null) {
    throw new Error(
      `${name} is not on PATH. These tests execute what the tool emits, so a missing ` +
        "interpreter cannot be skipped past — a skipped zsh case is how the BASH_SOURCE " +
        "bug survived in the first place. CI installs bash, zsh and jq in the " +
        "Jenkinsfile Test stage; install it locally to run this file.",
    );
  }
  return found;
}

function runCtx(outDir: string, root: string): RunContext {
  return {
    trees: [],
    outDir,
    variants: 3,
    heaps: "stress",
    force: true,
    report: false,
    provider: undefined,
    apiSpec: undefined,
    inlineSummary: false,
    nextjs: { root, router: "app", apiRoutes: [], appResolver: undefined },
  } as unknown as RunContext;
}

// ---------------------------------------------------------------------------
// load/env.sh
// ---------------------------------------------------------------------------

/**
 * Every branch of env.sh's jq filter, in one file.
 *
 * `buildingId` proves the upper-casing, `token` proves a per-route entry can
 * rescue a blank default, the blank override on `/x/[id]` proves the reverse
 * cannot happen, and the space in `id` proves the export survives word
 * splitting. A params.json of the shape the docs show would exercise one of the
 * four.
 */
const HOSTILE_PARAMS = {
  defaults: {
    buildingId: "seed-building",
    token: "",
    id: "seed id with spaces",
    unfilled: "",
  },
  routes: {
    "/invite/[token]": { token: "per-route-token" },
    "/x/[id]": { id: "" },
  },
};

interface LoadSuite {
  root: string;
  outDir: string;
  envPath: string;
}

async function emitLoadSuite(params: unknown = HOSTILE_PARAMS): Promise<LoadSuite> {
  const root = await tmpRoot();
  const outDir = path.join(root, "flawless");
  if (params !== null) {
    await Bun.write(
      path.join(outDir, "e2e", "params.json"),
      `${JSON.stringify(params, null, 2)}\n`,
    );
  }
  const result = await loadPipes.run(runCtx(outDir, root));
  expect(result.ok).toBe(true);
  return { root, outDir, envPath: path.join(outDir, "load", "env.sh") };
}

interface ShellRun {
  vars: Record<string, string>;
  stderr: string;
  status: number;
}

/**
 * Source the emitted script and report what it exported.
 *
 * The path travels in an env var rather than as an operand, because `sh -c cmd
 * name arg` disagrees between shells about whether the first operand lands in
 * $0 or $1. The environment is otherwise minimal: a LOAD_* left over from the
 * developer's own shell must not be able to decide the result. bash skips its
 * rc files with --norc, zsh needs --no-rcs because it reads .zshenv even
 * non-interactively.
 */
async function sourceEnvSh(
  shell: "bash" | "zsh",
  opts: { script: string; cwd: string; pathOverride?: string },
): Promise<ShellRun> {
  const bin = requireInterpreter(shell);
  const flags = shell === "bash" ? ["--norc", "--noprofile"] : ["--no-rcs"];
  const proc = Bun.spawn([bin, ...flags, "-c", 'source "$FLAWLESS_ENV_SH"; env'], {
    cwd: opts.cwd,
    env: {
      PATH: opts.pathOverride ?? process.env.PATH ?? "",
      HOME: "/nonexistent",
      FLAWLESS_ENV_SH: opts.script,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const vars: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^(LOAD_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1] !== undefined) vars[m[1]] = m[2] ?? "";
  }
  return { vars, stderr, status };
}

/** A PATH holding everything the script needs except the named commands. */
async function binDirWithout(missing: string[]): Promise<string> {
  const dir = await tmpRoot();
  for (const cmd of ["dirname", "tr", "env", "jq"]) {
    if (missing.includes(cmd)) continue;
    const real = Bun.which(cmd);
    if (real !== null) await symlink(real, path.join(dir, cmd));
  }
  return dir;
}

describe("load/env.sh is sourced by a shell, so a shell sources it here", () => {
  test("bash exports every filled id, from a cwd that cannot rescue it", async () => {
    const { envPath } = await emitLoadSuite();
    // Deliberately not the project root: env.sh falls back to
    // $PWD/flawless/e2e/params.json, and from the root that fallback would mask
    // a self-location that does not work.
    const run = await sourceEnvSh("bash", { script: envPath, cwd: await tmpRoot() });

    expect(run.status).toBe(0);
    expect(run.vars.LOAD_BUILDINGID).toBe("seed-building");
    expect(run.vars.LOAD_ID).toBe("seed id with spaces");
  });

  test("zsh does too — the shell the BASH_SOURCE bug hid from", async () => {
    const { envPath } = await emitLoadSuite();
    const run = await sourceEnvSh("zsh", { script: envPath, cwd: await tmpRoot() });

    expect(run.status).toBe(0);
    expect(run.vars.LOAD_BUILDINGID).toBe("seed-building");
    expect(run.vars.LOAD_ID).toBe("seed id with spaces");
  });

  test("the relative form the docs tell you to type works in both", async () => {
    // `source flawless/load/env.sh` from the project root — what load/README.md
    // and the routes.pipes header both say. dirname of a relative path is
    // relative, so this is a different code path from the absolute one above.
    const { root } = await emitLoadSuite();
    for (const shell of ["bash", "zsh"] as const) {
      const run = await sourceEnvSh(shell, { script: "flawless/load/env.sh", cwd: root });
      expect(run.status).toBe(0);
      expect(run.vars.LOAD_BUILDINGID).toBe("seed-building");
    }
  });

  test("an id filled only per-route counts as supplied", async () => {
    const { envPath } = await emitLoadSuite();
    const run = await sourceEnvSh("bash", { script: envPath, cwd: await tmpRoot() });
    expect(run.vars.LOAD_TOKEN).toBe("per-route-token");
  });

  test("a blank per-route override does not clobber a filled default", async () => {
    // `/x/[id]` carries id:"" while defaults.id is set. An unfiltered merge
    // would let the blank win and the pipe would request an empty segment.
    const { envPath } = await emitLoadSuite();
    const run = await sourceEnvSh("zsh", { script: envPath, cwd: await tmpRoot() });
    expect(run.vars.LOAD_ID).toBe("seed id with spaces");
  });

  test("an id filled nowhere is left unset, not exported empty", async () => {
    // An exported-but-empty LOAD_X expands to nothing in the pipe's URL, which
    // is the malformed-path failure wearing a different hat. Unset is what lets
    // the gate comment in routes.pipes stand for the truth.
    const { envPath } = await emitLoadSuite();
    const run = await sourceEnvSh("bash", { script: envPath, cwd: await tmpRoot() });
    expect(run.vars.LOAD_UNFILLED).toBeUndefined();
    expect(run.vars.LOAD_BUILDINGID).toBe("seed-building");
  });

  test("the $PWD fallback finds the file when self-location cannot", async () => {
    const { root, envPath } = await emitLoadSuite();
    // Copied somewhere with no ../e2e beside it, then sourced from the project
    // root: the fallback is the only thing that can work here.
    const stray = path.join(await tmpRoot(), "env.sh");
    await Bun.write(stray, await Bun.file(envPath).text());
    const run = await sourceEnvSh("bash", { script: stray, cwd: root });

    expect(run.status).toBe(0);
    expect(run.vars.LOAD_BUILDINGID).toBe("seed-building");
  });

  test("no params.json: a message, no exports, and a zero return", async () => {
    // Returning non-zero from a sourced file kills a `set -e` shell, which is a
    // worse outcome than the missing ids it is reporting.
    const { envPath } = await emitLoadSuite(null);
    const run = await sourceEnvSh("bash", { script: envPath, cwd: await tmpRoot() });

    expect(run.status).toBe(0);
    expect(run.stderr).toContain("params.json");
    expect(Object.keys(run.vars)).toEqual([]);
  });

  test("without jq it says so instead of leaving every id silently unset", async () => {
    // The same failure shape as the original bug: the pipes still run, they just
    // request URLs with empty path segments and measure the 404 handler. The
    // shell's own `jq: command not found` does not say that.
    const { envPath } = await emitLoadSuite();
    const run = await sourceEnvSh("bash", {
      script: envPath,
      cwd: await tmpRoot(),
      pathOverride: await binDirWithout(["jq"]),
    });

    expect(run.status).toBe(0);
    expect(Object.keys(run.vars)).toEqual([]);
    // Specifically the tool's own message, not the shell's `jq: command not
    // found` — that one carries the script's path, which contains "flawless"
    // and would let a looser assertion here pass on nothing at all.
    expect(run.stderr).toMatch(/flawless: jq/);
    expect(run.stderr).toContain("LOAD_");
  });

  test("bash never parses the zsh-only expansion", async () => {
    // ${(%):-%x} is a syntax error to bash, which is why it is behind an eval.
    const { envPath } = await emitLoadSuite();
    const proc = Bun.spawn([requireInterpreter("bash"), "--norc", "-n", envPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, status] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  test("the harness catches the bug this file was written for", async () => {
    // Guards the guard. Neutralise the zsh self-location and the ids must come
    // out unset under zsh — if they do not, every assertion above is passing on
    // the $PWD fallback and would have passed before the fix too.
    const { envPath } = await emitLoadSuite();
    const broken = path.join(await tmpRoot(), "env.sh");
    const original = await Bun.file(envPath).text();
    const mutated = original.replace(`eval '_self="\${(%):-%x}"'`, ":");
    expect(mutated).not.toBe(original);
    await Bun.write(broken, mutated);

    const run = await sourceEnvSh("zsh", { script: broken, cwd: await tmpRoot() });
    expect(run.vars.LOAD_BUILDINGID).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// scripts/report.mjs
// ---------------------------------------------------------------------------

/** A Playwright JSON report carrying the lines the profile specs print. */
function resultsJson(stdout: string[]): string {
  return JSON.stringify({
    suites: [
      {
        title: "Card.profile.spec.ts",
        suites: [
          {
            title: "inner",
            specs: [
              {
                title: "variant matrix",
                tests: [{ results: [{ stdout: stdout.map((text) => ({ text })) }] }],
              },
            ],
          },
        ],
        specs: [],
      },
    ],
  });
}

async function emitPerfSuite(report: boolean): Promise<string> {
  const tree = await analyse({ entry: fixture("Card.tsx"), depth: 0, includeChildren: false });
  const outDir = path.join(await tmpRoot(), "flawless");
  await scaffold(tree, {
    outDir,
    variants: 3,
    force: true,
    report,
    provider: undefined,
    apiSpec: undefined,
  });
  return outDir;
}

/**
 * A node that is actually node.
 *
 * oven/bun:1 — the image CI runs `bun test` in — ships
 * /usr/local/bun-node-fallback-bin/node as a symlink to bun, and bun strips
 * TypeScript annotations. The exact bug this group was written to catch
 * (`const sections: string[]` in a .mjs file) runs perfectly under that shim,
 * so a green CI would have meant nothing at all.
 */
function requireRealNode(): string {
  const bin = requireInterpreter("node");
  const probe = Bun.spawnSync([bin, "-e", "process.exit(typeof Bun === 'undefined' ? 0 : 1)"]);
  if (probe.exitCode !== 0) {
    throw new Error(
      `${bin} is bun wearing node's name — it strips type annotations, so running the ` +
        "emitted .mjs through it proves nothing. Install a real node and put it ahead of " +
        "the bun fallback on PATH (the Jenkinsfile Test stage apt-installs nodejs).",
    );
  }
  return bin;
}

async function runReportScript(outDir: string): Promise<{ status: number; stderr: string }> {
  const proc = Bun.spawn([requireRealNode(), path.join(outDir, "scripts", "report.mjs")], {
    cwd: outDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, status] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { status, stderr };
}

describe("scripts/report.mjs is run by node, so node runs it here", () => {
  test("it aggregates the stats the profile specs print", async () => {
    const outDir = await emitPerfSuite(true);
    await Bun.write(
      path.join(outDir, "test-results", "results.json"),
      resultsJson(['[Card variants] {"p95":12,"mean":9}\n', '[Card forced] {"p95":4,"mean":3}\n']),
    );

    const run = await runReportScript(outDir);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);

    const md = await Bun.file(path.join(outDir, "report.md")).text();
    expect(md).toContain("## Card (variants)");
    expect(md).toContain("## Card (forced)");
    expect(md).toContain('{"p95":12,"mean":9}');
  });

  test("run before the first test run, it says so and exits non-zero", async () => {
    const outDir = await emitPerfSuite(true);
    const run = await runReportScript(outDir);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("results.json");
  });

  test("a run with no stat lines yields no sections", async () => {
    // Guards the guard: the assertions above must be matching the stats rather
    // than boilerplate the script prints either way.
    const outDir = await emitPerfSuite(true);
    await Bun.write(
      path.join(outDir, "test-results", "results.json"),
      resultsJson(["nothing of interest here\n"]),
    );

    expect((await runReportScript(outDir)).status).toBe(0);
    const md = await Bun.file(path.join(outDir, "report.md")).text();
    expect(md).not.toContain("##");
  });
});

// ---------------------------------------------------------------------------
// load/routes.pipes — the assert is JavaScript crust evaluates
// ---------------------------------------------------------------------------

const DASHBOARD: LoadTarget = { name: "dashboard", urlPath: "/dashboard", params: [] };

/** The `assert (…)` lambda source out of the first live pipe. */
function extractAssert(pipesText: string): string {
  const line = pipesText.split("\n").find((l) => l.startsWith("load ")) ?? "";
  return /\| assert \((.*)\)\s*$/.exec(line)?.[1] ?? "";
}

/**
 * Evaluate it with a Bun whose `file()` resolves against a stand-in project
 * root — which also pins the emitted path as relative to the project root,
 * because that is the directory crust runs the pipes from.
 *
 * What this does and does not prove: the baseline file is written by this test,
 * so it establishes that the assert is self-consistent, not that crust really
 * produces that shape. The other half has been confirmed against a live crust
 * run rather than left as a reading — an emitted pipe pointed at a local server,
 * where `stats --out` wrote `{crustStats, startedAt, urls, summary}` with
 * `summary.p95`, the object handed to `assert` carried a TOP-LEVEL `p95`, and
 * the gate passed with no baseline, passed against a baseline at the observed
 * p95, and failed against one forced below half of it. That run is not
 * automated here: it needs crust on PATH and a server to hit, and a test that
 * silently skipped when either was missing would be worth less than this
 * comment. The reading it confirms is src/transforms.ts, where `stats --out`
 * writes
 * `{crustStats, startedAt, urls, summary}` (hence `.summary.p95` on the
 * baseline) while the value passed downstream is the bare summary (hence
 * `s.p95` on the live stats), and `summarize()` keys it `p95` even though its
 * neighbours are `meanMs`/`wallMs`. In src/parser.ts the lambda is compiled
 * with a bare `new Function` — so `Bun` comes off the global, which is there
 * because crust runs under Bun — and awaited, so the async form here is not a
 * permanently-true promise. crust also rejects a summary tagged `empty` before
 * ever calling the lambda, so a pipe whose ids expanded to nothing cannot pass
 * this gate on zero requests.
 */
function baselineGate(src: string, projectRoot: string): (s: { p95: number }) => Promise<boolean> {
  const stub = { file: (p: string) => Bun.file(path.resolve(projectRoot, p)) };
  return new Function("Bun", `return (${src});`)(stub);
}

describe("the baseline assert in routes.pipes is real JavaScript", () => {
  const src = (): string =>
    extractAssert(renderPipes([DASHBOARD], "/app/flawless", "/app", new Set()));

  test("the lambda is there to evaluate at all", () => {
    // Guards the guard: an extractor that returned "" would make every case
    // below throw rather than assert, which reads nothing like a pass.
    expect(src()).toContain("p95");
    expect(src()).toContain("baseline-dashboard.json");
  });

  test("no baseline: the gate passes rather than failing the first run", async () => {
    const gate = baselineGate(src(), await tmpRoot());
    expect(await gate({ p95: 9999 })).toBe(true);
  });

  test("under 2x baseline passes, at and over it fails", async () => {
    const root = await tmpRoot();
    await Bun.write(
      path.join(root, "flawless", "load", "baseline-dashboard.json"),
      JSON.stringify({ summary: { p95: 100 } }),
    );
    const gate = baselineGate(src(), root);

    expect(await gate({ p95: 150 })).toBe(true);
    expect(await gate({ p95: 200 })).toBe(false);
    expect(await gate({ p95: 250 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Emitted configuration
// ---------------------------------------------------------------------------

interface Token {
  text: string;
  quoted: boolean;
}

/** Split on whitespace, keeping quoted runs whole and remembering which they were. */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  for (const m of command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) {
    if (m[1] !== undefined) tokens.push({ text: m[1], quoted: true });
    else if (m[2] !== undefined) tokens.push({ text: m[2], quoted: true });
    else tokens.push({ text: m[3] as string, quoted: false });
  }
  return tokens;
}

/** Flags whose value is a path even when it carries no slash and no extension. */
const PATH_FLAGS = new Set(["--config", "--root", "--target", "--dir", "--outputDir"]);

/** A bare operand counts as a path when it is shaped like one. */
function looksLikePath(s: string): boolean {
  return s.includes("/") || /\.(mjs|cjs|js|ts|tsx|json|pipes|sh)$/.test(s);
}

/**
 * Subcommands, so a bare operand that is NOT one of these reads as a path.
 *
 * `playwright test profile` is the whole reason: `profile` carries no slash and
 * no extension, so shape alone cannot tell it from `run`. Listing the verbs is
 * the honest way round — an unrecognised one produces a loud false positive
 * that someone fixes, where guessing by shape produced a silent miss, and a
 * silent miss on exactly this command is what d47abbe had to fix by hand.
 */
const SUBCOMMANDS = new Set(["test", "run", "related", "exec", "install"]);

/**
 * Every path a script command names — including the ones that are not files.
 *
 * The predecessor matched only operands ending in a known source extension,
 * which is blind to exactly the family this check exists for. A script can name
 * a DIRECTORY (`playwright test flawless/profile`, `playwright test profile`),
 * a path carried by a flag with no extension at all (`vitest run --root
 * flawless`), or a path buried in a quoted inner command (`crust -c 'test-pipes
 * --target …/routes.pipes'`). All of those appear verbatim in the scripts this
 * tool writes, and none of them was being checked.
 */
function commandPathRefs(command: string): string[] {
  const out: string[] = [];
  const tokens = tokenize(command);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    // A quoted operand carrying spaces is a command line rather than a path:
    // crust takes its whole pipeline that way, and its only path is inside.
    if (t.quoted && t.text.includes(" ")) {
      out.push(...commandPathRefs(t.text));
      continue;
    }
    if (PATH_FLAGS.has(t.text)) {
      // The flag declares its value a path, so take it whatever it looks like.
      // This is the only reason `--root flawless` is visible at all.
      const v = tokens[i + 1];
      if (v !== undefined && !v.text.startsWith("-")) {
        out.push(v.text);
        i++;
      }
      continue;
    }
    const eq = /^(--[\w-]+)=(.*)$/.exec(t.text);
    if (eq !== null) {
      const flag = eq[1] as string;
      const value = eq[2] as string;
      if (PATH_FLAGS.has(flag) || looksLikePath(value)) out.push(value);
      continue;
    }
    if (t.text.startsWith("-")) continue;
    // i === 0 is the program itself (`playwright`, `node`, `crust`), which is
    // resolved off PATH rather than out of the emitted tree.
    if (i === 0 || SUBCOMMANDS.has(t.text)) continue;
    // The value of a flag this function does not know is not a path — the
    // 60000 in `--timeout 60000` read as one the moment bare words counted.
    // An `=`-form flag carries its own value, so it does not claim the next.
    const prev = i > 0 ? (tokens[i - 1] as Token) : undefined;
    const claimedByFlag =
      prev !== undefined && !prev.quoted && prev.text.startsWith("-") && !prev.text.includes("=");
    if (claimedByFlag || /^\d+$/.test(t.text)) continue;
    if (looksLikePath(t.text) || /^[\w.-]+$/.test(t.text)) out.push(t.text);
  }
  return out
    .map((p) => p.replace(/^\.\//, ""))
    .filter((p) => p !== "" && !p.startsWith("../") && !path.isAbsolute(p));
}

/**
 * The emitted set, plus every directory on the way to each entry.
 *
 * `playwright test flawless/profile` names a directory that appears in no
 * emitted path as such — without the ancestors it reads as missing and the
 * check cries wolf on a script that is perfectly correct.
 */
function presentPaths(relPaths: string[]): Set<string> {
  const present = new Set<string>();
  for (const rel of relPaths) {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) present.add(parts.slice(0, i).join("/"));
  }
  return present;
}

/** Scripts naming something the run did not emit — `bun run <name>` would fail. */
function danglingIn(scripts: Record<string, string>, present: Set<string>): string[] {
  const out: string[] = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const ref of commandPathRefs(command)) {
      if (!present.has(ref)) out.push(`${name}: ${command} — ${ref} is not emitted`);
    }
  }
  return out;
}

describe("emitted configuration is machine-readable and internally consistent", () => {
  const suiteFiles = (report: boolean): RenderedFile[] =>
    renderSuite({
      tree: {
        entry: {
          componentName: "Card",
          filePath: "/app/src/Card.tsx",
          importSpecifier: "./Card",
          propsShape: {},
          variants: [],
          hooks: [],
          unresolvedProps: [],
          exportKind: "named",
        },
        children: [],
      } as never,
      outDir: "/app/flawless",
      variants: 3,
      report,
    });

  test("every emitted .json parses", async () => {
    const files = suiteFiles(true);
    const json = files.filter((f) => f.relPath.endsWith(".json"));
    // Not vacuous: the suite has these three, and a rename here should fail
    // rather than quietly shrink the set being checked.
    expect(json.map((f) => f.relPath).sort()).toEqual([
      "budgets.json",
      "package.json",
      "tsconfig.json",
    ]);
    for (const f of json) expect(() => JSON.parse(f.content)).not.toThrow();

    // The two written straight to disk by the route tasks, not through renderSuite.
    const root = await tmpRoot();
    const outDir = path.join(root, "flawless");
    await e2eRoutes.run(runCtx(outDir, root));
    await loadPipes.run(runCtx(outDir, root));
    const params = await Bun.file(path.join(outDir, "e2e", "params.json")).text();
    expect(() => JSON.parse(params)).not.toThrow();
  });

  const danglingScripts = (report: boolean): string[] => {
    const files = suiteFiles(report);
    const pkg = files.find((f) => f.relPath === "package.json");
    if (!pkg) throw new Error("no package.json emitted");
    const { scripts } = JSON.parse(pkg.content) as { scripts: Record<string, string> };
    return danglingIn(scripts, presentPaths(files.map((f) => f.relPath)));
  };

  test("every script in the emitted package.json names a file the suite emits", () => {
    expect(danglingScripts(true)).toEqual([]);
    // Without --report there is no scripts/report.mjs, so there must be no
    // `report` script either: `bun run report` on a suite that never emitted it
    // fails with a module-not-found nobody can act on.
    expect(danglingScripts(false)).toEqual([]);
  });

  test("the reference check sees directories and quoted inner commands too", () => {
    // Guards the guard: commandPathRefs returning [] would make every loop
    // above assert nothing at all. The last three are the cases the previous
    // extension-matching version could not see, and they are the exact
    // commands core.ts writes.
    expect(commandPathRefs("node ./scripts/report.mjs")).toEqual(["scripts/report.mjs"]);
    expect(commandPathRefs("playwright test --project=interactive")).toEqual([]);
    // The bare directory operand — no slash, no extension. This is the exact
    // command d47abbe had to correct by hand, and shape alone cannot see it.
    expect(commandPathRefs("playwright test profile")).toEqual(["profile"]);
    expect(commandPathRefs("vitest run")).toEqual([]);
    expect(
      commandPathRefs(
        "playwright test --config flawless/playwright.config.ts --project=chromium flawless/profile",
      ),
    ).toEqual(["flawless/playwright.config.ts", "flawless/profile"]);
    expect(commandPathRefs("vitest run --root flawless")).toEqual(["flawless"]);
    expect(
      commandPathRefs("crust -c 'test-pipes --target flawless/load/routes.pipes --timeout 60000'"),
    ).toEqual(["flawless/load/routes.pipes"]);
  });

  test("a directory counts as present when the suite emitted files into it", () => {
    // The other half of the same guard: without the ancestor walk, every
    // directory-naming script reads as dangling and the check cries wolf.
    const present = presentPaths(["profile/Card.profile.spec.ts", "load/routes.pipes"]);
    expect(present.has("profile")).toBe(true);
    expect(present.has("load/routes.pipes")).toBe(true);
    expect(present.has("browser")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The Next.js-mode flawless:* scripts, which no renderer produces
// ---------------------------------------------------------------------------

/**
 * The scripts merged into the TARGET app's package.json, and what that run
 * emitted for them to point at.
 *
 * These never pass through renderSuite, so the group above cannot see them —
 * core.ts writes them straight into the host project. That is where the
 * interesting version of this bug lived: the merge sits inside `if (nextCtx)`
 * and runs on every Next.js invocation, so a `--tasks load` run declared
 * flawless:unit, flawless:perf and flawless:browser naming a
 * playwright.config.ts, a profile/ and a browser/ that only other tasks emit.
 *
 * The fixture is COPIED first. runCore in Next.js mode rewrites the target's
 * package.json, and tests/fixtures/nextapp is tracked.
 */
async function nextjsRun(
  taskIds: TaskId[],
): Promise<{ scripts: Record<string, string>; present: Set<string>; outDir: string }> {
  const app = path.join(await tmpRoot(), "app");
  await cp(fixture("nextapp"), app, { recursive: true });
  const outDir = path.join(app, "flawless");

  await runCore({
    pattern: path.join(app, "src", "app", "page.tsx"),
    outDir,
    taskIds,
    nextjs: app,
    force: true,
    log: false,
    inlineSummary: false,
  });

  const emitted = (readdirSync(outDir, { recursive: true }) as string[]).map((rel) =>
    path.join("flawless", rel).split(path.sep).join("/"),
  );
  const pkg = JSON.parse(await Bun.file(path.join(app, "package.json")).text()) as {
    scripts?: Record<string, string>;
  };
  const scripts = Object.fromEntries(
    Object.entries(pkg.scripts ?? {}).filter(([n]) => n.startsWith("flawless:")),
  );
  return { scripts, present: presentPaths(emitted), outDir };
}

/**
 * The same question for a standalone suite, where the package.json is the
 * suite's own and two emitters take turns writing it.
 *
 * `--tasks unit-browser` alone renders no browser/ (those specs mount through
 * the perf host, so they are gated on perf-harness) and no profile/ — yet the
 * merge declared test:browser and test:perf regardless, and --run-tests then
 * invoked test:browser and reported a correct suite as failing.
 */
async function standaloneRun(
  taskIds: TaskId[],
  report = false,
): Promise<{ scripts: Record<string, string>; present: Set<string>; outDir: string }> {
  const outDir = path.join(await tmpRoot(), "flawless");
  await runCore({
    pattern: fixture("Dashboard.tsx"),
    outDir,
    taskIds,
    force: true,
    report,
    log: false,
    inlineSummary: false,
  });

  const emitted = (readdirSync(outDir, { recursive: true }) as string[]).map((rel) =>
    rel.split(path.sep).join("/"),
  );
  const pkg = JSON.parse(await Bun.file(path.join(outDir, "package.json")).text()) as {
    scripts?: Record<string, string>;
  };
  return { scripts: pkg.scripts ?? {}, present: presentPaths(emitted), outDir };
}

describe("the standalone test:* scripts point only at what the run emitted", () => {
  test("--tasks unit-browser declares neither the perf nor the browser script", async () => {
    const { scripts, present } = await standaloneRun(["unit-browser"]);

    expect(danglingIn(scripts, present)).toEqual([]);
    // `vitest run` names no path, so only the key set catches the other two.
    expect(Object.keys(scripts).sort()).toEqual(["test:unit"]);
  });

  test("with perf-harness in the run, all five are declared and all resolve", async () => {
    // Order no longer matters here, though it used to: both emitters wrote this
    // package.json and both declared test:perf, so the file depended on which
    // task ran last.
    const { scripts, present } = await standaloneRun(["perf-harness", "unit-browser"]);

    expect(danglingIn(scripts, present)).toEqual([]);
    expect(Object.keys(scripts).sort()).toEqual([
      "test",
      "test:browser",
      "test:headed",
      "test:perf",
      "test:unit",
    ]);
    // Bare, and it selects the profile specs rather than nothing: scope comes
    // from `testDir: "./profile"` in the config it runs under. `bun run test` —
    // the command the emitted README gives every user — has always been exactly
    // this, so a bare `playwright test` that selected nothing would mean no
    // suite had ever run. What broke in d47abbe was a positional filter naming
    // a directory that no longer existed, which is why the filter is gone
    // rather than corrected: a path spelled twice can fall out of step, and the
    // config cannot fall out of step with itself.
    expect(scripts["test:perf"]).toBe("playwright test");
  });
});

describe("the flawless:* scripts point only at what the run emitted", () => {
  test("--tasks load declares the load script and nothing needing another task", async () => {
    const { scripts, present } = await nextjsRun(["load"]);

    // The generic check first — it is the one that generalises. Before the fix
    // it reported flawless:perf's playwright.config.ts and profile/, and
    // flawless:browser's config, none of which a load run emits.
    expect(danglingIn(scripts, present)).toEqual([]);
    // Then the exact set. `flawless:unit` is `vitest run --root flawless`,
    // which resolves to the suite root and so is never dangling — only naming
    // the keys catches that one being declared by a run that emitted no specs.
    expect(Object.keys(scripts).sort()).toEqual(["flawless:load"]);
  });

  test("--tasks e2e likewise", async () => {
    const { scripts, present } = await nextjsRun(["e2e"]);

    expect(danglingIn(scripts, present)).toEqual([]);
    expect(Object.keys(scripts).sort()).toEqual(["flawless:e2e"]);
  });

  test("--tasks unit-browser declares no browser script without perf-harness", async () => {
    // The gate this file's first pass missed. browser/ is rendered only when
    // perf-harness is in the run too (unitAndBrowser.ts derives browserSpecs
    // from exactly that), so unit-browser alone declared a script for a config
    // that was never written — and runGeneratedTests invoked it and printed
    // `failed suites: browser` for a run that was fine.
    const { scripts, present } = await nextjsRun(["unit-browser"]);

    expect(danglingIn(scripts, present)).toEqual([]);
    expect(Object.keys(scripts).sort()).toEqual(["flawless:unit"]);
  });

  test("with every task selected, all four resolve into the emitted tree", async () => {
    // Guards the guard from the other side: if the gates were simply always
    // false the cases above would pass while the tool emitted no scripts
    // at all. Here every script must be present AND resolve.
    const { scripts, present } = await nextjsRun(["perf-harness", "unit-browser", "e2e", "load"]);

    expect(Object.keys(scripts).sort()).toEqual([
      "flawless:browser",
      "flawless:e2e",
      "flawless:load",
      "flawless:perf",
      "flawless:unit",
    ]);
    expect(danglingIn(scripts, present)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// host/server.ts and mock/server.ts — nothing had ever started either
// ---------------------------------------------------------------------------

/** A port nothing is listening on, so the suite's hardcoded 5173/5174 stay free. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = probe;
  probe.stop(true);
  if (port === undefined) throw new Error("could not allocate an ephemeral port");
  return port;
}

/** Boot budget, and the per-test budget that has to outlast it to see the error. */
const BOOT_TIMEOUT_MS = 20_000;
const CASE_TIMEOUT_MS = 30_000;

interface Booted {
  base: string;
  kill(): void;
  stderr(): Promise<string>;
}

/**
 * Start an emitted server and wait until it answers.
 *
 * A server that dies during boot must not read as a timeout. The emitted host
 * throws "host bundle failed" out of Bun.build before it ever listens, and that
 * is precisely the failure a stubbed node_modules could hide — so an exited
 * process is reported with its stderr instead of being waited out.
 */
async function boot(script: string, port: number, env: Record<string, string>): Promise<Booted> {
  const proc = Bun.spawn(["bun", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Held, not awaited: this resolves only when the process exits, so awaiting
  // it on a healthy server would hang the test forever.
  const stderr = new Response(proc.stderr as ReadableStream).text();
  const name = path.basename(script);
  const base = `http://127.0.0.1:${port}`;
  // Comfortably under the per-test timeout the two cases below pass to bun.
  // With the default 5s the harness gave up first and reported a bare "timed
  // out", throwing away the bundle error that says what actually broke.
  const deadline = Date.now() + BOOT_TIMEOUT_MS;

  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`${name} exited ${proc.exitCode} before listening:\n${await stderr}`);
    }
    try {
      await fetch(base);
      return { base, kill: () => proc.kill(), stderr: () => stderr };
    } catch {
      if (Date.now() > deadline) {
        proc.kill();
        // Empty stderr here and no exit code means it was still running: with
        // the stubs removed, bun tries to auto-install the missing react from
        // the registry and hangs rather than reporting a resolution failure.
        throw new Error(`${name} never listened on ${port}:\n${await stderr}`);
      }
      await Bun.sleep(50);
    }
  }
}

/**
 * Enough of react, react-dom/client and react-scan to bundle against.
 *
 * The emitted host imports all three (and the JSX runtime, which the analysed
 * components pull in), none of which is a dependency of this repo. Installing
 * them for real is the slow, network-bound work that was deliberately left out,
 * and stubs are sufficient here because Bun.build only has to RESOLVE and
 * bundle these — nothing executes them. The bundle is asserted on rather than
 * merely the boot, because a stub that satisfies resolution can still leave a
 * bundling failure invisible.
 */
async function writeReactStubs(suiteDir: string): Promise<void> {
  const mod = (dir: string, files: Record<string, string>): Promise<unknown> =>
    Promise.all(
      Object.entries(files).map(([rel, body]) =>
        Bun.write(path.join(suiteDir, "node_modules", dir, rel), body),
      ),
    );

  const hooks =
    "export const useState = (v) => [v, () => {}];\n" +
    "export const useEffect = () => {};\n" +
    "export const useMemo = (f) => f();\n" +
    "export const useCallback = (f) => f;\n" +
    "export const useRef = (v) => ({ current: v });\n" +
    "export const createElement = () => null;\n" +
    "export const Profiler = 'Profiler';\n" +
    "export const Fragment = 'Fragment';\n";

  await mod("react", {
    "package.json": JSON.stringify({
      name: "react",
      version: "18.3.0",
      exports: {
        ".": "./index.js",
        "./jsx-runtime": "./jsx-runtime.js",
        "./jsx-dev-runtime": "./jsx-runtime.js",
      },
    }),
    "index.js": `${hooks}export default { createElement, Profiler, Fragment };\n`,
    "jsx-runtime.js":
      "export const jsx = () => null;\nexport const jsxs = () => null;\n" +
      "export const jsxDEV = () => null;\nexport const Fragment = 'Fragment';\n",
  });

  await mod("react-dom", {
    "package.json": JSON.stringify({
      name: "react-dom",
      version: "18.3.0",
      exports: { ".": "./index.js", "./client": "./client.js" },
    }),
    "index.js": "export default {};\n",
    "client.js": "export const createRoot = () => ({ render: () => {}, unmount: () => {} });\n",
  });

  await mod("react-scan", {
    "package.json": JSON.stringify({ name: "react-scan", version: "0.4.3", main: "index.js" }),
    "index.js": "export const scan = () => {};\n",
  });
}

/** Render a suite to disk and hand back its directory. */
async function emitSuiteTo(opts: { mockRoutes?: MockRoute[] } = {}): Promise<string> {
  const tree = await analyse({ entry: fixture("Card.tsx"), depth: 0, includeChildren: false });
  const outDir = path.join(await tmpRoot(), "flawless");
  const files = renderSuite({
    tree,
    outDir,
    variants: 3,
    report: false,
    ...(opts.mockRoutes ? { mockRoutes: opts.mockRoutes } : {}),
  });
  await Promise.all(files.map((f) => Bun.write(path.join(outDir, f.relPath), f.content)));
  return outDir;
}

describe("the emitted servers are started, not merely written", () => {
  test(
    "mock/server.ts answers the readiness probe and its compiled routes",
    async () => {
      // Hermetic: this one imports ./routes and nothing else.
      const mockRoutes = extractRoutes(await loadApiSpec(fixture("_api.json")));
      expect(mockRoutes.length).toBeGreaterThan(0);
      const outDir = await emitSuiteTo({ mockRoutes });
      const port = freePort();
      const server = await boot(path.join(outDir, "mock", "server.ts"), port, {
        MOCK_PORT: String(port),
      });

      try {
        // Playwright's webServer probe rejects a 404, so "/" has to be a 200 —
        // a mock server that only answered its routes would hang every run that
        // waits on it.
        const root = await fetch(server.base);
        expect(root.status).toBe(200);

        const list = await fetch(`${server.base}/api/users`);
        expect(list.status).toBe(200);
        expect(await list.json()).toEqual([{ id: 1, name: "Alice" }]);

        // The templated path — /api/users/{id} only answers if compile() turned
        // the OpenAPI template into a matcher rather than comparing it literally.
        expect((await fetch(`${server.base}/api/users/7`)).status).toBe(200);
        expect((await fetch(`${server.base}/api/users/7/nope`)).status).toBe(404);
      } finally {
        server.kill();
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "host/server.ts bundles the registry and serves it",
    async () => {
      const outDir = await emitSuiteTo();
      await writeReactStubs(outDir);
      const port = freePort();
      const server = await boot(path.join(outDir, "host", "server.ts"), port, {
        PORT: String(port),
      });

      try {
        const page = await fetch(server.base);
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toContain("text/html");
        expect(await page.text()).toContain('<div id="root">');

        // The build is what matters: reaching this line proves Bun.build resolved
        // the components AND the bare specifiers through the resolve-from-suite
        // plugin, since the server throws "host bundle failed" otherwise.
        const bundle = await fetch(`${server.base}/bundle.js`);
        expect(bundle.status).toBe(200);
        expect(bundle.headers.get("content-type")).toContain("javascript");
        const js = await bundle.text();
        expect(js).toContain("Card");
        expect(js.length).toBeGreaterThan(500);

        // msw is not installed, so the documented stub answers rather than the
        // route falling through to the generic 404.
        const sw = await fetch(`${server.base}/mockServiceWorker.js`);
        expect(sw.status).toBe(404);
        expect(await sw.text()).toContain("msw not installed");

        expect((await fetch(`${server.base}/nothing-here`)).status).toBe(404);
      } finally {
        server.kill();
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a re-run's new component reaches the served bundle through the kept main.tsx",
    async () => {
      // FR-016 end to end: the suite exists, main.tsx is write-once and kept,
      // and a plain re-scaffold with an added tree must still put the new
      // component into what /bundle.js serves — via the refreshed registry.ts.
      const outDir = await emitSuiteTo();
      await writeReactStubs(outDir);
      const mainPath = path.join(outDir, "host", "main.tsx");
      const mainBytes = await Bun.file(mainPath).text();

      const cardTree = await analyse({
        entry: fixture("Card.tsx"),
        depth: 0,
        includeChildren: false,
      });
      const toolbarTree = await analyse({
        entry: fixture("Toolbar.tsx"),
        depth: 0,
        includeChildren: false,
      });
      const second = await scaffold(cardTree, {
        outDir,
        extraTrees: [toolbarTree],
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: undefined,
      });
      expect(second.status).toBe("refreshed");
      expect(await Bun.file(mainPath).text()).toBe(mainBytes);

      const port = freePort();
      const server = await boot(path.join(outDir, "host", "server.ts"), port, {
        PORT: String(port),
      });
      try {
        const js = await (await fetch(`${server.base}/bundle.js`)).text();
        // A string probe, not a mount: react is stubbed here (createRoot is a
        // no-op), so the honest reachable-signal is the new component's
        // identifier landing in the bundle main.tsx pulls via ./registry.
        // Bare, not '"Toolbar"': Bun collapses {"Toolbar": Toolbar} to
        // shorthand, so the quoted key never survives bundling.
        expect(js).toContain("Toolbar");
        expect(js).toContain("Card");
      } finally {
        server.kill();
      }
    },
    CASE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Emitted prose — the half danglingIn cannot see
// ---------------------------------------------------------------------------

/**
 * Every `bun run <name>` an emitted file tells the reader to type.
 *
 * Read out of the files ON DISK rather than the template functions, so the
 * READMEs the load and e2e tasks write are covered too — no template-level scan
 * reaches those, and they carry as many instructions as the suite README.
 */
function bunRunNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    // "e.g. `bun run db:reset`" names a script in the READER's project as an
    // illustration — e2e/README.md says "whatever your repo uses". Illustrations
    // cannot be checked against anything, and demanding they exist would mean
    // deleting a useful line. Only instructions are held to the rule.
    if (/\be\.g\./.test(line)) continue;
    for (const m of line.matchAll(/bun run ([\w:.-]+)/g)) out.push(m[1] as string);
  }
  return out;
}

/**
 * Lifecycle scripts belonging to the TARGET project, named on purpose.
 *
 * The pipes header tells you to point LOAD_BASE at a production build rather
 * than at `next dev`, because a dev server compiles on demand and the run
 * measures the compiler. That instruction is about the reader's app, so these
 * are never flawless's to declare.
 */
const HOST_LIFECYCLE = new Set(["build", "start", "dev"]);

/** Every text file under a directory, relative-path keyed. */
function emittedText(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = path.join(dir, rel);
    if (!statSync(abs).isFile()) continue;
    try {
      out.set(rel.split(path.sep).join("/"), readFileSync(abs, "utf8"));
    } catch {
      // Binary or unreadable — nothing to scan.
    }
  }
  return out;
}

/** Prose telling the reader to run a script this configuration never declared. */
function proseNamingUndeclared(outDir: string, declared: Set<string>): string[] {
  const bad: string[] = [];
  for (const [rel, text] of emittedText(outDir)) {
    for (const name of bunRunNames(text)) {
      if (declared.has(name) || HOST_LIFECYCLE.has(name)) continue;
      bad.push(`${rel}: \`bun run ${name}\` — no such script in this run`);
    }
  }
  return bad;
}

describe("emitted prose names only scripts the run declared", () => {
  test("the standalone suite", async () => {
    const { scripts, outDir } = await standaloneRun(["perf-harness", "unit-browser"], true);

    expect(proseNamingUndeclared(outDir, new Set(Object.keys(scripts)))).toEqual([]);
  });

  test("Next.js mode, where `bun run test` reaches the app's own suite", async () => {
    // The defect this closes: the suite README's Run block was the standalone
    // one in both modes, and there is no suite package.json in this one — so
    // `bun run test` walked up to the APPLICATION's package.json and ran its
    // real test suite while the reader believed they were running the profile
    // suite. Silent, and it reads as success.
    const { scripts, outDir } = await nextjsRun(["perf-harness", "unit-browser", "e2e", "load"]);

    expect(proseNamingUndeclared(outDir, new Set(Object.keys(scripts)))).toEqual([]);
  });

  test("the scan sees an instruction and lets an illustration past", () => {
    // Guards the guard, both ways: a bunRunNames that returned [] would make
    // every case above assert nothing, and one that ignored "e.g." would force
    // the removal of a line that is correct as written.
    expect(bunRunNames("bun run flawless:perf   # headless")).toEqual(["flawless:perf"]);
    expect(
      bunRunNames("- Seed the DB (whatever your repo uses — e.g. `bun run db:reset`)."),
    ).toEqual([]);
    expect(bunRunNames("nothing to see here")).toEqual([]);
  });
});
