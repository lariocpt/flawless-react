import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { census, depthBlock } from "../src/reporters/depth.ts";
import { renderReportMarkdown } from "../src/reporters/report.ts";
import { writeVerdict } from "../src/reporters/verdict.ts";
import { suiteDepth } from "../src/tasks/unitAndBrowser.ts";
import type { TaskResult } from "../src/types.ts";

/**
 * The D0 report wiring (PLAN-00 acceptance 4/5): the depth census reaches
 * REPORT.md, VERDICT.json and VERDICT.md, and the three views agree with
 * scripts/depth-census.ts over the same suite — one census, three views,
 * CHECKED not assumed. Plus the two properties the wiring must not break:
 * the depth block is byte-stable across runs (M1's property, no timestamps),
 * and a task that emits no specs gets NO depth field — an absent field is
 * unmeasured, never a zero (verdict.ts's contract).
 */

const REPO = path.join(import.meta.dir, "..");

// A four-file out-dir suite plus one colocated decoy outside it. The decoy
// must never enter the headline: the census subject is the emitted suite.
const UNIT_T2 = `
test("Widget fires onClick when 'Save' (click)", async () => {
  await userEvent.click(screen.getByText("Save"));
  expect(handlers.onClick).toHaveBeenCalled();
});
`;
const UNIT_T0_UNCLAIMED = `
test("Widget: fetches on mount — no fixture could be synthesised", async () => {
  // TODO(flawless): supply a fixture and assert the rendered payload.
  await waitFor(() => expect(document.body).toBeTruthy());
});
`;
const UNIT_ALL_SKIPPED = `
test.skip("Widget: server render — no DOM in this host", () => {});
`;
const BROWSER_T0 = `
test("Widget page renders markup", async ({ page }) => {
  expect(await page.content()).toBeTruthy();
});
`;
const COLOCATED_T1 = `
test("Deco renders a <span>", () => {
  const { container } = renderTarget();
  expect(container.querySelector("span")).not.toBeNull();
});
`;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "depth-wiring-"));
  await mkdir(path.join(root, "flawless", "unit"), { recursive: true });
  await mkdir(path.join(root, "flawless", "browser"), { recursive: true });
  await mkdir(path.join(root, "src", "widgets"), { recursive: true });
  await writeFile(path.join(root, "flawless/unit/A.test.tsx"), UNIT_T2);
  await writeFile(path.join(root, "flawless/unit/B.test.tsx"), UNIT_T0_UNCLAIMED);
  await writeFile(path.join(root, "flawless/unit/Skipped.test.tsx"), UNIT_ALL_SKIPPED);
  await writeFile(path.join(root, "flawless/browser/C.spec.ts"), BROWSER_T0);
  await writeFile(path.join(root, "src/widgets/D.flawless.test.tsx"), COLOCATED_T1);
  return root;
}

const outDirOf = (root: string) => path.join(root, "flawless");

function ubTask(depth: TaskResult["depth"]): TaskResult {
  return {
    id: "unit-browser",
    ok: true,
    outputs: [],
    findings: [],
    summary: "unit tests for Widget",
    depth,
  } as TaskResult;
}

function runInput(results: TaskResult[]) {
  return {
    targetHash: "sha256:aaaaaaaaaaaaaaaa",
    results,
    skipCensus: [],
    claimFile: () => "unit-browser",
    evidenceFor: () => [],
  };
}

function reportMd(results: TaskResult[], root: string, outDir: string): string {
  return renderReportMarkdown({
    trees: [],
    results,
    outDir,
    projectRoot: root,
  });
}

/** Run scripts/depth-census.ts over the same tree, return its JSON payload. */
async function scriptCensus(root: string): Promise<any> {
  const out = path.join(root, "census.json");
  const proc = Bun.spawnSync(
    [process.execPath, "run", path.join(REPO, "scripts", "depth-census.ts"), root, "--json", out],
    { cwd: root },
  );
  expect(proc.exitCode).toBe(0);
  return JSON.parse(await readFile(out, "utf8"));
}

/** Pull the printed totals out of a rendered Depth section, by regex. */
function reportDepthTotals(md: string) {
  const specs =
    /(\d+) spec\(s\) censused; (\d+) have T0 as their strongest tier; (\d+) test\(s\) classified, (\d+) unclaimed, (\d+) skipped/.exec(
      md,
    );
  const t = (tier: string) => Number(new RegExp(`\\| ${tier} \\| (\\d+) \\|`).exec(md)?.[1]);
  if (!specs) throw new Error("no Depth totals in REPORT.md");
  return {
    specs: Number(specs[1]),
    T0: t("T0"),
    T1: t("T1"),
    T2: t("T2"),
    T3: t("T3"),
    strongestT0: Number(specs[2]),
    testsClassified: Number(specs[3]),
    testsUnclaimed: Number(specs[4]),
    testsSkipped: Number(specs[5]),
  };
}

function verdictDepthTotals(json: any) {
  const d = json.entries["unit-browser"].depth;
  return {
    specs: d.specs,
    T0: d.T0,
    T1: d.T1,
    T2: d.T2,
    T3: d.T3,
    testsClassified: d.testsClassified,
    testsUnclaimed: d.testsUnclaimed,
    testsSkipped: d.testsSkipped,
  };
}

function scriptTotals(payload: any) {
  const h = payload.headline;
  return {
    specs: h.specs,
    T0: h.distribution.T0,
    T1: h.distribution.T1,
    T2: h.distribution.T2,
    T3: h.distribution.T3,
    testsClassified: h.testsClassified,
    testsUnclaimed: h.testsUnclaimed,
    testsSkipped: h.testsSkipped,
  };
}

describe("depth wiring — one census, three views", () => {
  test("REPORT.md, VERDICT.json and scripts/depth-census.ts print the same totals", async () => {
    const root = await fixture();
    const outDir = outDirOf(root);
    const depth = suiteDepth(outDir);
    expect(depth).toBeDefined();

    const verdict = await writeVerdict(outDir, runInput([ubTask(depth)]));
    const verdictJson = JSON.parse(await readFile(verdict.jsonPath, "utf8"));
    const report = reportMd([ubTask(depth)], root, outDir);
    const script = await scriptCensus(root);

    const fromReport = reportDepthTotals(report);
    const fromVerdict = verdictDepthTotals(verdictJson);
    const fromScript = scriptTotals(script);

    // The three views are equal — the agreement is proven, not assumed.
    // (`strongestT0` is the report's rendering of the T0 column, checked below.)
    const { strongestT0, ...reportTotals } = fromReport;
    expect(reportTotals).toEqual(fromVerdict);
    expect(fromScript).toEqual(fromVerdict);

    // And the numbers are the fixture's truth: unit A(T2) + B(T0 unclaimed)
    // + Skipped(all-skipped) + browser C(T0); the colocated decoy excluded.
    expect(fromVerdict).toEqual({
      specs: 4,
      T0: 2,
      T1: 0,
      T2: 1,
      T3: 0,
      testsClassified: 3,
      testsUnclaimed: 1,
      testsSkipped: 1,
    });
    expect(strongestT0).toBe(2);
    expect(script.crossCheck.specs).toBe(1);
    expect(script.crossCheck.distribution.T1).toBe(1);

    // The task-side block equals the pure census over the same files, too.
    const files = [
      { path: "flawless/unit/A.test.tsx", source: UNIT_T2 },
      { path: "flawless/unit/B.test.tsx", source: UNIT_T0_UNCLAIMED },
      { path: "flawless/unit/Skipped.test.tsx", source: UNIT_ALL_SKIPPED },
      { path: "flawless/browser/C.spec.ts", source: BROWSER_T0 },
    ];
    expect(depth).toEqual(depthBlock(census(files)));

    // VERDICT.md carries the same distribution and the plain-language line.
    const vmd = await readFile(verdict.mdPath, "utf8");
    expect(vmd).toContain("## Depth");
    expect(vmd).toContain("| `unit-browser` | 4 | 2 | 0 | 1 | 0 | 3 | 1 | 1 |");
    expect(vmd).toContain(
      "T0 means mount-only — not a failure, the floor this tool guarantees and no more.",
    );
    expect(report).toContain("## Depth");
    expect(report).toContain(
      "T0 means mount-only — not a failure, the floor this tool guarantees and no more.",
    );
  });

  test("the depth block is byte-stable across consecutive runs and carries no timestamps", async () => {
    const root = await fixture();
    const outDir = outDirOf(root);
    const depth = suiteDepth(outDir);
    expect(depth).toBeDefined();

    const v1 = await writeVerdict(outDir, runInput([ubTask(depth)]));
    const json1 = await readFile(v1.jsonPath, "utf8");
    const md1 = await readFile(v1.mdPath, "utf8");
    // Second run, same tree, same inputs: the verdict rewrites byte-identically.
    const v2 = await writeVerdict(outDir, runInput([ubTask(depth)]));
    const json2 = await readFile(v2.jsonPath, "utf8");
    const md2 = await readFile(v2.mdPath, "utf8");
    expect(json2).toBe(json1);
    expect(md2).toBe(md1);
    expect(json1).toContain('"depth"');

    // REPORT.md renders byte-identically from the same inputs.
    expect(reportMd([ubTask(depth)], root, outDir)).toBe(reportMd([ubTask(depth)], root, outDir));

    // No clock anywhere in the new output: no ISO dates, no unix-era epochs.
    for (const text of [json1, md1]) {
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(text).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    }
  });

  test("guard the guard: a task that emits no specs gets NO depth field, never a zero-filled one", async () => {
    const root = await fixture();
    const outDir = outDirOf(root);
    const perf = {
      id: "perf-static",
      ok: true,
      outputs: [],
      findings: [],
      summary: "0 findings",
    } as TaskResult;
    const ub = {
      id: "unit-browser",
      ok: true,
      outputs: [],
      findings: [],
      summary: "no components to scaffold",
    } as TaskResult;

    const v = await writeVerdict(outDir, runInput([perf, ub]));
    const json = JSON.parse(await readFile(v.jsonPath, "utf8"));
    expect(json.entries["perf-static"].depth).toBeUndefined();
    expect(json.entries["unit-browser"].depth).toBeUndefined();
    // Not even the key — an absent field is unmeasured, not zero.
    expect(JSON.stringify(json)).not.toContain('"depth"');

    const md = await readFile(v.mdPath, "utf8");
    expect(md).toContain("Not measured — no task on record emitted specs");

    // REPORT.md: the same three-state honesty.
    const report = reportMd([perf, ub], root, outDir);
    expect(report).toContain("Not measured — no task in this run emitted specs");
    expect(report).not.toMatch(/\| T0 \| 0 \|/);
  });

  test("suiteDepth is undefined for an out dir with no specs at all", async () => {
    const root = await fixture();
    const empty = path.join(root, "nothing-here");
    await mkdir(empty, { recursive: true });
    expect(suiteDepth(empty)).toBeUndefined();
  });
});
