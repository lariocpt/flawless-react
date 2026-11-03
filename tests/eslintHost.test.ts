import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * Defect #17, by execution — the eslint branch of the style-adoption pass,
 * on a host whose only style config is a FLAT eslint config.
 *
 * The fixture is a copy of tests/fixtures/nextapp with two differences:
 * layout.tsx carries no `// @ts-nocheck` (this fixture's own config fires
 * @typescript-eslint/ban-ts-comment on that line — the one error class the
 * fixture exists to keep at zero — so its unresolvable specifiers typecheck
 * against the ambient declarations in next-shims.d.ts instead), and a flat
 * eslint.config.js (js.configs.recommended + typescript-eslint recommended)
 * is the only style config present. With no biome or prettier config the
 * adoption chain reaches the eslint branch only.
 *
 * A flat-config host leaves no filesystem trace from that pass:
 * ensureFormatterIgnores writes .eslintignore for the eslintrc family only,
 * and --fix on the template output is a measured no-op — none of the errors
 * pinned below is auto-fixable. The pass is therefore proven by runCore's
 * stdout (the `style:` line naming the formatter), and its effect is
 * measured by the HOST's own eslint over the two trees the run wrote.
 *
 * The pinned set is the gap as measured on the CONTROL binary (main at
 * 376023e, built the same way) on a fresh copy of this fixture: 32 errors /
 * 0 warnings. None of them is auto-fixable, so the pass's --fix clears
 * nothing — every one is a template defect, and the template work this
 * chunk lands exists to make the next measurement read zero.
 */

const FIXTURE = path.resolve(__dirname, "fixtures", "eslint-next-app");

/**
 * The five dev runners the emitted specs import — the PRE-regen install of
 * the app that already carries its own react (18), then the post-regen
 * install adds whatever the tool writes into the app's manifest. Ranges come
 * from the suite manifest, never hand-picked.
 */
const RUNNERS = [
  "vitest",
  "jsdom",
  "@testing-library/react",
  "@testing-library/user-event",
  "@testing-library/jest-dom",
];

/**
 * The gap as measured (control binary, fresh fixture copy): the host's own
 * eslint over `src flawless` exits 1 with exactly these 32 errors — 10
 * no-useless-escape (8 in host/server.ts, 2 in vitest.config.mts) and 22
 * @typescript-eslint/no-unused-vars across the suite's configs and specs.
 */
const EXPECTED_EXIT = 1;
const EXPECTED_BY_RULE: Record<string, number> = {
  "no-useless-escape": 10,
  "@typescript-eslint/no-unused-vars": 22,
};
const EXPECTED_ERROR_FILES: Record<string, number> = {
  "flawless/host/server.ts": 8,
  "flawless/playwright.config.ts": 1,
  "flawless/profile/HomePage.profile.spec.ts": 3,
  "flawless/profile/Providers.profile.spec.ts": 3,
  "flawless/profile/Toast.profile.spec.ts": 3,
  "flawless/vitest.config.mts": 2,
  "src/app/items/[id]/page.flawless.test.tsx": 3,
  "src/app/page.flawless.test.tsx": 2,
  "src/components/Providers.flawless.test.tsx": 3,
  "src/components/Toast.flawless.test.tsx": 4,
};

/**
 * Non-vacuity: the complete set of 40 JS files the host's eslint linted in
 * the measurement (60 files on disk — the flat config silently skips the
 * 20 non-JS ones). If a config or CLI regression ever made the sweep match
 * nothing, a zero-error flip would pass vacuously; this list is what
 * prevents that. A suite-layout change must be a conscious edit of it.
 */
const LINTED_REQUIRED = [
  "flawless/browser/HomePage.spec.ts",
  "flawless/browser/Providers.spec.ts",
  "flawless/browser/Toast.spec.ts",
  "flawless/browser/playwright.config.ts",
  "flawless/e2e/global-setup.ts",
  "flawless/e2e/index.spec.ts",
  "flawless/e2e/items-id.spec.ts",
  "flawless/e2e/params.ts",
  "flawless/e2e/playwright.config.ts",
  "flawless/host/_polyfill.ts",
  "flawless/host/main.tsx",
  "flawless/host/registry.ts",
  "flawless/host/server.ts",
  "flawless/load/routes.setup.ts",
  "flawless/mocks/browser.ts",
  "flawless/mocks/handlers.ts",
  "flawless/mocks/node.ts",
  "flawless/playwright.config.ts",
  "flawless/profile/HomePage.profile.spec.ts",
  "flawless/profile/Providers.profile.spec.ts",
  "flawless/profile/Toast.profile.spec.ts",
  "flawless/profile/_heap.ts",
  "flawless/profile/_helpers.ts",
  "flawless/provider.fixtures.ts",
  "flawless/provider.tsx",
  "flawless/server-only-stub.ts",
  "flawless/setup.ts",
  "flawless/vitest.config.mts",
  "src/app/api/(internal)/health/route.ts",
  "src/app/api/items/route.ts",
  "src/app/items/[id]/page.flawless.test.tsx",
  "src/app/items/[id]/page.tsx",
  "src/app/layout.flawless.test.tsx",
  "src/app/layout.tsx",
  "src/app/page.flawless.test.tsx",
  "src/app/page.tsx",
  "src/components/Providers.flawless.test.tsx",
  "src/components/Providers.tsx",
  "src/components/Toast.flawless.test.tsx",
  "src/components/Toast.tsx",
];

type EslintMessage = {
  ruleId: string | null;
  line: number;
  column: number;
  message: string;
  severity: 1 | 2;
};
type EslintFileReport = {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
};

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function suitePins(outDir: string, names: string[], reactPinDir: string): string[] {
  const manifest = suitePackageJson(outDir, false, false, false, reactPinDir);
  const pkg = JSON.parse(manifest) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return names.map((name) => {
    const range = all[name];
    if (range === undefined) throw new Error(`the emitted suite no longer pins ${name}`);
    return `${name}@${range}`;
  });
}

async function bunRun(args: string[], cwd: string, label: string): Promise<void> {
  const proc = Bun.spawn(["bun", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${label} failed (needs registry access):\n${err}`);
}

/**
 * Run the app's own eslint from its cwd; return stdout and the exit code.
 * console.error on a non-zero exit mirrors the execution tests' pattern, so
 * a red run leaves its report in the gate log.
 */
async function eslintRun(bin: string, args: string[], cwd: string) {
  const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) console.error(out);
  return { out, code };
}

describe("defect #17: the eslint branch on a flat-config host", () => {
  test("the pass runs the host's eslint, and the host's own lint of the suite is what is pinned", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "flawless-eslinthost-"));
    tmpDirs.push(root);
    const app = path.join(root, "eslint-next-app");
    cpSync(FIXTURE, app, { recursive: true });

    await bunRun(["install"], app, "bun install");
    const outDir = path.join(app, "flawless");
    await bunRun(["add", "-d", ...suitePins(outDir, RUNNERS, app)], app, "bun add -d");

    const eslintBin = path.join(app, "node_modules", ".bin", "eslint");
    if (!existsSync(eslintBin)) throw new Error(`eslint did not install at ${eslintBin}`);

    // runCore's own narration goes to stdout — captured here, because a
    // flat-config host leaves no filesystem trace from the style pass and
    // the `style:` line is its only observable evidence. (dogfood-baseline
    // sets the precedent with stderr.)
    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      out.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
    let result: Awaited<ReturnType<typeof runCore>>;
    try {
      result = await runCore({
        pattern: path.join(app, "src", "**", "*.tsx"),
        outDir,
        taskIds: [
          "perf-harness",
          "unit-browser",
          "perf-static",
          "a11y",
          "react-rules",
          "e2e",
          "load",
        ],
        nextjs: app,
        log: true,
        inlineSummary: false,
        colocate: true,
      });
    } finally {
      process.stdout.write = original;
    }
    expect(result.exitCode).toBe(0);

    const styleLine = out
      .join("")
      .split("\n")
      .find((l) => l.startsWith("style:"));
    if (styleLine === undefined) {
      throw new Error("the run's stdout carries no style: line — the eslint branch never ran");
    }
    expect(styleLine).toContain("the project's eslint");

    // The tool just updated the app's OWN manifest (msw, @playwright/test,
    // react-scan) exactly as it does for a real user's app: a real user's
    // suite works only after the post-regen install, so the fixture's must
    // take it too.
    await bunRun(["install"], app, "bun install (post-regen: the suite's dev deps)");

    // The HOST's own eslint, on its own flat config, over the two trees the
    // run wrote — directory form, so the config (not this test) decides what
    // is linted.
    const r = await eslintRun(eslintBin, ["src", "flawless", "--format", "json"], app);
    expect(r.code).toBe(EXPECTED_EXIT);
    const report = JSON.parse(r.out) as EslintFileReport[];

    // Non-vacuity first: the sweep must have reached the whole suite.
    const linted = new Set(report.map((f) => path.relative(app, f.filePath)));
    const missing = LINTED_REQUIRED.filter((rel) => !linted.has(rel));
    expect(missing).toEqual([]);

    const byRule: Record<string, number> = {};
    const errorFiles: Record<string, number> = {};
    const warnings: string[] = [];
    for (const f of report) {
      const rel = path.relative(app, f.filePath);
      if (f.errorCount > 0) errorFiles[rel] = f.errorCount;
      for (const m of f.messages) {
        if (m.severity === 2) {
          byRule[m.ruleId ?? "<fatal>"] = (byRule[m.ruleId ?? "<fatal>"] ?? 0) + 1;
        } else {
          warnings.push(`${rel} :: ${m.ruleId ?? "<fatal>"}`);
        }
      }
    }
    expect(byRule).toEqual(EXPECTED_BY_RULE);
    expect(errorFiles).toEqual(EXPECTED_ERROR_FILES);
    // Zero warnings, named if the set ever grows: a floating ^9 pin that
    // starts emitting a new warning class is a tripwire, not a surprise.
    expect(warnings).toEqual([]);
  }, 600_000);
});
