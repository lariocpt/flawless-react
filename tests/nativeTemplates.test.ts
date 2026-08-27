// The native emitter, tested IN PROCESS.
//
// It was reachable only through `bun src/bin.ts` subprocesses, so coverage
// reported 0% functions on it: a refactor would have been caught by a slow
// end-to-end run, or not at all. The end-to-end run stays (nativeExecution.test.ts
// proves the output RUNS); this proves the output is what it should be.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";
import { analyseFile, createAnalyseSharedContext } from "../src/analyse/index.ts";
import { detectExpo } from "../src/expo/detect.ts";
import { renderNativeUnit } from "../src/scaffold-tests/nativeTemplates.ts";
import type { ComponentTree, ExpoContext } from "../src/types.ts";

const EXPOAPP = path.resolve(__dirname, "fixtures/expoapp");
const OUT = path.join(EXPOAPP, "flawless");

let expo: ExpoContext;
let trees: ComponentTree[];
const files = new Map<string, string>();

async function build(): Promise<void> {
  if (files.size > 0) return;
  expo = await detectExpo(EXPOAPP);
  const shared = createAnalyseSharedContext();
  trees = [];
  for (const rel of [
    "app/_layout.tsx",
    "app/(tabs)/_layout.tsx",
    "app/(tabs)/index.tsx",
    "app/login.tsx",
    "app/items/[id].tsx",
    "components/icon.tsx",
  ]) {
    trees.push(
      ...(await analyseFile(
        { entry: path.join(EXPOAPP, rel), depth: 3, includeChildren: true, roots: "exported" },
        shared,
      )),
    );
  }
  for (const f of renderNativeUnit({ trees, outDir: OUT, expo })) files.set(f.relPath, f.content);
}

const get = (rel: string): string => {
  const c = files.get(rel);
  if (c === undefined)
    throw new Error(`not emitted: ${rel}. Have: ${[...files.keys()].join(", ")}`);
  return c;
};

describe("what gets emitted", () => {
  test("a config, a write-once setup, and one spec per EXPORTED component", async () => {
    await build();
    expect(files.has("jest.config.cjs")).toBe(true);
    expect(files.has("jest.setup.ts")).toBe(true);
    const specs = [...files.keys()].filter((k) => k.startsWith("unit/"));
    expect(specs.length).toBeGreaterThan(3);
    // Specs live in unit/, NOT a directory of their own: docsLint's EMITTED_DIRS
    // is a filter, so a new directory would make every native path claim in the
    // docs unchecked forever rather than red.
    for (const s of specs) expect(s).toMatch(/^unit\/[^/]+\.flawless\.test\.tsx$/);
  });

  test("jest.setup.ts is write-once; the config is not", async () => {
    await build();
    const rendered = renderNativeUnit({ trees, outDir: OUT, expo });
    expect(rendered.find((f) => f.relPath === "jest.setup.ts")?.skipIfExists).toBe(true);
    expect(rendered.find((f) => f.relPath === "jest.config.cjs")?.skipIfExists).toBeUndefined();
  });
});

describe("every emitted spec is valid TypeScript", () => {
  // The specs are built by string concatenation from component names, file paths,
  // static copy and placeholders — all attacker-ish input from the tool's point of
  // view. A spec that does not parse is a suite that cannot run at all.
  test("no parse diagnostics in any emitted file", async () => {
    await build();
    const bad: string[] = [];
    for (const [rel, content] of files) {
      if (!/\.(ts|tsx)$/.test(rel)) continue;
      const sf = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      // biome-ignore lint/suspicious/noExplicitAny: parseDiagnostics is internal but stable
      const diags = (sf as any).parseDiagnostics as ts.Diagnostic[];
      if (diags?.length) {
        bad.push(`${rel}: ${ts.flattenDiagnosticMessageText(diags[0]?.messageText, " ")}`);
      }
    }
    expect(bad.join("\n")).toBe("");
  });

  test("the .cjs config parses as JavaScript", async () => {
    await build();
    const sf = ts.createSourceFile(
      "jest.config.cjs",
      get("jest.config.cjs"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    // biome-ignore lint/suspicious/noExplicitAny: as above
    expect(((sf as any).parseDiagnostics as ts.Diagnostic[]).length).toBe(0);
  });

  test("no emitted file names the machine that wrote it", async () => {
    await build();
    // The same rule tests/emittedPaths.test.ts enforces for the DOM path: the
    // repo lives under a different root on every machine, so an absolute path in
    // a committed file churns git status everywhere else.
    for (const [rel, content] of files) {
      expect(`${rel}:${content.includes(EXPOAPP)}`).toBe(`${rel}:false`);
      expect(`${rel}:${/\/home\/|\/Users\/|^[A-Z]:\\/m.test(content)}`).toBe(`${rel}:false`);
    }
  });
});

describe("the three spec shapes", () => {
  test("a route screen mounts through renderRouter at its own URL", async () => {
    await build();
    const s = get("unit/LoginScreen.flawless.test.tsx");
    expect(s).toContain('from "expo-router/testing-library"');
    expect(s).toContain("renderRouter(CONTEXT");
    expect(s).toContain('const INITIAL_URL = "/login"');
    expect(s).toContain('toHavePathname("/login")');
    // expo-router/testing-library calls jest.mock() at REQUIRE time, not hoisted,
    // so it has to be imported before the component under test.
    expect(s.indexOf("expo-router/testing-library")).toBeLessThan(s.indexOf("import LoginScreen"));
  });

  test("the context is the OBJECT form, never a path string", async () => {
    await build();
    const s = get("unit/LoginScreen.flawless.test.tsx");
    expect(s).toMatch(/const CONTEXT = \{/);
    // The string and { appDir } forms resolve through path.resolve(process.cwd(), …),
    // so either would break the moment jest ran from the monorepo root. Asserted
    // on the CODE, not the file: the emitted comment names both forms in order to
    // explain why neither is used, and a whole-file substring check would fail on
    // its own documentation.
    const code = s
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/renderRouter\(\s*"/);
    expect(code).not.toMatch(/\bappDir\s*:/);
  });

  test("a _layout mounts through its own navigator, because render() throws", async () => {
    await build();
    const s = get("unit/TabsLayout.flawless.test.tsx");
    expect(s).toContain("renderRouter(CONTEXT");
    expect(s).toContain("mounts as a navigator");
    // <Tabs>/<Stack> call useContextKey and throw "No filename found" alone.
    expect(s).not.toMatch(/\brender\(</);
  });

  test("a plain component mounts through RNTL render()", async () => {
    await build();
    const s = get("unit/Icon.flawless.test.tsx");
    expect(s).toContain('from "@testing-library/react-native"');
    expect(s).toMatch(/render\(<Icon /);
    expect(s).not.toContain("renderRouter");
  });
});

describe("the invariants a native spec has to hold", () => {
  test("a module performing fetch() is mocked, with the specifier relativised to the SPEC", async () => {
    await build();
    const s = get("unit/LoginScreen.flawless.test.tsx");
    expect(s).toContain("jest.mock(");
    // app/login.tsx writes "../lib/api"; from flawless/unit/ that names
    // flawless/lib/api and does not exist. One sibling passed by coincidence.
    expect(s).toMatch(/jest\.mock\("\.\.\/\.\.\/lib\/api"/);
    expect(s).not.toMatch(/jest\.mock\("\.\.\/lib\/api"/);
  });

  test("an unaddressable control is a skip that names the remedy", async () => {
    await build();
    const s = get("unit/ItemDetail.flawless.test.tsx");
    expect(s).toContain("test.skip(");
    expect(s).toMatch(/accessibilityLabel/);
    // And never a locator that matches nothing.
    expect(s).not.toContain("UNSAFE_getByType");
    expect(s).not.toMatch(/querySelector/);
  });

  test("a literal push target is asserted AND stubbed in the context", async () => {
    await build();
    const s = get("unit/ItemsTab.flawless.test.tsx");
    expect(s).toContain('toHavePathname("/items/new")');
    // Without the stub the push lands on expo-router's injected +not-found and
    // the assertion fails for a reason that has nothing to do with the component.
    expect(s).toMatch(/"items\/new": \{ default: \(\) => null \}/);
  });

  test("the config pins jest-expo to the project's OWN sdk major", async () => {
    await build();
    expect(get("jest.config.cjs")).toContain("Expo SDK 54");
    expect(get("jest.config.cjs")).toContain('require("jest-expo/jest-preset")');
  });

  test("the transformIgnorePatterns splice REFUSES rather than narrowing silently", async () => {
    await build();
    const cfg = get("jest.config.cjs");
    // Two patterns in the array give the INTERSECTION, which is the opposite of
    // what is wanted — so the alternation is spliced, and a shape change throws
    // instead of quietly leaving a package untransformed. That failure mode reads
    // as "Cannot use import statement outside a module" from inside a dependency.
    expect(cfg).toContain("throw new Error");
    expect(cfg).toContain("refusing to guess");
  });
});
