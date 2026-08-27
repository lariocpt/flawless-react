import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { analyse } from "../src/analyse/index.ts";
import { detectNextjs } from "../src/nextjs/detect.ts";
import { emitNextjsMocks } from "../src/nextjs/emit.ts";
import { ensureClientProviderWrapper } from "../src/nextjs/providerWrapper.ts";
import { extractRoutes, loadApiSpec } from "../src/scaffold/openapi.ts";
import { renderSuite } from "../src/scaffold/templates.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import { findTask } from "../src/tasks/index.ts";
import type { ComponentTree, TaskId } from "../src/types.ts";

/**
 * Every file the tool writes has to TYPE-CHECK, not just parse.
 *
 * emittedSyntax.test.ts calls `ts.createSourceFile` and reads `parseDiagnostics`.
 * That is a parser, and a parser has no idea what a module exports. So a spec
 * that says `import { Card } from "./Card"` against a file whose only export is
 * `default`, or that indexes `ComponentProps<typeof X>["fonts"]` for a prop X
 * does not declare, sailed through every check in this repo and surfaced minutes
 * into a vitest or Playwright run as a stack trace in a file no human wrote.
 *
 * This file builds a real `ts.Program` over the emitted output and asks the
 * checker. `exportKind` — "default" | "named" | "none", inferred by
 * src/analyse/parseFile.ts and used by BOTH emitComponentImport (scaffold-tests)
 * and hostComponentImport (scaffold) to pick the import form — was the thing
 * with no coverage at all: get it wrong and the spec imports a name that is not
 * there. TS2305/TS2613 catch that in milliseconds.
 *
 * WHAT THIS CANNOT SEE, so nobody mistakes it for more than it is:
 *
 *   - Synthesised prop VALUES. The unit template renders
 *     `<C {...(merged as unknown as Props)} />` and the profile host registers
 *     `C as unknown as Component`; both deliberately erase the prop type at the
 *     call site, because props are assembled at runtime into a
 *     `Record<string, unknown>`. A wrong-typed value in DEFAULTS is invisible
 *     here. What IS checked is every prop the emitters write as literal JSX —
 *     provider.tsx's `<Providers theme="dark" fonts={…}>` is checked in full.
 *   - Arity of a component call. React's `FC` accepts a second (legacy context)
 *     parameter, so TS2554 is unreachable for FC-typed fixtures; a wrong-arity
 *     call is simply legal TypeScript against those types.
 *
 * Runtime is ~2s: four component fixtures plus the Next.js app, which is enough
 * to cover both import forms and every emitter that writes a .ts/.tsx file.
 */

const FIXTURES_DIR = path.resolve(__dirname, "fixtures");
const NEXTAPP = path.join(FIXTURES_DIR, "nextapp");

/**
 * Deliberately small, and deliberately covering both `exportKind` branches.
 *
 * A set that was all-default-export would leave `import { X } from` — half of
 * emitComponentImport — unchecked, which is the kind of coverage that passes
 * because it never ran the code. "both import forms are exercised" below
 * asserts this stays true rather than trusting the comment.
 */
const FIXTURES = [
  "Toolbar.tsx", // export default → `import Toolbar from`
  "Card.tsx", // named only → `import { Card } from`
  "StatefulPanel.tsx", // named function declaration, hooks and a child component
  "CheckboxForm.tsx", // default + named, typed form fields
  "CompoundHeader.tsx", // compound family -> wrapped spec + composed registry entry
];

/**
 * Stub packages for everything the emitted specs import that this repo does not
 * install, written into a temp node_modules — the same technique
 * emittedConfigs.test.ts uses to load a config without installing vitest.
 *
 * Two rules earn their keep here:
 *
 * 1. `react` is NOT stubbed. It is symlinked to the real @types/react this repo
 *    already depends on. A stubbed React makes `React.ComponentProps<typeof C>`
 *    resolve to `any`, and then every prop assertion in every emitted spec is
 *    trivially satisfied — the test would pass over generated garbage. The
 *    "react resolved to the real @types/react" case guards that.
 * 2. These stubs list their exports EXPLICITLY rather than using a permissive
 *    `export = any`. If an emitter starts importing a new name from one of these
 *    packages, this file goes red asking for a declaration. That false RED is
 *    the price of TS2305 being reachable at all; a catch-all stub would make
 *    "has no exported member" impossible to observe, which is the vacuity this
 *    whole file exists to avoid. Adding a line here is the correct fix.
 */
const PACKAGE_STUBS: Record<string, string> = {
  // --- the native plane -----------------------------------------------------
  // Deliberately `any`-typed, like the DOM stubs above: this gate is here to
  // catch a spec REFERENCING something that is not there (TS2304/TS2305), not to
  // re-typecheck React Native. Precise types would only add stub-shaped noise.
  "react-native": `export declare const View: any;
export declare const Text: any;
export declare const Pressable: any;
export declare const TextInput: any;
export declare const FlatList: any;
export declare const ScrollView: any;
export declare const Switch: any;
export declare const Button: any;
export declare const ActivityIndicator: any;
export declare const KeyboardAvoidingView: any;
export declare const Platform: any;
export declare const Alert: any;
export declare const StyleSheet: any;
`,
  "react-native-safe-area-context": `export declare const SafeAreaView: any;
export declare const SafeAreaProvider: any;
export declare const initialWindowMetrics: any;
export declare function useSafeAreaInsets(): any;
`,
  "@testing-library/react-native": `export declare const render: any;
export declare const screen: any;
export declare const fireEvent: any;
export declare const userEvent: any;
export declare const waitFor: any;
export declare const within: any;
export declare const act: any;
`,
  "expo-router": `export declare function useRouter(): any;
export declare function useLocalSearchParams<T = any>(): T;
export declare function useFocusEffect(cb: any): void;
export declare const Stack: any;
export declare const Tabs: any;
export declare const Link: any;
export declare function useSegments(): any;
`,
  "expo-router/testing-library": `export declare const renderRouter: any;
export declare const testRouter: any;
export declare const screen: any;
export declare const fireEvent: any;
export declare const waitFor: any;
export declare const within: any;
export declare const act: any;
`,
  "@expo/vector-icons": `export declare const Ionicons: any;
export declare const MaterialIcons: any;
`,
  vitest: `export declare const describe: any;
export declare const test: any;
export declare const it: any;
export declare const expect: any;
export declare const beforeEach: any;
export declare const afterEach: any;
export declare const beforeAll: any;
export declare const afterAll: any;
export declare const vi: any;
`,
  "vitest/config": `export declare function defineConfig<T>(c: T): T;\n`,
  // Explicit members on purpose (rule 2 above): the compound fixture imports
  // this namespace, and a catch-all stub would make TS2305 unobservable for
  // the wrapped-spec and composed-registry emission branches.
  "@radix-ui/react-dialog": `import type * as React from "react";
export declare const Root: (props: Record<string, unknown>) => React.ReactElement | null;
export declare const Trigger: (props: Record<string, unknown>) => React.ReactElement | null;
export declare const Portal: (props: Record<string, unknown>) => React.ReactElement | null;
export declare const Overlay: (props: Record<string, unknown>) => React.ReactElement | null;
export declare const Content: (props: Record<string, unknown>) => React.ReactElement | null;
export declare const Title: (props: Record<string, unknown>) => React.ReactElement | null;
`,
  "@testing-library/react": `export declare const render: any;
export declare const screen: any;
export declare const waitFor: any;
export declare const within: any;
export declare const fireEvent: any;
export declare const cleanup: any;
export declare const act: any;
`,
  "@testing-library/user-event": `declare const userEvent: any;
export default userEvent;
`,
  "@testing-library/jest-dom/vitest": `export {};\n`,
  "@playwright/test": `export declare const test: any;
export declare const expect: any;
export declare const devices: any;
export declare function defineConfig<T>(c: T): T;
export type Page = any;
export type Locator = any;
export type BrowserContext = any;
export type FullConfig = any;
export type TestInfo = any;
export type CDPSession = any;
export type PlaywrightTestConfig = any;
`,
  "react-scan": `export declare function scan(opts: any): void;\n`,
  msw: `export declare const http: any;
export declare const HttpResponse: any;
export declare const graphql: any;
export type RequestHandler = any;
`,
  "msw/node": `export declare function setupServer(...handlers: any[]): any;\n`,
  "msw/browser": `export declare function setupWorker(...handlers: any[]): any;\n`,
  bun: `export declare const serve: any;
export declare const file: any;
export declare const build: any;
`,
};

/** Walk up to the nearest installed copy of a types package, or say so loudly. */
function installedTypes(pkg: string): string {
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, "node_modules", pkg);
    if (existsSync(path.join(candidate, "index.d.ts"))) return candidate;
    const up = path.dirname(dir);
    if (up === dir) {
      throw new Error(
        `${pkg} is not installed. It is a declared devDependency; without it this ` +
          `file would type-check the emitted specs against an implicit 'any' React ` +
          `and pass no matter what the emitters wrote.`,
      );
    }
    dir = up;
  }
}

/** A temp project root whose node_modules resolves everything the specs import. */
function stubProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "flawless-types-"));
  const modules = path.join(root, "node_modules");
  mkdirSync(path.join(modules, "@types"), { recursive: true });
  symlinkSync(installedTypes("@types/react"), path.join(modules, "@types", "react"));
  symlinkSync(installedTypes("@types/node"), path.join(modules, "@types", "node"));

  for (const [spec, dts] of Object.entries(PACKAGE_STUBS)) {
    const dir = path.join(modules, spec);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: spec, version: "0.0.0", types: "index.d.ts" }),
    );
    writeFileSync(path.join(dir, "index.d.ts"), dts);
  }

  // react-dom/client is a subpath import, so it needs a directory rather than
  // the flat `<name>/index.d.ts` the loop above writes.
  const reactDom = path.join(modules, "react-dom");
  mkdirSync(reactDom, { recursive: true });
  writeFileSync(
    path.join(reactDom, "package.json"),
    JSON.stringify({ name: "react-dom", version: "0.0.0", types: "index.d.ts" }),
  );
  writeFileSync(path.join(reactDom, "index.d.ts"), "export {};\n");
  writeFileSync(
    path.join(reactDom, "client.d.ts"),
    `export type Root = any;
export declare function createRoot(el: any, opts?: any): any;
`,
  );
  return root;
}

/**
 * The settings the emitted suite's own tsconfig.json declares, plus one
 * deviation.
 *
 * `noImplicitAny` is off because the stubs above type third-party values as
 * `any`, so every callback the specs hand to them — `test(name, ({ page }) => …)`,
 * `page.on("console", (msg) => …)` — reports TS7031/TS7006 for a param the real
 * @playwright/test and vitest types would have given a contextual type. That is
 * a property of the stub, not of the generated code: it was 89 of the first 91
 * diagnostics this file ever produced and none of them named a bug. Turning it
 * off removes exactly that class; TS2305, TS2613, TS2322, TS2741 and TS2304 are
 * independent of it, which the "teeth" cases below demonstrate rather than
 * assert.
 */
const CHECK_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  skipLibCheck: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  noImplicitAny: false,
};

interface Checked {
  /** Everything the checker complained about, except unresolved modules. */
  errors: string[];
  /**
   * TS2307 kept apart on purpose. An unresolved import does not just lose its
   * own diagnostic — every symbol it brought in silently becomes `any`, so the
   * errors we came here for stop being reachable. It has to be zero, not
   * filtered away.
   */
  unresolved: string[];
  /** Emitted files the program actually loaded, relative to outDir. */
  checked: string[];
  program: ts.Program;
}

function checkTypes(outDir: string, roots: string[], extra: ts.CompilerOptions = {}): Checked {
  const program = ts.createProgram({
    rootNames: roots,
    options: { ...CHECK_OPTIONS, ...extra },
  });
  const errors: string[] = [];
  const unresolved: string[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const file = d.file ? path.relative(outDir, d.file.fileName) : "<options>";
    const at =
      d.file && d.start !== undefined
        ? `:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
        : "";
    const line = `${file}${at} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    (d.code === 2307 ? unresolved : errors).push(line);
  }
  const prefix = `${outDir}${path.sep}`;
  const checked = program
    .getSourceFiles()
    .map((f) => f.fileName)
    .filter((f) => f.startsWith(prefix) && !f.includes(`${path.sep}node_modules${path.sep}`))
    .map((f) => path.relative(outDir, f).split(path.sep).join("/"))
    .sort();
  return { errors, unresolved, checked, program };
}

const treeOf = (fixture: string): Promise<ComponentTree> =>
  analyse({ entry: path.join(FIXTURES_DIR, fixture), depth: 0, includeChildren: false });

/**
 * Every emitter's output for every fixture, each fixture in its own suite dir.
 *
 * One shared outDir would have been closer to a real multi-component run, but
 * renderSuite writes host/main.tsx per call, so the fourth fixture's copy
 * overwrote the other three and only ONE of the two hostComponentImport
 * branches was ever reaching the checker. Separate dirs keep every emitted file
 * on disk to be checked; `node_modules` sits above them all, so resolution is
 * unaffected.
 */
async function emitSuites(
  root: string,
): Promise<{ roots: string[]; sources: Map<string, string> }> {
  const roots: string[] = [];
  const sources = new Map<string, string>();
  // --api is passed for one fixture only: mock/server.ts and mock/routes.ts are
  // emitted solely when mockRoutes is set, so a run without it covers neither.
  const mockRoutes = extractRoutes(await loadApiSpec(path.join(FIXTURES_DIR, "_api.json")));
  expect(mockRoutes.length, "the OpenAPI fixture produced routes to mock").toBeGreaterThan(0);

  for (const [i, fixture] of FIXTURES.entries()) {
    const name = path.basename(fixture, ".tsx");
    const outDir = path.join(root, `suite-${name}`);
    const tree = await treeOf(fixture);
    const files = [
      ...renderSuite({
        tree,
        outDir,
        variants: 3,
        report: true,
        ...(i === 0 ? { mockRoutes } : {}),
      }),
      ...renderUnitBrowser({ trees: [tree], outDir, variants: 3, browserSpecs: true }),
    ];
    for (const f of files) {
      const abs = path.join(outDir, f.relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
      if (/\.(m?tsx?)$/.test(f.relPath)) {
        roots.push(abs);
        sources.set(`suite-${name}/${f.relPath}`, f.content);
      }
    }
  }
  return { roots, sources };
}

describe("the emitted suite type-checks, not just parses", () => {
  test("the profile host, profile specs, unit specs, browser specs and mock server", async () => {
    const root = stubProject();
    const { roots, sources } = await emitSuites(root);
    const { errors, unresolved, checked, program } = checkTypes(root, roots);

    expect(unresolved, "every import the specs make resolves").toEqual([]);
    expect(errors).toEqual([]);

    // A program over zero files reports zero errors. Name what was checked, and
    // name one file per emitter so a template that stops writing something is a
    // failure rather than a silent reduction in coverage.
    for (const expected of [
      // Toolbar is `export default` and Card is named-only, so naming the
      // registry and unit spec for both pins BOTH import forms to a file that
      // was really checked. The component imports live in host/registry.ts
      // since the FR-016 split; main.tsx is the wrapper reading it.
      "suite-Toolbar/host/registry.ts", // hostComponentImport, default branch
      "suite-Card/host/registry.ts", // hostComponentImport, named branch
      "suite-Toolbar/host/main.tsx",
      "suite-Card/host/main.tsx",
      "suite-Toolbar/unit/Toolbar.test.tsx", // emitComponentImport, default branch
      "suite-Card/unit/Card.test.tsx", // emitComponentImport, named branch
      "suite-StatefulPanel/unit/StatefulPanel.test.tsx",
      "suite-CheckboxForm/unit/CheckboxForm.test.tsx",
      "suite-Toolbar/host/server.ts",
      "suite-Toolbar/host/_polyfill.ts",
      "suite-Toolbar/profile/_helpers.ts",
      "suite-Toolbar/profile/_heap.ts",
      "suite-Toolbar/profile/Toolbar.profile.spec.ts",
      "suite-Card/profile/Card.profile.spec.ts",
      "suite-Toolbar/playwright.config.ts",
      "suite-Toolbar/mock/server.ts", // --api only
      "suite-Toolbar/mock/routes.ts", // --api only
      "suite-Toolbar/vitest.config.mts",
      "suite-Toolbar/setup.ts",
      "suite-Toolbar/browser/playwright.config.ts",
      "suite-Toolbar/browser/Toolbar.spec.ts",
    ]) {
      expect(checked, `type-checked ${expected}`).toContain(expected);
    }
    // Every emitted .ts/.tsx really made it into the program — no silent drop.
    // `checked` runs slightly longer because resolveJsonModule pulls each
    // suite's budgets.json in as a source file too.
    const relRoots = roots.map((r) => path.relative(root, r).split(path.sep).join("/")).sort();
    expect(checked.filter((f) => /\.(m?tsx?)$/.test(f))).toEqual(relRoots);

    // The component sources have to be IN the program. If the relative import
    // path the emitters compute were wrong, TS2307 would fire above — but if it
    // resolved to some other file the errors would be about the wrong code.
    const loaded = program
      .getSourceFiles()
      .map((f) => f.fileName)
      .filter((f) => f.startsWith(`${FIXTURES_DIR}${path.sep}`))
      .map((f) => path.basename(f));
    for (const fixture of FIXTURES) {
      expect(loaded, `checked the spec against the real ${fixture}`).toContain(fixture);
    }

    // Both branches of exportKind reached the emitters. Without this the whole
    // suite could be default-exports and half of the import logic untested.
    const unitSpecs = [...sources].filter(([rel]) => rel.includes("/unit/"));
    expect(unitSpecs.length).toBe(FIXTURES.length);
    expect(unitSpecs.some(([, src]) => /^import \w+ from "\.\./m.test(src))).toBe(true);
    expect(unitSpecs.some(([, src]) => /^import \{ \w+ \} from "\.\./m.test(src))).toBe(true);
  });

  test("the e2e specs, MSW mocks and derived provider — emitters no other check reaches", async () => {
    const outDir = path.join(stubProject(), "flawless");
    const nextjs = await detectNextjs(NEXTAPP);
    const page = path.join(NEXTAPP, "src", "app", "items", "[id]", "page.tsx");
    const e2e = findTask("e2e" as TaskId);
    if (!e2e) throw new Error("e2e task not registered");
    await e2e.run({
      trees: [await analyse({ entry: page, depth: 0, includeChildren: false })],
      outDir,
      variants: 3,
      heaps: "stress",
      force: false,
      report: false,
      provider: undefined,
      apiSpec: undefined,
      inlineSummary: false,
      nextjs,
    });
    await emitNextjsMocks(nextjs, outDir);
    ensureClientProviderWrapper(nextjs, outDir);

    const roots = (readdirSync(outDir, { recursive: true }) as string[])
      .filter((rel) => /\.(m?tsx?)$/.test(rel))
      .map((rel) => path.join(outDir, rel));

    // provider.tsx and provider.fixtures.ts import through the target app's own
    // "@/*" alias, so the program needs the app's path mapping — the same one
    // detectNextjs read out of the fixture's tsconfig.
    const { errors, unresolved, checked } = checkTypes(outDir, roots, {
      baseUrl: NEXTAPP,
      paths: { "@/*": ["./src/*"] },
    });

    expect(unresolved, "the @/* alias and msw stubs resolve").toEqual([]);
    expect(errors).toEqual([]);

    for (const expected of [
      "e2e/playwright.config.ts",
      "e2e/params.ts",
      "e2e/global-setup.ts",
      "e2e/items-id.spec.ts",
      "mocks/handlers.ts",
      "mocks/browser.ts",
      "mocks/node.ts",
      "provider.tsx", // the only emitted file with literal JSX props
      "provider.fixtures.ts",
    ]) {
      expect(checked, `type-checked ${expected}`).toContain(expected);
    }
  });

  test("the options used here are the ones the tool writes into the emitted tsconfig", async () => {
    // Checking under settings the generated suite does not use would prove
    // nothing about the generated suite. This pins the two together so a change
    // to suiteTsconfig cannot quietly leave this file checking something else.
    const root = stubProject();
    await emitSuites(root);
    const outDir = path.join(root, "suite-Toolbar");
    const raw = JSON.parse(readFileSync(path.join(outDir, "tsconfig.json"), "utf8")) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    const { options, errors } = ts.convertCompilerOptionsFromJson(
      raw.compilerOptions,
      outDir,
      "tsconfig.json",
    );
    expect(errors).toEqual([]);
    // configFilePath/pathsBasePath are bookkeeping the converter adds, not
    // settings the template declared.
    const declared = Object.entries(options).filter(
      ([k]) => k !== "configFilePath" && k !== "pathsBasePath",
    );
    expect(declared.length, "the emitted tsconfig declares options to compare").toBeGreaterThan(5);
    for (const [key, value] of declared) {
      expect(
        CHECK_OPTIONS[key],
        `emitted tsconfig's ${key} is what this file checks under`,
      ).toEqual(value as never);
    }

    // The emitted tsconfig's own `include` does NOT cover unit/ or browser/, so
    // a user running `tsc` inside the generated suite would skip exactly the
    // specs that import the component under test. That is why this file passes
    // explicit rootNames rather than honouring `include`.
    expect(raw.include.some((g) => g.startsWith("unit"))).toBe(false);
    expect(raw.include.some((g) => g.startsWith("browser"))).toBe(false);
  });
});

/**
 * The guard on the guard.
 *
 * Everything above asserts an empty list, and an empty list is what a broken
 * harness produces too — a stub that swallows the error, a module that failed to
 * resolve, a `paths` entry pointing somewhere harmless. These cases feed the
 * SAME setup a spec with a defect an emitter could plausibly ship and require it
 * to be reported.
 */
describe("the checker catches the generator bugs it exists for", () => {
  /** The single import in an emitted spec that names the component under test. */
  function componentImport(source: string): string {
    const line = source.split("\n").find((l) => /^import .+ from "\.\..*fixtures\//.test(l));
    if (!line) throw new Error("no component import in the emitted spec — the template changed");
    return line;
  }

  async function emitCard(): Promise<{ outDir: string; spec: string; content: string }> {
    const outDir = path.join(stubProject(), "flawless");
    const files = renderUnitBrowser({
      trees: [await treeOf("Card.tsx")],
      outDir,
      variants: 3,
      browserSpecs: true,
    });
    const unit = files.find((f) => f.relPath === "unit/Card.test.tsx");
    if (!unit) throw new Error("unit/Card.test.tsx was not emitted");
    return { outDir, spec: path.join(outDir, unit.relPath), content: unit.content };
  }

  function checkOne(outDir: string, spec: string, content: string): string[] {
    mkdirSync(path.dirname(spec), { recursive: true });
    writeFileSync(spec, content);
    const { errors, unresolved } = checkTypes(outDir, [spec]);
    expect(unresolved, "the mutation did not break module resolution instead").toEqual([]);
    return errors;
  }

  test("the unmutated spec is clean, so the cases below measure the mutation", async () => {
    const { outDir, spec, content } = await emitCard();
    expect(checkOne(outDir, spec, content)).toEqual([]);
  });

  test("importing a name the component does not export — a wrong exportKind, or a typo", async () => {
    const { outDir, spec, content } = await emitCard();
    const original = componentImport(content);
    const broken = original.replace("{ Card }", "{ CardPanel }");
    expect(broken, "the mutation applied").not.toBe(original);
    const errors = checkOne(outDir, spec, content.replace(original, broken));
    expect(errors.join("\n")).toContain("TS2305");
    expect(errors.join("\n")).toContain("has no exported member 'CardPanel'");
  });

  test("default-importing a component that only has a named export", async () => {
    // exportKind === "default" against a module with none. This is the bug the
    // parser could never see: `import Card from "./Card"` parses perfectly.
    const { outDir, spec, content } = await emitCard();
    const original = componentImport(content);
    const broken = original.replace("import { Card }", "import Card");
    expect(broken, "the mutation applied").not.toBe(original);
    const errors = checkOne(outDir, spec, content.replace(original, broken));
    expect(errors.join("\n")).toContain("TS2613");
    expect(errors.join("\n")).toContain("has no default export");
  });

  test("a prop of the wrong type, where an emitter writes literal JSX", async () => {
    // Card takes `title: string`. This is the shape of provider.tsx's output,
    // which is the one emitter that does write props as literal JSX.
    const { outDir, spec, content } = await emitCard();
    const errors = checkOne(outDir, spec, `${content}\nvoid <Card title={123} body="b" />;\n`);
    expect(errors.join("\n")).toContain("TS2322");
    expect(errors.join("\n")).toContain("Type 'number' is not assignable to type 'string'");
  });

  test("a required prop left out", async () => {
    const { outDir, spec, content } = await emitCard();
    const errors = checkOne(outDir, spec, `${content}\nvoid <Card title="a" />;\n`);
    expect(errors.join("\n")).toContain("TS2741");
    expect(errors.join("\n")).toContain("Property 'body' is missing");
  });

  test("react resolved to the real @types/react, not to something that types as any", async () => {
    // If React were stubbed, `React.ComponentProps<typeof Card>` would be `any`
    // and the two prop cases above would pass over any garbage at all. They are
    // the behavioural proof; this is the direct one.
    const { outDir, spec, content } = await emitCard();
    mkdirSync(path.dirname(spec), { recursive: true });
    writeFileSync(spec, content);
    const { program } = checkTypes(outDir, [spec]);
    const reactTypes = program
      .getSourceFiles()
      .map((f) => f.fileName)
      .filter((f) => /@types[/\\]react[/\\].*\.d\.ts$/.test(f));
    expect(
      reactTypes.length,
      "the real React type declarations are in the program",
    ).toBeGreaterThan(0);

    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(spec);
    if (!sf) throw new Error("the spec is not in its own program");
    const props = sf.statements.find(
      (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "Props",
    );
    if (!props) throw new Error("the unit template no longer declares `type Props`");
    // Card's props are { title: string; body: string }. If React were a stub
    // this resolves to `any` and reports no members.
    const resolved = checker.getTypeAtLocation(props.name);
    const members = checker.getPropertiesOfType(resolved).map((p) => p.getName());
    expect(members.sort()).toEqual(["body", "title"]);
  });
});

/**
 * The NATIVE emitter had no type gate at all.
 *
 * `emittedSyntax.test.ts` reads `parseDiagnostics` over what `--expo` writes.
 * That is a parser, and — as this file's header already says — a parser has no
 * idea what a module exports or whether an identifier is declared. So the whole
 * native plane, which is three of the seven tasks today and gains four more
 * waves, was checked only for syntax.
 *
 * It let one through. `postDispatchAssertions` emits
 * `expect(handlers["onX"]).toHaveBeenCalled()` for any handler bound to a prop,
 * with no route guard — while the `const handlers` block above it is suppressed
 * for route files (`const fnProps = route ? [] : functionProps(info)`). TS2304
 * in the emitted file, ReferenceError in the one interaction test, and every
 * parse-level check green.
 */
describe("the emitted NATIVE suite type-checks, not just parses", () => {
  const EXPOAPP = path.join(FIXTURES_DIR, "expoapp");

  async function emitNative(root: string): Promise<{ outDir: string; specs: string[] }> {
    const { detectExpo } = await import("../src/expo/detect.ts");
    const { renderNativeUnit } = await import("../src/scaffold-tests/nativeTemplates.ts");
    const { createAnalyseSharedContext, analyseFile } = await import("../src/analyse/index.ts");
    // The app is COPIED under the stub root, because the emitted specs import
    // the components by relative path and those files import react-native,
    // expo-router and friends. Left in tests/fixtures/ they sit outside the
    // project that has node_modules, and every one of those resolves to TS2307
    // — which, per `Checked.unresolved` above, turns the symbols they carry into
    // `any` and makes the errors this gate exists for unreachable.
    const app = path.join(root, "app-under-test");
    cpSync(EXPOAPP, app, { recursive: true });
    rmSync(path.join(app, "flawless"), { recursive: true, force: true });
    const expo = await detectExpo(app);
    const shared = createAnalyseSharedContext();
    const trees: ComponentTree[] = [];
    for (const rel of [
      "app/_layout.tsx",
      "app/(tabs)/_layout.tsx",
      "app/(tabs)/index.tsx",
      "app/login.tsx",
      "app/items/[id].tsx",
      "app/hostile.tsx",
      "app/props-route.tsx",
      "components/icon.tsx",
      "components/aliased.tsx",
    ]) {
      trees.push(
        ...(await analyseFile(
          { entry: path.join(app, rel), depth: 3, includeChildren: true, roots: "exported" },
          shared,
        )),
      );
    }
    const outDir = path.join(app, "flawless");
    mkdirSync(outDir, { recursive: true });
    const specs: string[] = [];
    for (const f of renderNativeUnit({ trees, outDir, expo })) {
      const abs = path.join(outDir, f.relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
      if (abs.endsWith(".tsx")) specs.push(abs);
    }
    return { outDir, specs };
  }

  test("every emitted native spec type-checks against a real ts.Program", async () => {
    const root = stubProject();
    try {
      const { outDir, specs } = await emitNative(root);
      expect(specs.length).toBeGreaterThan(0);
      // `types: []` so the ambient jest globals do not have to be installed —
      // the specs' own `jest.fn` reads come through the stub below.
      writeFileSync(
        path.join(root, "node_modules", "jest-globals.d.ts"),
        // `jest` is BOTH a value and a namespace in @types/jest, which jest-expo
        // pulls in. The specs read `jest.fn(...)` as a value and
        // `as unknown as jest.Mock` as a TYPE, so a `declare const` alone leaves
        // the type position unresolvable — a property of this stub, not of the
        // emitted code.
        "declare namespace jest { type Mock = any; type Mocked<T> = T; }\ndeclare const jest: any;\ndeclare const describe: any;\ndeclare const test: any;\ndeclare const expect: any;\ndeclare const beforeEach: any;\ndeclare const afterEach: any;\n",
      );
      const { errors, unresolved, checked } = checkTypes(outDir, [
        ...specs,
        path.join(root, "node_modules", "jest-globals.d.ts"),
      ]);
      // Unresolved imports kept apart for the reason the header gives: they turn
      // every symbol they brought in into `any`, so the errors we came for stop
      // being reachable.
      expect(unresolved).toEqual([]);
      expect(errors).toEqual([]);
      expect(checked.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("guard the guard: an undeclared identifier in a native spec IS caught", () => {
    // The exact shape E1 had — a reference the parser is perfectly happy with.
    // Without this, a green run above could mean "the checker saw nothing".
    const root = stubProject();
    try {
      const outDir = path.join(root, "native");
      mkdirSync(outDir, { recursive: true });
      const spec = path.join(outDir, "Probe.flawless.test.tsx");
      writeFileSync(
        spec,
        `import { render, screen, fireEvent } from "@testing-library/react-native";
const el = screen;
export const probe = () => {
  fireEvent(el, "press");
  return handlers["onPress"];
};
void render;
`,
      );
      const { errors, unresolved } = checkTypes(outDir, [spec]);
      expect(unresolved).toEqual([]);
      // The MESSAGE, not the code. TypeScript reports an undeclared identifier
      // as TS2304, or as TS2552 when it can suggest a near-miss — and with
      // lib.dom loaded, `handlers` suggests `Headers`. Pinning 2304 made this
      // guard fail for a reason that had nothing to do with what it guards.
      expect(errors.join(" | ")).toContain("Cannot find name 'handlers'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
