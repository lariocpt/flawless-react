// The native emitter, tested IN PROCESS.
//
// It was reachable only through `bun src/bin.ts` subprocesses, so coverage
// reported 0% functions on it: a refactor would have been caught by a slow
// end-to-end run, or not at all. The end-to-end run stays (nativeExecution.test.ts
// proves the output RUNS); this proves the output is what it should be.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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
    // Quotes and slashes in copy, testIDs and placeholders. Without this the
    // "every emitted spec parses" test below passed over a fixture too clean to
    // exercise the escaping — and the tool was writing files jest could not
    // collect.
    "app/hostile.tsx",
    "app/props-route.tsx",
    "components/icon.tsx",
    "components/aliased.tsx",
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

describe("defects the production-readiness review found", () => {
  test("a file that does not import `View` still has its interactions harvested", async () => {
    // The dialect was probed as hostTag("View")?.dialect === "native", which is
    // only true when the file imports View UNDER THAT EXACT LOCAL NAME. Every
    // `import { Pressable, Text }` file answered "dom", so onPress matched
    // nothing and clicks came back EMPTY — a spec with a mount assertion, no
    // interaction tests, and NO SKIP naming the gap. Green, touching nothing,
    // silent about it, on the commonest file shape in a React Native app.
    const { analyseFile } = await import("../src/analyse/index.ts");
    const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-noview-"));
    const f = path.join(dir, "Row.tsx");
    writeFileSync(
      f,
      'import { Pressable, Text } from "react-native";\n' +
        "export default function Row({ onPress }: { onPress: () => void }) {\n" +
        '  return (<Pressable onPress={onPress} testID="go"><Text>Continue</Text></Pressable>);\n' +
        "}\n",
    );
    const trees = await analyseFile({ entry: f, depth: 0, includeChildren: false });
    const info = trees[0]?.entry;
    expect(info?.hostDialect).toBe("native");
    expect(info?.interactions?.clicks).toHaveLength(1);
    expect(info?.interactions?.clicks[0]?.hints.testid).toBe("go");
    rmSync(dir, { recursive: true, force: true });
  });

  test("quotes and slashes in app copy cannot break the emitted spec", async () => {
    await build();
    const s = get("unit/HostileScreen.flawless.test.tsx");
    // A `"` in a testID or label ends the test title's string; a `/` in a partial
    // label closes the regex literal. Either takes the WHOLE FILE out of the run,
    // and the fixture that existed before had neither character in it.
    expect(s).not.toMatch(/test(\.skip)?\("[^"\n]*"[^"\n]*"[^)]*\)/);
    for (const m of s.matchAll(/getAllByText\((\/[^)]*\/)\)/g)) {
      const body = (m[1] as string).slice(1, -1);
      expect(() => new RegExp(body)).not.toThrow();
      // An unescaped `/` inside the literal is the specific failure.
      expect(body.replace(/\\\//g, "")).not.toContain("/");
    }
  });

  test("an await never lands in a non-async callback", async () => {
    await build();
    for (const [rel, content] of files) {
      if (!rel.endsWith(".tsx")) continue;
      // `(await …)[0]` needs the parens for precedence, and the isAsync check
      // that decides whether the callback is `async` missed that form — emitting
      // a SyntaxError that took the whole suite file out.
      for (const block of content.split(/\n {2}test(?:\.skip)?\(/).slice(1)) {
        const body = block.slice(0, block.indexOf("\n  });"));
        if (!/\bawait\b/.test(body)) continue;
        expect(`${rel}:${body.split("\n")[0]?.includes("async")}`).toBe(`${rel}:true`);
      }
    }
  });

  test("the mock keeps the shape but empties the collections", async () => {
    await build();
    const s = get("unit/ItemsTab.flawless.test.tsx");
    // The SHAPE has to be real, or `const { items } = await listItems()` binds
    // undefined and the next `items.length` throws into the app's ErrorBoundary.
    // The ARRAYS have to be empty, or the component flips into its loaded branch
    // and every assertion the analyser derived from the INITIAL render is
    // describing a screen that is no longer there.
    expect(s).toMatch(/listItems: jest\.fn\(async \(\) => \(\{"items":\[\]\}\)\)/);
  });
});

describe("router.back() needs a history entry", () => {
  test("the emitted test pushes one before pressing", async () => {
    await build();
    const spec = files.get("unit/ItemDetail.flawless.test.tsx");
    expect(spec).toBeDefined();
    const src = spec as string;
    // The labelled back button is addressable, so it gets a REAL test rather
    // than a skip — that is the a11y fix paying off, and the precondition below
    // is only needed because it did.
    expect(src).toContain("[Go back] can be driven");
    const body = src.slice(src.indexOf("[Go back] can be driven"));
    const press = body.indexOf("fireEvent(");
    const push = body.indexOf("testRouter.push(INITIAL_URL)");
    expect(push).toBeGreaterThan(-1);
    // Order matters, not mere presence: a push AFTER the press gives back()
    // nothing to go to and the test fails exactly as it did before the fix.
    expect(push).toBeLessThan(press);
    expect(src).toContain("testRouter");
  });

  test("a spec with no back handler does not import testRouter", async () => {
    await build();
    for (const [rel, src] of files) {
      if (src.includes("router.back") || src.includes("testRouter.push(INITIAL_URL)")) continue;
      expect(`${rel}: ${src.includes("testRouter")}`).toBe(`${rel}: false`);
    }
  });

  test("the unlabelled back button is still an honest skip", async () => {
    await build();
    const src = files.get("unit/ItemDetail.flawless.test.tsx") as string;
    // Two back buttons in the fixture, one labelled and one not. The unlabelled
    // one must NOT acquire a test just because its labelled twin has one.
    const skips = src.match(/test\.skip\(/g) ?? [];
    expect(skips.length).toBeGreaterThan(0);
    expect(src).toMatch(/test\.skip\("onPress on <Pressable> — [^"]*only an icon/);
  });
});

describe("the emitted spec has to type-check in the app that adopts it", () => {
  test("the mount spread casts to the component's props, never to `never`", async () => {
    await build();
    const src = files.get("unit/Icon.flawless.test.tsx") as string;
    // `{...(x as never)}` is TS2698 — never is not an object type — and the DOM
    // emitter says so in a comment of its own. Every native component spec had
    // it, so every one failed `tsc --noEmit` in the adopting app.
    expect(src).not.toContain("as never");
    expect(src).toContain("as unknown as ComponentProps<typeof Icon>");
    expect(src).toContain('import type { ComponentProps } from "react";');
  });

  test("a component with NO props gets no spread at all", async () => {
    await build();
    const src = files.get("unit/Aliased.flawless.test.tsx") as string;
    // ComponentProps<typeof X> resolves to `unknown` for a zero-parameter
    // function, and spreading that is TS2698 + TS2322. There is also nothing to
    // pass, so omitting it is the honest form as well as the typed one.
    expect(src).toMatch(/render\(<Aliased \/>\)/);
    expect(src).not.toContain("DEFAULTS as unknown as ComponentProps<typeof Aliased>");
  });

  test("a route spec never references the `handlers` it does not declare", async () => {
    await build();
    for (const [rel, src] of files) {
      if (!src.includes("renderRouter(CONTEXT")) continue;
      // `const fnProps = route ? [] : …` suppresses the declaration for route
      // files; postDispatchAssertions emitted the reference regardless.
      expect(`${rel}: ${src.includes("handlers[")}`).toBe(`${rel}: false`);
    }
  });
});

describe("an aliased api import is mocked and classified like any other", () => {
  test("the mock carries the real inferred shape, not a bare {}", async () => {
    await build();
    const src = files.get("unit/Aliased.flawless.test.tsx") as string;
    // The emitter iterates the module's OWN export names; the classifiers read
    // the component's subtree, where the LOCAL name appears. Out of step, this
    // silently became `listItems: jest.fn(async () => ({}))` with NO marker —
    // R-3's poisoning shape — while the identical unaliased import resolved.
    expect(src).toContain('listItems: jest.fn(async () => ({"items":[]}))');
    expect(src).not.toMatch(/listItems: jest\.fn\(async \(\) => \(\{\}\)\)/);
    expect(src).not.toContain("TODO(flawless): give this a realistic return value");
  });

  test("and it still reaches the loaded-state test", async () => {
    await build();
    const src = files.get("unit/Aliased.flawless.test.tsx") as string;
    // Querying the subtree facts with the module-side name made the component
    // vanish from that half of the emitter — no test AND no skip explaining why.
    expect(src).toContain("renders the loaded state when listItems returns a row");
  });
});

describe("a generated spec declares only what it reads", () => {
  // Adopting the suite into mybodycorpai/apps/mobile put 55 `noUnusedVariables`
  // errors into THAT repo's lint gate: DEFAULTS and SAMPLE_TEXT are pushed
  // unconditionally, but only a spread/prop-rung reads the first and only a
  // filled TextInput reads the second. Dead code the tool writes is the tool's
  // defect, not the adopter's.
  test("no emitted native spec carries an unreferenced top-level const", async () => {
    await build();
    const offenders: string[] = [];
    for (const [name, src] of files) {
      if (!name.endsWith(".tsx")) continue;
      const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const decl of st.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const id = decl.name.text;
          let uses = 0;
          const walk = (n: ts.Node): void => {
            if (ts.isIdentifier(n) && n.text === id && n !== decl.name) uses++;
            ts.forEachChild(n, walk);
          };
          walk(sf);
          if (uses === 0) offenders.push(`${name}: ${id}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The anti-vacuous half. The test above would pass just as well if every
  // fixture component happened to read both constants — it would then be
  // asserting nothing about the filter. This pins that the fixture app really
  // does contain a spec on each side of the decision.
  test("and the fixture exercises BOTH sides of that filter", async () => {
    await build();
    const specs = [...files].filter(([n]) => n.endsWith(".test.tsx"));
    const reads = specs.filter(([, s]) => /\bSAMPLE_TEXT\b/.test(s)).map(([n]) => n);
    const omits = specs.filter(([, s]) => !/\bSAMPLE_TEXT\b/.test(s)).map(([n]) => n);
    expect(reads.length).toBeGreaterThan(0);
    expect(omits.length).toBeGreaterThan(0);
  });
});
