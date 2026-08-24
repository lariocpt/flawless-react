import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectTestScriptCollisions, runCore, UsageError } from "../src/core.ts";
import { runFlawless } from "../src/index.ts";
import { divergentScripts, mergePackageJson } from "../src/packageJson.ts";
import { renderSuite } from "../src/scaffold/templates.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";
import type { TaskId } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures");
const DASHBOARD = path.join(FIXTURES, "Dashboard.tsx");

const tmpDirs: string[] = [];

function tmpOutDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-core-"));
  tmpDirs.push(dir);
  return dir;
}

/** Inline summaries land next to the analysed sources — never leave them behind. */
function sidecars(): string[] {
  return readdirSync(FIXTURES).filter((f) => f.endsWith(".flawless.json"));
}

function removeSidecars(): void {
  for (const f of sidecars()) unlinkSync(path.join(FIXTURES, f));
}

beforeAll(() => {
  removeSidecars();
});

afterAll(() => {
  removeSidecars();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("kept scripts reach every durable surface", () => {
  test("a customized flawless:* script lands in CoreResult and REPORT.md, not just stdout", async () => {
    // The FR-034 keep alone was stdout-only — suppressed under --ci/--json
    // and programmatic runs, the exact modes an agent refreshes in. The
    // fact a script was kept must survive in the artifacts the regen
    // doctrine says to trust.
    const root = mkdtempSync(path.join(os.tmpdir(), "flawless-kept-scripts-"));
    tmpDirs.push(root);
    cpSync(path.resolve(__dirname, "fixtures", "nextapp"), root, { recursive: true });
    const pkgPath = path.join(root, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    pkg.scripts = { ...(pkg.scripts ?? {}), "flawless:load": "crust --env-file custom -c 'x'" };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const result = await runCore({
      pattern: path.join(root, "src", "app", "page.tsx"),
      outDir: path.join(root, "flawless"),
      taskIds: ["unit-browser", "load"],
      nextjs: root,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.keptScripts).toEqual(["flawless:load"]);
    const report = readFileSync(path.join(root, "flawless", "REPORT.md"), "utf8");
    expect(report).toContain("Kept script(s): flawless:load");
    // And the recognized-spelling upgrade must NOT be reported: the app's
    // own dev script is untouched territory entirely.
    expect(result.keptScripts).not.toContain("dev");
  });
});

describe("runCore", () => {
  test("unit-browser task on the Dashboard fixture resolves without exiting", async () => {
    const outDir = tmpOutDir();
    const result = await runCore({
      pattern: DASHBOARD,
      outDir,
      taskIds: ["unit-browser"],
      log: false,
      inlineSummary: false,
    });

    // Reaching this line at all proves runCore never called process.exit.
    expect(result.exitCode).toBe(0);
    expect(result.outDir).toBe(path.resolve(outDir));
    expect(result.results.length).toBeGreaterThan(0);

    const unit = result.results.find((r) => r.id === "unit-browser");
    expect(unit).toBeDefined();
    expect(unit?.ok).toBe(true);
    expect(unit?.error).toBeUndefined();
    expect((unit?.outputs ?? []).length).toBeGreaterThan(0);

    expect(result.trees).toHaveLength(1);
    expect(result.trees[0]?.entry.componentName).toBe("Dashboard");
    expect(result.nextjs).toBeUndefined();
  });

  test("a pattern matching nothing throws UsageError instead of exiting", async () => {
    const outDir = tmpOutDir();
    const patterns = [
      // Plain path that does not exist (no glob characters).
      path.join(outDir, "NoSuchComponent.tsx"),
      // Glob inside a real directory that matches no file.
      path.join(FIXTURES, "ZzNoSuchComponent-*.tsx"),
    ];
    for (const pattern of patterns) {
      let caught: unknown;
      try {
        await runCore({
          pattern,
          outDir,
          taskIds: ["perf-static"],
          log: false,
          inlineSummary: false,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UsageError);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("no files matched");
    }
  });

  test("perf-static returns findings and writes reports/summary.json", async () => {
    const outDir = tmpOutDir();
    const result = await runCore({
      pattern: DASHBOARD,
      outDir,
      taskIds: ["perf-static"],
      log: false,
      inlineSummary: false,
    });

    const perf = result.results.find((r) => r.id === "perf-static");
    expect(perf).toBeDefined();
    expect(perf?.ok).toBe(true);
    expect((perf?.findings ?? []).length).toBeGreaterThan(0);
    for (const finding of perf?.findings ?? []) {
      expect(finding.source).toBe("perf-static");
    }

    const summaryPath = path.join(result.outDir, "reports", "summary.json");
    expect(existsSync(summaryPath)).toBe(true);
    const summary = (await Bun.file(summaryPath).json()) as {
      ts: string;
      results: Array<{ id: string; ok: boolean; findings: number }>;
    };
    expect(summary.results.map((r) => r.id)).toContain("perf-static");
    expect(summary.results[0]?.findings).toBe(perf?.findings.length ?? -1);
  });

  test("a second run over the same outDir refreshes the harness and exits 0", async () => {
    // FR-028: this used to be { ok: false, summary: "task threw" } and exit 1,
    // committed into REPORT.md as a failure of a healthy adopted suite.
    const outDir = tmpOutDir();
    const base = {
      pattern: DASHBOARD,
      outDir,
      taskIds: ["perf-harness"] as TaskId[],
      log: false,
      inlineSummary: false,
    };
    const first = await runCore(base);
    expect(first.exitCode).toBe(0);
    expect(first.results.find((r) => r.id === "perf-harness")?.status).toBe("generated");

    const second = await runCore(base);
    expect(second.exitCode).toBe(0);
    const perf = second.results.find((r) => r.id === "perf-harness");
    expect(perf?.ok).toBe(true);
    expect(perf?.status).toBe("refreshed");
  });

  test("changed-mode keeps the harness, so the affected-run gate cannot trip", async () => {
    // FR-017's fix is indirect: the !anyFailed gate on the affected run stays,
    // and a full selection now passes it because a kept harness is ok:true
    // rather than a manufactured failure. testRun is the load-bearing
    // assertion here — exit 0 alone is equally consistent with the affected
    // branch never executing (a mutation reinstating FR-017 passed the whole
    // suite until this seam existed). A true end-to-end (git repo with staged
    // component edits + a real playwright run) would re-prove the runner,
    // already pinned in tests/runTests.test.ts, at disproportionate cost.
    // --changed needs a real checkout: comparing against a ref git cannot
    // resolve is a false pass, so runCore now refuses it. A one-commit repo
    // keeps this test about the FR-017 gate rather than about git.
    const outDir = tmpOutDir();
    for (const args of [
      ["init", "-q"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"],
    ]) {
      const proc = Bun.spawn(["git", ...args], { cwd: outDir, stdout: "pipe", stderr: "pipe" });
      if ((await proc.exited) !== 0) throw new Error(`git ${args[0]} failed in ${outDir}`);
    }
    const base = {
      pattern: DASHBOARD,
      outDir,
      taskIds: ["perf-harness"] as TaskId[],
      log: false,
      inlineSummary: false,
    };
    await runCore(base);
    const second = await runCore({ ...base, changed: true });
    expect(second.exitCode).toBe(0);
    const perf = second.results.find((r) => r.id === "perf-harness");
    expect(perf?.ok).toBe(true);
    expect(perf?.status).toBe("kept");
    expect(perf?.outputs).toEqual([]);
    // The affected run FIRED in the kept state — the gate opened. Narrowed
    // rather than optional-chained: since B-14 made testRun a union, `mode`
    // alone no longer implies `green` exists, and reading it through `?.` on
    // the wrong arm would be undefined rather than a failure.
    const run = second.testRun;
    expect(run?.mode).toBe("affected");
    if (run?.mode !== "affected" && run?.mode !== "generated") {
      throw new Error(`expected a suite run, got ${JSON.stringify(run)}`);
    }
    expect(run.green).toBe(true);
  });

  // B-14's control. The new branch reports mode:"none" when a run was asked for
  // and nothing could run it; this proves the branch did not swallow the real
  // one — a REAL --run-tests still reports "generated". Cheap on purpose: an
  // empty node_modules skips the runner's `bun install`, and `bun run test:perf`
  // fails in milliseconds with 127 because `playwright` is not on PATH (bun run
  // resolves, it does not auto-install the way bunx would). ~40 ms, no network,
  // and it exercises the red-suite path into exitCode at the same time.
  test("a real --run-tests reports mode:generated — even when the suite goes red", async () => {
    const outDir = tmpOutDir();
    mkdirSync(path.join(outDir, "node_modules"), { recursive: true });
    const saved = process.env.FLAWLESS_SKIP_BROWSER_INSTALL;
    process.env.FLAWLESS_SKIP_BROWSER_INSTALL = "1";
    try {
      const result = await runCore({
        pattern: DASHBOARD,
        outDir,
        taskIds: ["perf-harness"],
        runTests: true,
        log: false,
        quiet: true,
        inlineSummary: false,
      });
      const run = result.testRun;
      expect(run?.mode).toBe("generated");
      if (run?.mode !== "generated") throw new Error(`expected generated, got ${run?.mode}`);
      // The suite genuinely ran and genuinely failed — so this is not a
      // vacuous "generated" from a branch that never invoked the runner.
      expect(run.green).toBe(false);
      expect(result.exitCode).toBe(1);
      // …and a red SUITE is not a failed task: results stay ok, which is
      // exactly why testRun has to ride in the blob for the caller to see it.
      expect(result.results.every((r) => r.ok)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.FLAWLESS_SKIP_BROWSER_INSTALL;
      else process.env.FLAWLESS_SKIP_BROWSER_INSTALL = saved;
    }
  }, 60000);

  test("a genuinely failing task still exits 1 over a kept-or-refreshed harness", async () => {
    // The honesty floor: nothing that failed maps to 0. e2e without --nextjs is
    // the cheapest real failure — the task returns ok:false without spawning.
    const outDir = tmpOutDir();
    const base = {
      pattern: DASHBOARD,
      outDir,
      taskIds: ["perf-harness", "e2e"] as TaskId[],
      log: false,
      inlineSummary: false,
    };
    await runCore(base);
    const second = await runCore(base);
    expect(second.exitCode).toBe(1);
    expect(second.results.find((r) => r.id === "perf-harness")?.ok).toBe(true);
    expect(second.results.find((r) => r.id === "e2e")?.ok).toBe(false);

    // The kept variant of the honesty floor: --changed with a real failure
    // still exits 1, and the failure BLOCKS the affected run (the gate's
    // other half — running tests over a half-failed generation would report
    // green against artefacts that were never produced).
    const kept = await runCore({ ...base, changed: true });
    expect(kept.exitCode).toBe(1);
    expect(kept.results.find((r) => r.id === "perf-harness")?.status).toBe("kept");
    expect(kept.results.find((r) => r.id === "e2e")?.ok).toBe(false);
    expect(kept.testRun).toBeUndefined();
  });

  test("inlineSummary:false leaves no <Component>.flawless.json beside the source", async () => {
    expect(sidecars()).toEqual([]);
    const outDir = tmpOutDir();
    await runCore({
      pattern: DASHBOARD,
      outDir,
      taskIds: ["perf-static"],
      log: false,
      inlineSummary: false,
    });
    expect(sidecars()).toEqual([]);
    expect(existsSync(path.join(FIXTURES, "Dashboard.flawless.json"))).toBe(false);
    expect(existsSync(path.join(FIXTURES, "Hello.flawless.json"))).toBe(false);
    expect(existsSync(path.join(FIXTURES, "Card.flawless.json"))).toBe(false);
  });
});

describe("runFlawless", () => {
  test("returns the CoreResult shape and never exits", async () => {
    const out = tmpOutDir();
    const result = await runFlawless({
      entry: DASHBOARD,
      out,
      tasks: ["unit-browser"],
      inlineSummary: false,
    });

    expect(result.outDir).toBe(path.resolve(out));
    expect(Array.isArray(result.results)).toBe(true);
    expect(Array.isArray(result.trees)).toBe(true);
    expect(result.trees[0]?.entry.componentName).toBe("Dashboard");
    expect(result.exitCode).toBe(0);
    expect(result.nextjs).toBeUndefined();
    expect(result.provider).toBeUndefined();
    // log defaults to false for the programmatic API.
    expect(sidecars()).toEqual([]);
  });

  // B-13 split warn()'s gate from log()'s, and `quiet` is the deliberate opt-out
  // the docs offer an embedder. Nothing else in the suite passes it: three
  // separate mutations that made `quiet: true` a no-op — dropping it from
  // index.ts's plumbing, ignoring it in core's gate, inverting its default —
  // survived all 822 tests. A documented flag with no test is a promise, not a
  // contract. Driven through runFlawless rather than runCore so the plumbing is
  // covered too, and paired with its own control: the negative assertion below
  // means nothing unless the same run WITHOUT quiet is shown to be loud.
  test("quiet:true silences the diagnostic that speaks by default", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-quiet-"));
    tmpDirs.push(dir);
    const src = path.join(dir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      path.join(src, "Ok.tsx"),
      "export const Ok = ({ name }: { name: string }) => <div>{name}</div>;\n",
    );
    // A value constant, not a component: the sweep skips it and warns.
    writeFileSync(path.join(src, "NotAComponent.tsx"), "export const NOOP = () => null;\n");

    const run = async (quiet: boolean | undefined): Promise<string> => {
      const original = process.stderr.write.bind(process.stderr);
      let buf = "";
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        return true;
      }) as typeof process.stderr.write;
      try {
        await runFlawless({
          entry: path.join(src, "*.tsx"),
          out: path.join(dir, quiet === true ? "out-quiet" : "out-loud"),
          tasks: ["perf-static"],
          inlineSummary: false,
          ...(quiet === undefined ? {} : { quiet }),
        });
      } finally {
        process.stderr.write = original;
      }
      return buf;
    };

    // Control: the default is LOUD, even though log defaults to false here.
    expect(await run(undefined)).toContain("warning: skipping");
    // The opt-out actually opts out.
    expect(await run(true)).not.toContain("warning: skipping");
  }, 30000);
});

describe("test-script collision detection", () => {
  function pkg(dir: string, scripts: Record<string, string>): void {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", scripts }, null, 2));
  }

  test("flags an unscoped bun test when specs are colocated", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-collide-"));
    tmpDirs.push(dir);
    pkg(dir, { test: "bun test" });
    const warnings = detectTestScriptCollisions(dir, true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bun test");
    expect(warnings[0]).toContain("flawless.test.tsx");
  });

  test("a path-scoped script is fine", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-collide-"));
    tmpDirs.push(dir);
    pkg(dir, { test: "bun test tests" });
    expect(detectTestScriptCollisions(dir, true)).toEqual([]);
  });

  test("nothing is flagged without --colocate", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-collide-"));
    tmpDirs.push(dir);
    pkg(dir, { test: "bun test" });
    expect(detectTestScriptCollisions(dir, false)).toEqual([]);
  });

  test("the flawless:* scripts it wrote are never flagged", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-collide-"));
    tmpDirs.push(dir);
    pkg(dir, { "flawless:unit": "vitest run", test: "bun test tests" });
    expect(detectTestScriptCollisions(dir, true)).toEqual([]);
  });
});

/**
 * package.json is the only file two tasks both write, and the CLI documents that
 * tasks run in the order you type them — so the result must not depend on it.
 */
describe("the two emitters that share package.json", () => {
  const scriptsAfter = async (taskIds: TaskId[]): Promise<string[]> => {
    const outDir = tmpOutDir();
    const result = await runCore({
      pattern: DASHBOARD,
      outDir,
      taskIds,
      log: false,
      inlineSummary: false,
    });
    const pkgJson = (await Bun.file(path.join(result.outDir, "package.json")).json()) as {
      scripts: Record<string, string>;
    };
    return Object.keys(pkgJson.scripts).sort();
  };

  /** Each emitter's fresh contribution, before either touches disk. */
  const perfScripts = (): Record<string, string> => {
    const pkg = renderSuite({
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
      report: true,
    }).find((f) => f.relPath === "package.json");
    if (!pkg) throw new Error("perf-harness emitted no package.json");
    return (JSON.parse(pkg.content) as { scripts: Record<string, string> }).scripts;
  };

  const unitScripts = (): Record<string, string> =>
    (JSON.parse(suitePackageJson("/app/flawless", true)) as { scripts: Record<string, string> })
      .scripts;

  test("no script key is declared by both emitters with different commands", () => {
    // The asymmetry this closes: both declared test:perf, perf-harness as
    // `playwright test` and unit-browser as `playwright test profile`. Both
    // commands work, so nothing failed — the file's bytes just depended on
    // which task ran last. Unfixable at merge time, where a differing value on
    // disk is indistinguishable from an older version being upgraded.
    expect(divergentScripts(perfScripts(), unitScripts())).toEqual([]);
  });

  test("the divergence check would catch one", () => {
    // Guards the guard, and it earns its place: the two emitters share no key at
    // all today, so the assertion above passes over an empty intersection and
    // would keep passing if the check were dead.
    expect(
      divergentScripts({ "test:perf": "playwright test" }, { "test:perf": "playwright test x" }),
    ).toEqual(['test:perf: "playwright test" vs "playwright test x"']);
    expect(divergentScripts({ a: "x" }, { a: "x", b: "y" })).toEqual([]);
  });

  test("test:perf has exactly one owner", () => {
    // It names perf-harness's config and directory, and browserSpecs is set from
    // exactly selectedTasks.includes("perf-harness") — so unit-browser could
    // only ever declare it in runs where perf-harness already had. A redundant
    // second spelling is what let the two drift apart.
    expect(perfScripts()["test:perf"]).toBe("playwright test");
    expect(unitScripts()["test:perf"]).toBeUndefined();
    expect(JSON.parse(suitePackageJson("/app/flawless", false)).scripts["test:browser"]).toBe(
      undefined,
    );
  });

  test("either order keeps every script both tasks declare", async () => {
    // Reversed, perf-harness's package.json overwrote the one unit-browser had
    // merged into: test:unit and test:browser disappeared, and --run-tests then
    // invoked test:unit and reported a correct suite as failing.
    const registryOrder = await scriptsAfter(["perf-harness", "unit-browser"]);
    expect(registryOrder).toEqual([
      "test",
      "test:browser",
      "test:headed",
      "test:perf",
      "test:unit",
    ]);
    expect(await scriptsAfter(["unit-browser", "perf-harness"])).toEqual(registryOrder);
  });

  test("a script of your own survives the merge, and your pins are not bumped", () => {
    const merged = JSON.parse(
      mergePackageJson(
        JSON.stringify({
          name: "mine",
          version: "1.2.3",
          packageManager: "bun@1.1.0",
          scripts: { deploy: "./deploy.sh", test: "vitest run" },
          dependencies: { react: "^19.0.0" },
        }),
        JSON.stringify({
          name: "generated",
          version: "0.0.0",
          scripts: { test: "playwright test" },
          dependencies: { react: "^18.3.0", "react-dom": "^18.3.0" },
        }),
      ),
    ) as {
      name: string;
      version: string;
      packageManager: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };

    expect(merged.scripts.deploy).toBe("./deploy.sh");
    expect(merged.packageManager).toBe("bun@1.1.0");
    // Same as scaffoldUnitBrowser's merge, which keeps a renamed suite renamed —
    // two merges into one file must not disagree about who owns a field.
    expect(merged.name).toBe("mine");
    expect(merged.version).toBe("1.2.3");
    // Generated scripts win their own key, so a suite scaffolded by an older
    // version picks up a corrected command — the same call the other two merges
    // in this repo make.
    expect(merged.scripts.test).toBe("playwright test");
    // A version range is the project's decision; ours is only a default.
    expect(merged.dependencies.react).toBe("^19.0.0");
    expect(merged.dependencies["react-dom"]).toBe("^18.3.0");
  });

  test("an unparseable package.json is replaced rather than fatal", () => {
    expect(mergePackageJson("{ not json", '{"name":"x"}')).toBe('{"name":"x"}');
  });
});
