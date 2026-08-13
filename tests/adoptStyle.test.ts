import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptProjectStyle, detectJsonIndent, stringifyLike } from "../src/scaffold/adoptStyle.ts";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-style-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("detectJsonIndent", () => {
  test("reads the indentation actually used by the file on disk", () => {
    const dir = tmpDir();
    const cases: Array<[string, string, string]> = [
      ["tabs.json", '{\n\t"a": 1,\n\t"b": 2\n}\n', "\t"],
      ["four.json", '{\n    "a": 1,\n    "b": 2\n}\n', "    "],
      ["two.json", '{\n  "a": 1,\n  "b": 2\n}\n', "  "],
      ["flat.json", '{"a":1,"b":2}\n', "  "],
    ];
    for (const [name, source, expected] of cases) {
      const file = path.join(dir, name);
      writeFileSync(file, source);
      expect(detectJsonIndent(readFileSync(file, "utf8"))).toBe(expected);
    }
  });

  test("tabs win over spaces and unindented files fall back to two spaces", () => {
    expect(detectJsonIndent('{\n\t"a": 1\n}')).toBe("\t");
    expect(detectJsonIndent('{\n      "a": 1\n}')).toBe("      ");
    expect(detectJsonIndent("")).toBe("  ");
    expect(detectJsonIndent("not json at all")).toBe("  ");
  });
});

describe("stringifyLike", () => {
  test("preserves tab indentation and the original trailing newline", () => {
    const original = '{\n\t"name": "app",\n\t"version": "1.0.0"\n}\n';
    const out = stringifyLike(original, { name: "app", nested: { deep: true } });
    expect(out).toBe(`${JSON.stringify({ name: "app", nested: { deep: true } }, null, "\t")}\n`);
    expect(out).toContain('\n\t"name": "app"');
    expect(out).toContain('\n\t\t"deep": true');
    expect(out.endsWith("}\n")).toBe(true);
  });

  test("drops the trailing newline when the original had none", () => {
    const original = '{\n    "a": 1\n}';
    const out = stringifyLike(original, { a: 1, b: 2 });
    expect(out.endsWith("\n")).toBe(false);
    expect(out).toBe(JSON.stringify({ a: 1, b: 2 }, null, "    "));
    expect(out).toContain('\n    "a": 1');
  });
});

describe("adoptProjectStyle", () => {
  test("no formatter config anywhere → formatter none and files untouched", async () => {
    const dir = tmpDir();
    const target = path.join(dir, "generated.ts");
    const before = "export  const   x =   {a:1,\n        b:2}\n";
    writeFileSync(target, before);

    const result = await adoptProjectStyle(dir, [target]);
    expect(result).toEqual({ formatter: "none", formatted: 0 });
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("an empty file list short-circuits to formatter none", async () => {
    const dir = tmpDir();
    expect(await adoptProjectStyle(dir, [])).toEqual({ formatter: "none", formatted: 0 });
    // Non-existent paths are filtered out before any formatter is detected.
    expect(await adoptProjectStyle(dir, [path.join(dir, "missing.ts")])).toEqual({
      formatter: "none",
      formatted: 0,
    });
  });

  test("a biome.json in the root selects biome and never throws", async () => {
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, "biome.json"),
      `${JSON.stringify({ formatter: { enabled: true, indentStyle: "space", indentWidth: 2 } }, null, 2)}\n`,
    );
    const target = path.join(dir, "generated.ts");
    writeFileSync(target, "export const x = 1\n");

    // The biome binary may or may not be resolvable from a tmp dir; either way the
    // contract is the same — resolve with formatter "biome", never reject.
    const result = await adoptProjectStyle(dir, [target]);
    expect(result.formatter).toBe("biome");
    expect(typeof result.formatted).toBe("number");
    expect(result.formatted).toBeGreaterThanOrEqual(0);
    if (result.formatted === 0) expect(typeof result.warning).toBe("string");
  });

  test("non-formattable extensions are ignored even when a formatter is configured", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "biome.json"), "{}\n");
    const heap = path.join(dir, "run.heapsnapshot");
    const before = '{"nodes":[1,2,3]}';
    writeFileSync(heap, before);

    const result = await adoptProjectStyle(dir, [heap]);
    expect(result).toEqual({ formatter: "none", formatted: 0 });
    expect(readFileSync(heap, "utf8")).toBe(before);
  });
});
