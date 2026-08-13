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

  test("--colocate sets colocate (default false)", () => {
    expect(parseArgs(["./Foo.tsx"]).colocate).toBe(false);
    const a = parseArgs(["./Foo.tsx", "--colocate"]);
    expect(a.colocate).toBe(true);
    // --colocate is standalone: it must not swallow the next argument.
    const b = parseArgs(["./Foo.tsx", "--colocate", "--out=./out"]);
    expect(b.colocate).toBe(true);
    expect(b.out).toBe("./out");
  });

  test("--ci implies noInteractive and json", () => {
    const base = parseArgs(["./Foo.tsx"]);
    expect(base.ci).toBe(false);
    expect(base.noInteractive).toBe(false);
    expect(base.json).toBe(false);

    const a = parseArgs(["./Foo.tsx", "--ci"]);
    expect(a.ci).toBe(true);
    expect(a.noInteractive).toBe(true);
    expect(a.json).toBe(true);
  });

  test("--nextjs takes the next argument when it is not a flag", () => {
    const a = parseArgs(["--nextjs", "./my-app"]);
    expect(a.nextjs).toBe("./my-app");
    // The value was consumed, so it must not also land as the positional entry.
    expect(a.entry).toBeUndefined();

    const b = parseArgs(["--nextjs=./other-app"]);
    expect(b.nextjs).toBe("./other-app");
  });

  test("--nextjs without a value peeks and defaults to cwd", () => {
    expect(parseArgs(["--nextjs"]).nextjs).toBe(".");

    const a = parseArgs(["--nextjs", "--json"]);
    expect(a.nextjs).toBe(".");
    expect(a.json).toBe(true);
    expect(a.entry).toBeUndefined();

    const b = parseArgs(["./Foo.tsx", "--nextjs", "--tasks=a11y"]);
    expect(b.nextjs).toBe(".");
    expect(b.entry).toBe("./Foo.tsx");
    expect(b.tasks).toEqual(["a11y"]);

    // `--nextjs=` with an empty value also falls back to cwd.
    expect(parseArgs(["--nextjs="]).nextjs).toBe(".");
  });

  test("--tasks accepts the e2e and load ids", () => {
    expect(parseArgs(["./Foo.tsx", "--tasks=e2e,load"]).tasks).toEqual(["e2e", "load"]);
    expect(parseArgs(["./Foo.tsx", "--tasks", "load"]).tasks).toEqual(["load"]);
    expect(parseArgs(["./Foo.tsx", "--tasks= e2e , unit-browser "]).tasks).toEqual([
      "e2e",
      "unit-browser",
    ]);
  });

  test("--tasks rejects an unknown id and lists every valid one", () => {
    expect(() => parseArgs(["./Foo.tsx", "--tasks=e2e,loadtest"])).toThrow(
      /unknown task id: loadtest/,
    );
    let message = "";
    try {
      parseArgs(["./Foo.tsx", "--tasks=nope"]);
    } catch (err) {
      message = (err as Error).message;
    }
    for (const id of [
      "perf-harness",
      "unit-browser",
      "perf-static",
      "a11y",
      "react-rules",
      "e2e",
      "load",
    ]) {
      expect(message).toContain(id);
    }
  });
});
