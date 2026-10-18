import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { relativeToEmitted } from "../src/emitPaths.ts";
import { ignoreEntries, ignoreRootFor } from "../src/nextjs/detect.ts";
import { renderSuite } from "../src/scaffold/templates.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import { e2eRoutes } from "../src/tasks/e2eRoutes.ts";

/**
 * No file the tool writes may contain the path of the machine that wrote it.
 *
 * Generated files are committed, and the same repository lives under different
 * roots on different machines — /home/lario/Projects/… on two, /mnt/data/… on a
 * third. Three files broke this and the consequences were not cosmetic:
 *
 *  - vitest.config.ts aliased react and react-dom into a node_modules path that
 *    exists on one machine, so the committed suite could not resolve React
 *    anywhere else.
 *  - host/server.ts keyed its server-action stubs by absolute path, so on any
 *    other checkout every stub misses and pg + nodemailer go back into the
 *    browser bundle — which fails the whole bundle, not one spec.
 *  - e2e/playwright.config.ts pointed webServer.cwd at a directory that is not
 *    there.
 *
 * A peer session established the principle for REPORT.md's reproduce-command.
 * This widens it to everything, which is where it should have been: the
 * reproduce-command was the one place someone happened to look.
 *
 * The sentinel is fed IN deliberately. With ordinary fixtures these code paths
 * are empty — no aliases, no server actions — and a test that only rendered the
 * defaults would pass while proving nothing.
 */

const SENTINEL = "/sentinel-machine-root/checkout";
const tmpDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), "flawless-paths-"));

/** Lines carrying the sentinel, with their file, for a readable failure. */
function leaks(files: Array<{ relPath: string; content: string }>): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const [i, line] of f.content.split("\n").entries()) {
      if (line.includes(SENTINEL)) out.push(`${f.relPath}:${i + 1}: ${line.trim()}`);
    }
  }
  return out;
}

describe("relativeToEmitted", () => {
  test("walks up out of the emitted file's directory", () => {
    expect(relativeToEmitted("/a/b/flawless", "/a/b/src")).toBe("../src");
    expect(relativeToEmitted("/a/b/flawless/host", "/a/node_modules/react")).toBe(
      "../../../node_modules/react",
    );
  });

  test("the directory itself is '.', not the empty string", () => {
    // "" would make path.resolve(dir, "") return the cwd, silently.
    expect(relativeToEmitted("/a/b", "/a/b")).toBe(".");
  });

  test("always POSIX-separated, so the bytes do not depend on the OS", () => {
    expect(relativeToEmitted("/a/b/c", "/a/x/y")).not.toContain("\\");
  });
});

describe("no emitted file names the machine that generated it", () => {
  test("vitest aliases — the react pins that broke resolution elsewhere", async () => {
    const files = renderUnitBrowser({
      trees: [await analyse({ entry: fixture("Card.tsx"), depth: 0, includeChildren: false })],
      outDir: `${SENTINEL}/app/flawless`,
      variants: 3,
      resolveAliases: [
        { find: "@/", replacement: `${SENTINEL}/app/src`, prefix: true },
        { find: "react", replacement: `${SENTINEL}/node_modules/react`, prefix: false },
      ],
    });
    expect(leaks(files)).toEqual([]);
    const cfg = files.find((f) => f.relPath === "vitest.config.mts")?.content ?? "";
    // Still absolute at RUNTIME — that is what Vite needs; only the bytes change.
    expect(cfg).toContain("path.resolve(configDir,");
  });

  test("vitest aliases in colocate mode too", async () => {
    const files = renderUnitBrowser({
      trees: [await analyse({ entry: fixture("Card.tsx"), depth: 0, includeChildren: false })],
      outDir: `${SENTINEL}/app/flawless`,
      variants: 3,
      colocate: true,
      resolveAliases: [{ find: "react", replacement: `${SENTINEL}/nm/react`, prefix: false }],
    });
    // Colocated specs are written beside the source, so absPath is legitimately
    // absolute — the check is on file CONTENT, which is what gets committed.
    expect(leaks(files)).toEqual([]);
  });

  test("the server-action stub map", async () => {
    const files = renderSuite({
      tree: await analyse({
        entry: fixture("actions/PostForm.tsx"),
        depth: 1,
        includeChildren: true,
      }),
      outDir: `${SENTINEL}/app/flawless`,
      variants: 3,
      report: false,
    });
    expect(leaks(files)).toEqual([]);
  });

  test("even when the stub map is populated by hand", () => {
    // PostForm may not carry a "use server" import in every checkout, so drive
    // the emitter directly too — otherwise this test could quietly stop
    // exercising the branch it exists for.
    const files = renderSuite({
      tree: {
        entry: {
          componentName: "X",
          filePath: `${SENTINEL}/app/src/X.tsx`,
          importSpecifier: "./X",
          propsShape: {},
          variants: [],
          hooks: [],
          unresolvedProps: [],
          exportKind: "named",
          isAsync: false,
          moduleImports: [
            {
              specifier: "./actions",
              names: ["doThing"],
              kind: "value",
              isTypeOnly: false,
              hasDefault: false,
              resolvedPath: `${SENTINEL}/app/src/actions.ts`,
              isServerAction: true,
              serverActionExports: ["doThing"],
              pos: { file: `${SENTINEL}/app/src/X.tsx`, line: 1, column: 1 },
            },
          ],
        },
        children: [],
      } as never,
      outDir: `${SENTINEL}/app/flawless`,
      variants: 3,
      report: false,
    });
    const server = files.find((f) => f.relPath === "host/server.ts")?.content ?? "";
    expect(server).toContain("SERVER_STUB_SOURCES");
    expect(server).toContain("path.resolve(HOST_DIR,");
    expect(leaks(files)).toEqual([]);
  });

  test("the e2e playwright config's webServer cwd", async () => {
    // The suite lives INSIDE the project, which is the geometry that matters:
    // <root>/flawless/e2e/ back to <root> is "../..", naming nothing. (Point
    // --out at an unrelated directory and the relative path must of course walk
    // through real directory names — but then it is fragile whatever we emit,
    // because the two trees can move independently.)
    const root = await tmpDir();
    const outDir = path.join(root, "flawless");
    const result = await e2eRoutes.run({
      trees: [],
      outDir,
      variants: 3,
      heaps: "stress",
      force: true,
      report: false,
      provider: undefined,
      apiSpec: undefined,
      inlineSummary: false,
      json: false,
      changed: undefined,
      nextjs: { root, router: "app", apiRoutes: [], appResolver: undefined },
    } as never);
    expect(result.ok).toBe(true);
    const cfg = await Bun.file(path.join(outDir, "e2e", "playwright.config.ts")).text();
    expect(cfg).not.toContain(root);
    expect(cfg).toContain('cwd: path.resolve(__dirname, "../..")');
  });

  test("the check itself rejects a leak", () => {
    // Guards the guard: every assertion above is a `.toEqual([])`, which is
    // exactly what a broken detector also returns.
    expect(leaks([{ relPath: "x.ts", content: `const a = "${SENTINEL}/b";` }])).toEqual([
      `x.ts:1: const a = "${SENTINEL}/b";`,
    ]);
  });
});

function fixture(rel: string): string {
  return path.resolve(__dirname, "fixtures", rel);
}

describe("standalone emissions never use __dirname", () => {
  test("every suite and unit file is loader-neutral", async () => {
    // A "type":"module" suite is loaded as ESM, where __dirname does not
    // exist: the browser config died at import and the profile spec's heap
    // writer threw mid-run (FR-022, found on first real execution). Relative
    // config paths and the runtime FullConfig.rootDir are the loader-neutral
    // anchors. The e2e emitter is exempt BY LOCATION, not by grace: its
    // config needs an absolute use.storageState (cwd-relative otherwise) and
    // only ever lands in Next.js projects, where playwright's CJS transpile
    // defines __dirname — it never ships in a standalone suite.
    const tree = await analyse({
      entry: fixture("actions/PostForm.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const files = [
      ...renderSuite({ tree, outDir: `${SENTINEL}/app/flawless`, variants: 3, report: true }),
      ...renderUnitBrowser({
        trees: [tree],
        outDir: `${SENTINEL}/app/flawless`,
        variants: 3,
        browserSpecs: true,
      }),
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      if (!/\.(m?tsx?)$/.test(f.relPath)) continue;
      expect(f.content.includes("__dirname"), `${f.relPath} uses __dirname`).toBe(false);
    }
  });
});

describe("the profile heap dir anchors on the CONFIG FILE, never rootDir", () => {
  test("the emitted spec derives heaps/ from configFile — rootDir is the resolved testDir", async () => {
    // Playwright computes FullConfig.rootDir as resolve(configDir, testDir):
    // with the perf config's testDir "./profile", rootDir is the PROFILE dir,
    // and a rootDir-anchored heap writer put snapshots in profile/heaps/ —
    // outside the emitted .gitignore's <out>/heaps/ entry, the 566MB class
    // all over again. configFile is the config's own path in both loaders.
    const tree = await analyse({
      entry: fixture("actions/PostForm.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const files = renderSuite({
      tree,
      outDir: `${SENTINEL}/app/flawless`,
      variants: 3,
      report: true,
    });
    const heap = files.find((f) => f.relPath === "profile/_heap.ts");
    expect(heap).toBeDefined();
    const content = heap?.content ?? "";
    expect(content).toContain("configFile");
    expect(content).not.toContain("config.rootDir, HEAPS_DIR");
  });
});

describe("a dotted-mock conflict still gets the RSC skip escape", () => {
  test("certain-shaped conflicting deps crash on the {} fallback — that must skip, not fail", () => {
    // The fallback mocks the binding as vi.fn(async () => ({})); db.query is
    // then undefined at runtime. With CERTAIN dep shapes nothing set
    // d.uncertain, so the escape vanished and correct code failed red —
    // FR-014's exact failure mode, confined to the conflict shapes.
    const certainShape = {
      kind: "array",
      element: {
        kind: "object",
        fields: [{ name: "name", shape: { kind: "string" }, rendersAsText: true }],
      },
    } as const;
    const dep = (callee: string, varName: string) => ({
      varName,
      callee,
      calleeRoot: "db",
      specifier: "@/lib/db",
      awaited: true,
      shape: certainShape,
      uncertain: false,
      pos: { file: "/proj/src/Page.tsx", line: 3, column: 1 },
    });
    const files = renderUnitBrowser({
      trees: [
        {
          entry: {
            componentName: "MixPanel",
            filePath: "/proj/src/MixPanel.tsx",
            importSpecifier: "./MixPanel.tsx",
            propsShape: {},
            variants: [],
            hooks: [],
            unresolvedProps: [],
            exportKind: "default",
            isAsync: true,
            renderMode: "rsc",
            moduleImports: [
              {
                specifier: "@/lib/db",
                names: ["db"],
                kind: "value",
                isTypeOnly: false,
                hasDefault: false,
                pos: { file: "/proj/src/MixPanel.tsx", line: 1, column: 1 },
              },
            ],
            dataDeps: [dep("db", "conn"), dep("db.query.users.findMany", "rows")],
          },
          children: [],
        } as never,
      ],
      outDir: `${SENTINEL}/app/flawless`,
      variants: 1,
      browserSpecs: false,
    });
    const spec = files.find((f) => f.relPath === "unit/MixPanel.test.tsx")?.content ?? "";
    expect(spec).toContain("db: vi.fn(async () => ({}))");
    expect(spec).toContain("data fixture missing");
  });
});

/**
 * A path an emitted file hands the reader must be a path that exists.
 *
 * The <Component>.flawless.json sidecar carries a `reports` map, and two of its
 * three entries named `reports/<Component>.a11y.json` and
 * `reports/<Component>.react-rules.json` — files no run has ever written, because
 * both of those tasks are SWEEPS that emit one aggregate for the whole run. The
 * sidecar had no test at all, so the wrong names survived every round and were
 * then copied into the published docs, which is how the website came to promise
 * per-component a11y reports.
 *
 * Checked against a real run rather than against the constants, so that renaming
 * an aggregate without updating the pointer fails here.
 */
describe("the inline sidecar points at files that exist", () => {
  test("every path in a sidecar's reports map was actually written", async () => {
    const dir = await tmpDir();
    const app = path.join(dir, "app");
    await Bun.$`cp -r ${path.join(import.meta.dir, "fixtures", "nextapp")} ${app}`.quiet();
    const proc = Bun.spawn(
      [
        "bun",
        path.join(import.meta.dir, "..", "src", "bin.ts"),
        path.join(app, "src/app/**/page.tsx"),
        "--nextjs",
        app,
        "--ci",
        "--tasks",
        "perf-static,a11y,react-rules",
      ],
      { stdout: "pipe", stderr: "pipe", cwd: dir },
    );
    await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    const found = (await Bun.$`find ${app} -name ${"*.flawless.json"}`.quiet().text())
      .trim()
      .split("\n");
    // Without this the test passes by finding no sidecar to check.
    expect(found.filter(Boolean).length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const sidecar of found) {
      const body = JSON.parse(await Bun.file(sidecar).text()) as {
        file: string;
        reports: Record<string, string>;
      };
      expect(Object.keys(body.reports).length).toBeGreaterThan(0);
      for (const [key, target] of Object.entries(body.reports)) {
        // Relative to the sidecar, never to the machine that wrote it: this file
        // is committed, so an absolute path in it names a developer's home
        // directory and resolves nowhere on any other checkout.
        expect(path.isAbsolute(target)).toBe(false);
        const abs = path.resolve(path.dirname(sidecar), target);
        if (!(await Bun.file(abs).exists())) missing.push(`${key} -> ${target}`);
      }
      // The analysed source is a path too, and was absolute for the same reason.
      expect(path.isAbsolute(body.file)).toBe(false);
      expect(await Bun.file(path.resolve(path.dirname(sidecar), body.file)).exists()).toBe(true);
    }
    expect(missing.join("\n")).toBe("");
  });
});

/**
 * A run must ignore what it generates, in EVERY mode.
 *
 * updateGitignore was reached only from the Next.js branch, so a plain
 * `flawless-react "src/**\/*.tsx"` run ignored nothing at all — not reports/,
 * not heaps/, not playwright-report/, and not e2e/.auth.json, which the emitted
 * global-setup itself describes as session cookies staged for commit. One run
 * in a fresh repo left 28 generated files untracked and unignored.
 */
describe("generated output is ignored outside Next.js mode too", () => {
  test("the ignore root is the git root, then a package, then the out dir's parent", async () => {
    const root = await tmpDir();
    const nested = path.join(root, "a", "b", "flawless");
    await Bun.$`mkdir -p ${nested}`.quiet();

    // Nothing to anchor on: the out dir's parent, so something is ignored.
    expect(ignoreRootFor(nested)).toBe(path.join(root, "a", "b"));

    // A package that is not a repository.
    await Bun.write(path.join(root, "a", "package.json"), "{}");
    expect(ignoreRootFor(nested)).toBe(path.join(root, "a"));

    // A repository outranks it — that is where git reads a repo-wide ignore
    // and where the user's existing one already is.
    await Bun.$`mkdir -p ${path.join(root, ".git")}`.quiet();
    expect(ignoreRootFor(nested)).toBe(root);
  });

  test("both modes ignore the same set", () => {
    // Two call sites composing their own lists is precisely how one of them
    // came to ignore nothing.
    expect(ignoreEntries("flawless")).toEqual([
      "flawless/reports/",
      "flawless/heaps/",
      "flawless/playwright-report/",
      "flawless/node_modules/",
      "flawless/test-results/",
      "flawless/browser/test-results/",
      "flawless/e2e/test-results/",
      "flawless/e2e/.auth.json",
      "flawless/load/last-*.json",
      "*.flawless.json",
    ]);
  });

  test("a non-default --out is honoured, not assumed to be flawless/", () => {
    const entries = ignoreEntries("qa");
    expect(entries).toContain("qa/e2e/.auth.json");
    expect(entries).toContain("qa/heaps/");
    expect(entries.some((e) => e.startsWith("flawless/"))).toBe(false);
    // The sidecar pattern is not under the out dir, so it stays literal.
    expect(entries).toContain("*.flawless.json");
  });

  test("a dot-named out dir negates itself, first", () => {
    // `.*` in the app's .gitignore is the saleor-dashboard case: the whole
    // generated suite invisible to git. The negation must come before the
    // byproduct entries, which still ignore what they always did.
    expect(ignoreEntries(".flawless")).toEqual([
      "!.flawless/",
      ".flawless/reports/",
      ".flawless/heaps/",
      ".flawless/playwright-report/",
      ".flawless/node_modules/",
      ".flawless/test-results/",
      ".flawless/browser/test-results/",
      ".flawless/e2e/test-results/",
      ".flawless/e2e/.auth.json",
      ".flawless/load/last-*.json",
      "*.flawless.json",
    ]);
    // A nested dot dir is negated relative to the ignore root, like every entry.
    expect(ignoreEntries("apps/web/.flawless")[0]).toBe("!apps/web/.flawless/");
    // Not a dot dir, nothing to negate; and an out dir that IS the project root
    // ("." per outDirRel) is not a dot-named directory, so it must not emit `!./`.
    expect(ignoreEntries("flawless")[0]).toBe("flawless/reports/");
    expect(ignoreEntries(".")).toEqual([
      "reports/",
      "heaps/",
      "playwright-report/",
      "node_modules/",
      "test-results/",
      "browser/test-results/",
      "e2e/test-results/",
      "e2e/.auth.json",
      "load/last-*.json",
      "*.flawless.json",
    ]);
  });

  test("a run in a repo that ignores `.*` still leaves a committable suite", async () => {
    const root = await tmpDir();
    await Bun.$`cp -r ${path.join(import.meta.dir, "fixtures", "nextapp")} ${path.join(root, "app")}`.quiet();
    const app = path.join(root, "app");
    await Bun.$`git init -q ${app}`.quiet();
    await Bun.write(path.join(app, ".gitignore"), ".*\nnode_modules\n");

    const proc = Bun.spawn(
      [
        "bun",
        path.join(import.meta.dir, "..", "src", "bin.ts"),
        "src/**/*.tsx",
        "--ci",
        "--tasks",
        "perf-static,perf-harness",
      ],
      { stdout: "pipe", stderr: "pipe", cwd: app },
    );
    await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    // Git's opinion, again, and with -uall so an invisible directory cannot hide
    // behind a collapsed `?? .flawless/` line.
    const visible = await Bun.$`git -C ${app} status --short -uall`.quiet().text();
    expect(visible).toContain(".flawless/playwright.config.ts");
    expect(visible).toContain(".flawless/profile/");
    // The byproducts are still ignored, with the negation sitting earlier in the
    // same block: last match wins, and it never matched the contents anyway.
    const ignored = await Bun.$`git -C ${app} status --short -uall --ignored=matching`
      .quiet()
      .text();
    expect(
      ignored.split("\n").filter((l) => l.startsWith("!! .flawless/reports/")).length,
    ).toBeGreaterThan(0);
  });

  test("a real non-Next run writes them, and leaks no report, heap, auth file or sidecar", async () => {
    const root = await tmpDir();
    await Bun.$`cp -r ${path.join(import.meta.dir, "fixtures", "nextapp")} ${path.join(root, "app")}`.quiet();
    const app = path.join(root, "app");
    await Bun.$`git init -q ${app}`.quiet();
    await Bun.write(path.join(app, ".gitignore"), "node_modules\n");

    const proc = Bun.spawn(
      [
        "bun",
        path.join(import.meta.dir, "..", "src", "bin.ts"),
        "src/**/*.tsx",
        "--ci",
        "--tasks",
        "perf-static,perf-harness",
      ],
      { stdout: "pipe", stderr: "pipe", cwd: app },
    );
    await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    const gi = await Bun.file(path.join(app, ".gitignore")).text();
    for (const entry of ignoreEntries(".flawless")) expect(gi).toContain(entry);

    // The check that matters is git's opinion, not the file's contents.
    await Bun.$`git -C ${app} add -A`.quiet();
    const staged = await Bun.$`git -C ${app} status --short`.quiet().text();
    const leaked = staged
      .split("\n")
      .filter((l) => /reports\/|heaps\/|\.auth\.json|\.flawless\.json|test-results/.test(l));
    expect(leaked.join("\n")).toBe("");
    // ...and it did not over-ignore: the suite's own sources are still staged.
    expect(staged).toContain("playwright.config.ts");
  });
});
