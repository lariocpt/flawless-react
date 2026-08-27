// Expo mode's detector and its refusals, checked against a real fixture project
// and real CLI runs — not against a reading of the source.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../src/cli.ts";
import { FLAG_NAMES } from "../src/cliFlags.ts";
import { detectExpo, expoWebPort, majorOf } from "../src/expo/detect.ts";
import { platformOf } from "../src/platform.ts";
import { UsageError } from "../src/types.ts";

const EXPOAPP = path.resolve(__dirname, "fixtures/expoapp");
const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "flawless-expo-"));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("detectExpo", () => {
  test("reads the fixture project", async () => {
    const ctx = await detectExpo(EXPOAPP);
    expect(ctx.root).toBe(EXPOAPP);
    expect(ctx.routerRoot).toBe(path.join(EXPOAPP, "app"));
    expect(ctx.sdkMajor).toBe(54);
    expect(ctx.routerMajor).toBe(6);
    // Both read off disk, and both change what a later wave emits: the compiler
    // flag suppresses three perf-static rules, and nativewind decides whether an
    // unstyled host is honest to ship.
    expect(ctx.reactCompiler).toBe(true);
    expect(ctx.nativewind).toBe(true);
    // From the fixture's own `web` script (`--port 8081`), not from the default.
    expect(ctx.webPort).toBe(8081);
  });

  test("a missing directory and a non-Expo directory are both UsageErrors", async () => {
    expect(detectExpo(path.join(EXPOAPP, "nope"))).rejects.toThrow(UsageError);
    // A bare app.json is NOT proof — the name is generic and the `expo` key is
    // what distinguishes an Expo config from anything else called app.json.
    const d = tmp();
    writeFileSync(path.join(d, "app.json"), JSON.stringify({ name: "not-expo" }));
    writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x" }));
    expect(detectExpo(d)).rejects.toThrow(/does not look like an Expo project/);
  });

  test("expo in dependencies is enough, with no app.json at all", async () => {
    const d = tmp();
    writeFileSync(
      path.join(d, "package.json"),
      JSON.stringify({ name: "x", dependencies: { expo: "~53.0.0" } }),
    );
    const ctx = await detectExpo(d);
    expect(ctx.sdkMajor).toBe(53);
    // No expo-router dependency means no router root, even though many projects
    // happen to have an app/ directory. The dependency is the evidence.
    expect(ctx.routerRoot).toBeUndefined();
    expect(ctx.routerMajor).toBeUndefined();
    expect(ctx.reactCompiler).toBe(false);
    expect(ctx.nativewind).toBe(false);
    expect(ctx.webPort).toBe(8081);
  });
});

describe("majorOf — never guesses", () => {
  const none = path.join(EXPOAPP, "does-not-exist", "package.json");
  test.each([
    ["~54.0.33", 54],
    ["^54.0.0", 54],
    ["54.0.33", 54],
    ["54.x", 54],
    [">=54.0.0 <55", 54],
    ["  54 ", 54],
  ])("%s -> %p", (range, want) => {
    expect(majorOf(range as string, none)).toBe(want as number);
  });

  // The whole point of the field being nullable. A jest-expo major that does not
  // match the SDK fails deep inside expo-modules-core with a message that names
  // nothing, so an unreadable range must produce "unknown", never a number.
  test.each([
    "latest",
    "*",
    "next",
    "github:expo/expo",
    "file:../expo",
  ])("%s -> undefined, rather than a guess", (range) => {
    expect(majorOf(range, none)).toBeUndefined();
  });

  test("falls back to what is actually installed when the range says nothing", () => {
    const d = tmp();
    writeFileSync(path.join(d, "package.json"), JSON.stringify({ version: "57.0.5" }));
    expect(majorOf("latest", path.join(d, "package.json"))).toBe(57);
  });
});

describe("expoWebPort", () => {
  // A sibling of devScriptPort, not a parameterisation: different script keys
  // AND a different default. Metro serves 8081; Next serves 3000.
  test("defaults to Metro's 8081, never to 3000", () => {
    expect(expoWebPort(undefined)).toBe(8081);
    expect(expoWebPort({ dev: "next dev -p 3000" })).toBe(8081);
  });
  test.each([
    [{ web: "expo start --web --port 8090" }, 8090],
    [{ web: "expo start --web -p 19006" }, 19006],
    [{ start: "expo start --port 8100" }, 8100],
  ])("%o -> %p", (scripts, want) => {
    expect(expoWebPort(scripts as Record<string, string>)).toBe(want as number);
  });
  test("web wins over start", () => {
    expect(expoWebPort({ web: "expo start --web -p 1111", start: "expo start -p 2222" })).toBe(
      1111,
    );
  });
});

describe("--expo, as a flag", () => {
  test("is in the inventory, so --help and the README table cannot omit it", () => {
    expect(FLAG_NAMES).toContain("--expo");
  });

  test("parses in every documented spelling, and opens no file doing it", () => {
    expect(parseArgs(["x.tsx", "--expo", "."]).expo).toBe(".");
    expect(parseArgs(["x.tsx", "--expo=apps/mobile"]).expo).toBe("apps/mobile");
    // Bare, like --nextjs: the value is optional and defaults to cwd.
    expect(parseArgs(["x.tsx", "--expo"]).expo).toBe(".");
    // A path that does not exist still PARSES. Validation belongs to detectExpo
    // at run time, because --check's contract is that it opens no file.
    expect(parseArgs(["x.tsx", "--expo", "/nowhere/at/all"]).expo).toBe("/nowhere/at/all");
  });

  test("is mutually exclusive with --nextjs", () => {
    expect(() => parseArgs(["x.tsx", "--expo", ".", "--nextjs", "."])).toThrow(
      /mutually exclusive/,
    );
    // Order must not matter — the check is on the pair, not on which came last.
    expect(() => parseArgs(["x.tsx", "--nextjs", ".", "--expo", "."])).toThrow(
      /mutually exclusive/,
    );
  });

  test("--help and --version still answer with both flags present", () => {
    // The mutual-exclusion check sits behind the same guard as --depth's, so the
    // parse-only surfaces never pay for it.
    expect(parseArgs(["--help", "--expo", ".", "--nextjs", "."]).help).toBe(true);
    expect(parseArgs(["--version", "--expo", ".", "--nextjs", "."]).version).toBe(true);
  });

  test("--expo alone satisfies the entry requirement, like --nextjs", () => {
    expect(parseArgs(["--expo", "."]).entry).toBeUndefined();
  });
});

describe("platformOf", () => {
  test("is native only when an Expo context is present", async () => {
    expect(platformOf({ expo: undefined })).toBe("web");
    expect(platformOf({})).toBe("web");
    expect(platformOf({ expo: await detectExpo(EXPOAPP) })).toBe("native");
  });
});

describe("--out outside the project", () => {
  // Both failures were observed on a real run, and both put a path from THIS
  // machine into the user's repository:
  //
  //   "flawless:unit": "jest --config ../../../../../../../tmp/mockfix2/out/jest.config.cjs"
  //   .gitignore:      ../../../../tmp/mockfix2/out/reports/   (× 10)
  //
  // A project mode does not merely choose a directory — it merges scripts into
  // the project's package.json and adds entries to its .gitignore, both computed
  // relative to the project. So an out dir outside it is not a preference, it is
  // a run that writes paths escaping the repository.
  test("is refused, naming the escape", async () => {
    const d = tmp();
    cpSync(EXPOAPP, path.join(d, "app"), { recursive: true });
    const proc = Bun.spawn(
      [
        "bun",
        path.resolve(__dirname, "..", "src", "bin.ts"),
        "--expo",
        path.join(d, "app"),
        "--out",
        path.join(d, "elsewhere"),
        "--ci",
        "--tasks",
        "perf-static",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
    expect(stderr).toMatch(/is outside the --expo project/);
    // The message has to name the way out, or the only option is to guess.
    expect(stderr).toMatch(/Drop --out/);
  }, 60_000);

  test("an out dir inside the project is fine, and so is the default", async () => {
    const d = tmp();
    const app = path.join(d, "app");
    cpSync(EXPOAPP, app, { recursive: true });
    for (const args of [["--out", path.join(app, "qa")], []]) {
      const proc = Bun.spawn(
        [
          "bun",
          path.resolve(__dirname, "..", "src", "bin.ts"),
          "--expo",
          app,
          "--ci",
          "--tasks",
          "perf-static",
          "--no-inline-summary",
          ...args,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(`${args.join(" ")}:${await proc.exited}`).toBe(`${args.join(" ")}:0`);
    }
  }, 120_000);
});
