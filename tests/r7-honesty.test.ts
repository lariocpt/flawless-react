import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedFiles } from "../src/changed.ts";
import { reproCommand, runCore, UsageError } from "../src/core.ts";
import { runBiome } from "../src/tasks/biomeRunner.ts";

/**
 * Round-7 review findings, each pinned by the case that exposed it. Every one
 * is a variation on the house rule: the tool must never report a pass it did
 * not earn, and must never crash where it could say what went wrong.
 */

// The a11y sweep's rule set, mirrored from a11yScan's private helper — the
// test only needs a category-filtered run, not the full rule list.
const A11Y_RULES = { recommended: false, a11y: { noAccessKey: "error" } };

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function tinyProject(): { dir: string; entry: string } {
  const dir = tmp("flawless-r7-");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
  );
  const entry = path.join(dir, "src", "Card.tsx");
  writeFileSync(
    entry,
    `export function Card({ label }: { label: string }) {\n  return <div>{label}</div>;\n}\n`,
  );
  return { dir, entry };
}

describe("unknown task ids are an error, not a silent no-op", () => {
  test("a typo'd task id fails loudly instead of exiting 0 having run nothing", async () => {
    const { dir, entry } = tinyProject();
    // `taskIds.map(findTask).filter(Boolean)` used to drop the unknown id and
    // run zero tasks — exit 0, empty results, no message. A programmatic
    // caller (or a JSON config) with "unit" instead of "unit-browser" got a
    // green run that tested nothing.
    const run = runCore({
      pattern: entry,
      outDir: path.join(dir, "out"),
      // @ts-expect-error deliberately invalid id — the point of the test
      taskIds: ["unit"],
      log: false,
      inlineSummary: false,
    });
    await expect(run).rejects.toThrow(UsageError);
    await expect(run).rejects.toThrow(/unit/);
  }, 30000);

  test("the error names the valid ids so the fix is mechanical", async () => {
    const { dir, entry } = tinyProject();
    let message = "";
    try {
      await runCore({
        pattern: entry,
        outDir: path.join(dir, "out"),
        // @ts-expect-error deliberately invalid id
        taskIds: ["a11yy"],
        log: false,
        inlineSummary: false,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("a11yy");
    expect(message).toContain("a11y");
    expect(message).toContain("unit-browser");
  }, 30000);
});

describe("Next.js mode without an entry positional", () => {
  test("reproCommand uses the RESOLVED pattern — an auto-detected entry must not crash it", () => {
    // opts.pattern is typed `string` but is genuinely undefined in Next.js
    // auto-detection mode, where the local resolved pattern is what ran. The
    // report line used opts.pattern and died with `The "path" property must
    // be of type string, got undefined` AFTER every task had already run.
    const line = reproCommand(
      // @ts-expect-error reproducing the runtime shape: pattern absent
      { nextjs: "/proj", pattern: undefined },
      "/proj",
      ["perf-static"],
    );
    expect(typeof line).toBe("string");
    expect(line).toContain("flawless-react");
  });

  test("a real --nextjs run with no entry completes and reports its own command", async () => {
    const dir = tmp("flawless-r7-next-");
    cpSync(path.resolve(__dirname, "fixtures", "nextapp"), dir, { recursive: true });
    const result = await runCore({
      // @ts-expect-error the CLI allows this shape; detection fills it in
      pattern: undefined,
      nextjs: dir,
      outDir: path.join(dir, "flawless"),
      taskIds: ["perf-static"],
      report: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);
    const report = readFileSync(path.join(dir, "flawless", "REPORT.md"), "utf8");
    expect(report).toContain("flawless-react");
  }, 60000);
});

describe("--changed with a ref git cannot resolve", () => {
  test("an unresolvable ref is an error, not an empty changed set", async () => {
    // Every `git diff <bad-ref>` exits nonzero and was skipped with a bare
    // `continue`, so a typo — or a ref missing from a shallow CI clone —
    // silently produced "nothing affected" and a green run.
    const repo = path.resolve(__dirname, "..");
    await expect(changedFiles(repo, "definitely-not-a-ref-r7")).rejects.toThrow(UsageError);
    await expect(changedFiles(repo, "definitely-not-a-ref-r7")).rejects.toThrow(
      /definitely-not-a-ref-r7/,
    );
  }, 30000);

  test("a resolvable ref still works — the guard is not a blanket refusal", async () => {
    const repo = path.resolve(__dirname, "..");
    const files = await changedFiles(repo, "HEAD");
    expect(Array.isArray(files)).toBe(true);
  }, 30000);
});

describe("a file biome cannot parse is never reported clean", () => {
  test("a syntax error surfaces as a finding even under a category filter", async () => {
    const dir = tmp("flawless-r7-parse-");
    const broken = path.join(dir, "Broken.tsx");
    // A merge-conflict marker is the realistic case: biome emits a `parse`
    // diagnostic, which the a11y sweep's `lint/a11y` category filter dropped
    // on the floor — reporting "a11y: 0 findings" for a file it never read.
    writeFileSync(
      broken,
      `export function Broken() {\n<<<<<<< HEAD\n  return <div>a</div>;\n=======\n  return <div>b</div>;\n>>>>>>> other\n}\n`,
    );
    const findings = await runBiome({
      files: [broken],
      categoryPrefix: "lint/a11y",
      source: "a11y",
      rules: A11Y_RULES,
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => /parse|syntax/i.test(`${f.rule} ${f.message}`))).toBe(true);
  }, 60000);

  test("a clean file still reports nothing — the guard did not become noise", async () => {
    const dir = tmp("flawless-r7-clean-");
    const ok = path.join(dir, "Ok.tsx");
    writeFileSync(ok, `export function Ok() {\n  return <button type="button">go</button>;\n}\n`);
    const findings = await runBiome({
      files: [ok],
      categoryPrefix: "lint/a11y",
      source: "a11y",
      rules: A11Y_RULES,
    });
    expect(findings).toEqual([]);
  }, 60000);
});

describe("the RSC spec's rendered-output assertion can actually fail", () => {
  test("it asserts on the render container, not on document.body", async () => {
    const dir = tmp("flawless-r7-rsc-");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }, null, 2)}\n`,
    );
    const entry = path.join(dir, "src", "Panel.tsx");
    writeFileSync(
      entry,
      `import { getRows } from "./data";\n\nexport default async function Panel() {\n  const rows = await getRows();\n  return <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>;\n}\n`,
    );
    writeFileSync(
      path.join(dir, "src", "data.ts"),
      `export async function getRows(): Promise<string[]> {\n  throw new Error("never runs");\n}\n`,
    );
    const result = await runCore({
      pattern: entry,
      outDir: path.join(dir, "out"),
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);
    const spec = readFileSync(path.join(dir, "out", "unit", "Panel.test.tsx"), "utf8");
    // @testing-library always appends its container div to document.body, so
    // `document.body.innerHTML.length > 0` holds even when the component
    // rendered nothing at all — an assertion that cannot fail.
    expect(spec).not.toContain("document.body.innerHTML.length");
    expect(spec).toContain("container");
  }, 60000);
});
