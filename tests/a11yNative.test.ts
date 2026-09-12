// The native a11y analyser — wave 5 of the Expo mode.
//
// The wave exists because the biome sweep was vacuously green on React Native:
// 0 findings over 31 files carrying 82 unlabelled Pressables, while scoring 3/3
// on the DOM offender fixture. Everything here guards against that class
// recurring: the offender fixture pins exact per-rule counts, the clean and
// dynamic fixtures pin zero-WITH-a-denominator, and every rule has a mutation
// probe proving a one-line fix retires exactly its finding.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { emitNativeSelector } from "../src/scaffold-tests/selectorsNative.ts";
import { NATIVE_A11Y_RULES, nativeA11yFindings, runNativeA11y } from "../src/tasks/a11yNative.ts";
import { findTask } from "../src/tasks/index.ts";
import type { ComponentTree, ExpoContext, Finding, RunContext } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures", "native");
const OFFENDER = path.join(FIXTURES, "NativeA11yOffender.tsx");
const CLEAN = path.join(FIXTURES, "NativeA11yClean.tsx");
const DYNAMIC = path.join(FIXTURES, "NativeA11yDynamic.tsx");

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

const EXPO_STUB: ExpoContext = {
  root: ".",
  routerRoot: undefined,
  sdkMajor: 54,
  routerMajor: undefined,
  reactCompiler: false,
  nativewind: false,
  webPort: 8081,
};

function ctxOf(outDir: string, trees: ComponentTree[]): RunContext {
  return {
    trees,
    outDir,
    variants: 3,
    heaps: "stress",
    force: false,
    report: false,
    provider: undefined,
    apiSpec: undefined,
    inlineSummary: false,
    nextjs: undefined,
    expo: EXPO_STUB,
  };
}

function tree(entry: string): Promise<ComponentTree> {
  return analyse({ entry, depth: 0, includeChildren: false });
}

function countsOf(findings: Finding[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of findings) out.set(f.rule, (out.get(f.rule) ?? 0) + 1);
  return out;
}

describe("the offender fixture", () => {
  test("exact per-rule counts — the analyser sees what biome could not", async () => {
    const { findings, stats } = nativeA11yFindings([await tree(OFFENDER)]);
    const counts = countsOf(findings);

    expect(counts.get("a11y/unnamed-control")).toBe(2);
    expect(counts.get("a11y/missing-role")).toBe(5);
    expect(counts.get("a11y/textinput-unlabelled")).toBe(1);
    expect(counts.get("a11y/icon-unhidden")).toBe(1);
    expect(counts.get("a11y/label-text-mismatch")).toBe(1);
    expect(counts.get("a11y/invalid-role")).toBe(1);
    expect(findings).toHaveLength(11);

    for (const f of findings) {
      expect(f.source).toBe("a11y");
      expect(NATIVE_A11Y_RULES).toContain(f.rule as (typeof NATIVE_A11Y_RULES)[number]);
      expect(f.file).toBe(OFFENDER);
      expect(f.line).toBeGreaterThan(0);
      expect(f.column).toBeGreaterThan(0);
      expect(f.severity).toBe(f.rule === "a11y/icon-unhidden" ? "warn" : "error");
      expect(f.message.length).toBeGreaterThan(20);
    }

    // The denominator the summary and aggregate are built from.
    expect(stats.pressTargets).toBe(7);
    expect(stats.textInputs).toBe(1);
    expect(stats.icons).toBe(4);
    expect(stats.nativeFiles).toEqual([OFFENDER]);
    expect(stats.domDialectFiles).toEqual([]);
  });

  test("findings are sorted and deduped even when two trees share the file", async () => {
    const t = await tree(OFFENDER);
    const copy: ComponentTree = { ...t, entry: { ...t.entry, componentName: "OffenderAlias" } };
    const { findings } = nativeA11yFindings([t, copy]);
    // Same file under two roots: the census dedupes by element position, so the
    // counts do not double.
    expect(findings).toHaveLength(11);
    const keys = findings.map((f) => `${f.file}:${f.line}:${f.column}:${f.rule}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("the controls", () => {
  test("clean fixture: zero findings WITH a denominator — never vacuously green", async () => {
    const { findings, stats } = nativeA11yFindings([await tree(CLEAN)]);
    expect(findings).toEqual([]);
    // Zero findings must be distinguishable from "the rules do not apply":
    // the elements were seen, examined, and passed.
    expect(stats.pressTargets).toBe(2);
    expect(stats.textInputs).toBe(1);
    expect(stats.icons).toBe(3);
  });

  test("dynamic fixture: attribute presence without a readable value stands every rule down", async () => {
    const { findings, stats } = nativeA11yFindings([await tree(DYNAMIC)]);
    expect(findings).toEqual([]);
    expect(stats.pressTargets).toBe(1);
    expect(stats.textInputs).toBe(1);
    expect(stats.icons).toBe(1);
  });
});

describe("agreement with the selector ladder", () => {
  // The doc comment on ClickHandler.iconOnly promises the skip's wording and
  // the a11y finding agree without either re-deriving the other. These pins are
  // that promise, INCLUDING the two deliberate asymmetries.
  test("an icon-only control with no handle: ladder skip AND unnamed finding — one label retires both", async () => {
    const t = await tree(OFFENDER);
    const { findings } = nativeA11yFindings([t]);
    const clicks = t.entry.interactions?.clicks ?? [];
    const send = clicks.find((c) => c.binding.kind === "prop" && c.binding.propName === "onSend");
    expect(send?.iconOnly).toBe(true);
    expect(send).toBeDefined();
    if (!send) throw new Error("unreachable");
    expect(emitNativeSelector(send)).toBeUndefined();
    expect(
      findings.some((f) => f.rule === "a11y/unnamed-control" && f.line === send.pos?.line),
    ).toBe(true);
  });

  test("the testID asymmetry: addressable to a spec, still flagged — a testID is not a name", async () => {
    const t = await tree(OFFENDER);
    const { findings } = nativeA11yFindings([t]);
    const bell = (t.entry.interactions?.clicks ?? []).find((c) => c.hints.testid === "bell");
    expect(bell).toBeDefined();
    if (!bell) throw new Error("unreachable");
    expect(emitNativeSelector(bell)?.rung).toBe("testID");
    expect(
      findings.some((f) => f.rule === "a11y/unnamed-control" && f.line === bell.pos?.line),
    ).toBe(true);
  });

  test("the dynamic-text asymmetry: ladder skip WITHOUT an unnamed finding — `{year}` announces at runtime", async () => {
    const t = await tree(OFFENDER);
    const { findings } = nativeA11yFindings([t]);
    const dot = (t.entry.interactions?.clicks ?? []).find(
      (c) => c.binding.kind === "prop" && c.binding.propName === "onDot",
    );
    expect(dot).toBeDefined();
    if (!dot) throw new Error("unreachable");
    expect(emitNativeSelector(dot)).toBeUndefined();
    expect(
      findings.some((f) => f.rule === "a11y/unnamed-control" && f.line === dot.pos?.line),
    ).toBe(false);
  });
});

describe("mutation probes — every rule's finding dies to exactly its one-line fix", () => {
  async function mutated(from: string, to: string): Promise<Map<string, number>> {
    const dir = tmp("a11y-mutate");
    const original = readFileSync(OFFENDER, "utf8");
    // Never trust an unverified in-place edit: the probe is only a probe if the
    // anchor matched exactly once.
    expect(original.split(from).length - 1).toBe(1);
    const file = path.join(dir, "NativeA11yOffender.tsx");
    writeFileSync(file, original.replace(from, to));
    const { findings } = nativeA11yFindings([await tree(file)]);
    return countsOf(findings);
  }

  test("unnamed-control: adding the accessibilityLabel retires it", async () => {
    const counts = await mutated(
      "onPress={onSend}>",
      'onPress={onSend} accessibilityLabel="Send message">',
    );
    expect(counts.get("a11y/unnamed-control")).toBe(1);
    expect(counts.get("a11y/missing-role")).toBe(5);
  });

  test("missing-role: adding the accessibilityRole retires it", async () => {
    const counts = await mutated(
      "onPress={onSave}>",
      'onPress={onSave} accessibilityRole="button">',
    );
    expect(counts.get("a11y/missing-role")).toBe(4);
    expect(counts.get("a11y/unnamed-control")).toBe(2);
  });

  test("textinput-unlabelled: the label retires it, the placeholder never did", async () => {
    const counts = await mutated(
      'placeholder="Email" />',
      'accessibilityLabel="Email" placeholder="Email" />',
    );
    expect(counts.get("a11y/textinput-unlabelled")).toBeUndefined();
  });

  test("icon-unhidden: aria-hidden retires it", async () => {
    const counts = await mutated(
      '<Ionicons name="alert-circle"',
      '<Ionicons aria-hidden name="alert-circle"',
    );
    expect(counts.get("a11y/icon-unhidden")).toBeUndefined();
  });

  test("label-text-mismatch: a label containing the visible text retires it", async () => {
    const counts = await mutated('accessibilityLabel="Submit"', 'accessibilityLabel="Sign out"');
    expect(counts.get("a11y/label-text-mismatch")).toBeUndefined();
  });

  test("invalid-role: the real accessibilityRole value retires it", async () => {
    const counts = await mutated('accessibilityRole="heading"', 'accessibilityRole="button"');
    expect(counts.get("a11y/invalid-role")).toBeUndefined();
  });

  test("the clean control REDDENS when its label is removed — the zero is falsifiable", async () => {
    const dir = tmp("a11y-clean-mutate");
    const original = readFileSync(CLEAN, "utf8");
    const anchor = 'accessibilityLabel="Go back" ';
    expect(original.split(anchor).length - 1).toBe(1);
    const file = path.join(dir, "NativeA11yClean.tsx");
    writeFileSync(file, original.replace(anchor, ""));
    const { findings } = nativeA11yFindings([await tree(file)]);
    expect(findings.map((f) => f.rule)).toEqual(["a11y/unnamed-control"]);
  });
});

describe("the task under --expo", () => {
  test("writes the aggregate with engine, denominator, and per-owner reports", async () => {
    const outDir = tmp("a11y-native-task");
    const trees = [await tree(OFFENDER), await tree(CLEAN)];
    const task = findTask("a11y");
    if (!task) throw new Error("a11y not registered");
    const result = await task.run(ctxOf(outDir, trees));

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.findings).toHaveLength(11);
    expect(result.summary).toContain("a11y: 11 finding(s) across 2 file(s)");
    expect(result.summary).toContain("9 press target(s)");
    expect(result.summary).toContain("2 text input(s)");
    expect(result.summary).toContain("7 icon(s) examined");
    expect(result.summary).toContain("6 native rules");
    expect(result.summary).not.toContain("NOT swept");

    const reports = path.join(outDir, "reports");
    const aggregatePath = path.join(reports, "a11y.json");
    expect(result.outputs).toEqual([
      aggregatePath,
      path.join(reports, "NativeA11yOffender.a11y.json"),
    ]);
    expect(existsSync(path.join(reports, "NativeA11yClean.a11y.json"))).toBe(false);

    const aggregate = JSON.parse(readFileSync(aggregatePath, "utf8")) as {
      task: string;
      engine: string;
      filesScanned: number;
      findingCount: number;
      elementsExamined: { pressTargets: number; textInputs: number; icons: number };
      rulesApplied: string[];
      domDialectFilesNotSwept?: string[];
      findingsByFile: Record<string, Finding[]>;
    };
    expect(aggregate.task).toBe("a11y");
    expect(aggregate.engine).toBe("native");
    expect(aggregate.filesScanned).toBe(2);
    expect(aggregate.findingCount).toBe(11);
    expect(aggregate.elementsExamined).toEqual({ pressTargets: 9, textInputs: 2, icons: 7 });
    expect(aggregate.rulesApplied).toEqual([...NATIVE_A11Y_RULES]);
    expect(aggregate.domDialectFilesNotSwept).toBeUndefined();
    expect(Object.keys(aggregate.findingsByFile)).toEqual([OFFENDER]);

    const per = JSON.parse(
      readFileSync(path.join(reports, "NativeA11yOffender.a11y.json"), "utf8"),
    ) as { component: string; file: string; findings: Finding[] };
    expect(per.component).toBe("NativeA11yOffender");
    expect(per.findings).toHaveLength(11);
  });

  test("no trees: aggregate written, zero denominator, and the summary says so", async () => {
    const outDir = tmp("a11y-native-empty");
    const result = await runNativeA11y(ctxOf(outDir, []));
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.summary).toContain("0 finding(s) across 0 file(s)");
    expect(result.summary).toContain("0 press target(s)");
    expect(existsSync(path.join(outDir, "reports", "a11y.json"))).toBe(true);
  });

  test("dom-dialect files are counted and NAMED, never silently skipped", async () => {
    const outDir = tmp("a11y-native-dom");
    const domFixture = path.resolve(__dirname, "fixtures", "Toolbar.tsx");
    const trees = [await tree(OFFENDER), await tree(domFixture)];
    const result = await runNativeA11y(ctxOf(outDir, trees));

    expect(result.findings).toHaveLength(11);
    expect(result.summary).toContain("1 dom-dialect file(s) NOT swept");

    const aggregate = JSON.parse(
      readFileSync(path.join(outDir, "reports", "a11y.json"), "utf8"),
    ) as { domDialectFilesNotSwept?: string[] };
    expect(aggregate.domDialectFilesNotSwept).toEqual([domFixture]);
  });
});
