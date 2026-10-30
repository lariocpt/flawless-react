import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findTask } from "../src/tasks/index.ts";
import type {
  ChildAttrInfo,
  ComponentInfo,
  ComponentTree,
  Finding,
  HookDetail,
  ReactCompilerProbe,
  RunContext,
  SourcePosition,
  StateInfo,
  Task,
  TaskResult,
} from "../src/types.ts";

// perf-static's half of BUG-11: the tool detects the React Compiler and then
// emits the memo-family findings anyway, 136 of 160 on the dogfood app. These
// tests pin the contract its own types always claimed — the three memo rules
// step aside when the compiler runs, the other six do not, and neither the
// suppression nor its absence is ever silent.

const FILE = "/proj/src/Board.tsx";
const created: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-perfcompiler-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function pos(line: number, column = 1): SourcePosition {
  return { file: FILE, line, column };
}

function comp(name: string, extra: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    componentName: name,
    filePath: FILE,
    importSpecifier: `./${name}.tsx`,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    ...extra,
  };
}

function tree(entry: ComponentInfo, children: ComponentTree[] = []): ComponentTree {
  return { entry, children };
}

function attr(
  over: Partial<ChildAttrInfo> & {
    tag: string;
    attr: string;
    valueKind: ChildAttrInfo["valueKind"];
  },
): ChildAttrInfo {
  return { pos: pos(9), ...over };
}

function stateful(): StateInfo[] {
  return [
    {
      kind: "useState",
      typeKind: "boolean",
      pos: pos(4),
      varName: "open",
      setterName: "setOpen",
      setterCalls: [],
      flowsToJsx: [],
      setterCalledInEffect: false,
    },
  ];
}

/**
 * One component that trips a memo rule of each kind AND a hook-deps rule AND an
 * unresolved prop, so a single run shows exactly which findings the compiler
 * makes redundant and which it has nothing to say about.
 */
function oneOfEachRule(): ComponentTree {
  const hook: HookDetail = {
    pos: pos(6),
    name: "useMemo",
    argCount: 2,
    argsSummary: ["arrow", "array"],
    deps: ["count"],
    depsHasComplex: false,
    missingDepsArray: false,
    callbackReads: ["items"],
    callbackIsInline: true,
    readsBareParamsObject: false,
  };
  return tree(
    comp("Board", {
      propsShape: { items: { type: "string" } },
      state: stateful(),
      hookDetails: [hook],
      childAttrs: [
        attr({ tag: "Row", attr: "onPick", valueKind: "arrow", pos: pos(11, 7) }),
        attr({ tag: "Badge", attr: "label", valueKind: "string", pos: pos(12, 7) }),
      ],
    }),
    [tree(comp("Row")), tree(comp("Badge")), tree(comp("Spacer"))],
  );
}

function ctxOf(over: Partial<RunContext> & { outDir: string; trees: ComponentTree[] }): RunContext {
  return {
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

function probe(
  state: ReactCompilerProbe["state"],
  evidence = "app.json experiments.reactCompiler",
): ReactCompilerProbe {
  return { state, evidence };
}

function rulesOf(findings: Finding[], rule: string): Finding[] {
  return findings.filter((f) => f.rule === rule);
}

function perfStatic(): Task {
  const task = findTask("perf-static");
  if (!task) throw new Error("perf-static is not registered");
  return task;
}

async function run(
  trees: ComponentTree[],
  reactCompiler?: ReactCompilerProbe,
): Promise<{ outDir: string; result: TaskResult }> {
  const outDir = tmp();
  const result = await perfStatic().run(
    ctxOf({ outDir, trees, ...(reactCompiler ? { reactCompiler } : {}) }),
  );
  return { outDir, result };
}

const MEMO_RULES = [
  "perf/no-memoisation-with-children",
  "perf/unstable-child-prop",
  "perf/missing-memo-leaf",
];

describe("perf-static under the React Compiler", () => {
  test("the fixture tree trips all three memo rules when the compiler is off", async () => {
    // The control. Without it, a suppressed zero below could mean this tree
    // never produced those findings at all.
    const { result } = await run([oneOfEachRule()], probe("off", "next.config.js reactCompiler"));
    for (const rule of MEMO_RULES) {
      expect(rulesOf(result.findings, rule), `${rule} fires when off`).not.toHaveLength(0);
    }
    expect(result.summary).not.toContain("suppressed");
    expect(result.summary).not.toContain("undetermined");
  });

  test("compiler on: the three memo rules are suppressed, everything else still emits", async () => {
    const { result } = await run([oneOfEachRule()], probe("on"));
    for (const rule of MEMO_RULES) {
      expect(rulesOf(result.findings, rule), `${rule} must be suppressed`).toHaveLength(0);
    }
    // The compiler relies on correct dependency arrays rather than repairing
    // wrong ones, so these stay at full strength.
    expect(rulesOf(result.findings, "perf/hook-missing-dependency")).toHaveLength(1);

    expect(result.summary).toContain(`${result.findings.length} finding(s)`);
    expect(result.summary).toContain("3 memo rule(s) suppressed");
    expect(result.summary).toContain("app.json experiments.reactCompiler");

    const suppressed = result.reactCompiler?.suppressed ?? [];
    expect(suppressed.map((s) => s.rule).sort()).toEqual([...MEMO_RULES].sort());
    expect(suppressed.reduce((n, s) => n + s.count, 0)).toBeGreaterThan(0);
  });

  test("suppressed findings land in the per-component report as a count, not silently", async () => {
    const { outDir, result } = await run([oneOfEachRule()], probe("on"));
    const reportPath = path.join(outDir, "reports", "Board.perf-static.json");
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      findings: Finding[];
      reactCompiler: ReactCompilerProbe;
      suppressed?: { rule: string; count: number }[];
    };
    expect(report.findings.map((f) => f.rule)).not.toContain("perf/unstable-child-prop");
    expect(report.reactCompiler.state).toBe("on");
    expect(report.reactCompiler.evidence).toBe("app.json experiments.reactCompiler");
    expect(report.suppressed?.find((s) => s.rule === "perf/unstable-child-prop")?.count).toBe(1);
    expect(result.outputs).toEqual([reportPath]);
  });

  test("compiler off: the report file still records that the question was asked", async () => {
    // Provenance, so two runs of one tree with different compiler states diff
    // against each other instead of producing byte-identical files.
    const { outDir, result } = await run([oneOfEachRule()], probe("off", "next.config.js"));
    const report = JSON.parse(
      readFileSync(path.join(outDir, "reports", "Board.perf-static.json"), "utf8"),
    ) as { reactCompiler: ReactCompilerProbe; suppressed?: unknown };
    expect(report.reactCompiler.state).toBe("off");
    expect(report.reactCompiler.evidence).toBe("next.config.js");
    expect(report.suppressed).toBeUndefined();
    expect(result.reactCompiler?.suppressed).toBeUndefined();
    expect(result.reactCompiler?.state).toBe("off");
  });

  test("undetermined: every rule runs, and the summary says the memo findings may be noise", async () => {
    const { result } = await run([oneOfEachRule()], probe("undetermined", "no configs to read"));
    for (const rule of MEMO_RULES) {
      expect(rulesOf(result.findings, rule), `${rule} runs when undetermined`).not.toHaveLength(0);
    }
    expect(result.summary).toContain("react-compiler state undetermined");
    expect(result.summary).toContain("pre-compiled noise");
    expect(result.reactCompiler?.suppressed).toBeUndefined();
  });

  test("a context that never read the project says it did not look, in undetermined's voice", async () => {
    // ctx.reactCompiler is absent only for a hand-built context. Assuming either
    // state there would suppress findings on a guess.
    const { result } = await run([oneOfEachRule()]);
    expect(rulesOf(result.findings, "perf/unstable-child-prop")).not.toHaveLength(0);
    expect(result.summary).toContain("react-compiler state undetermined");
    expect(result.reactCompiler?.evidence).toBe("this run did not read the project's configs");
  });
});
