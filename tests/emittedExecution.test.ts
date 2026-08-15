import { describe, expect, test } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { scaffold } from "../src/scaffold/index.ts";
import { type RenderedFile, renderSuite } from "../src/scaffold/templates.ts";
import { e2eRoutes } from "../src/tasks/e2eRoutes.ts";
import { type LoadTarget, loadPipes, renderPipes } from "../src/tasks/loadPipes.ts";
import type { RunContext } from "../src/types.ts";

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

/** Local files a package.json script names, e.g. `node ./scripts/report.mjs`. */
function scriptFileRefs(command: string): string[] {
  return [...command.matchAll(/(?:^|\s)(\.?\.?\/?[\w./-]+\.(?:mjs|cjs|js|ts|json))/g)]
    .map((m) => (m[1] as string).replace(/^\.\//, ""))
    .filter((f) => !f.startsWith("../"));
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

  /** Scripts naming a file the suite does not write — `bun run <name>` would fail. */
  const danglingScripts = (report: boolean): string[] => {
    const files = suiteFiles(report);
    const present = new Set(files.map((f) => f.relPath));
    const pkg = files.find((f) => f.relPath === "package.json");
    if (!pkg) throw new Error("no package.json emitted");
    const { scripts } = JSON.parse(pkg.content) as { scripts: Record<string, string> };
    const out: string[] = [];
    for (const [name, command] of Object.entries(scripts)) {
      for (const ref of scriptFileRefs(command)) {
        if (!present.has(ref)) out.push(`${name}: ${command} — ${ref} is not emitted`);
      }
    }
    return out;
  };

  test("every script in the emitted package.json names a file the suite emits", () => {
    expect(danglingScripts(true)).toEqual([]);
    // Without --report there is no scripts/report.mjs, so there must be no
    // `report` script either: `bun run report` on a suite that never emitted it
    // fails with a module-not-found nobody can act on.
    expect(danglingScripts(false)).toEqual([]);
  });

  test("the reference check can tell a missing file from a present one", () => {
    // Guards the guard: scriptFileRefs returning [] would make the loop above
    // assert nothing at all.
    expect(scriptFileRefs("node ./scripts/report.mjs")).toEqual(["scripts/report.mjs"]);
    expect(scriptFileRefs("playwright test --project=interactive")).toEqual([]);
  });
});
