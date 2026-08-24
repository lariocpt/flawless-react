import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";

describe("VERSION", () => {
  test("does not drift from package.json", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  // parseArgs terminates the -V branch with process.exit(0), so a subprocess is
  // the only way to cover it. src/bin.ts is the entry that actually calls main().
  test("-V prints the package version", async () => {
    const proc = Bun.spawn(["bun", path.resolve(__dirname, "../src/bin.ts"), "-V"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toBe(`flawless-react ${VERSION}\n`);
  });

  // `bun src/cli.ts …` used to be a silent exit-0 no-op — cli.ts only exported
  // main() and nothing called it, the same trap bin.ts's header documents for
  // the compile entry. A real session lost an afternoon to it (the project
  // memory blamed the sandbox); running the obvious entry must do something.
  test("bun src/cli.ts -V is not a silent no-op", async () => {
    const proc = Bun.spawn(["bun", path.resolve(__dirname, "../src/cli.ts"), "-V"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toBe(`flawless-react ${VERSION}\n`);
  });
});

// FR-020: the --ci process contract — a consumer pipes the ENTIRE stdout into
// JSON.parse, so the stream must be one blob and nothing else, and the exit
// code has to ride inside it or a scripted caller needs shell plumbing around
// $? to learn whether the run was green. Only a subprocess can observe stdout,
// stderr and the exit code at once.
describe("--ci process contract", () => {
  const BIN = path.resolve(__dirname, "../src/bin.ts");
  const CARD = path.resolve(__dirname, "fixtures/Card.tsx");

  test(
    "stdout is exactly one JSON blob carrying {exitCode, outDir, results}",
    async () => {
      const out = await mkdtemp(path.join(tmpdir(), "flawless-ci-"));
      try {
        // --no-inline-summary: without it the run drops a Card.flawless.json
        // sidecar beside the tracked fixture, dirtying the repo on every run.
        const proc = Bun.spawn(
          ["bun", BIN, CARD, "--ci", "--tasks", "perf-static", "--no-inline-summary", "--out", out],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        const blob = JSON.parse(stdout) as {
          exitCode: number;
          outDir: string;
          results: Array<{ id: string }>;
        };
        expect(blob.exitCode).toBe(0);
        expect(typeof blob.outDir).toBe("string");
        expect(blob.results.map((r) => r.id)).toEqual(["perf-static"]);
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    },
    30000,
  );

  test(
    "a usage error exits 2 and leaves stdout empty",
    async () => {
      const out = await mkdtemp(path.join(tmpdir(), "flawless-ci-"));
      try {
        const proc = Bun.spawn(
          ["bun", BIN, "does-not-exist-*.tsx", "--ci", "--tasks", "perf-static", "--out", out],
          { stdout: "pipe", stderr: "pipe" },
        );
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(2);
        expect(stdout.trim()).toBe("");
      } finally {
        await rm(out, { recursive: true, force: true });
      }
    },
    30000,
  );

  test(
    "a rejection escaping main() exits 1 with the error alone on stderr",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "flawless-ci-"));
      try {
        // The only throw sites outside main()'s try/catch are its trailing
        // stdout writes, so fault-inject there: refuse the JSON blob itself.
        const preload = path.join(dir, "preload.ts");
        await writeFile(
          preload,
          `const original = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  if (typeof chunk === "string" && chunk.startsWith("{")) throw new Error("stdout torn down");
  return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;
`,
        );
        const proc = Bun.spawn(
          [
            "bun",
            `--preload=${preload}`,
            path.resolve(__dirname, "../src/cli.ts"),
            CARD,
            "--ci",
            "--tasks",
            "perf-static",
            "--no-inline-summary",
            "--out",
            path.join(dir, "out"),
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const stderr = await new Response(proc.stderr).text();
        expect(await proc.exited).toBe(1);
        // The entry catch writes String(err.stack): the message leads, with
        // none of the runtime's uncaught-error framing around it.
        expect(stderr.startsWith("Error: stdout torn down")).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30000,
  );
});

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
