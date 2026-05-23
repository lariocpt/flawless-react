import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli.ts";

describe("parseArgs", () => {
  test("entry only → defaults", () => {
    const a = parseArgs(["./Foo.tsx"]);
    expect(a.entry).toBe("./Foo.tsx");
    expect(a.depth).toBe(3);
    expect(a.variants).toBe(5);
    expect(a.includeChildren).toBe(true);
    expect(a.force).toBe(false);
    expect(a.report).toBe(false);
    expect(a.out).toBeUndefined();
  });

  test("all flags, --foo=value form", () => {
    const a = parseArgs([
      "./Foo.tsx",
      "--out=./out",
      "--depth=1",
      "--variants=10",
      "--include-children=false",
      '--props={"x":1}',
      "--force",
      "--report",
    ]);
    expect(a.out).toBe("./out");
    expect(a.depth).toBe(1);
    expect(a.variants).toBe(10);
    expect(a.includeChildren).toBe(false);
    expect(a.force).toBe(true);
    expect(a.report).toBe(true);
    expect(a.propsOverride).toEqual({ x: 1 });
  });

  test("space-separated form", () => {
    const a = parseArgs(["./Foo.tsx", "--out", "./out", "--depth", "2", "--variants", "7"]);
    expect(a.out).toBe("./out");
    expect(a.depth).toBe(2);
    expect(a.variants).toBe(7);
  });

  test("entry is optional (interactive mode handles missing entry)", () => {
    const a = parseArgs([]);
    expect(a.entry).toBeUndefined();
  });

  test("unknown flag throws", () => {
    expect(() => parseArgs(["./Foo.tsx", "--bogus"])).toThrow(/unknown flag/);
  });

  test("negative depth rejected", () => {
    expect(() => parseArgs(["./Foo.tsx", "--depth=-1"])).toThrow(/--depth/);
  });

  test("--tasks csv parses to TaskId[]", () => {
    const a = parseArgs(["./Foo.tsx", "--tasks=perf-harness,a11y,react-rules"]);
    expect(a.tasks).toEqual(["perf-harness", "a11y", "react-rules"]);
  });

  test("--tasks rejects unknown ids", () => {
    expect(() => parseArgs(["./Foo.tsx", "--tasks=perf-harness,bogus"])).toThrow(/unknown task/);
  });

  test("--no-interactive + --run-tests + --no-inline-summary flags parse", () => {
    const a = parseArgs(["./Foo.tsx", "--no-interactive", "--run-tests", "--no-inline-summary"]);
    expect(a.noInteractive).toBe(true);
    expect(a.runTests).toBe(true);
    expect(a.inlineSummary).toBe(false);
  });

  test("glob pattern allowed as positional", () => {
    const a = parseArgs(["src/**/*.tsx"]);
    expect(a.entry).toBe("src/**/*.tsx");
  });
});
