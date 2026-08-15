import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
