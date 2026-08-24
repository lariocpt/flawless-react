import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  test("stdout is exactly one JSON blob carrying {exitCode, outDir, results}", async () => {
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
        results: Array<{ id: string; ok: boolean; summary: string }>;
        keptScripts: string[];
      };
      expect(blob.exitCode).toBe(0);
      // Echoing the tmpdir back proves --out was honored — existence alone is
      // vacuous here (the test pre-created the dir), and a run that ignored
      // --out would still have created whatever dir it reported.
      expect(blob.outDir).toBe(out);
      expect(existsSync(path.join(blob.outDir, "reports", "summary.json"))).toBe(true);
      expect(blob.results.map((r) => r.id)).toEqual(["perf-static"]);
      expect(blob.results[0]?.ok).toBe(true);
      expect(typeof blob.results[0]?.summary).toBe("string");
      // keptScripts joined the blob in FR-034; empty outside Next.js mode is
      // fine, but the key itself must ride along or scripted callers branch
      // on undefined.
      expect(Array.isArray(blob.keptScripts)).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 30000);

  // B-13: --ci is the mode built for machines, and it was the one that lost its
  // diagnostics. warn() writes to STDERR but was gated on the same predicate as
  // log(), so `warning: skipping <file>` — a component that silently vanished
  // from the sweep — was invisible in exactly the mode a scripted caller reads.
  // The stdout purity --json needs is a statement about stdout, not a vow of
  // silence, so both halves are pinned in ONE test: split them across two and
  // the next change re-conflates the gates without either going red.
  test("a warning reaches stderr while stdout stays exactly one JSON blob", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-ci-warn-"));
    try {
      const src = path.join(dir, "src");
      await mkdir(src, { recursive: true });
      await writeFile(
        path.join(src, "Ok.tsx"),
        "export const Ok = ({ name }: { name: string }) => <div>{name}</div>;\n",
      );
      // A value constant, not a component: analyseFile throws, the sweep catches
      // it, records it as unparseable and warns. The run still succeeds on the
      // sibling, which is the point — this is the diagnostic for work that was
      // skipped inside an otherwise green run, the easiest kind to lose.
      await writeFile(path.join(src, "NotAComponent.tsx"), "export const NOOP = () => null;\n");
      const proc = Bun.spawn(
        [
          "bun",
          BIN,
          "src/*.tsx",
          "--ci",
          "--tasks",
          "perf-static",
          "--no-inline-summary",
          "--out",
          "out",
        ],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      // The half that was lost.
      expect(stderr).toContain("warning: skipping");
      expect(stderr).toContain("NotAComponent.tsx");
      // The half it must not cost: still exactly one blob, whole-stdout parsed.
      const blob = JSON.parse(stdout) as { exitCode: number; results: Array<{ id: string }> };
      expect(blob.exitCode).toBe(0);
      expect(blob.results.map((r) => r.id)).toEqual(["perf-static"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  // Control for the test above: without a provoking input that string is absent,
  // so the stderr assertion is reading the diagnostic rather than matching
  // ambient chatter that a --ci run emits anyway.
  test("a clean --ci run emits no skip warning — the assertion above can fail", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "flawless-ci-"));
    try {
      const proc = Bun.spawn(
        ["bun", BIN, CARD, "--ci", "--tasks", "perf-static", "--no-inline-summary", "--out", out],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).not.toContain("warning: skipping");
      expect(() => JSON.parse(stdout)).not.toThrow();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 30000);

  // The worst of the nine warn sites, and the only one that accompanies
  // `anyFailed = true`: a Next.js emit that FAILED the run. Under the shared
  // gate a --ci caller got exit 1 with an EMPTY stderr — the run said it was
  // broken and refused to say how. Provoked deterministically by making
  // .gitignore a DIRECTORY, so updateGitignore's writeFileSync throws EISDIR
  // from inside core's try. (Found by the mutation pass: deleting this warn
  // call was invisible to all 822 tests.)
  test("a failed Next.js emit exits 1 and says why on stderr", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-ci-emitfail-"));
    try {
      const app = path.join(dir, "app");
      cpSync(path.resolve(__dirname, "fixtures", "nextapp"), app, { recursive: true });
      mkdirSync(path.join(app, ".gitignore"));
      const proc = Bun.spawn(
        ["bun", BIN, "--nextjs", app, "--ci", "--tasks", "perf-static", "--no-inline-summary"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain("nextjs emit failed");
      // …and the red run still hands the caller one parseable blob.
      const blob = JSON.parse(stdout) as { exitCode: number };
      expect(blob.exitCode).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  // The same line without --json is the control that proves the whole-stdout
  // JSON.parse above CAN fail: the human summary table is not JSON, so a
  // regression that leaks it into a --ci run cannot slip past a vacuous parse.
  test("without --json the summary table makes JSON.parse throw", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "flawless-ci-"));
    try {
      const proc = Bun.spawn(
        [
          "bun",
          BIN,
          CARD,
          "--no-interactive",
          "--tasks",
          "perf-static",
          "--no-inline-summary",
          "--out",
          out,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
      expect(() => JSON.parse(stdout)).toThrow();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 30000);

  // A red run must still hand the caller one parseable blob: exit 1 on the
  // process, the same 1 mirrored inside, and the failing task visible in
  // results. The cheapest deterministic red is a Next-only task outside
  // --nextjs mode — no server, no suite run, same code path through main().
  test("a failing task exits 1 and the blob still parses with exitCode 1", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "flawless-ci-"));
    try {
      const proc = Bun.spawn(
        ["bun", BIN, CARD, "--ci", "--tasks", "e2e", "--no-inline-summary", "--out", out],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(1);
      const blob = JSON.parse(stdout) as {
        exitCode: number;
        results: Array<{ id: string; ok: boolean }>;
        keptScripts: string[];
      };
      expect(blob.exitCode).toBe(1);
      expect(blob.results.find((r) => r.id === "e2e")?.ok).toBe(false);
      expect(Array.isArray(blob.keptScripts)).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 30000);

  // parseArgs throws before anything reaches stdout, so a scripted caller
  // piping stdout into JSON.parse sees "" — not half a table — and exit 2
  // distinguishes "you called it wrong" from "the run went red".
  test("an unknown flag exits 2 with the message on stderr and stdout empty", async () => {
    const proc = Bun.spawn(["bun", BIN, CARD, "--ci", "--definitely-not-a-flag"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("unknown flag: --definitely-not-a-flag");
  }, 30000);

  test("a usage error exits 2 and leaves stdout empty", async () => {
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
  }, 30000);

  test("a rejection escaping main() exits 1 with the error alone on stderr", async () => {
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
  }, 30000);
});

// FR-031: --help/--version must not pay for the TypeScript compiler. The
// analyser (src/analyse/*) imports `typescript`, and a top-level value-import
// of ./core.ts drags it into every invocation before parseArgs even runs.
describe("startup latency (FR-031)", () => {
  const CLI = path.resolve(__dirname, "../src/cli.ts");

  test("--help answers fast (no compiler on the startup path)", async () => {
    const started = performance.now();
    const proc = Bun.spawn(["bun", CLI, "--help"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const elapsed = performance.now() - started;
    expect(out).toContain("flawless-react");
    // Measured on this machine: ~131ms with the top-level core.ts import
    // (typescript in the graph), ~14ms without. 100ms sits between the two
    // clusters with margin on both sides, so a compiler regression trips it
    // while CI jitter does not.
    expect(elapsed).toBeLessThan(100);
  });

  // Bytes-level guard: timing can flake, source cannot. Only `import type` may
  // reference ./core.ts at top level; the value import must stay dynamic.
  test("cli.ts has no top-level value-import of ./core.ts", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/cli.ts"), "utf8");
    const coreImports = src.match(/^import\s[^;]*?from\s+"\.\/core\.ts";?$/gm) ?? [];
    for (const line of coreImports) {
      expect(line.startsWith("import type")).toBe(true);
    }
  });
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

  // FR-033: a trailing `--depth`/`--variants` used to silently fall back to the
  // default instead of failing like their --out sibling.
  test("--depth without a value throws", () => {
    expect(() => parseArgs(["x.tsx", "--depth"])).toThrow(/--depth requires a value/);
  });

  test("--variants without a value throws", () => {
    expect(() => parseArgs(["x.tsx", "--variants"])).toThrow(/--variants requires a value/);
  });

  // FR-033: raw JSON.parse errors ("JSON Parse error: …") name no flag; the
  // rethrow must say which flag failed and keep the original diagnostic.
  test("--props with invalid JSON names the flag in both forms", () => {
    expect(() => parseArgs(["x.tsx", "--props", "{bad"])).toThrow(/--props is not valid JSON/);
    expect(() => parseArgs(["x.tsx", "--props={bad"])).toThrow(/--props is not valid JSON/);
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
