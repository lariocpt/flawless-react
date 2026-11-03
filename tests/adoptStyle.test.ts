import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  test("the prettier pass overrides the repo's ignore files — its own output stays formatted", async () => {
    // A run appends `flawless/` to the repo's .prettierignore, and prettier skips
    // ignored files EVEN WHEN PASSED EXPLICITLY (proven on 3.0.3). Without an
    // --ignore-path override, the next run's format pass would silently do
    // nothing to the suite it just wrote. The stub records argv so the contract
    // is checked without network or a real prettier version.
    const dir = tmpDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ prettier: { semi: false } }));
    const bin = path.join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const argvFile = path.join(dir, "prettier-argv.txt");
    writeFileSync(path.join(bin, "prettier"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`);
    chmodSync(path.join(bin, "prettier"), 0o755);
    const target = path.join(dir, "flawless", "generated.ts");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "const x = 1\n");

    const result = await adoptProjectStyle(dir, [target]);
    expect(result.formatter).toBe("prettier");
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    const i = argv.indexOf("--ignore-path");
    expect(i).toBeGreaterThanOrEqual(0);
    // An EMPTY ignore file: the tool's explicit files all pass, while the repo's
    // own .prettierignore — which ignores those very files — stays in force for
    // the repo's own sweeps.
    const ignorePath = argv[i + 1];
    if (ignorePath === undefined) throw new Error("--ignore-path passed with no path");
    expect(readFileSync(ignorePath, "utf8")).toBe("");
  });

  test("prettier that cannot parse the tool's specs skips only the unparseable files", async () => {
    // talkformai: prettier 3.0.3 cannot parse the `with { type: "json" }`
    // import attributes every emitted profile spec carries (3.1+ syntax).
    // Failing the whole run there punishes a complete generation for the
    // repo's old pin; abandoning the whole pass would leave even the
    // parseable files unformatted. The contract: skip the unparseable,
    // format the rest, say so.
    const dir = tmpDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ prettier: {} }));
    const bin = path.join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const lastArgv = path.join(dir, "prettier-argv.txt");
    writeFileSync(
      path.join(bin, "prettier"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${lastArgv}'\nif printf '%s\\n' "$@" | grep -q 'bad.spec.ts'; then\n  echo '[error] flawless/bad.spec.ts: SyntaxError: ; expected. (3:39)' >&2\n  exit 2\nfi\n`,
    );
    chmodSync(path.join(bin, "prettier"), 0o755);
    mkdirSync(path.join(dir, "flawless"), { recursive: true });
    const bad = path.join(dir, "flawless", "bad.spec.ts");
    const good = path.join(dir, "flawless", "good.ts");
    writeFileSync(bad, 'import x from "./x.json" with { type: "json" };\nexport {};\n');
    writeFileSync(good, "export const y = 1\n");

    const result = await adoptProjectStyle(dir, [bad, good]);
    expect(result.formatter).toBe("prettier");
    expect(result.formatted).toBe(1);
    expect(String(result.warning)).toContain("predates");
    // The retry re-ran prettier WITHOUT the unparseable file.
    const argv = readFileSync(lastArgv, "utf8");
    expect(argv).toContain("good.ts");
    expect(argv).not.toContain("bad.spec.ts");
  });

  test(".mts configs reach the formatter — the one file biome ci checks either way", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "biome.json"), "{}\n");
    const target = path.join(dir, "vitest.config.mts");
    writeFileSync(target, "export default {\n  test: {},\n};\n");

    // The suite emits vitest.config.mts, and an adopter's `biome ci` checks
    // .mts files. If the style pass filters the extension out, the run still
    // reports every other file formatted while the one config it always emits
    // is the one file left in the template's indentation.
    const result = await adoptProjectStyle(dir, [target]);
    expect(result.formatter).toBe("biome");
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

describe("adoptProjectStyle: the eslint branch", () => {
  // The stub records its argv so the contract is checked without a real eslint
  // binary or a network — same pattern as the prettier ignore test above.
  function eslintStub(dir: string, argvFile: string): void {
    const bin = path.join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "eslint"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`);
    chmodSync(path.join(bin, "eslint"), 0o755);
  }

  test("a flat eslint.config.js is detected and the pass runs --fix --no-ignore on the JS files", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "eslint.config.js"), "export default [];\n");
    const argvFile = path.join(dir, "eslint-argv.txt");
    eslintStub(dir, argvFile);
    const target = path.join(dir, "generated.ts");
    writeFileSync(target, "const x = 1\n");

    const result = await adoptProjectStyle(dir, [target]);
    expect(result).toEqual({ formatter: "eslint", formatted: 1 });
    expect(readFileSync(argvFile, "utf8").trim().split("\n")).toEqual([
      "--fix",
      "--no-ignore",
      target,
    ]);
  });

  test("a legacy .eslintrc.json whose .eslintignore covers the suite dir still gets the files passed", async () => {
    // ensureFormatterIgnores appends the out dir to the repo's .eslintignore.
    // eslint skips ignored files even when they are passed explicitly, so the
    // pass takes --no-ignore to keep its own output in scope on the next run.
    const dir = tmpDir();
    writeFileSync(path.join(dir, ".eslintrc.json"), "{}\n");
    writeFileSync(path.join(dir, ".eslintignore"), "flawless/\n");
    const argvFile = path.join(dir, "eslint-argv.txt");
    eslintStub(dir, argvFile);
    const target = path.join(dir, "flawless", "spec.test.ts");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "const x = 1\n");

    const result = await adoptProjectStyle(dir, [target]);
    expect(result.formatter).toBe("eslint");
    expect(result.formatted).toBe(1);
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    expect(argv).toContain("--no-ignore");
    expect(argv).toContain(target);
  });

  test("a package.json eslintConfig key is a config too", async () => {
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", eslintConfig: { root: true } }),
    );
    const argvFile = path.join(dir, "eslint-argv.txt");
    eslintStub(dir, argvFile);
    const target = path.join(dir, "generated.ts");
    writeFileSync(target, "const x = 1\n");

    const result = await adoptProjectStyle(dir, [target]);
    expect(result).toEqual({ formatter: "eslint", formatted: 1 });
    expect(readFileSync(argvFile, "utf8").trim().split("\n")).toContain("--fix");
  });

  test("non-JS files are excluded from eslint's argv — passing them would be a hard error", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "eslint.config.js"), "export default [];\n");
    const argvFile = path.join(dir, "eslint-argv.txt");
    eslintStub(dir, argvFile);
    const json = path.join(dir, "data.json");
    const css = path.join(dir, "styles.css");
    const md = path.join(dir, "notes.md");
    const ts = path.join(dir, "code.ts");
    writeFileSync(json, "{}\n");
    writeFileSync(css, ".a {}\n");
    writeFileSync(md, "# hi\n");
    writeFileSync(ts, "const x = 1\n");

    const result = await adoptProjectStyle(dir, [json, css, md, ts]);
    expect(result.formatter).toBe("eslint");
    expect(result.formatted).toBe(1);
    expect(readFileSync(argvFile, "utf8").trim().split("\n")).toEqual(["--fix", "--no-ignore", ts]);
  });

  test("an eslint config with zero JS files formats nothing and never resolves a binary", async () => {
    // No node_modules in this dir: if the pass resolved a binary first and
    // warned about its absence, the formatter would read "eslint" — the JS
    // filter must short-circuit before that.
    const dir = tmpDir();
    writeFileSync(path.join(dir, "eslint.config.js"), "export default [];\n");
    const json = path.join(dir, "data.json");
    const md = path.join(dir, "notes.md");
    writeFileSync(json, "{}\n");
    writeFileSync(md, "# hi\n");

    const result = await adoptProjectStyle(dir, [json, md]);
    expect(result).toEqual({ formatter: "none", formatted: 0 });
    expect(readFileSync(json, "utf8")).toBe("{}\n");
  });

  test("a host carrying both prettier and eslint keeps the prettier pass — chain order wins", async () => {
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ prettier: { semi: false }, eslintConfig: { root: true } }),
    );
    const prettierArgv = path.join(dir, "prettier-argv.txt");
    const eslintArgv = path.join(dir, "eslint-argv.txt");
    const bin = path.join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "prettier"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${prettierArgv}'\n`,
    );
    chmodSync(path.join(bin, "prettier"), 0o755);
    writeFileSync(path.join(bin, "eslint"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${eslintArgv}'\n`);
    chmodSync(path.join(bin, "eslint"), 0o755);
    const target = path.join(dir, "generated.ts");
    writeFileSync(target, "const x = 1\n");

    const result = await adoptProjectStyle(dir, [target]);
    expect(result.formatter).toBe("prettier");
    expect(result.formatted).toBe(1);
    expect(existsSync(prettierArgv)).toBe(true);
    // The eslint stub was never invoked.
    expect(existsSync(eslintArgv)).toBe(false);
  });

  test("an eslint config with no resolvable binary warns instead of rejecting", async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "eslint.config.js"), "export default [];\n");
    const target = path.join(dir, "generated.ts");
    writeFileSync(target, "const x = 1\n");

    // eslint may or may not be on this machine's PATH; either way the
    // contract is the same — resolve with formatter "eslint", never reject.
    const result = await adoptProjectStyle(dir, [target]);
    expect(result.formatter).toBe("eslint");
    expect(result.formatted).toBeGreaterThanOrEqual(0);
    if (result.formatted === 0) expect(typeof result.warning).toBe("string");
  });
});
