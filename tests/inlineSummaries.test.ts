import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeInlineSummaries } from "../src/reporters/findings.ts";
import type { ComponentInfo, ComponentTree, TaskResult } from "../src/types.ts";

function comp(name: string, dir: string): ComponentInfo {
  return {
    componentName: name,
    filePath: path.join(dir, `${name}.tsx`),
    importSpecifier: `./${name}.tsx`,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
  };
}

const tree = (entry: ComponentInfo, children: ComponentTree[] = []): ComponentTree => ({
  entry,
  children,
});

function perfStaticFinding(file: string, line: number, message: string): TaskResult {
  return {
    id: "perf-static",
    ok: true,
    outputs: [],
    summary: "",
    findings: [
      {
        rule: "perf/early-exit",
        severity: "warn",
        file,
        line,
        column: 1,
        message,
        source: "perf-static",
      },
    ],
  } as TaskResult;
}

async function readSidecar(dir: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, `${name}.flawless.json`), "utf8"));
}

describe("writeInlineSummaries", () => {
  test("same-named components in different directories keep both sidecars and both findings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flawless-inline-"));
    try {
      const a = path.join(root, "a");
      const b = path.join(root, "b");
      await mkdir(a, { recursive: true });
      await mkdir(b, { recursive: true });

      const trees = [tree(comp("Header", a)), tree(comp("Header", b))];
      const results = [
        perfStaticFinding(path.join(a, "Header.tsx"), 3, "a: early exit"),
        perfStaticFinding(path.join(b, "Header.tsx"), 9, "b: early exit"),
      ];

      const written = (await writeInlineSummaries(trees, results, root)).sort();
      expect(written).toEqual([
        path.join(a, "Header.flawless.json"),
        path.join(b, "Header.flawless.json"),
      ]);

      // Keyed on the bare name, the first Header won the map entry and the
      // second file's finding was dropped with no sidecar at all.
      const sa = await readSidecar(a, "Header");
      const sb = await readSidecar(b, "Header");
      expect(sa.component).toBe("Header");
      expect(sb.component).toBe("Header");
      expect(sa.file).toBe("Header.tsx");
      expect(sb.file).toBe("Header.tsx");
      const topA = sa.top as Array<{ message: string }>;
      const topB = sb.top as Array<{ message: string }>;
      expect(topA.map((t) => t.message)).toEqual(["a: early exit"]);
      expect(topB.map((t) => t.message)).toEqual(["b: early exit"]);
      const counts = (s: Record<string, unknown>) =>
        (s.counts as Record<string, number>)["perf-static"];
      expect(counts(sa)).toBe(1);
      expect(counts(sb)).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a child rendered by two parents still collapses to one sidecar", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flawless-inline-"));
    try {
      const src = path.join(root, "src");
      await mkdir(src, { recursive: true });
      const shared = comp("Pill", src);

      // The same tree node appears under two roots — the dedupe this key must
      // not undo while fixing the cross-directory collapse.
      const child = tree(shared);
      const trees = [tree(comp("PageA", src), [child]), tree(comp("PageB", src), [child])];
      const results = [perfStaticFinding(path.join(src, "Pill.tsx"), 5, "pill: early exit")];

      const written = (await writeInlineSummaries(trees, results, root)).sort();
      expect(written).toEqual([
        path.join(src, "PageA.flawless.json"),
        path.join(src, "PageB.flawless.json"),
        path.join(src, "Pill.flawless.json"),
      ]);
      const pill = await readSidecar(src, "Pill");
      expect((pill.counts as Record<string, number>)["perf-static"]).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
