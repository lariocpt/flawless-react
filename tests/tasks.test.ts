import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
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
    json: false,
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
  test("emits vitest.config.ts + setup.ts + one unit spec per analysed component", async () => {
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

    expect(result.outputs).toContain(path.join(outDir, "vitest.config.ts"));
    expect(result.outputs).toContain(path.join(outDir, "setup.ts"));
    for (const name of ["Dashboard", "Hello", "Card"]) {
      const spec = path.join(outDir, "unit", `${name}.test.tsx`);
      expect(result.outputs).toContain(spec);
      expect(existsSync(spec)).toBe(true);
    }
    expect(existsSync(path.join(outDir, "vitest.config.ts"))).toBe(true);

    expect(result.summary).toContain("3 component(s)");
    for (const name of ["Dashboard", "Hello", "Card"]) {
      expect(result.summary).toContain(name);
    }
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

  test("emits a port-aware config, global setup, README and one spec per page", async () => {
    const outDir = tmp("e2e-out");
    const nextjs = nextProject("next dev -p 3123");
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
    expect(spec).toContain('import { routeUrl } from "./params";');
    expect(spec).toContain("const ROUTE = routeUrl(ROUTE_TEMPLATE) as string;");
    expect(spec).toContain("test.skip(");
    expect(spec).toContain("fill flawless/e2e/params.json");
    expect(spec).toContain("GET /things/[id] renders without console or page errors");

    const paramsJson = path.join(outDir, "e2e", "params.json");
    const paramsHelper = path.join(outDir, "e2e", "params.ts");
    for (const p of [paramsJson, paramsHelper]) expect(existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(paramsJson, "utf8"))).toEqual({
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
  test("writes a per-root report and returns unresolved-prop findings", async () => {
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

    const unresolved = result.findings.filter((f) => f.rule === "perf/unresolved-prop");
    expect(unresolved).toHaveLength(3);
    for (const f of unresolved) {
      expect(f.source).toBe("perf-static");
      expect(f.severity).toBe("warn");
      expect(f.file).toBe(tree.entry.filePath);
      expect(f.message).toContain("Toolbar");
    }
    expect(unresolved.map((f) => f.message).join(" ")).toContain('prop "onSave"');
    expect(result.summary).toContain(`${result.findings.length} finding(s)`);
    expect(result.summary).toContain("1 root(s)");

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      component: string;
      file: string;
      findings: unknown[];
    };
    expect(report.component).toBe("Toolbar");
    expect(report.file).toBe(tree.entry.filePath);
    expect(report.findings).toHaveLength(result.findings.length);
  });
});

describe("the perf harness respects --force and protects what it cannot rebuild", () => {
  const tree = async (): Promise<ComponentTree> =>
    analyse({ entry: path.join(FIXTURES, "Toolbar.tsx"), depth: 0, includeChildren: false });

  test("a bare re-run over an existing outDir is refused", async () => {
    // perfHarness hardcoded `force: true`, so the guard in scaffold/index.ts was
    // unreachable from the CLI — while docs/extending.md:3 and cli.ts:62 both
    // promised a re-run is "rejected unless you pass --force".
    const outDir = tmp("perf-force");
    const trees = [await tree()];
    const first = await task("perf-harness").run(ctxOf({ outDir, trees }));
    expect(first.ok).toBe(true);

    // The task throws; core.ts:305-316 catches it into { ok: false, error }, so
    // the CLI reports the refusal rather than crashing.
    expect(task("perf-harness").run(ctxOf({ outDir, trees }))).rejects.toThrow(
      /a generated suite already exists/,
    );
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
