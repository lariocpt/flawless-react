import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NamedSkip } from "../src/reporters/report.ts";
import {
  aggregateSkipReasons,
  hashTargetFiles,
  makeFileClaimer,
  mergeVerdict,
  renderVerdictJson,
  renderVerdictMarkdown,
  skipReasonOf,
  VERDICT_JSON,
  VERDICT_MD,
  type VerdictDoc,
  writeVerdict,
} from "../src/reporters/verdict.ts";
import type { TaskResult } from "../src/types.ts";

const task = (id: string, over: Partial<TaskResult> = {}): TaskResult =>
  ({
    id,
    ok: true,
    outputs: [],
    findings: [],
    summary: `${id} summary`,
    ...over,
  }) as TaskResult;

const skip = (file: string, title: string): NamedSkip => ({ file, title });

const run = (
  results: TaskResult[],
  skipCensus: NamedSkip[] = [],
  targetHash = "sha256:aaaaaaaaaaaaaaaa",
) => ({
  targetHash,
  results,
  skipCensus,
  claimFile: (file: string) =>
    results.find((r) => r.outputs.includes(file))?.id ??
    (file.includes("/browser/") || file.includes("/unit/") ? "unit-browser" : undefined),
  evidenceFor: (taskId: string) =>
    results.find((r) => r.id === taskId)?.outputs.filter((o) => o.endsWith(".json")) ?? [],
});

describe("hashTargetFiles", () => {
  test("is stable for unchanged content and changes when a file's bytes change", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "verdict-hash-"));
    const a = path.join(dir, "a.tsx");
    const b = path.join(dir, "b.tsx");
    await writeFile(a, "export const A = () => <div/>;\n");
    await writeFile(b, "export const B = () => <span/>;\n");
    const h1 = await hashTargetFiles([a, b]);
    const h2 = await hashTargetFiles([b, a]); // order-independent
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{16}$/);
    await writeFile(b, "export const B = () => <p/>;\n");
    expect(await hashTargetFiles([a, b])).not.toBe(h1);
  });
});

describe("skipReasonOf / aggregateSkipReasons", () => {
  test("splits on the em-dash separator; a bare title is its own reason", () => {
    expect(skipReasonOf("Widget: click — no clickable target could be derived")).toBe(
      "no clickable target could be derived",
    );
    expect(skipReasonOf("no separator here")).toBe("no separator here");
  });

  test("aggregates by reason, sorted, counting repeats", () => {
    const agg = aggregateSkipReasons([
      "B: x — shared reason",
      "A: y — shared reason",
      "C: z — other reason",
    ]);
    expect(agg).toEqual([
      { count: 1, reason: "other reason" },
      { count: 2, reason: "shared reason" },
    ]);
  });
});

describe("mergeVerdict", () => {
  test("a run records one entry per task with its tallies", () => {
    const doc = mergeVerdict(
      null,
      run(
        [task("unit-browser", { outputs: ["/s/unit/A.test.tsx"], findings: [1, 2] as never })],
        [
          skip("/s/unit/A.test.tsx", "A: click — no clickable target"),
          skip("/s/unit/A.test.tsx", "A: submit — no submit control"),
        ],
      ),
    );
    const e = doc.entries["unit-browser"] as NonNullable<VerdictDoc["entries"][string]>;
    expect(e).toBeDefined();
    expect(e.written).toBe(1);
    expect(e.findings).toBe(2);
    expect(e.skips).toBe(2);
    expect(e.skipReasons).toEqual([
      { count: 1, reason: "no clickable target" },
      { count: 1, reason: "no submit control" },
    ]);
    expect(e.targetHash).toBe("sha256:aaaaaaaaaaaaaaaa");
  });

  test("accumulates across runs: a task that did not run keeps its last entry", () => {
    const first = mergeVerdict(null, run([task("perf-harness")], [], "sha256:1"));
    const second = mergeVerdict(first, run([task("unit-browser")], [], "sha256:2"));
    expect(Object.keys(second.entries).sort()).toEqual(["perf-harness", "unit-browser"]);
    // The first entry survives untouched — including the target it describes.
    expect(second.entries["perf-harness"]?.targetHash).toBe("sha256:1");
    expect(second.entries["unit-browser"]?.targetHash).toBe("sha256:2");
  });

  test("a rerun of the same task replaces its entry; totals equal the census", () => {
    const census = [
      skip("/s/unit/A.test.tsx", "A: x — reason one"),
      skip("/s/unit/A.test.tsx", "A: y — reason one"),
      skip("/s/unit/B.test.tsx", "B: z — reason two"),
    ];
    const doc = mergeVerdict(
      null,
      run([task("unit-browser", { outputs: ["/s/unit/A.test.tsx"] })], census),
    );
    const e = doc.entries["unit-browser"] as NonNullable<VerdictDoc["entries"][string]>;
    const sum = e.skipReasons.reduce((n, r) => n + r.count, 0);
    expect(sum).toBe(e.skips);
  });

  test("TodoCounter tallies ride into the entry when the task measured them", () => {
    const doc = mergeVerdict(
      null,
      run([
        task("unit-browser", {
          handWork: [{ kind: "server-action-stub", count: 47, exemplar: "/s/x.tsx" }],
        }),
      ]),
    );
    expect(doc.entries["unit-browser"]?.todos).toEqual([{ kind: "server-action-stub", count: 47 }]);
    expect(doc.entries["perf-harness"]?.todos).toBeUndefined();
  });
});

describe("renderVerdictJson / renderVerdictMarkdown", () => {
  const doc: VerdictDoc = mergeVerdict(
    mergeVerdict(null, run([task("perf-harness")], [], "sha256:1")),
    run(
      [task("unit-browser", { outputs: ["/s/unit/A.test.tsx"] })],
      [skip("/s/unit/A.test.tsx", "A: x — reason one")],
      "sha256:2",
    ),
  );

  test("JSON is byte-stable and key-sorted", () => {
    const a = renderVerdictJson(doc);
    const b = renderVerdictJson(mergeVerdict(JSON.parse(a), run([], [], "sha256:2")));
    expect(a).toBe(renderVerdictJson(JSON.parse(a)));
    expect(b).toContain("perf-harness");
    expect(a.indexOf("perf-harness")).toBeLessThan(a.indexOf("unit-browser"));
  });

  test("markdown names every task id, marks this run, and totals the skip reasons", () => {
    const md = renderVerdictMarkdown(doc, ["unit-browser"]);
    for (const id of ["perf-harness", "unit-browser"]) expect(md).toContain(`\`${id}\``);
    expect(md).toContain("*(this run)*");
    // perf-harness is on record without being this run's.
    expect(md).toMatch(/`perf-harness` \| ok/);
    expect(md).toContain("1 emitted skip(s)");
    expect(md).toContain("| reason one | 1 |");
  });

  test("no timestamps: two renders of one doc are byte-identical", () => {
    expect(renderVerdictMarkdown(doc, ["unit-browser"])).toBe(
      renderVerdictMarkdown(doc, ["unit-browser"]),
    );
  });

  test("a plane whose reason rows do not sum to its Skips column is named", () => {
    // The totals-equality is a checked claim: a hand-built doc that lies gets
    // called out instead of printed as a quiet wrong total.
    const lying: VerdictDoc = {
      schema: "flawless-verdict/1",
      tool: "test",
      entries: {
        "unit-browser": {
          targetHash: "sha256:1",
          ok: true,
          written: 1,
          findings: 0,
          skips: 5,
          skipReasons: [{ reason: "r", count: 3 }],
          evidence: [],
          summary: "",
        },
      },
    };
    const md = renderVerdictMarkdown(lying, []);
    expect(md).toContain(
      "Tally mismatch — `unit-browser`: Skips column says 5, reason rows sum 3.",
    );
    expect(md).toContain("do NOT equal");
  });
});

describe("makeFileClaimer", () => {
  const results = [
    { id: "unit-browser", outputs: ["/s/unit/A.test.tsx"] },
    { id: "e2e", outputs: ["/s/e2e/route.spec.ts"] },
  ];
  test("a file is claimed by the task that wrote it", () => {
    const claim = makeFileClaimer("/s", results, "unit-browser");
    expect(claim("/s/unit/A.test.tsx")).toBe("unit-browser");
    expect(claim("/s/e2e/route.spec.ts")).toBe("e2e");
  });
  test("a kept file falls to its plane directory; outside the suite, the colocated plane", () => {
    const claim = makeFileClaimer("/s", [], "unit-browser");
    expect(claim("/s/browser/Kept.spec.ts")).toBe("unit-browser");
    expect(claim("/s/profile/Kept.spec.ts")).toBe("perf-harness");
    expect(claim("/s/load/last-x.json")).toBe("load");
    expect(claim("/app/src/kept.flawless.test.tsx")).toBe("unit-browser");
    expect(makeFileClaimer("/s", [], undefined)("/app/src/kept.flawless.test.tsx")).toBeUndefined();
  });
});

describe("writeVerdict", () => {
  test("writes both files and accumulates across calls", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "verdict-write-"));
    const first = await writeVerdict(dir, run([task("perf-harness")], [], "sha256:1"));
    const md1 = await Bun.file(first.mdPath).text();
    expect(first.mdPath).toBe(path.join(dir, VERDICT_MD));
    expect(first.jsonPath).toBe(path.join(dir, VERDICT_JSON));
    expect(md1).toContain("perf-harness");
    expect(md1).not.toContain("unit-browser");

    const second = await writeVerdict(dir, run([task("unit-browser")], [], "sha256:2"));
    const md2 = await Bun.file(second.mdPath).text();
    const json2 = await Bun.file(second.jsonPath).text();
    expect(md2).toContain("perf-harness");
    expect(md2).toContain("unit-browser");

    // Acceptance item 4's core property: rerunning the same task against the
    // same target rewrites the files byte-identically.
    const third = await writeVerdict(dir, run([task("unit-browser")], [], "sha256:2"));
    expect(await Bun.file(third.mdPath).text()).toBe(md2);
    expect(await Bun.file(third.jsonPath).text()).toBe(json2);
  });

  test("an unreadable existing verdict starts the record fresh instead of throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "verdict-bad-"));
    await writeFile(path.join(dir, VERDICT_JSON), "{ not json");
    const r = await writeVerdict(dir, run([task("a11y")]));
    expect(Object.keys(r.doc.entries)).toEqual(["a11y"]);
  });
});
