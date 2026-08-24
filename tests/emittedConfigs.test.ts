import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyse } from "../src/analyse/index.ts";
import { detectNextjs } from "../src/nextjs/detect.ts";
import { findTask } from "../src/tasks/index.ts";
import type { ComponentTree, NextjsContext, RunContext, TaskId } from "../src/types.ts";

/**
 * The emitted configs are LOADED, and the values they compute are checked
 * against the files the same run wrote.
 *
 * Every existing check on these is a substring: `toContain("root: projectRoot")`
 * proves the text is there, not that it resolves to a directory that exists.
 * Two shipped bugs lived in exactly that gap — vitest.config.ts hardcoded
 * `flawless/setup.ts` so any other --out pointed setupFiles at a file that was
 * never written, and the alias replacements were absolute paths naming the
 * machine that generated them.
 *
 * Loading them here is not identical to how vitest and playwright load them —
 * playwright transpiles its config to CJS. What is asserted is path resolution,
 * and `__dirname`, `import.meta.url` and `path.resolve` agree across both, so
 * the conclusions carry. Anything that depended on module format would not.
 */

const NEXTAPP = path.resolve(__dirname, "fixtures", "nextapp");

/**
 * A project with stub `vitest/config` and `@playwright/test` in node_modules.
 *
 * The real packages are not dependencies of this repo, and installing them to
 * read back a config object would make the test slow and network-bound. The
 * stubs return the config verbatim, which is all `defineConfig` does.
 */
function projectWithStubs(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "flawless-cfg-"));
  const vitest = path.join(root, "node_modules", "vitest");
  mkdirSync(vitest, { recursive: true });
  writeFileSync(
    path.join(vitest, "package.json"),
    JSON.stringify({ name: "vitest", version: "0.0.0", exports: { "./config": "./config.js" } }),
  );
  writeFileSync(path.join(vitest, "config.js"), "export const defineConfig = (c) => c;\n");

  const pw = path.join(root, "node_modules", "@playwright", "test");
  mkdirSync(pw, { recursive: true });
  writeFileSync(
    path.join(pw, "package.json"),
    JSON.stringify({ name: "@playwright/test", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(
    path.join(pw, "index.js"),
    "export const defineConfig = (c) => c;\nexport const devices = new Proxy({}, { get: () => ({}) });\n",
  );
  return root;
}

const load = async (file: string): Promise<Record<string, unknown>> => {
  expect(existsSync(file), `${path.basename(file)} was emitted`).toBe(true);
  // Cache-bust: several cases load configs of the same name from different dirs.
  const mod = (await import(`${pathToFileURL(file).href}?t=${Math.random()}`)) as {
    default: Record<string, unknown>;
  };
  return mod.default;
};

function ctxOf(over: Partial<RunContext> & { outDir: string }): RunContext {
  return {
    trees: [],
    variants: 3,
    heaps: "stress",
    force: false,
    report: false,
    provider: undefined,
    apiSpec: undefined,
    inlineSummary: false,
    nextjs: undefined,
    ...over,
  };
}

const run = async (id: TaskId, ctx: RunContext): Promise<void> => {
  const t = findTask(id);
  if (!t) throw new Error(`task not registered: ${id}`);
  const r = await t.run(ctx);
  if (!r.ok) throw new Error(`${id} failed: ${r.error ?? r.summary}`);
};

const toolbar = (): Promise<ComponentTree> =>
  analyse({
    entry: path.resolve(__dirname, "fixtures", "Toolbar.tsx"),
    depth: 0,
    includeChildren: false,
  });

/**
 * The same component, but living INSIDE the temp project.
 *
 * --colocate writes `<name>.flawless.test.tsx` beside the source it analysed.
 * Pointed at tests/fixtures it writes into this repo, which a test must never
 * do — the first run of this file left a stray spec in the fixtures directory.
 */
async function toolbarInside(root: string): Promise<ComponentTree> {
  const src = path.join(root, "src");
  mkdirSync(src, { recursive: true });
  const entry = path.join(src, "Toolbar.tsx");
  writeFileSync(entry, readFileSync(path.resolve(__dirname, "fixtures", "Toolbar.tsx"), "utf8"));
  return analyse({ entry, depth: 0, includeChildren: false });
}

/**
 * Every emitted unit spec is matched by at least one of the config's globs.
 *
 * Asserting the glob's TEXT — that it starts with the out dir, that it contains
 * "unit" — passes for a glob that matches nothing, which is the failure worth
 * catching: vitest then reports "no test files found" and a green run means the
 * suite never executed. Globs are resolved against `root`, as vitest resolves
 * them.
 */
function expectEverySpecSelected(globRoot: string, searchDirs: string[], globs: string[]): void {
  const specs: string[] = [];
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
      if (!/\.test\.tsx?$/.test(rel)) continue;
      specs.push(path.relative(globRoot, path.join(dir, rel)));
    }
  }
  expect(specs.length, "the run emitted specs for the globs to select").toBeGreaterThan(0);

  const matchers = globs.map((g) => new Bun.Glob(g));
  for (const spec of specs) {
    const posix = spec.split(path.sep).join("/");
    expect(
      matchers.some((m) => m.match(posix)),
      `${posix} is selected by one of: ${globs.join(", ")}`,
    ).toBe(true);
  }
}

describe("the emitted vitest config resolves to files that exist", () => {
  test("setupFiles points at the setup.ts the same run wrote — under a NON-default out dir", async () => {
    // The bug: setupFiles was `path.join(projectRoot, "flawless/setup.ts")`, a
    // hardcoded directory name. With --out .flawless (the standalone default)
    // or any other name, vitest died at startup on a missing setup file. Every
    // existing assertion used the literal `flawless`, so none of them saw it.
    const root = projectWithStubs();
    const outDir = path.join(root, ".flawless");
    const trees = [await toolbarInside(root)];
    await run("unit-browser" as TaskId, ctxOf({ outDir, trees, colocate: true }));

    const cfg = await load(path.join(outDir, "vitest.config.mts"));
    const test = cfg.test as { setupFiles: string[]; include: string[] };

    expect(path.isAbsolute(test.setupFiles[0] as string)).toBe(true);
    expect(existsSync(test.setupFiles[0] as string), "setupFiles target exists").toBe(true);
    expect(cfg.root).toBe(root);
    // Run the globs, do not eyeball their prefix. `startsWith(".flawless/")`
    // passes for a glob that selects nothing — the property is that every spec
    // this run emitted is reachable from the config it emitted beside them.
    // Colocate roots vitest at the project and writes specs beside the source.
    expectEverySpecSelected(root, [path.join(root, "src"), outDir], test.include);
  });

  test("the default out dir resolves too, so the fix did not just move the hardcoding", async () => {
    const root = projectWithStubs();
    const outDir = path.join(root, "flawless");
    const trees = [await toolbarInside(root)];
    await run("unit-browser" as TaskId, ctxOf({ outDir, trees, colocate: true }));

    const cfg = await load(path.join(outDir, "vitest.config.mts"));
    const test = cfg.test as { setupFiles: string[] };
    expect(existsSync(test.setupFiles[0] as string)).toBe(true);
    expect(cfg.root).toBe(root);
  });

  test("without --colocate the globs still select the specs, which colocate never exercises", async () => {
    // The two branches emit DIFFERENT include globs, and the colocate case above
    // cannot reach this one: colocate writes specs beside the source, so
    // `<out>/unit/**` matches nothing there and a break in it passes unnoticed.
    // Found exactly that way — changing the glob to *.spec left the suite green.
    const root = projectWithStubs();
    const outDir = path.join(root, "flawless");
    await run("unit-browser" as TaskId, ctxOf({ outDir, trees: [await toolbar()] }));

    // .mts, not .ts: the non-colocate branch emits the ESM extension. The two
    // branches differ in filename as well as content, which is itself a reason
    // a check written against one of them proves nothing about the other.
    const cfg = await load(path.join(outDir, "vitest.config.mts"));
    const test = cfg.test as { include: string[] };
    // No explicit root in this branch: vitest roots at the config's directory.
    expectEverySpecSelected(outDir, [outDir], test.include);
  });

  test("every resolve alias points at a path that exists", async () => {
    // These were absolute paths into the generating machine's node_modules. On
    // a checkout rooted elsewhere the suite could not resolve React at all.
    const root = projectWithStubs();
    const outDir = path.join(root, "flawless");
    const nextjs: NextjsContext = await detectNextjs(NEXTAPP);
    await run("unit-browser" as TaskId, ctxOf({ outDir, trees: [await toolbar()], nextjs }));

    const cfg = await load(path.join(outDir, "vitest.config.mts"));
    const resolve = cfg.resolve as { alias?: Array<{ replacement: string }> };
    const aliases = resolve.alias ?? [];
    expect(aliases.length, "the fixture produced aliases to check").toBeGreaterThan(0);
    for (const a of aliases) {
      expect(path.isAbsolute(a.replacement), `${a.replacement} is absolute after resolution`).toBe(
        true,
      );
      expect(existsSync(a.replacement.replace(/\/$/, "")), `${a.replacement} exists`).toBe(true);
    }
  });
});

describe("the emitted playwright configs select the specs the same run wrote", () => {
  test("the profile config's testDir holds the emitted profile specs", async () => {
    const root = projectWithStubs();
    const outDir = path.join(root, "flawless");
    await run("perf-harness" as TaskId, ctxOf({ outDir, trees: [await toolbar()] }));

    const cfg = await load(path.join(outDir, "playwright.config.ts"));
    const testDir = path.resolve(outDir, cfg.testDir as string);
    expect(existsSync(testDir), `${cfg.testDir} exists`).toBe(true);
    expect(existsSync(path.join(testDir, "Toolbar.profile.spec.ts"))).toBe(true);
    // Traces and the json reporter stay inside the suite rather than the repo
    // root — as a RELATIVE path, which playwright resolves against the config
    // file in both module systems. An absolute __dirname anchor died at
    // import under the "type":"module" ESM loader (FR-022).
    expect(path.isAbsolute(cfg.outputDir as string)).toBe(false);
    expect((cfg.outputDir as string).startsWith("..")).toBe(false);
    expect(path.resolve(outDir, cfg.outputDir as string).startsWith(outDir)).toBe(true);
  });

  test("the e2e config's webServer.cwd is the project root, not an absolute stranger", async () => {
    const root = projectWithStubs();
    const outDir = path.join(root, "flawless");
    mkdirSync(path.join(root, "app"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "target", scripts: { dev: "next dev -p 3123" } }),
    );
    const nextjs: NextjsContext = { root, router: "app", appResolver: undefined, apiRoutes: [] };
    await run("e2e" as TaskId, ctxOf({ outDir, trees: [], nextjs }));

    const cfg = await load(path.join(outDir, "e2e", "playwright.config.ts"));
    const web = cfg.webServer as { cwd: string; url: string } | undefined;
    expect(web, "webServer is configured when no base URL override is set").toBeDefined();
    expect(path.resolve((web as { cwd: string }).cwd)).toBe(root);
    expect(existsSync((web as { cwd: string }).cwd)).toBe(true);
    // The port came from the target's own dev script, so the server it waits
    // for is the one the project starts.
    expect((web as { url: string }).url).toContain("3123");
  });

  test("the browser config's testDir holds the emitted browser specs", async () => {
    const root = projectWithStubs();
    const outDir = path.join(root, "flawless");
    await run("unit-browser" as TaskId, ctxOf({ outDir, trees: [await toolbar()] }));

    const cfg = await load(path.join(outDir, "browser", "playwright.config.ts"));
    const dir = path.resolve(path.join(outDir, "browser"), cfg.testDir as string);
    expect(existsSync(dir), `${cfg.testDir} exists`).toBe(true);
    expect(existsSync(path.join(dir, "Toolbar.spec.ts"))).toBe(true);
  });
});
