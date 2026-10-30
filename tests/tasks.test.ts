import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { globalSetupStubForTest } from "../src/tasks/e2eRoutes.ts";
import { ALL_TASK_IDS, findTask, TASKS } from "../src/tasks/index.ts";
import type {
  ComponentTree,
  FetchCallInfo,
  NextjsContext,
  RunContext,
  Task,
  TaskId,
} from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures");

const EXPECTED_IDS: TaskId[] = [
  "perf-harness",
  "unit-browser",
  "perf-static",
  "a11y",
  "react-rules",
  "e2e",
  "load",
];

const created: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `flawless-${prefix}-`));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function task(id: TaskId): Task {
  const t = findTask(id);
  if (!t) throw new Error(`task not registered: ${id}`);
  return t;
}

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

/** A hand-built NextjsContext over a temp dir carrying package.json + app/. */
function nextProject(devScript: string): NextjsContext {
  const root = tmp("next");
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "target-app", scripts: { dev: devScript } }, null, 2)}\n`,
  );
  mkdirSync(path.join(root, "app"), { recursive: true });
  return { root, router: "app", appResolver: undefined, apiRoutes: [] };
}

/** Write a real page file under the project's app/ dir and return its path. */
function writePage(nextjs: NextjsContext, relDir: string): string {
  const dir = path.join(nextjs.root, "app", relDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "page.tsx");
  writeFileSync(file, "export default function Page() {\n  return <main />;\n}\n");
  return file;
}

function withFilePath(tree: ComponentTree, filePath: string): ComponentTree {
  return { ...tree, entry: { ...tree.entry, filePath } };
}

function withFetchCalls(tree: ComponentTree, fetchCalls: FetchCallInfo[]): ComponentTree {
  return { ...tree, entry: { ...tree.entry, fetchCalls } };
}

function fetchCall(method: string, urlTemplate: string, holes: string[] = []): FetchCallInfo {
  return {
    urlTemplate,
    holes,
    method,
    pos: { file: "/proj/app/page.tsx", line: 1, column: 1 },
    inEffect: true,
  };
}

const toolbarTree = (): Promise<ComponentTree> =>
  analyse({ entry: path.join(FIXTURES, "Toolbar.tsx"), depth: 0, includeChildren: false });

describe("task registry", () => {
  test("TASKS / findTask / ALL_TASK_IDS agree on the 7 registered tasks", () => {
    expect(TASKS).toHaveLength(7);
    expect(TASKS.map((t) => t.id)).toEqual(EXPECTED_IDS);
    expect(ALL_TASK_IDS).toEqual(EXPECTED_IDS);
    expect(ALL_TASK_IDS).toEqual(TASKS.map((t) => t.id));

    for (const id of EXPECTED_IDS) {
      const t = findTask(id);
      expect(t).toBeDefined();
      expect(t?.id).toBe(id);
      expect(typeof t?.run).toBe("function");
      expect(typeof t?.label).toBe("string");
      expect((t?.label ?? "").length).toBeGreaterThan(0);
      expect((t?.description ?? "").length).toBeGreaterThan(0);
    }
    expect(findTask("not-a-task" as TaskId)).toBeUndefined();
  });
});

describe("unit-browser task", () => {
  test("emits vitest.config.mts + setup.ts + one unit spec per analysed component", async () => {
    const outDir = tmp("unit-out");
    const tree = await analyse({
      entry: path.join(FIXTURES, "Dashboard.tsx"),
      depth: 3,
      includeChildren: true,
    });
    const result = await task("unit-browser").run(ctxOf({ outDir, trees: [tree] }));

    expect(result.id).toBe("unit-browser");
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.findings).toEqual([]);

    expect(result.outputs).toContain(path.join(outDir, "vitest.config.mts"));
    expect(result.outputs).toContain(path.join(outDir, "setup.ts"));
    for (const name of ["Dashboard", "Hello", "Card"]) {
      const spec = path.join(outDir, "unit", `${name}.test.tsx`);
      expect(result.outputs).toContain(spec);
      expect(existsSync(spec)).toBe(true);
    }
    expect(existsSync(path.join(outDir, "vitest.config.mts"))).toBe(true);

    expect(result.summary).toContain("3 component(s)");
    for (const name of ["Dashboard", "Hello", "Card"]) {
      expect(result.summary).toContain(name);
    }
  });

  test("React Native components get no DOM spec, and the summary says why", async () => {
    // The bare-RN dogfood (ospfranco/sol) is the reason this test exists: 16
    // specs emitted, 16 collect failures — `SyntaxError: Unexpected token
    // 'typeof'` from react-native's Flow source — and zero tests ever ran. A
    // suite that cannot report anything is worse than no suite, and the native
    // plane is --expo, which refuses a non-Expo project by design.
    const outDir = tmp("unit-native");
    const screen = await analyse({
      entry: path.join(FIXTURES, "expoapp", "app", "(tabs)", "index.tsx"),
      depth: 3,
      includeChildren: true,
    });
    const result = await task("unit-browser").run(ctxOf({ outDir, trees: [screen] }));

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual([]);
    expect(result.summary).toContain("React Native");
    expect(existsSync(path.join(outDir, "unit"))).toBe(false);
  });

  test("a DOM component is still tested when a sibling tree is React Native", async () => {
    // The exclusion is per tree, not per run: a monorepo swept in one pass has
    // apps/web and apps/mobile in it, and refusing everything would be the same
    // mistake in the other direction. Named, never silent.
    const outDir = tmp("unit-mixed");
    const screen = await analyse({
      entry: path.join(FIXTURES, "expoapp", "app", "(tabs)", "index.tsx"),
      depth: 3,
      includeChildren: true,
    });
    const result = await task("unit-browser").run(
      ctxOf({ outDir, trees: [await toolbarTree(), screen] }),
    );

    expect(result.ok).toBe(true);
    expect(result.outputs).toContain(path.join(outDir, "unit", "Toolbar.test.tsx"));
    expect(result.summary).toContain("React Native component(s) skipped");
  });

  test("a unit spec with no component behind it is named, and kept", async () => {
    // The runner takes `unit/**/*.test.tsx` from the DIRECTORY, not from what
    // this run analysed, so a spec an earlier run left behind still executes —
    // against a component that may be renamed, refactored, or gone. Reported,
    // never deleted: an in-outDir spec carries no stamp, so a hand-hardened one
    // is byte-identical to an orphan, and silently dropping specs is how a
    // suite's coverage evaporates without anyone deciding to.
    const outDir = tmp("unit-orphan");
    const tree = await analyse({
      entry: path.join(FIXTURES, "Dashboard.tsx"),
      depth: 3,
      includeChildren: true,
    });
    await task("unit-browser").run(ctxOf({ outDir, trees: [tree] }));
    mkdirSync(path.join(outDir, "unit"), { recursive: true });
    const ghost = path.join(outDir, "unit", "Ghost.test.tsx");
    writeFileSync(
      ghost,
      'import { expect, test } from "vitest";\ntest("gone", () => expect(1).toBe(1));\n',
    );

    const result = await task("unit-browser").run(ctxOf({ outDir, trees: [tree] }));

    expect(result.summary).toContain("1 unit spec(s) with no component behind them");
    expect(result.summary).toContain(path.join("unit", "Ghost.test.tsx"));
    expect(existsSync(ghost)).toBe(true);
  });

  test("the React Native exit names the specs it strands", async () => {
    // That exit writes nothing at all, which is right — but it also means an
    // older suite's unit specs stay exactly where they are, and the runner will
    // still pick them up. The one case where a run emits less than it removed.
    const outDir = tmp("unit-native-strand");
    mkdirSync(path.join(outDir, "unit"), { recursive: true });
    const stranded = path.join(outDir, "unit", "OldScreen.test.tsx");
    writeFileSync(
      stranded,
      'import { expect, test } from "vitest";\ntest("x", () => expect(1).toBe(1));\n',
    );
    const screen = await analyse({
      entry: path.join(FIXTURES, "expoapp", "app", "login.tsx"),
      depth: 3,
      includeChildren: true,
    });

    const result = await task("unit-browser").run(ctxOf({ outDir, trees: [screen] }));

    expect(result.summary).toContain("React Native source");
    expect(result.summary).toContain("1 unit spec(s) with no component behind them");
    expect(existsSync(stranded)).toBe(true);
  });

  test("no analysed components → ok false with an error", async () => {
    const outDir = tmp("unit-empty");
    const result = await task("unit-browser").run(ctxOf({ outDir, trees: [] }));

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no components");
    expect(result.outputs).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("no components");
  });
});

// Update DELIBERATELY, and read the test below before you do.
const EXPECTED_STUB_SHA256 = "b43628cafe7c279c1288796dc3bb1c89659bd80f3c6ff7330d494bab1bc29e74";

describe("e2e task", () => {
  test("without a Next.js context → ok false", async () => {
    const outDir = tmp("e2e-nonext");
    const tree = await toolbarTree();
    const result = await task("e2e").run(ctxOf({ outDir, trees: [tree] }));

    expect(result.id).toBe("e2e");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not a Next.js run");
    expect(result.outputs).toEqual([]);
    expect(existsSync(path.join(outDir, "e2e"))).toBe(false);
  });

  // B-12, the visibility half. The suite is green before it is real: the auth
  // hook ships as a stub, so every route spec navigates unauthenticated. The
  // correctness half (each spec asserting it landed on the route it asked for)
  // is proved by EXECUTION in tests/e2eExecution.test.ts — reading a spec is
  // what let this survive in the first place. This pins the reporting.
  test("an untouched auth stub is reported as hand-work — and a filled one is not", async () => {
    const nextjs = nextProject("next dev -p 3123");
    const outDir = path.join(nextjs.root, "flawless");
    const pageFile = writePage(nextjs, path.join("things", "[id]"));
    const tree = withFilePath(await toolbarTree(), pageFile);

    const first = await task("e2e").run(ctxOf({ outDir, trees: [tree], nextjs }));
    expect(first.ok).toBe(true);
    expect(first.handWork).toEqual([
      {
        kind: "e2e-auth-unfilled",
        count: 1,
        exemplar: path.join(outDir, "e2e", "global-setup.ts"),
      },
    ]);

    // The control, and the reason this is byte-identity and not a marker grep:
    // a user who authenticates but leaves the TODO comment in place must stop
    // being reported. Edit the file the way a human would and re-run.
    const setupPath = path.join(outDir, "e2e", "global-setup.ts");
    writeFileSync(
      setupPath,
      `${readFileSync(setupPath, "utf8")}\n// authenticated for real, by a person\n`,
    );
    const second = await task("e2e").run(ctxOf({ outDir, trees: [tree], nextjs, force: true }));
    expect(second.ok).toBe(true);
    expect(second.handWork).toEqual([]);
    // …and the edit survived, because global-setup is never overwritten — which
    // is exactly why the fix had to go in the ROUTE SPECS, which --force does
    // rewrite, and not in the stub.
    expect(readFileSync(setupPath, "utf8")).toContain("by a person");
  });

  // S2/F, the coupling nobody could see. The tally fires on BYTE-IDENTITY with
  // globalSetupStub(), and the stub file is never overwritten — so the day
  // anyone edits the stub's text (a typo fix in its comment is enough), every
  // already-generated, never-filled suite stops being reported as unfilled.
  // That is "green before it is real" restored by an upgrade.
  //
  // Every other test writes and reads the stub inside one version, so
  // same-version identity was pinned and cross-version identity was not. This
  // pins the bytes themselves: if you are changing them deliberately, update
  // the expected digest AND accept that existing suites go quiet.
  test("the auth stub's bytes are pinned — changing them retires the tally for existing suites", () => {
    const stub = globalSetupStubForTest();
    const digest = new Bun.CryptoHasher("sha256").update(stub).digest("hex");
    expect(digest).toBe(EXPECTED_STUB_SHA256);
    // The two facts the tally depends on, asserted rather than assumed:
    // deterministic (no dates, ports or paths interpolated) …
    expect(globalSetupStubForTest()).toBe(stub);
    // … and still carrying the marker the report's prose refers to.
    expect(stub).toContain("TODO(flawless)");
  });

  // S5. The guard that stops a suite with no route specs from reporting an
  // auth hook as hand-work. Removing it left every test green.
  test("no page routes means no auth hand-work — there is no suite to authenticate", async () => {
    const nextjs = nextProject("next dev -p 3123");
    const outDir = path.join(nextjs.root, "flawless");
    // A component tree that is not a page: the task emits a config and no specs.
    const result = await task("e2e").run(ctxOf({ outDir, trees: [await toolbarTree()], nextjs }));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("no analysed entry is an app-router page.tsx");
    expect(result.handWork).toEqual([]);
  });

  test("emits a port-aware config, global setup, README and one spec per page", async () => {
    const nextjs = nextProject("next dev -p 3123");
    // Under the project root, like a real run. Pointed at an unrelated tmpdir
    // the emitted prose says "../flawless-e2e-out-XXXX/e2e/params.json", which
    // is accurate but tests a layout no user has.
    const outDir = path.join(nextjs.root, "flawless");
    const pageFile = writePage(nextjs, path.join("things", "[id]"));
    const tree = withFilePath(await toolbarTree(), pageFile);

    const result = await task("e2e").run(ctxOf({ outDir, trees: [tree], nextjs }));
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    const configPath = path.join(outDir, "e2e", "playwright.config.ts");
    const specPath = path.join(outDir, "e2e", "things-id.spec.ts");
    const setupPath = path.join(outDir, "e2e", "global-setup.ts");
    const readmePath = path.join(outDir, "e2e", "README.md");
    for (const p of [configPath, specPath, setupPath, readmePath]) {
      expect(result.outputs).toContain(p);
      expect(existsSync(p)).toBe(true);
    }

    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("3123");
    expect(config).toContain("http://localhost:3123");
    expect(config).toContain("FLAWLESS_E2E_BASEURL");
    // Relative, anchored to the config itself. An absolute root here would name
    // the machine that generated it, and this file is committed.
    expect(config).toContain("cwd: path.resolve(__dirname,");
    expect(config).not.toContain(nextjs.root);

    const spec = readFileSync(specPath, "utf8");
    expect(spec).toContain('from "@playwright/test"');
    // Ids come from the shared fixture, not a const per spec. The old form
    // defaulted to "REPLACE_WITH_SEEDED_ID", navigated to a URL that 404s, and
    // reported the tool's missing fixture as an application bug.
    expect(spec).toContain('import { expectedLanding, routeUrl } from "./params";');
    // B-12. The landing assertion, in BOTH emitted tests — the interaction one
    // is the more dangerous of the two unasserted, because every harvested
    // click is visibility-guarded and silently no-ops on a login page.
    expect(spec.match(/await assertOnRoute\(page\);/g)?.length).toBe(2);
    expect(spec).toContain("expectedLanding(ROUTE_KEY,");
    // The escape the failure message offers must name the file that SURVIVES
    // --force. Naming the spec itself would be advice --force deletes.
    expect(spec).toContain("flawless/e2e/params.json");
    expect(spec).toContain("survives --force, this spec does not");
    // A cheap-net BACKSTOP, and only that. The real proof is execution
    // (tests/e2eExecution.test.ts) — reading a spec is what let this bug
    // survive in the first place. But that test is gated on
    // FLAWLESS_CI_BROWSER, and the mutation pass showed the ungated suite
    // could not see the assertion deleted, weakened to toBeTruthy, or turned
    // into a self-comparison. These lines cost nothing and mean the whole
    // correctness half is not one unset environment variable from unguarded.
    expect(spec).toContain("const landed = normalisePath(new URL(page.url()).pathname);");
    expect(spec).toContain(").toBe(wanted);");
    expect(spec).toContain("const ROUTE = routeUrl(ROUTE_TEMPLATE) as string;");
    expect(spec).toContain("test.skip(");
    expect(spec).toContain("fill flawless/e2e/params.json");
    // The route rides on the DESCRIBE so grepForRoutes' "\bGET <route> "
    // pattern selects both tests via the full title path — embedded in one
    // test's own title, a --changed grep dropped the interaction test.
    expect(spec).toContain('test.describe("GET /things/[id]", () => {');
    expect(spec).toContain('test("renders without console or page errors"');
    expect(spec).toContain('test("basic interactions from analysis stay error-free"');

    const paramsJson = path.join(outDir, "e2e", "params.json");
    const paramsHelper = path.join(outDir, "e2e", "params.ts");
    for (const p of [paramsJson, paramsHelper]) expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(paramsJson, "utf8"))).toEqual({
      // `landing` ships empty and is never written by the tool — only carried.
      // Present in the file so the knob is discoverable where it is used.
      landing: {},
      defaults: { id: "" },
      routes: { "/things/[id]": { id: "" } },
    });
    // The legacy single-id escape hatch moves into the helper.
    expect(readFileSync(paramsHelper, "utf8")).toContain("FLAWLESS_E2E_ID");

    // Hand-filled ids survive regeneration, including --force: a value typed
    // against a seeded database cannot be recovered from the tool's inputs, so
    // --force regenerates the HELPER and never the DATA.
    writeFileSync(
      paramsJson,
      JSON.stringify({ defaults: { id: "seeded-uuid" }, routes: {} }, null, 2),
    );
    await task("e2e").run(ctxOf({ outDir, trees: [tree], nextjs, force: true }));
    const after = JSON.parse(readFileSync(paramsJson, "utf8")) as {
      defaults: Record<string, string>;
      routes: Record<string, Record<string, string>>;
    };
    expect(after.defaults.id).toBe("seeded-uuid");
    // …and the route key the previous write dropped is restored.
    expect(after.routes["/things/[id]"]).toEqual({ id: "" });

    expect(readFileSync(setupPath, "utf8")).toContain(".auth.json");
    expect(readFileSync(readmePath, "utf8")).toContain("3123");
    expect(result.summary).toContain("/things/[id]");
  });

  test("rerun keeps an existing spec; --force rewrites it", async () => {
    const outDir = tmp("e2e-force");
    const nextjs = nextProject("next dev -p 3000");
    const pageFile = writePage(nextjs, path.join("things", "[id]"));
    const tree = withFilePath(await toolbarTree(), pageFile);
    const specPath = path.join(outDir, "e2e", "things-id.spec.ts");

    const first = await task("e2e").run(ctxOf({ outDir, trees: [tree], nextjs }));
    expect(first.outputs).toContain(specPath);

    writeFileSync(specPath, "// hand-edited\n");
    const second = await task("e2e").run(ctxOf({ outDir, trees: [tree], nextjs }));
    expect(second.ok).toBe(true);
    expect(second.outputs).not.toContain(specPath);
    expect(second.summary).toContain("kept 1 existing spec(s)");
    expect(readFileSync(specPath, "utf8")).toBe("// hand-edited\n");

    const forced = await task("e2e").run(ctxOf({ outDir, trees: [tree], nextjs, force: true }));
    expect(forced.ok).toBe(true);
    expect(forced.outputs).toContain(specPath);
    expect(forced.summary).not.toContain("kept");
    expect(readFileSync(specPath, "utf8")).toContain('from "@playwright/test"');
  });

  test("no analysed entry is a page.tsx → config only, no specs", async () => {
    const outDir = tmp("e2e-nopages");
    const nextjs = nextProject("next dev");
    const tree = await toolbarTree();

    const result = await task("e2e").run(ctxOf({ outDir, trees: [tree], nextjs }));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("no analysed entry is an app-router page.tsx");
    expect(result.summary).toContain("no specs");

    const configPath = path.join(outDir, "e2e", "playwright.config.ts");
    expect(result.outputs).toContain(configPath);
    expect(existsSync(configPath)).toBe(true);
    // Default port when the dev script carries no -p flag.
    expect(readFileSync(configPath, "utf8")).toContain("http://localhost:3000");
    expect(result.outputs.some((o) => o.endsWith(".spec.ts"))).toBe(false);
  });
});

describe("load task", () => {
  test("without a Next.js context → ok false", async () => {
    const outDir = tmp("load-nonext");
    const tree = await toolbarTree();
    const result = await task("load").run(ctxOf({ outDir, trees: [tree] }));

    expect(result.id).toBe("load");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not a Next.js run");
    expect(result.outputs).toEqual([]);
    expect(existsSync(path.join(outDir, "load"))).toBe(false);
  });

  test("emits routes.pipes + README with the crust env/baseline contract", async () => {
    const outDir = tmp("load-out");
    const nextjs = nextProject("next dev -p 3001");
    const pageFile = writePage(nextjs, path.join("things", "[id]"));
    const base = await analyse({
      entry: path.join(FIXTURES, "DepsBugs.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const tree = withFilePath(base, pageFile);

    const result = await task("load").run(ctxOf({ outDir, trees: [tree], nextjs }));
    // Emit-only: succeeds whether or not crust is installed.
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("load pipes for 2 target(s)");

    const pipesPath = path.join(outDir, "load", "routes.pipes");
    const readmePath = path.join(outDir, "load", "README.md");
    expect(result.outputs).toContain(pipesPath);
    expect(result.outputs).toContain(readmePath);

    const pipes = readFileSync(pipesPath, "utf8");
    expect(pipes).toContain("$LOAD_BASE");
    expect(pipes).toContain("stats --out");
    expect(pipes).toContain("assert (async s =>");
    expect(pipes).toContain("baseline-things-id.json");
    // Dynamic page segments and fetch holes both become $LOAD_ vars.
    expect(pipes).toContain("GET $LOAD_BASE/things/$LOAD_ID");
    expect(pipes).toContain("/api/users/$LOAD_USERID/rows");

    expect(readFileSync(readmePath, "utf8")).toContain("baseline-");
  });

  test("only GET fetch calls become load targets", async () => {
    const outDir = tmp("load-get");
    const nextjs = nextProject("next dev");
    const tree = withFetchCalls(await toolbarTree(), [
      fetchCall("GET", "/api/get-me"),
      fetchCall("POST", "/api/post-me"),
    ]);

    const result = await task("load").run(ctxOf({ outDir, trees: [tree], nextjs }));
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("load pipes for 1 target(s)");

    const pipes = readFileSync(path.join(outDir, "load", "routes.pipes"), "utf8");
    expect(pipes).toContain("GET $LOAD_BASE/api/get-me");
    expect(pipes).not.toContain("/api/post-me");
    expect(pipes).toContain("last-api-get-me.json");
  });
});

describe("perf-static task", () => {
  test("writes a per-root report and buckets the props no fixture could synthesise", async () => {
    const outDir = tmp("perf-out");
    const tree = await toolbarTree();
    expect(tree.entry.unresolvedProps).toEqual(["onSave", "onCancel", "onDelete"]);

    const result = await task("perf-static").run(ctxOf({ outDir, trees: [tree] }));
    expect(result.id).toBe("perf-static");
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    const reportPath = path.join(outDir, "reports", "Toolbar.perf-static.json");
    expect(result.outputs).toEqual([reportPath]);
    expect(existsSync(reportPath)).toBe(true);

    // NOTES-9: these were per-prop findings, 713 of the dogfood run's 926, and
    // the 127 rerender findings underneath them read as noise. They are the
    // analyser's fixture limits, so they are bucketed per component and counted
    // apart — the finding number means app work again.
    expect(result.findings.filter((f) => f.rule === "perf/unresolved-prop")).toHaveLength(0);
    expect(result.specQuality).toEqual({
      rule: "perf/unresolved-prop",
      props: 3,
      components: [
        {
          component: "Toolbar",
          file: tree.entry.filePath,
          props: ["onCancel", "onDelete", "onSave"],
        },
      ],
    });
    expect(result.summary).toContain(`${result.findings.length} finding(s)`);
    expect(result.summary).toContain("1 root(s)");
    expect(result.summary).toContain("3 spec-quality prop gap(s) across 1 component(s)");

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      component: string;
      file: string;
      findings: unknown[];
      specQuality: unknown[];
    };
    expect(report.component).toBe("Toolbar");
    expect(report.file).toBe(tree.entry.filePath);
    expect(report.findings).toHaveLength(result.findings.length);
    expect(report.specQuality).toHaveLength(1);
  });

  test("a component rendered by several roots is ONE bucket, and the count is props, not trees", async () => {
    // The same leaf arrives as its own root and as someone's child — which is how
    // one button reached 148 "findings". Merging on file::component (the registry
    // convention) makes it one row naming its props once.
    const outDir = tmp("perf-dedupe");
    const tree = await toolbarTree();
    const result = await task("perf-static").run(ctxOf({ outDir, trees: [tree, tree, tree] }));
    expect(result.specQuality?.components).toHaveLength(1);
    expect(result.specQuality?.props).toBe(3);
  });

  test("a tree whose props all synthesise has no spec-quality section at all — a real zero", async () => {
    const outDir = tmp("perf-clean");
    const tree = treeWithAllProps();
    const result = await task("perf-static").run(ctxOf({ outDir, trees: [tree] }));
    expect(result.specQuality).toBeUndefined();
    expect(result.summary).not.toContain("spec-quality");
  });
});

/** A component with no unresolved props, for the measured-zero case. */
function treeWithAllProps(): ComponentTree {
  return {
    entry: {
      componentName: "Plain",
      filePath: "/proj/src/Plain.tsx",
      importSpecifier: "./Plain.tsx",
      propsShape: { title: { type: "string" } },
      variants: [],
      hooks: [],
      unresolvedProps: [],
      childAttrs: [],
    },
    children: [],
  };
}

describe("the perf harness respects --force and protects what it cannot rebuild", () => {
  const tree = async (): Promise<ComponentTree> =>
    analyse({ entry: path.join(FIXTURES, "Toolbar.tsx"), depth: 0, includeChildren: false });

  test("a bare re-run over an existing outDir refreshes instead of refusing", async () => {
    // FR-028: the refusal made core.ts record a healthy adopted suite as
    // { ok: false, summary: "task threw" } and exit 1 — refreshing derived
    // files is the normal case, not an error.
    const outDir = tmp("perf-force");
    const trees = [await tree()];
    const first = await task("perf-harness").run(ctxOf({ outDir, trees }));
    expect(first.ok).toBe(true);
    expect(first.status).toBe("generated");

    const again = await task("perf-harness").run(ctxOf({ outDir, trees }));
    expect(again.ok).toBe(true);
    expect(again.status).toBe("refreshed");
    // The summary names the kept set and the delete-to-regenerate escape.
    expect(again.summary).toContain("budgets.json");
    expect(again.summary).toContain("host/main.tsx");
    expect(again.summary).toContain("delete");
    // A post-split main.tsx imports ./registry, so no migration note fires.
    expect(again.summary).not.toContain("predates the registry split");
  });

  test("a pre-split monolithic main.tsx gets the registry beside it and the migration warning", async () => {
    // FR-016 migration: writeOnce is absolute (--force included), so the old
    // monolith is never rewritten — the run writes host/registry.ts inert
    // beside it and names the delete-and-re-run escape on both channels.
    const outDir = tmp("perf-presplit");
    const trees = [await tree()];
    await task("perf-harness").run(ctxOf({ outDir, trees }));

    const main = path.join(outDir, "host/main.tsx");
    const monolith = "// pre-split host: tables baked in, no registry import\n";
    writeFileSync(main, monolith);
    rmSync(path.join(outDir, "host/registry.ts"));

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const res = await task("perf-harness").run(ctxOf({ outDir, trees }));
      expect(res.ok).toBe(true);
      expect(readFileSync(path.join(outDir, "host/registry.ts"), "utf8")).toContain(
        "export const REGISTRY",
      );
      expect(readFileSync(main, "utf8")).toBe(monolith);
      expect(res.summary).toContain("predates the registry split");
      expect(res.summary).toContain("delete");
      expect(res.summary).toContain("./registry");
      const warned = warnings.join("\n");
      // The discriminating phrase, not just generic words: a future routine
      // kept-files warning saying "host/main.tsx … delete … re-run" must not
      // stand in for the migration warning.
      expect(warned).toContain("predates the registry split");
      expect(warned).toContain("host/main.tsx");
      expect(warned).toContain("delete");
      expect(warned).toContain("re-run");
    } finally {
      console.warn = origWarn;
    }
  });

  test("changed-mode keeps the harness and writes nothing", async () => {
    // FR-017: --changed narrows the RUN — regenerating here would churn a suite
    // the flag exists to leave alone, and a manufactured failure would gate the
    // affected-test run off.
    const { VERSION } = await import("../src/version.ts");
    const outDir = tmp("perf-kept");
    const trees = [await tree()];
    await task("perf-harness").run(ctxOf({ outDir, trees }));

    const spec = path.join(outDir, "profile/Toolbar.profile.spec.ts");
    writeFileSync(spec, "// untouched by kept\n");
    // Foreign version in the banner: same-version round-trips cannot tell a
    // real parse from one that echoes the tool's own VERSION.
    const marker = path.join(outDir, "playwright.config.ts");
    const foreign = readFileSync(marker, "utf8").replace(
      /Generated by flawless-react \S+/,
      "Generated by flawless-react 9.9.9-test",
    );
    writeFileSync(marker, foreign);

    const kept = await task("perf-harness").run(ctxOf({ outDir, trees, changed: true }));
    expect(kept.ok).toBe(true);
    expect(kept.status).toBe("kept");
    expect(kept.outputs).toEqual([]);
    expect(kept.summary).toContain("harness kept (generated by flawless-react 9.9.9-test");
    expect(kept.summary).toContain(`tool is ${VERSION}`);
    expect(readFileSync(spec, "utf8")).toBe("// untouched by kept\n");
    expect(readFileSync(marker, "utf8")).toBe(foreign);
  });

  test("changed-mode over a pre-banner suite says 'unknown version', never guesses", async () => {
    const outDir = tmp("perf-prebanner");
    const trees = [await tree()];
    await task("perf-harness").run(ctxOf({ outDir, trees }));
    const marker = path.join(outDir, "playwright.config.ts");
    const stripped = readFileSync(marker, "utf8")
      .split("\n")
      .filter((l) => !l.includes("Generated by flawless-react"))
      .join("\n");
    writeFileSync(marker, stripped);

    const kept = await task("perf-harness").run(ctxOf({ outDir, trees, changed: true }));
    expect(kept.status).toBe("kept");
    expect(kept.summary).toContain("unknown version");
  });

  test("--changed with --force regenerates: an explicit force outranks the keep", async () => {
    const outDir = tmp("perf-changed-force");
    const trees = [await tree()];
    await task("perf-harness").run(ctxOf({ outDir, trees }));
    const spec = path.join(outDir, "profile/Toolbar.profile.spec.ts");
    writeFileSync(spec, "// stale\n");

    const r = await task("perf-harness").run(ctxOf({ outDir, trees, changed: true, force: true }));
    expect(r.status).toBe("refreshed");
    expect(readFileSync(spec, "utf8")).not.toBe("// stale\n");
  });

  test("--force keeps the two files a user tunes, and still refreshes the specs", async () => {
    const outDir = tmp("perf-keep");
    const trees = [await tree()];
    await task("perf-harness").run(ctxOf({ outDir, trees }));

    // Both are files the docs tell you to edit: budgets.json holds thresholds
    // tightened to an observed p95, host/main.tsx holds hand-wired providers.
    // Nothing can rebuild either from the analysis.
    const budgets = path.join(outDir, "budgets.json");
    const main = path.join(outDir, "host/main.tsx");
    writeFileSync(budgets, '{"mine":true}\n');
    writeFileSync(main, "// my provider wiring\n");

    const spec = path.join(outDir, "profile/Toolbar.profile.spec.ts");
    writeFileSync(spec, "// stale\n");

    const again = await task("perf-harness").run(ctxOf({ outDir, trees, force: true }));
    expect(again.ok).toBe(true);

    expect(readFileSync(budgets, "utf8")).toBe('{"mine":true}\n');
    expect(readFileSync(main, "utf8")).toBe("// my provider wiring\n");
    // Specs are derived from the analysis: freezing them is what stranded
    // load/README.md behind its own improvements. --colocate is the supported
    // way to keep a hand-hardened spec.
    expect(readFileSync(spec, "utf8")).not.toBe("// stale\n");
  });

  test("a first run still writes both protected files", async () => {
    const outDir = tmp("perf-first");
    await task("perf-harness").run(ctxOf({ outDir, trees: [await tree()] }));
    expect(existsSync(path.join(outDir, "budgets.json"))).toBe(true);
    expect(existsSync(path.join(outDir, "host/main.tsx"))).toBe(true);
  });
});

describe("generated prose is refreshed, generated data is not", () => {
  // The criterion docs/extending.md states: a file is protected when its
  // contents cannot be recovered if lost. These four hold nothing of the user's,
  // and freezing them is what stranded load/README.md behind its own fixes.
  test("--force refreshes e2e/README.md", async () => {
    const nextjs = nextProject("next dev");
    writePage(nextjs, "dashboard");
    const outDir = tmp("e2e-readme");
    const base = { outDir, nextjs, trees: [] as ComponentTree[] };

    await task("e2e").run(ctxOf(base));
    const readme = path.join(outDir, "e2e", "README.md");
    writeFileSync(readme, "stale\n");

    await task("e2e").run(ctxOf({ ...base, force: true }));
    expect(readFileSync(readme, "utf8")).not.toBe("stale\n");
  });

  test("without --force it is still left alone", async () => {
    const nextjs = nextProject("next dev");
    writePage(nextjs, "dashboard");
    const outDir = tmp("e2e-readme-keep");
    const base = { outDir, nextjs, trees: [] as ComponentTree[] };

    await task("e2e").run(ctxOf(base));
    const readme = path.join(outDir, "e2e", "README.md");
    writeFileSync(readme, "mine\n");

    await task("e2e").run(ctxOf(base));
    expect(readFileSync(readme, "utf8")).toBe("mine\n");
  });

  test("env.sh says not to edit it, because nothing stops it being overwritten", async () => {
    // It is written with no gate at all, while its own body used to say
    // "LOAD_BASE and LOAD_AUTH are yours to set" — inviting edits into a file
    // rewritten on every run.
    const nextjs = nextProject("next dev -p 3001");
    const outDir = tmp("env-sh");
    await task("load").run(ctxOf({ outDir, nextjs, trees: [] }));
    const env = readFileSync(path.join(outDir, "load", "env.sh"), "utf8");
    expect(env).toContain("Do not edit");
    expect(env).not.toContain("yours to set");
  });
});
