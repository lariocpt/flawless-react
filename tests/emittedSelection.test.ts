import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * What the real runners SELECT when handed the configs this tool emits.
 *
 * tests/emittedConfigs.test.ts imports each config with stubbed `vitest/config`
 * and `@playwright/test` and asserts on the object. That proves the paths
 * inside it resolve; it cannot prove the runner agrees, because both
 * `defineConfig`s are near-identity functions — a stub returning its argument
 * verbatim behaves exactly like the real one. Everything interesting happens
 * afterwards, when vitest or playwright applies `testDir`, `include` and
 * `testMatch` to a real directory.
 *
 * That gap is not theoretical. d47abbe was a `test:perf` script whose
 * positional filter named a directory the specs had been moved out of, so the
 * command selected NOTHING and `--run-tests` reported a correct suite as
 * failing. Every existing check passed: the config parsed, type-checked, and
 * loaded. Only asking playwright what it would run exposes it — and `--list`
 * does exactly that without needing a browser binary.
 *
 * So each case here asserts the selected spec files EQUAL the spec files the
 * same run emitted. Not "more than zero" — a config that silently widened to
 * the whole project would pass that, and the emitted configs sit inside a real
 * application whose own tests must not be swept up.
 */

const INSTALL_TIMEOUT_MS = 300_000;
const CASE_TIMEOUT_MS = 120_000;

const fixture = (rel: string): string => path.resolve(__dirname, "fixtures", rel);

/**
 * The runner versions to install, read out of the emitted package.json itself.
 *
 * Not a second list: the question this file asks is what the runners the SUITE
 * declares do with the configs the suite emits, so a hardcoded copy here could
 * drift from the suite and quietly start answering a different question.
 */
const SUITE_PINS: string[] = (() => {
  const { devDependencies } = JSON.parse(suitePackageJson("/x/flawless", true)) as {
    devDependencies: Record<string, string>;
  };
  return ["@playwright/test", "vitest", "jsdom"].map((name) => {
    const range = devDependencies[name];
    if (range === undefined) throw new Error(`the emitted suite no longer pins ${name}`);
    return `${name}@${range}`;
  });
})();

interface Suite {
  app: string;
  outDir: string;
}

/**
 * One generated suite with the real runners installed beside it.
 *
 * Cached: the install is the expensive part and every case reads the same tree.
 */
let suitePromise: Promise<Suite> | undefined;

function emittedSuite(): Promise<Suite> {
  suitePromise ??= (async (): Promise<Suite> => {
    const app = path.join(await mkdtemp(path.join(tmpdir(), "flawless-select-")), "app");
    await cp(fixture("nextapp"), app, { recursive: true });
    const outDir = path.join(app, "flawless");

    await runCore({
      pattern: path.join(app, "src", "app", "page.tsx"),
      outDir,
      taskIds: ["perf-harness", "unit-browser", "e2e"],
      nextjs: app,
      force: true,
      log: false,
      inlineSummary: false,
    });

    // The real packages, not stubs, AT THE RANGES THE EMITTED package.json
    // PINS. @playwright/test and vitest are ~2s each; jsdom is the slow one and
    // is needed because the emitted vitest config names it as the environment.
    // No browser binary is downloaded — `--list` resolves the config and
    // enumerates specs without launching anything.
    //
    // Unpinned, this installed whatever the registry served that morning, which
    // is both non-hermetic and the wrong question: the suite declares ^2.1.0, so
    // that is the vitest whose selection behaviour matters. It also broke CI —
    // unpinned resolved vitest 4, which dies during collection under the node
    // the Jenkinsfile installs (Debian trixie ships node 20.19, and vitest 4
    // hits `webidl.util.markAsUncloneable is not a function` there). Locally,
    // on node 26, it passed.
    const install = Bun.spawn(["bun", "add", "-d", ...SUITE_PINS], {
      cwd: app,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(install.stderr).text(), install.exited]);
    if (code !== 0) {
      throw new Error(
        "could not install the real test runners, so this file cannot check what they " +
          "select. It is deliberately not skipped: a skip here restores exactly the blind " +
          "spot d47abbe shipped through, where every check passed and the command selected " +
          `nothing. Needs network access to the registry.\n${stderr}`,
      );
    }
    return { app, outDir };
  })();
  return suitePromise;
}

/** Spec files sitting in a directory, which is what a config should select. */
function specsOnDisk(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((r) => r.split(path.sep).join("/"))
    .filter((r) => match.test(r))
    .sort();
}

/** Ask playwright what it would run, without running it. */
async function playwrightSelects(app: string, config: string): Promise<string[]> {
  const proc = Bun.spawn(
    ["bunx", "playwright", "test", "--config", config, "--list", "--reporter=json"],
    { cwd: app, stdout: "pipe", stderr: "pipe" },
  );
  const [out, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Selecting nothing is a non-zero exit with "No tests found" rather than an
  // empty list — which is worth knowing on its own, because it is how d47abbe
  // surfaced: the run failed, and the message blamed the suite rather than the
  // filter. Here it is a legitimate answer to the question, so it is reported
  // as the empty selection it is and left for the assertion to judge.
  const noTests = /No tests found/.test(out) || /No tests found/.test(stderr);
  if (code !== 0 && !noTests) {
    throw new Error(`playwright --list failed for ${config}:\n${stderr}\n${out}`);
  }
  if (noTests) return [];

  const files = new Set<string>();
  const walk = (suites: Array<{ file?: string; suites?: unknown }> | undefined): void => {
    for (const s of suites ?? []) {
      if (typeof s.file === "string") files.add(s.file);
      walk(s.suites as Array<{ file?: string }> | undefined);
    }
  };
  walk((JSON.parse(out) as { suites?: Array<{ file?: string }> }).suites);
  return [...files].sort();
}

/** The same question for vitest, invoked the way `flawless:unit` invokes it. */
async function vitestSelects(app: string, root: string): Promise<string[]> {
  const proc = Bun.spawn(["bunx", "vitest", "list", "--root", root], {
    cwd: app,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`vitest list failed for root ${root}:\n${stderr}\n${out}`);
  // Exit 0 is not enough. A vitest that dies inside its worker while collecting
  // prints "There were unhandled errors during test collection", writes nothing
  // to stdout, and STILL exits 0 — so the empty list below would be reported as
  // "the config selected nothing". That is indistinguishable from the answer
  // this file exists to detect, and it is worse in the other direction: the
  // guard-the-guard case expects an empty selection, so a crashed vitest makes
  // the one case written to prove the check can fail pass without checking
  // anything. Seen for real in CI, where an unpinned vitest 4 hit
  // `webidl.util.markAsUncloneable is not a function` under node 20.
  if (/unhandled errors during test collection/i.test(stderr)) {
    throw new Error(`vitest crashed while collecting for root ${root}:\n${stderr}`);
  }
  // Deliberately the opposite convention to playwrightSelects above, which
  // treats "No tests found" as a legitimate empty selection rather than an
  // error. The difference is in the runners, not in the intent: playwright
  // reports an empty selection by exiting NON-zero, so it has to be rescued to
  // be reported; vitest reports a CRASH by exiting zero, so it has to be caught
  // to not be mistaken for one. Making the two look alike would break one of
  // them.

  // `unit/HomePage.test.tsx > HomePage renders a <main>` — the path is the
  // token before the first " > ".
  const files = new Set<string>();
  for (const line of out.split("\n")) {
    const spec = line.split(" > ")[0]?.trim();
    if (spec !== undefined && /\.(m?tsx?)$/.test(spec)) files.add(spec);
  }
  return [...files].sort();
}

describe("the real runners select exactly the specs the run emitted", () => {
  beforeAll(async () => {
    await emittedSuite();
  }, INSTALL_TIMEOUT_MS);

  test(
    "the profile config selects the profile specs",
    async () => {
      const { app, outDir } = await emittedSuite();
      const onDisk = specsOnDisk(path.join(outDir, "profile"), /\.profile\.spec\.ts$/);
      // Not vacuous: the suite has to have emitted something for the comparison
      // to mean anything, and a rename should fail here rather than quietly
      // shrink both sides of the equality to nothing.
      expect(onDisk.length).toBeGreaterThan(0);

      expect(await playwrightSelects(app, "flawless/playwright.config.ts")).toEqual(onDisk);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "the browser config selects the browser specs, and not the profile ones",
    async () => {
      const { app, outDir } = await emittedSuite();
      const onDisk = specsOnDisk(path.join(outDir, "browser"), /\.spec\.ts$/);
      expect(onDisk.length).toBeGreaterThan(0);

      const selected = await playwrightSelects(app, "flawless/browser/playwright.config.ts");
      expect(selected).toEqual(onDisk);
      // Two playwright configs sit in one suite with different testDirs. If
      // either widened, the profile specs would run twice — once under a config
      // that does not boot their host.
      expect(selected.some((f) => f.includes(".profile."))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "the e2e config selects the route specs",
    async () => {
      const { app, outDir } = await emittedSuite();
      const onDisk = specsOnDisk(path.join(outDir, "e2e"), /\.spec\.ts$/);
      expect(onDisk.length).toBeGreaterThan(0);

      expect(await playwrightSelects(app, "flawless/e2e/playwright.config.ts")).toEqual(onDisk);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "vitest selects the unit specs, invoked as flawless:unit invokes it",
    async () => {
      const { app, outDir } = await emittedSuite();
      const onDisk = specsOnDisk(path.join(outDir, "unit"), /\.test\.tsx?$/).map(
        (f) => `unit/${f}`,
      );
      expect(onDisk.length).toBeGreaterThan(0);

      // --root flawless, which is what the declared script passes. Without it
      // vitest roots at the app and the include glob matches nothing — the
      // failure this file exists to catch, reached by dropping a flag rather
      // than by a wrong config.
      expect(await vitestSelects(app, "flawless")).toEqual(onDisk);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a config whose directory holds no specs selects nothing, and that is visible",
    async () => {
      // Guards the guard. Every case above would pass if --list always reported
      // the files the walk found, so point a real config at an empty directory
      // and require the emptiness to show. This is d47abbe's shape exactly:
      // a config naming somewhere the specs are not.
      const { app, outDir } = await emittedSuite();
      const empty = path.join(outDir, "no-specs-here");
      await Bun.write(path.join(empty, ".keep"), "");
      const config = path.join(outDir, "empty.config.ts");
      await Bun.write(
        config,
        'import { defineConfig } from "@playwright/test";\n' +
          'export default defineConfig({ testDir: "./no-specs-here" });\n',
      );

      expect(await playwrightSelects(app, path.relative(app, config))).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
});
