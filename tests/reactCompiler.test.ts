import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configRootFor, detectReactCompiler } from "../src/reactCompiler.ts";

const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), `flawless-${prefix}-`));
  tmpDirs.push(d);
  return d;
}

function write(root: string, name: string, text: string): void {
  writeFileSync(path.join(root, name), text);
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("detectReactCompiler — Expo", () => {
  test("app.json experiments.reactCompiler turns it on, with the key as evidence", () => {
    const d = tmp("expo-on");
    write(d, "app.json", JSON.stringify({ expo: { experiments: { reactCompiler: true } } }));
    const probe = detectReactCompiler(d);
    expect(probe.state).toBe("on");
    expect(probe.evidence).toContain("app.json");
    expect(probe.evidence).toContain("experiments.reactCompiler");
  });

  test("an app.json that does not mention it turns it OFF — a read config is evidence", () => {
    const d = tmp("expo-absent");
    write(d, "app.json", JSON.stringify({ expo: { experiments: { typedRoutes: true } } }));
    const probe = detectReactCompiler(d);
    expect(probe.state).toBe("off");
    expect(probe.evidence).toContain("app.json");
  });

  test("the babel preset option spelled false is off, not on", () => {
    // The regression this shape exists for: the first detector matched the bare
    // word `reactCompiler`, so the one spelling that DISABLES the plugin inside
    // babel-preset-expo read as enabled — and would have suppressed valid
    // findings on a compiler-off app.
    const d = tmp("babel-false");
    write(
      d,
      "babel.config.js",
      "module.exports = { presets: [[require.resolve('babel-preset-expo'), " +
        "{ reactCompiler: false }]] };\n",
    );
    expect(detectReactCompiler(d).state).toBe("off");
  });

  test("the plugin listed in the babel config turns it on", () => {
    const d = tmp("babel-plugin");
    write(d, "babel.config.js", "module.exports = { plugins: ['babel-plugin-react-compiler'] };\n");
    const probe = detectReactCompiler(d);
    expect(probe.state).toBe("on");
    expect(probe.evidence).toContain("babel.config.js");
    expect(probe.evidence).toContain("babel-plugin-react-compiler");
  });

  test("an unparseable app.json is not evidence of an absent flag", () => {
    const d = tmp("appjson-broken");
    write(d, "app.json", "{ this is not json");
    expect(detectReactCompiler(d).state).toBe("undetermined");
  });
});

describe("detectReactCompiler — Next.js", () => {
  test("next.config reactCompiler: true turns it on", () => {
    const d = tmp("next-on");
    write(d, "next.config.ts", "export default { reactCompiler: true };\n");
    const probe = detectReactCompiler(d);
    expect(probe.state).toBe("on");
    expect(probe.evidence).toContain("next.config.ts");
  });

  test("the older `experimental` spelling turns it on too", () => {
    const d = tmp("next-experimental");
    write(d, "next.config.js", "module.exports = { experimental: { reactCompiler: true } };\n");
    expect(detectReactCompiler(d).state).toBe("on");
  });

  test("a next.config that does not mention it is off — the web half's whole gap", () => {
    const d = tmp("next-off");
    write(d, "next.config.mjs", "export default { react: { strictMode: true } };\n");
    const probe = detectReactCompiler(d);
    expect(probe.state).toBe("off");
    expect(probe.evidence).toContain("next.config.mjs");
  });
});

describe("detectReactCompiler — bundlers, and what it refuses to infer", () => {
  test("a vite config referencing the plugin turns it on", () => {
    const d = tmp("vite");
    write(
      d,
      "vite.config.ts",
      "export default { plugins: [react({ babel: { plugins: ['babel-plugin-react-compiler'] } })] };\n",
    );
    expect(detectReactCompiler(d).state).toBe("on");
  });

  test("a lockfile naming the plugin proves nothing: undetermined, never on", () => {
    // The dogfood web app's bun.lock contains babel-plugin-react-compiler
    // because Next ships it as a dependency of its own while the compiler is
    // OFF. A dependency-presence check would have suppressed 127 valid findings
    // on that run, which is why this probe never opens a lockfile.
    const d = tmp("lockfile");
    write(d, "bun.lock", '{"packages":{"babel-plugin-react-compiler":{"version":"1.0.0"}}}\n');
    write(d, "package.json", JSON.stringify({ name: "app" }));
    const probe = detectReactCompiler(d);
    expect(probe.state).toBe("undetermined");
    expect(probe.evidence).toContain("no app.json");
  });

  test("an unrecognised bundler says undetermined rather than guessing off", () => {
    const d = tmp("unknown-bundler");
    write(d, "parcel.config.json", "{}\n");
    expect(detectReactCompiler(d).state).toBe("undetermined");
  });
});

describe("configRootFor", () => {
  test("walks up out of the out dir to the nearest package.json", () => {
    const d = tmp("root");
    write(d, "package.json", JSON.stringify({ name: "app" }));
    write(d, "next.config.js", "module.exports = { reactCompiler: true };\n");
    expect(configRootFor(path.join(d, "apps", "web", "flawless"))).toBe(d);
    // The walk is only worth having if the root it lands on is the one holding
    // the configs — a run from a monorepo package still reads the app's flag.
    expect(detectReactCompiler(configRootFor(path.join(d, "apps", "web", "flawless"))).state).toBe(
      "on",
    );
  });

  test("a tree with package.json and no configs at all is undetermined", () => {
    // Not "off": nothing was read, and guessing off here is indistinguishable
    // from having checked — the whole point of the third state.
    const d = tmp("bare");
    write(d, "package.json", JSON.stringify({ name: "app" }));
    expect(detectReactCompiler(configRootFor(path.join(d, "flawless"))).state).toBe("undetermined");
  });
});
