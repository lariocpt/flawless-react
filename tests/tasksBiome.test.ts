import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import {
  dedupeTreeFiles,
  findingsByComponent,
  groupFindingsByFile,
} from "../src/tasks/biomeSweep.ts";
import { findTask } from "../src/tasks/index.ts";
import type { ComponentInfo, ComponentTree, Finding, RunContext, TaskId } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "..");

/** The biome-backed tasks shell out; when biome cannot be resolved the integration tests
 *  are skipped rather than failed, so this suite still runs on a bare checkout. */
const BIOME_AVAILABLE =
  existsSync(path.join(REPO_ROOT, "node_modules", ".bin", "biome")) || Boolean(Bun.which("biome"));
const testWithBiome = BIOME_AVAILABLE ? test : test.skip;

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `flawless-${prefix}-`));
  created.push(dir);
  return dir;
}

function ctxOf(outDir: string, trees: ComponentTree[]): RunContext {
  return {
    trees,
    outDir,
    variants: 3,
    force: false,
    report: false,
    provider: undefined,
    apiSpec: undefined,
    inlineSummary: false,
    json: false,
    nextjs: undefined,
  };
}

function info(componentName: string, filePath: string): ComponentInfo {
  return {
    componentName,
    filePath,
    importSpecifier: filePath,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
  };
}

function node(
  componentName: string,
  filePath: string,
  children: ComponentTree[] = [],
): ComponentTree {
  return { entry: info(componentName, filePath), children };
}

function finding(file: string, line: number, source: TaskId = "a11y"): Finding {
  return {
    rule: "lint/a11y/useAltText",
    severity: "error",
    file,
    line,
    column: 1,
    message: "needs alt text",
    source,
  };
}

function renamed(tree: ComponentTree, componentName: string): ComponentTree {
  return { ...tree, entry: { ...tree.entry, componentName } };
}

function runTask(id: TaskId, ctx: RunContext) {
  const t = findTask(id);
  if (!t) throw new Error(`task not registered: ${id}`);
  return t.run(ctx);
}

describe("dedupeTreeFiles", () => {
  test("two trees over the same file yield one path", () => {
    const file = "/proj/src/Shared.tsx";
    const files = dedupeTreeFiles([node("Alpha", file), node("Beta", file)]);
    expect(files).toEqual([file]);
  });

  test("dedupes across trees while still reaching children only one root knows", () => {
    const shared = "/proj/src/Shared.tsx";
    const leafA = "/proj/src/LeafA.tsx";
    const leafB = "/proj/src/LeafB.tsx";
    const files = dedupeTreeFiles([
      node("Alpha", shared, [node("LeafA", leafA)]),
      node("Beta", shared, [node("LeafB", leafB)]),
    ]);
    expect(files).toEqual([shared, leafA, leafB]);
  });

  test("paths are absolute and compared after resolution", () => {
    const raw = path.join(FIXTURES, "..", "fixtures", "Toolbar.tsx");
    const abs = path.join(FIXTURES, "Toolbar.tsx");
    expect(dedupeTreeFiles([node("Toolbar", raw), node("ToolbarCopy", abs)])).toEqual([abs]);
  });
});

describe("groupFindingsByFile", () => {
  test("groups by resolved path, keeping source order inside a file", () => {
    const a = path.join(FIXTURES, "A.tsx");
    const b = path.join(FIXTURES, "B.tsx");
    const unresolved = path.join(FIXTURES, "..", "fixtures", "A.tsx");
    const byFile = groupFindingsByFile([finding(a, 1), finding(b, 5), finding(unresolved, 9)]);

    expect([...byFile.keys()]).toEqual([a, b]);
    expect(byFile.get(a)?.map((f) => f.line)).toEqual([1, 9]);
    expect(byFile.get(b)).toHaveLength(1);
  });

  test("no findings yields an empty map", () => {
    expect(groupFindingsByFile([]).size).toBe(0);
  });
});

describe("findingsByComponent", () => {
  test("two components sharing a file both receive its findings", () => {
    const shared = "/proj/src/Shared.tsx";
    const byFile = groupFindingsByFile([finding(shared, 3)]);
    const owners = findingsByComponent([node("Alpha", shared), node("Beta", shared)], byFile);

    expect(owners.map((o) => o.tree.entry.componentName)).toEqual(["Alpha", "Beta"]);
    for (const o of owners) expect(o.findings.map((f) => f.line)).toEqual([3]);
  });

  test("a component with no findings is omitted, and a parent inherits its child's", () => {
    const parent = "/proj/src/Parent.tsx";
    const child = "/proj/src/Child.tsx";
    const clean = "/proj/src/Clean.tsx";
    const byFile = groupFindingsByFile([finding(child, 7)]);
    const owners = findingsByComponent(
      [node("Parent", parent, [node("Child", child)]), node("Clean", clean)],
      byFile,
    );

    expect(owners).toHaveLength(1);
    expect(owners[0]?.tree.entry.componentName).toBe("Parent");
    expect(owners[0]?.findings.map((f) => f.file)).toEqual([child]);
  });
});

describe("a11y task", () => {
  test("no trees: one aggregate report, no per-component reports, no biome run", async () => {
    const outDir = tmp("a11y-empty");
    const result = await runTask("a11y", ctxOf(outDir, []));

    const aggregate = path.join(outDir, "reports", "a11y.json");
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.outputs).toEqual([aggregate]);
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("0 finding(s) across 0 file(s)");

    const report = JSON.parse(readFileSync(aggregate, "utf8")) as {
      task: string;
      filesScanned: number;
      findingsByFile: Record<string, unknown>;
    };
    expect(report.task).toBe("a11y");
    expect(report.filesScanned).toBe(0);
    expect(report.findingsByFile).toEqual({});
  });

  testWithBiome(
    "one aggregate for the whole sweep; per-component reports only where findings are",
    async () => {
      const outDir = tmp("a11y-sweep");
      const offenderFile = path.join(FIXTURES, "A11yOffender.tsx");
      const offender = await analyse({ entry: offenderFile, depth: 0, includeChildren: false });
      const clean = await analyse({
        entry: path.join(FIXTURES, "Toolbar.tsx"),
        depth: 0,
        includeChildren: false,
      });
      // Four trees, two of them over the same file: the old per-tree loop would have spawned
      // four biome processes and written four reports.
      const trees = [
        offender,
        renamed(offender, "OffenderAlias"),
        clean,
        renamed(clean, "ToolbarCopy"),
      ];

      const result = await runTask("a11y", ctxOf(outDir, trees));
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();

      const reports = path.join(outDir, "reports");
      const aggregate = path.join(reports, "a11y.json");
      expect(result.outputs).toEqual([
        aggregate,
        path.join(reports, "A11yOffender.a11y.json"),
        path.join(reports, "OffenderAlias.a11y.json"),
      ]);
      expect(existsSync(path.join(reports, "Toolbar.a11y.json"))).toBe(false);
      expect(existsSync(path.join(reports, "ToolbarCopy.a11y.json"))).toBe(false);

      expect(result.findings.length).toBeGreaterThan(0);
      for (const f of result.findings) {
        expect(f.source).toBe("a11y");
        expect(f.rule.startsWith("lint/a11y")).toBe(true);
        expect(f.file).toBe(offenderFile);
      }
      expect(result.findings.map((f) => f.rule)).toContain("lint/a11y/useAltText");
      expect(result.summary).toContain(`${result.findings.length} finding(s) across 2 file(s)`);

      const report = JSON.parse(readFileSync(aggregate, "utf8")) as {
        filesScanned: number;
        findingCount: number;
        findingsByFile: Record<string, Finding[]>;
      };
      expect(report.filesScanned).toBe(2);
      expect(report.findingCount).toBe(result.findings.length);
      expect(Object.keys(report.findingsByFile)).toEqual([offenderFile]);

      // The shared file's findings reach both components declared over it.
      for (const name of ["A11yOffender", "OffenderAlias"]) {
        const per = JSON.parse(readFileSync(path.join(reports, `${name}.a11y.json`), "utf8")) as {
          component: string;
          file: string;
          findings: Finding[];
        };
        expect(per.component).toBe(name);
        expect(per.file).toBe(offenderFile);
        expect(per.findings).toHaveLength(result.findings.length);
      }
    },
  );
});

describe("react-rules task", () => {
  testWithBiome("writes a single aggregate carrying the bypass note", async () => {
    const outDir = tmp("react-rules-sweep");
    const trees = [
      await analyse({
        entry: path.join(FIXTURES, "DepsBugs.tsx"),
        depth: 0,
        includeChildren: false,
      }),
      await analyse({ entry: path.join(FIXTURES, "Card.tsx"), depth: 0, includeChildren: false }),
    ];

    const result = await runTask("react-rules", ctxOf(outDir, trees));
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    const aggregate = path.join(outDir, "reports", "react-rules.json");
    expect(result.outputs[0]).toBe(aggregate);
    expect(result.outputs.filter((o) => o.endsWith("react-rules.json"))).toContain(aggregate);
    expect(result.summary).toContain("across 2 file(s)");

    const report = JSON.parse(readFileSync(aggregate, "utf8")) as {
      task: string;
      note: string;
      filesScanned: number;
      findingCount: number;
      findingsByFile: Record<string, Finding[]>;
    };
    expect(report.task).toBe("react-rules");
    expect(report.note).toContain("Local biome.json is bypassed");
    expect(report.filesScanned).toBe(2);
    expect(report.findingCount).toBe(result.findings.length);
    expect(result.findings.length).toBeGreaterThan(0);
    // One aggregate plus exactly one report per component that has findings — never one
    // report per analysed component.
    expect(result.outputs).toHaveLength(1 + Object.keys(report.findingsByFile).length);

    // Unlike a11y this task passes no categoryPrefix, so every diagnostic survives.
    for (const f of result.findings) expect(f.source).toBe("react-rules");
    const grouped = Object.values(report.findingsByFile).flat();
    expect(grouped).toHaveLength(result.findings.length);
  });
});
