import path from "node:path";
import {
  collectionRenderingCalls,
  componentNode,
  mountPathCalls,
  referencedNames,
} from "../analyse/mountPathCalls.ts";
import { requiredNativeProviders } from "../analyse/nativeContentModel.ts";
import { annotatedReturnValue, VOID_RETURN } from "../analyse/resolveDepReturns.ts";
import { ModuleResolver } from "../analyse/resolveModule.ts";
import { exportedFunctions } from "../analyse/serverActionReturns.ts";
import { SourceFileCache } from "../analyse/sourceCache.ts";
import { relativeToEmitted } from "../emitPaths.ts";
import { expoFileToRoute, routeModuleId } from "../expo/routes.ts";
import { titleSafe } from "../scaffold/templates.ts";
import { JEST_CONFIG } from "../suiteScripts.ts";
import type { ComponentTree, ExpoContext, TodoRecorder } from "../types.ts";
import { describeNoClaim } from "./postDispatch.ts";
import { allocateSpecNames, flattenTrees, functionProps, synthesiseDefaults } from "./registry.ts";
import {
  awaitNativeSelector,
  describeUnlocatableNative,
  emitNativeDispatch,
  emitNativeSelector,
} from "./selectorsNative.ts";
import type { RenderedFile } from "./templates.ts";

/**
 * The jest-expo unit plane.
 *
 * Everything here is a string literal in `src/`, never a template file read at
 * runtime. `bun build --compile` bundles MODULES, not sibling assets, so a
 * template loaded from disk works perfectly from the checkout and produces
 * nothing at all from the published binary — and the dogfood loop runs from the
 * checkout, so nothing else would notice.
 */

export interface NativeRenderOptions {
  trees: ComponentTree[];
  outDir: string;
  expo: ExpoContext;
  todos?: TodoCounterLike;
  /** Shared across the whole render: an api module is read once, not once per spec. */
  resolver?: ModuleResolver;
  cache?: SourceFileCache;
}

interface ResolvedNativeOptions extends NativeRenderOptions {
  resolver: ModuleResolver;
  cache: SourceFileCache;
}

interface TodoCounterLike {
  for(file: string): TodoRecorder;
}

const JEST_SETUP = "jest.setup.ts";

export function renderNativeUnit(input: NativeRenderOptions): RenderedFile[] {
  const opts: ResolvedNativeOptions = {
    ...input,
    resolver: input.resolver ?? new ModuleResolver(),
    cache: input.cache ?? new SourceFileCache(),
  };
  const files: RenderedFile[] = [
    { relPath: JEST_CONFIG, content: jestConfig(opts) },
    { relPath: JEST_SETUP, content: jestSetup(opts), skipIfExists: true },
  ];

  const flat = flattenTrees(opts.trees);
  // Field names this component's SUBTREE renders as text — `{building.name}` in a
  // row component records propUsage { kind: "jsx-child", member: "name" }.
  //
  // Real evidence, replacing a guess. The first cut picked the witness from a
  // hand-written list of display-ish key names, and 16 of 31 loaded-state tests
  // asserted a field the row does not render.
  const renderedFields = new Map<string, Set<string>>();
  for (const tree of opts.trees) {
    const members = new Set<string>();
    const walk = (t: ComponentTree): void => {
      for (const u of t.entry.propUsage ?? []) {
        if (u.kind === "jsx-child" && u.member) members.add(u.member);
      }
      for (const child of t.children) walk(child);
    };
    walk(tree);
    const existing = renderedFields.get(tree.entry.filePath) ?? new Set<string>();
    for (const m of members) existing.add(m);
    renderedFields.set(tree.entry.filePath, existing);
  }
  const specNames = allocateSpecNames(flat);
  // A component with no export cannot be imported by a spec — the same rule the
  // DOM path applies, and on this app it is 16 of 47 components, every one of
  // them covered through the parent that renders it.
  const targets = flat.filter((c) => c.info.exportKind !== "none");

  for (const c of targets) {
    const specName = specNames.get(c) as string;
    // Specs live under unit/, NOT a directory of their own. Two reasons, and the
    // second is the sharp one: docsLint's EMITTED_DIRS is a FILTER, so a claim
    // about a path under an unlisted directory is silently skipped rather than
    // checked — a new directory would make every native path claim unverified
    // forever instead of turning something red.
    const rel = `unit/${specName}.flawless.test.tsx`;
    const target = path.join(path.resolve(opts.outDir), rel);
    files.push({
      relPath: rel,
      content: renderNativeSpec(
        c.info,
        specName,
        opts,
        path.dirname(target),
        renderedFields.get(c.info.filePath) ?? new Set<string>(),
        opts.todos?.for(target),
      ),
    });
  }
  return files;
}

/**
 * jest.config.cjs — `.cjs`, not `.js`.
 *
 * Jest loads `jest.config.js` through `require`, which is CJS unless the nearest
 * package.json says `"type": "module"` — and in Expo mode the nearest one is the
 * TARGET APP's, whose type we do not control. `.cjs` is unambiguous wherever it
 * sits, which is exactly why VITEST_CONFIG is `.mts`.
 */
function jestConfig(opts: NativeRenderOptions): string {
  const sdk = opts.expo.sdkMajor;
  const rootRel = relativeToEmitted(path.resolve(opts.outDir), opts.expo.root);
  return `// Generated by flawless-react. Rewritten on every run — put hand edits in
// ${JEST_SETUP} beside it, which is write-once.
const path = require("node:path");
const preset = require("jest-expo/jest-preset");

const projectRoot = path.resolve(__dirname, ${JSON.stringify(rootRel)});

// jest-expo's own pattern is \`node_modules/(?!(<alt>|<alt>|…)/)\`. Ours has to be
// the UNION of its allowlist and the extra packages this app ships untranspiled —
// and TWO patterns in the array give the INTERSECTION (a path is left
// untransformed when EITHER matches), which is the opposite of what is wanted.
// So the alternation is spliced, and it THROWS rather than silently narrowing if
// jest-expo's shape ever changes: a narrowed pattern surfaces as
// "SyntaxError: Cannot use import statement outside a module" from deep inside a
// dependency, which names nothing.
const EXTRA = ${JSON.stringify(extraTransformPackages(opts))};

function widen(patterns, extra) {
  const one = Array.isArray(patterns) ? patterns[0] : patterns;
  if (typeof one !== "string" || !one.includes("(?!")) {
    throw new Error(
      "flawless: jest-expo's transformIgnorePatterns is not the expected " +
        "node_modules/(?!(a|b)/) shape — refusing to guess. Got: " + String(one),
    );
  }
  if (extra.length === 0) return [one];
  return [one.replace("(?!(", "(?!(" + extra.join("|") + "|")];
}

module.exports = {
  ...preset,
  // Spread rather than named: the bare "jest-expo" preset is multi-project and
  // runs every spec once per platform, which multiplies the suite for no extra
  // signal on a codebase whose only Platform branching is a keyboard behaviour.
  preset: undefined,
  rootDir: projectRoot,
  setupFilesAfterEnv: [
    ...(preset.setupFilesAfterEnv ?? []),
    path.join(__dirname, ${JSON.stringify(JEST_SETUP)}),
  ],
  transformIgnorePatterns: widen(preset.transformIgnorePatterns, EXTRA),
  testMatch: ["<rootDir>/**/*.flawless.test.{ts,tsx}"],
  testPathIgnorePatterns: ["/node_modules/", "/\\\\.expo/", "/dist/", "/android/", "/ios/"],
  moduleNameMapper: {
    ...preset.moduleNameMapper,
    // app/_layout.tsx imports global.css for NativeWind. Jest cannot parse CSS,
    // and without this every route spec dies at import time.
    "\\\\.(css)$": path.join(__dirname, "styleStub.js"),
  },
};
${sdk === undefined ? "// NOTE: the Expo SDK major could not be read, so jest-expo is unpinned in package.json.\n" : `// Paired with jest-expo@~${sdk} — the major MUST match Expo SDK ${sdk}.\n`}`;
}

/**
 * Packages jest must transform beyond jest-expo's own allowlist.
 *
 * Derived from the project, not guessed: NativeWind ships untranspiled and its
 * absence here is a SyntaxError from inside a dependency. Everything under a
 * `react-native*` prefix is already covered by jest-expo's alternation, so
 * listing those again would only make the pattern longer.
 */
function extraTransformPackages(opts: NativeRenderOptions): string[] {
  return opts.expo.nativewind ? ["nativewind", "react-native-css-interop"] : [];
}

/**
 * jest.setup.ts — write-once, because it is where hand-written module mocks go
 * and nothing can rebuild those from the analysis.
 *
 * The 70 lines of jsdom shims the DOM setup carries (matchMedia, ResizeObserver,
 * IntersectionObserver, scrollIntoView, storage) are DELETED rather than ported.
 * jest-expo runs under `node` with no `window` at all, and adding one would be
 * inventing a DOM the app never sees.
 *
 * Deliberately NOT mocked here: react-native-reanimated, react-native-gesture-handler
 * and expo-linking. expo-router/testing-library's own mocks.js already wires all
 * three, and duplicating them is dead code that will rot.
 *
 * NEVER mocked, in any form: react-native itself. The dogfood app's own
 * tests/setup.ts does exactly that, and it is precisely why its testing skill
 * says "screens are not testable". jest-expo exists so you do not have to.
 */
function jestSetup(opts: NativeRenderOptions): string {
  const router = opts.expo.routerMajor !== undefined;
  return `// Generated by flawless-react — WRITE-ONCE. A re-run will not overwrite this,
// so hand-written module mocks belong here. Delete the file to regenerate it.
import { jest } from "@jest/globals";

// Icons render null and forward their handles.
//
// The tempting alternative — rendering <Text>{name}</Text> so an icon button
// becomes findable by its icon name — is a LIE: it invents an accessible name
// the shipped app does not have, so the spec would pass on a control a real user
// cannot reach. This choice and the selector ladder's refusal to guess a
// last-resort locator have to agree, or one of them is wrong.
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const handle = (props: Record<string, unknown>) =>
    React.createElement("Icon", {
      testID: props.testID,
      accessibilityLabel: props.accessibilityLabel,
    });
  return new Proxy({}, { get: () => handle });
});
${
  router
    ? `
// expo-secure-store reaches for a native module that does not exist under jest.
// Mocked GLOBALLY rather than per-spec: the component-level allowlist only sees
// a component's OWN imports, and a screen importing lib/api transitively pulls
// this in — which throws at collection time, before any test runs.
jest.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
`
    : ""
}
// react-native-safe-area-context's provider renders NOTHING until it measures,
// and under jest it never measures — so without initialMetrics every screen
// renders an empty tree and every assertion fails for a reason that has nothing
// to do with the component.
jest.mock("react-native-safe-area-context", () => {
  const actual = jest.requireActual("react-native-safe-area-context") as Record<string, unknown>;
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };
  return {
    ...actual,
    initialWindowMetrics: { insets: inset, frame },
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => frame,
  };
});
`;
}

/**
 * Which of the two native templates a component gets.
 *
 * A ROUTE SCREEN mounts through renderRouter at its own URL. That is not a
 * stylistic preference: useFocusEffect reaches useNavigation(), which throws
 * "Couldn't find a navigation object" outside a navigator, and useLocalSearchParams
 * is empty. On the dogfood app 19 of 31 route files use useFocusEffect, so a
 * plain render() would fail them all — and worse, would fail them in a way that
 * looks like the component is broken.
 *
 * Everything else mounts through RNTL's render().
 */
function routeOf(filePath: string, expo: ExpoContext) {
  if (!expo.routerRoot) return undefined;
  return expoFileToRoute(filePath, expo.routerRoot);
}

/**
 * A `_layout` file, mounted through its own navigator.
 *
 * `render(<TabsLayout/>)` throws "No filename found. This is likely a bug in
 * expo-router" — <Tabs> and <Stack> call useContextKey, which needs a route
 * context. So a layout gets the ROUTE template with a synthesised stub leaf
 * inside it, mounted at that leaf's URL: the navigator then has exactly one
 * child to render, which is the smallest honest way to exercise it.
 *
 * Found by executing the emitted suite. Nothing about the source says a layout
 * is different from any other default-exported component.
 */
function layoutRouteOf(filePath: string, expo: ExpoContext) {
  if (!expo.routerRoot) return undefined;
  const base = path.basename(filePath).replace(/\.(tsx|jsx|ts|js)$/, "");
  if (base !== "_layout") return undefined;
  const id = routeModuleId(filePath, expo.routerRoot);
  const dir = id.replace(/_layout$/, "");
  const leafId = `${dir}flawless-probe`;
  const urlPath = `/${dir
    .replace(/\/$/, "")
    .split("/")
    .filter((seg) => seg && !/^\(.*\)$/.test(seg))
    .concat("flawless-probe")
    .join("/")}`;
  return { id, leafId, urlPath };
}

function renderNativeSpec(
  info: Parameters<typeof synthesiseDefaults>[0],
  specName: string,
  opts: ResolvedNativeOptions,
  fromDir: string,
  /** Field names this component's subtree renders as text. */
  renderedFields: Set<string>,
  todo: TodoRecorder | undefined,
): string {
  const route = routeOf(info.filePath, opts.expo);
  const layout = layoutRouteOf(info.filePath, opts.expo);
  // Native read renderMode nowhere at all — grep was empty — so an undecidable
  // render reached the emitter as though it were an ordinary one and produced a
  // spec driving controls from a branch the defaults never take. A layout is
  // exempt: it is mounted through its own navigator with a synthesised child and
  // never described from its own render.
  if (info.renderUndecidable === true && !layout) {
    todo?.("other");
    return undecidableNativeSpec(
      specName,
      info.exportKind === "default" ? specName : `{ ${info.componentName} as ${specName} }`,
      importPathOf(fromDir, info),
    );
  }
  const importPath = importPathOf(fromDir, info);
  const imported =
    info.exportKind === "default" ? specName : `{ ${info.componentName} as ${specName} }`;
  const defaults = synthesiseDefaults(info);
  const clicks = info.interactions?.clicks ?? [];
  const providers = requiredNativeProviders(info.hooks ?? []);
  const loadedFixtures: LoadedFixture[] = [];
  const rejectedFixtures: RejectedFixture[] = [];
  const mocks = networkModuleMocks(
    info,
    fromDir,
    opts.resolver,
    opts.cache,
    loadedFixtures,
    rejectedFixtures,
    renderedFields,
    todo,
  );
  // Evidence, not a guess: the component awaits data iff a module the emitter
  // just mocked performs fetch(), or it registers a focus effect.
  const loadsData = mocks.length > 0 || (info.hooks ?? []).includes("useFocusEffect");

  const header = `// @flawless-generated
// ${route ? `Route screen for ${route.urlPath}` : "Component"} — regenerate with --force.
//
// expo-router/testing-library is imported FIRST, before the component under
// test. Its mocks.js calls jest.mock() at REQUIRE time rather than hoisted, so
// importing the component first would load the real module before the mock is
// installed.
`;

  const lines: string[] = [header];
  if (layout) {
    lines.push(
      `import { renderRouter, screen, fireEvent, waitFor } from "expo-router/testing-library";`,
      `import ${imported} from ${JSON.stringify(importPath)};`,
      "",
      `const DEFAULTS: Record<string, unknown> = {};`,
      `const SAMPLE_TEXT = "flawless";`,
      "",
      "// A layout is not mountable on its own: <Tabs>/<Stack> call useContextKey,",
      '// which throws "No filename found" without a route context. So it is',
      "// mounted through its own navigator with one synthesised child, which is the",
      "// smallest honest way to exercise it.",
      "const CONTEXT = {",
      `  ${JSON.stringify(layout.id)}: { default: ${specName} },`,
      `  ${JSON.stringify(layout.leafId)}: { default: () => null },`,
      "};",
      "",
      `describe(${JSON.stringify(specName)}, () => {`,
      `  test("mounts as a navigator", () => {`,
      `    renderRouter(CONTEXT, { initialUrl: ${JSON.stringify(layout.urlPath)} });`,
      "    expect(screen.toJSON()).not.toBeNull();",
      "  });",
      "});",
      "",
    );
    return lines.join("\n");
  }
  if (route) {
    // testRouter only when a handler calls router.back() and therefore needs a
    // history entry pushed first. Named unconditionally, it is an unused import
    // in every one of the other specs.
    const needsRouter = clicks.some((c) => c.navBack);
    lines.push(
      `import { renderRouter, screen, fireEvent, waitFor${needsRouter ? ", testRouter" : ""} } from "expo-router/testing-library";`,
    );
  } else {
    lines.push(
      `import { render, screen, fireEvent, userEvent, waitFor } from "@testing-library/react-native";`,
      // Type-only, and a NAMED import rather than a React namespace: the spec
      // has no other reason to name React, and `import type` is erased so it
      // cannot affect what jest loads or in what order.
      `import type { ComponentProps } from "react";`,
    );
  }
  lines.push(`import ${imported} from ${JSON.stringify(importPath)};`);
  if (route) lines.push(...routeContextImports(opts, fromDir, route));
  lines.push("");
  // The loaded-state tests drive the mock directly, so the spec imports the
  // mocked names — jest.mock has replaced the module, so these ARE the mocks.
  for (const imp of [...new Set(loadedFixtures.map((f) => `${f.fn}::${f.from}`))]) {
    const [fn, from] = imp.split("::") as [string, string];
    lines.push(`import { ${fn} } from ${JSON.stringify(from)};`);
  }
  lines.push(...mocks);
  // Record<string, unknown>, not `as const`: the prop rung emits
  // String(DEFAULTS["x"] ?? ""), which under Expo's strict tsconfig is TS7053
  // against a const-asserted literal — so an app running `tsc --noEmit` in CI
  // goes red on the generated file. The DOM emitter has always typed it this way.
  lines.push(`const DEFAULTS: Record<string, unknown> = ${JSON.stringify(defaults, null, 2)};`);
  // Function props, spread SEPARATELY because DEFAULTS is JSON and a function
  // cannot ride in it. Without these a prop-bound handler is undefined at mount:
  // pressing it asserted nothing, and deleting `onPress={onPress}` from the source
  // left the test green. The DOM emitter has passed spies for exactly this.
  const fnProps = route ? [] : functionProps(info);
  if (fnProps.length > 0) {
    lines.push(
      "const handlers: Record<string, jest.Mock> = {",
      ...fnProps.map((n) => `  ${JSON.stringify(n)}: jest.fn(),`),
      "};",
    );
  }
  lines.push(`const SAMPLE_TEXT = "flawless";`);
  lines.push("");
  if (route) lines.push(...routeContext(info, specName, opts, route));
  lines.push(`describe(${JSON.stringify(specName)}, () => {`);
  lines.push(
    ...mountTest(specName, route, providers, fnProps, Object.keys(defaults).length > 0, todo),
  );
  lines.push(...staticTextTests(info));
  lines.push(...interactionTests(clicks, Boolean(route), loadsData, todo));
  lines.push(...loadedStateTests(loadedFixtures, rejectedFixtures, mocks.length > 0, todo));
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

/**
 * The layout modules a route mounts inside, as imports.
 *
 * Only the layouts that actually EXIST — layoutChain reports every ancestor that
 * may have one, and asking renderRouter for a module that is not there is an
 * error rather than a no-op.
 */
function existingLayouts(opts: NativeRenderOptions, route: { layouts: string[] }): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const root = opts.expo.routerRoot as string;
  return route.layouts.filter((id) =>
    [".tsx", ".jsx", ".ts", ".js"].some((ext) => fs.existsSync(path.join(root, `${id}${ext}`))),
  );
}

function routeContextImports(
  opts: NativeRenderOptions,
  fromDir: string,
  route: NonNullable<ReturnType<typeof routeOf>>,
): string[] {
  const root = opts.expo.routerRoot as string;
  return existingLayouts(opts, route).map((id, i) => {
    const abs = path.join(root, id);
    // A namespace import: expo-router reads `ErrorBoundary` and
    // `unstable_settings` off a layout module, not just its default export.
    return `import * as Layout${i} from ${JSON.stringify(relativeToEmitted(fromDir, abs))};`;
  });
}

/**
 * renderRouter's context, as a plain OBJECT.
 *
 * Never the string form and never `{ appDir }`: expo-router resolves both with
 * `path.resolve(process.cwd(), …)` (build/testing-library/mock-config.js), so a
 * spec passing "./app" loads the wrong directory the moment jest runs from the
 * monorepo root rather than the app. The object form resolves nothing.
 */
function routeContext(
  info: Parameters<typeof synthesiseDefaults>[0],
  specName: string,
  opts: NativeRenderOptions,
  route: NonNullable<ReturnType<typeof routeOf>>,
): string[] {
  const root = opts.expo.routerRoot as string;
  const selfId = routeModuleId(info.filePath, root);
  const entries = existingLayouts(opts, route).map(
    (id, i) => `  ${JSON.stringify(id)}: Layout${i},`,
  );
  // specName, not componentName: the import above binds the ALIASED name when
  // allocateSpecNames renamed on a collision, so referencing componentName here
  // emitted a spec that parses fine and throws ReferenceError at module load.
  entries.push(`  ${JSON.stringify(selfId)}: { default: ${specName} },`);
  // A literal push target that is not in the context lands on expo-router's
  // injected +not-found, so a navigation assertion would fail for the wrong
  // reason. Stub every one this component navigates to.
  for (const target of literalPushTargets(info)) {
    const id = target.replace(/^\//, "") || "index";
    if (id === selfId) continue;
    entries.push(`  ${JSON.stringify(id)}: { default: () => null },`);
  }
  return [
    "// The OBJECT form of renderRouter's context. The string and { appDir } forms",
    "// both resolve against process.cwd(), so a spec using one breaks the moment",
    "// jest runs from the monorepo root instead of the app directory.",
    "const CONTEXT = {",
    ...dedupe(entries),
    "};",
    "",
    `const INITIAL_URL = ${JSON.stringify(seededUrl(route))};`,
    "",
  ];
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((l) => {
    const key = l.slice(0, l.indexOf(":"));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A concrete URL for the route, with a deterministic literal per dynamic segment. */
function seededUrl(route: { urlPath: string }): string {
  return route.urlPath
    .replace(/\[\.\.\.(.+?)\]/g, "flawless-$1")
    .replace(/\[(.+?)\]/g, "flawless-$1");
}

/** `router.push("/literal")` targets, which the context must carry a stub for. */
function literalPushTargets(info: Parameters<typeof synthesiseDefaults>[0]): string[] {
  const out: string[] = [];
  for (const c of info.interactions?.clicks ?? []) {
    for (const t of c.pushTargets ?? []) out.push(t);
  }
  return [...new Set(out)];
}

/** The mount test — the one assertion every native spec can honestly make. */
function mountTest(
  specName: string,
  route: ReturnType<typeof routeOf>,
  providers: ReturnType<typeof requiredNativeProviders>,
  fnProps: string[],
  /** Whether DEFAULTS has anything in it — see the no-props note below. */
  hasProps: boolean,
  todo: TodoRecorder | undefined,
): string[] {
  const out: string[] = [];
  if (route) {
    out.push(
      `  const mount = () => renderRouter(CONTEXT, { initialUrl: INITIAL_URL });`,
      "",
      `  test("mounts at ${route.urlPath}", () => {`,
      "    mount();",
      "    // The pathname is the claim. `expect(screen.toJSON()).not.toBeNull()`",
      '    // used to stand here calling itself "the direct analogue of the DOM',
      "    // spec's container.firstElementChild check\" — it is not. renderRouter",
      "    // mounts the screen inside a navigator, so the NAVIGATOR's tree answers",
      "    // it whatever the screen returns. Executed: a route screen whose whole",
      "    // body is `return null` passes that assertion.",
      `    expect(screen).toHavePathname(${JSON.stringify(seededUrl(route))});`,
      "  });",
      "",
    );
    if (providers.some((p) => p.hook === "useFocusEffect")) {
      // Mounted inside a real navigation container the screen is FOCUSED, so
      // useFocusEffect runs — which is the whole reason route screens use
      // renderRouter rather than render.
      // No "its focus effect runs on mount" test.
      //
      // It used to assert `screen.toJSON()).not.toBeNull()`, which is answered by
      // the navigator's own tree under renderRouter — so it could not fail, AND it
      // said nothing whatever about whether the focus effect ran. A test whose
      // NAME is a claim its body does not make is worse than no test.
      //
      // What actually proves the focus effect ran is the loaded-state test below:
      // it mocks one api function to return a row and asserts the row appears,
      // which cannot happen unless the effect fired and the fetch resolved. Where
      // that test does not qualify, this emitter has no proof to offer and says so
      // rather than staging one.
      // Blur/refocus is the reason the app uses useFocusEffect over useEffect, and
      // a single mount never blurs. Whether a refetch SHOULD happen depends on
      // state this emitter cannot reason about, so it is hand-work, named.
      todo?.("other");
      out.push(
        "  // TODO(flawless): this screen refetches on REFOCUS, which a single mount",
        "  // never exercises. To cover it:",
        '  //   testRouter.push("/somewhere-else"); testRouter.back();',
        "  //   expect(<your api mock>).toHaveBeenCalledTimes(2);",
        "  // Whether a second call is correct depends on the screen's own guard, so",
        "  // the assertion is yours to make.",
        "",
      );
    }
    return out;
  }
  if (fnProps.length > 0) {
    // Cleared between tests, or "was this handler called" is answered by an
    // earlier test in the same file rather than by this one.
    out.push(
      "  beforeEach(() => {",
      "    for (const h of Object.values(handlers)) h.mockClear();",
      "  });",
      "",
    );
  }
  // `{...(x as never)}` is TS2698 — never is not an object type — so every
  // component spec this emitter wrote failed `tsc --noEmit` in the adopting app,
  // which is the one place a generated file being unbuildable actually bites.
  //
  // The DOM emitter has known this since its own RSC branch hit it
  // (templates.ts: "`{...(props as never)}` is a type error … so the spread is
  // cast to the component's own props instead") and casts to
  // React.ComponentProps<typeof X>. The native copy used the exact form that
  // comment names as broken, one line down from a comment about keeping
  // DEFAULTS a Record so Expo's strict tsconfig stays green.
  //
  // Nothing caught it: parse-level checks are happy with a cast, and there was
  // no ts.Program gate over the native emitter at all until now.
  const propsCast = `as unknown as ComponentProps<typeof ${specName}>`;
  // A component that declares NO props makes ComponentProps<typeof X> resolve to
  // `unknown` — a zero-parameter function does not match JSXElementConstructor —
  // and spreading that is TS2698 again, plus TS2322 for good measure. The DOM
  // emitter has always omitted the spread entirely in that case
  // (`const spread = hasProps ? … : ""`), which is also simply more honest:
  // there is nothing to pass.
  const defaultsSpread = hasProps ? ` {...(DEFAULTS ${propsCast})}` : "";
  out.push(
    fnProps.length > 0
      ? `  const mount = () => render(<${specName}${defaultsSpread} {...(handlers ${propsCast})} />);`
      : `  const mount = () => render(<${specName}${defaultsSpread} />);`,
    "",
    `  test("mounts and renders something", () => {`,
    "    mount();",
    "    expect(screen.toJSON()).not.toBeNull();",
    "  });",
    "",
  );
  for (const p of providers) {
    // A non-route component that still needs a navigator cannot be mounted by
    // render() at all — say which hook and which wrapper, rather than emitting a
    // spec that throws.
    todo?.("other");
    out.push(`  // TODO(flawless): this component ${p.note}`, "");
  }
  return out;
}

/**
 * Static copy the component renders unconditionally.
 *
 * Ports unchanged from the DOM emitter in mechanism, and it is the one part that
 * needed no rethinking: RNTL's getByText matches a <Text>'s composed content,
 * which is where React Native copy lives.
 */
function staticTextTests(info: Parameters<typeof synthesiseDefaults>[0]): string[] {
  const texts = (info.staticText ?? []).filter((t) => t.trim().length > 1).slice(0, 5);
  if (texts.length === 0) return [];
  return [
    `  test("renders its static copy", () => {`,
    "    mount();",
    ...texts.map(
      (t) => `    expect(screen.getAllByText(${JSON.stringify(t)}).length).toBeGreaterThan(0);`,
    ),
    "  });",
    "",
  ];
}

/**
 * One test per handler the ladder can address, and a NAMED SKIP for each one it
 * cannot.
 *
 * The skip is the point. A locator that matches nothing would let
 * fireEvent.press run against undefined and the test pass having touched
 * nothing — the exact failure `emitVitestSelector`'s undefined return was
 * written to prevent, arriving on a second platform.
 */
/**
 * What a spec may honestly assert AFTER firing an event.
 *
 * Without these the interaction tests were `expect(el).toBeTruthy(); fireEvent(…)`
 * and stopped — proving the element is addressable and nothing else. Measured on
 * the dogfood apps: 17 of 87 live mobile tests and 25 of 341 web tests fired an
 * event and asserted nothing after it, which is a test that cannot fail.
 *
 * Every rule below was PROBED under real jest-expo before being emitted, because
 * reasoning about RNTL's behaviour is how the last three defects got in:
 *
 *   controlled TextInput   -> display value reflects the typed text   (1 match)
 *   uncontrolled TextInput -> so does it                              (1 match)
 *   frozen (value, no onChangeText) -> it does NOT                    (0 matches)
 *   prop spy               -> called                                  (1 call)
 *   throwing handler       -> propagates out of fireEvent
 *
 * The frozen case is why the display-value assertion is safe to emit: the only
 * shape it fails on is an input the app has genuinely wired wrong, and the
 * analyser can already tell that one apart.
 */
function postDispatchAssertions(
  h: Parameters<typeof emitNativeSelector>[0],
  el: string,
  /**
   * A route spec declares no `handlers`. `const fnProps = route ? [] : …` above
   * suppresses the whole block for route files, and this returned
   * `expect(handlers["onX"]).toHaveBeenCalled()` regardless — an undeclared
   * identifier, so TS2304 in the emitted file and a ReferenceError in the one
   * interaction test that runs it.
   *
   * Latent rather than shipped-broken: expo-router hands a route screen no
   * props, so nothing in the fixture app or the dogfood app has the shape. It
   * became reachable the moment a route file's default export declared one.
   */
  hasHandlers: boolean,
): string[] {
  // A handler bound to a PROP is the precise case: pass a spy, assert it ran.
  if (h.binding.kind === "prop") {
    if (!hasHandlers) return [];
    return [`    expect(handlers[${JSON.stringify(h.binding.propName)}]).toHaveBeenCalled();`];
  }
  if (h.event === "onChangeText") {
    // Typing into a wired input changes what it displays. Probed above for all
    // three wirings; only the frozen one fails, and that is an app defect.
    return [`    expect(${el}).toHaveDisplayValue(SAMPLE_TEXT);`];
  }
  // The floor, for a handler whose effect is not statically knowable: the tree
  // survived. Weak, but it is a real assertion — a handler that throws, or that
  // sets state the next render cannot cope with, fails here. It is strictly more
  // than the nothing that was emitted before.
  // The native floor, and the half of E5 that goes RED rather than vacuous: this
  // plane has no provider, so `screen.toJSON()` really is the screen's own tree
  // and a component that legitimately unmounts fails here on correct code.
  //
  // Replaced by the canary: drive the press, and assert only that nothing escaped
  // it. Strictly more than the floor — a throwing handler previously failed the
  // RUN with no assertion involved, and now names the test that caused it.
  // The native floor, and the half of E5 that goes RED rather than vacuous: this
  // plane has no provider, so `screen.toJSON()` really is the screen's own tree
  // and a component that legitimately unmounts fails here on correct code.
  //
  // Nothing replaces it, deliberately. RNTL's fireEvent calls the handler
  // SYNCHRONOUSLY, so a throw already fails this test at the dispatch line above
  // — the test has a falsifier without inventing a claim. The locator assertion
  // that precedes the dispatch is the other one. Adding a survival check here
  // would be re-adding the thing this removes.
  return [
    `    // TODO(flawless): ${describeNoClaim("opaque-callback")}, so nothing is`,
    "    // asserted after the press. The press itself is still checked: it throws",
    "    // out of this test if the handler throws, and the locator above must find",
    "    // the control. It becomes a real test as soon as the callback is a prop",
    "    // (the spec passes a spy) or the work goes through a module this spec mocks.",
  ];
}

function interactionTests(
  clicks: Parameters<typeof emitNativeSelector>[0][],
  isRoute: boolean,
  /**
   * The component awaits data before its final render — it has a focus effect,
   * or a module the emitter mocked performs fetch(). Its targets may not exist
   * at mount, so the query has to be the async one.
   */
  loadsData: boolean,
  todo: TodoRecorder | undefined,
): string[] {
  const out: string[] = [];
  // renderRouter turns on fake timers internally, and userEvent's press timing
  // under fake timers is not something this emitter can vouch for. fireEvent has
  // no timers in it.
  const useUserEvent = !isRoute;
  let n = 0;
  for (const h of clicks) {
    // A conditionally-reached target on a data-loading screen is one row of a
    // list the fixture leaves empty, so it does not render and cannot be driven.
    // The analyser is right to keep it — dropping every mapped row would lose most
    // of a list screen — but a test that presses it fails for a reason that is
    // neither the tool's nor the component's. A skip that names the gap is the
    // honest form, and the fix is a fixture with rows, which is hand-work.
    if (h.conditional && loadsData) {
      todo?.("other");
      out.push(
        `  test.skip("${h.event} on <${h.tag}> — renders once per row, and the generated ` +
          `fixture has no rows; give the mock a non-empty collection to drive it", () => {});`,
        "",
      );
      continue;
    }
    const target = emitNativeSelector(h);
    if (!target) {
      todo?.("unaddressable-target");
      out.push(
        `  test.skip("${h.event} on <${h.tag}> — ${safeTitle(describeUnlocatableNative(h))}", () => {});`,
        "",
      );
      continue;
    }
    const el = `el${n++}`;
    // A screen that loads in a focus effect renders its empty state first and
    // its rows only after the awaited fetch resolves, so a synchronous query at
    // mount fails with "Unable to find an element with text" — which reads as a
    // missing element and is really a missing await.
    const locator = loadsData ? awaitNativeSelector(target.locator) : target.locator;
    // `(await …)[0]` as well as `await …`: the indexed form needs the parens for
    // precedence, and a startsWith("await") check missed it — emitting an `await`
    // inside a non-async callback, which is a SyntaxError that takes the whole
    // suite file out of the run.
    const locatorIsAsync = /^\(?await /.test(locator);
    // The handle, so two identical handlers on two different elements do not
    // produce two identically-named tests — a duplicate name makes a failure
    // report ambiguous about which one broke.
    // Sanitised, because it is interpolated into a double-quoted test title and
    // its content is the APP's: a testID or a label containing a `"` produced an
    // unparseable spec, and jest then failed to collect the whole file. The DOM
    // emitter has done `titleSafe(s.replace(/"/g, "'"))` since FR-012 for exactly
    // this; the native copy did not.
    const handle = safeTitle(describeHandle(h, target));
    const dispatch = emitNativeDispatch(h.event, target, el, useUserEvent);
    if (!dispatch) {
      todo?.("other");
      out.push(
        `  test.skip("${h.event} on <${h.tag}> — no honest way to dispatch this event", () => {});`,
        "",
      );
      continue;
    }
    // Two separate questions that used to share one answer. `isAsync` decides
    // whether the callback is `async`; `usesUserEvent` decides whether to set up
    // a user instance. Conflating them emitted `userEvent.setup()` into route
    // specs — which import from expo-router/testing-library and never name
    // userEvent — as soon as an async LOCATOR made isAsync true.
    const usesUserEvent = dispatch.startsWith("await user.");
    const isAsync = usesUserEvent || locatorIsAsync;
    // `router.back()` needs a history entry, and renderRouter mounts ONE screen
    // at ONE url with no stack behind it — so the press dispatches GO_BACK into
    // a navigator that has nowhere to go, and react-navigation logs "The action
    // 'GO_BACK' was not handled by any navigator", which RNTL surfaces as a
    // failure. Twelve dogfood screens failed that way the moment their back
    // buttons became addressable: a missing PRECONDITION reported as a defect.
    // Pushing the same url first makes the stack two deep, so back() has a
    // destination and the handler is exercised for real. Route specs only —
    // a component spec has no router to push into, and there the skip below is
    // the honest answer.
    const needsHistory = Boolean(h.navBack) && isRoute;
    if (h.navBack && !isRoute) {
      todo?.("other");
      out.push(
        `  test.skip("${h.event} on <${h.tag}> ${handle} — calls router.back(), which needs a ` +
          `navigation stack this component spec does not mount", () => {});`,
        "",
      );
      continue;
    }
    out.push(
      `  test("${h.event} on <${h.tag}> ${handle} can be driven", ${isAsync ? "async " : ""}() => {`,
      ...(usesUserEvent ? ["    const user = userEvent.setup();"] : []),
      "    mount();",
      ...(needsHistory
        ? [
            "    // Give back() somewhere to go — see the note in the emitter: a freshly",
            "    // mounted router has no history, and GO_BACK into an empty stack fails.",
            "    testRouter.push(INITIAL_URL);",
          ]
        : []),
      `    const ${el} = ${locator};`,
      `    expect(${el}).toBeTruthy();`,
      `    ${dispatch};`,
      ...postDispatchAssertions(h, el, !isRoute),
      ...(h.pushTargets?.length
        ? [
            "    // The push target is a literal in the source, so where it lands is",
            "    // knowable — the React Native analogue of asserting a link's href.",
            `    expect(screen).toHavePathname(${JSON.stringify(h.pushTargets[0])});`,
          ]
        : []),
      "  });",
      "",
    );
  }
  return out;
}

/** How the target was found, for a test name that identifies WHICH element. */
function describeHandle(
  h: Parameters<typeof emitNativeSelector>[0],
  target: NonNullable<ReturnType<typeof emitNativeSelector>>,
): string {
  switch (target.rung) {
    case "testID":
      return `[testID=${h.hints.testid}]`;
    case "label":
      return `[${h.hints.ariaLabel}]`;
    case "role":
      return `[role=${h.hints.role}]`;
    case "placeholder":
      return `[placeholder=${h.hints.placeholder}]`;
    case "displayValue":
      return `[value=${h.hints.displayValue}]`;
    default:
      return `[${"value" in h.label ? h.label.value : "text"}]`;
  }
}

/**
 * `jest.mock(...)` for the modules a component's render would otherwise send to
 * the network.
 *
 * This is not a nicety. Without it the emitted suite makes LIVE HTTP CALLS: the
 * fixture run hit a real server on localhost and crashed the jest worker with
 * "api_error 405". A spec whose result depends on what is listening on a port is
 * not a test, and on a machine with nothing listening it would fail differently
 * — which is worse, because it would look like the component.
 *
 * Evidence, not a name convention: the specifier resolves to a project-local
 * file, and that file performs a `fetch(`. A helper module that does no I/O is
 * left alone, because mocking it would strip behaviour the component genuinely
 * has — the same reason the DOM emitter's allowlist refuses to mock `cn`.
 */
/** A mocked call whose shape carries a collection, and the one-row fixture for it. */
/** A collection-returning function that did NOT qualify, and why. */
export interface RejectedFixture {
  fn: string;
  reason: string;
}

export interface LoadedFixture {
  /** Local name of the mocked function, as the component imports it. */
  fn: string;
  /** Specifier to import it from, already relativised to the spec. */
  from: string;
  /** The resolved shape with ONE row in each collection, as emitted JSON. */
  rows: string;
  /** A literal string from inside that row, which the loaded render must display. */
  witness: string | undefined;
}

function networkModuleMocks(
  info: Parameters<typeof synthesiseDefaults>[0],
  fromDir: string,
  resolver: ModuleResolver,
  cache: SourceFileCache,
  loaded: LoadedFixture[],
  rejected: RejectedFixture[],
  renderedFields: Set<string>,
  todo: TodoRecorder | undefined,
): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  const self = cache.get(info.filePath);
  // THIS component's subtree, not the whole file. Two exported components in one
  // file share moduleImports and every other file-level fact, so a file-scoped
  // walk handed a component that calls nothing a skip naming a function from its
  // sibling — a statement about the component that was simply untrue.
  const scope = self ? componentNode(self, info.componentName) : undefined;
  const mountCalls = scope ? mountPathCalls(scope) : new Set<string>();
  const renderCalls = scope ? collectionRenderingCalls(scope) : new Map<string, Set<string>>();
  // Names THIS component actually mentions. Everything else about a mocked module
  // is file-level, so without this a component that references none of an
  // import's names is still told why one of them did not qualify.
  const mine = scope ? referencedNames(scope) : undefined;
  for (const mi of info.moduleImports ?? []) {
    if (mi.isTypeOnly || !mi.resolvedPath) continue;
    let src: string;
    try {
      src = fs.readFileSync(mi.resolvedPath, "utf8");
    } catch {
      continue;
    }
    if (!/\bfetch\s*\(/.test(src)) continue;
    // EVERY exported function of the module, not just the ones this component
    // imports — the same rule serverActionExports follows on the web path, for
    // the same reason its comment gives: "a transitive importer needs the
    // others". jest.mock replaces the module in the whole registry, so a name
    // this component happens not to import still has to be there, or the other
    // importer receives undefined and fails somewhere unrelated.
    //
    // Taking the module's own exports rather than the import list ALSO drops
    // type-only names. `import { listMessages, type AshaMessage }` is not a
    // type-only DECLARATION, so mi.names carries "AshaMessage" and the mock was
    // stubbing a type as though it were a function.
    const target = cache.get(mi.resolvedPath);
    const names = target
      ? [...new Map(exportedFunctions(target)).keys()]
      : mi.names.filter((n) => n !== "default");
    if (names.length === 0) continue;
    // The mocked function's OWN `Promise<T>` annotation, read by exactly the rules
    // resolveDepReturns' Path A uses — including through a workspace package's
    // barrel, which is what B-8 and B-9 were built for.
    //
    // This is not a nicety either. A `{}` placeholder is not merely uninformative:
    // `const { items } = await listBuildings()` then binds `items` to undefined,
    // `setBuildings(undefined)` follows, and the next `buildings.length` throws
    // into the app's own ErrorBoundary — so the screen renders "Something went
    // wrong" and every copy assertion fails. A freshly generated suite was RED on
    // 3 of 31 real screens for that reason alone, and the failure looked like the
    // component rather than like the fixture.
    // Relative to the SPEC, not to the component. `app/login.tsx` writes
    // "../lib/api"; from flawless/unit/ that names flawless/lib/api, which does
    // not exist. A bare specifier (a package, a tsconfig alias) is left as
    // written, because jest resolves those the same way from anywhere.
    const spec = mi.specifier.startsWith(".")
      ? relativeToEmitted(fromDir, mi.resolvedPath).replace(/\.(tsx|jsx|ts|js)$/, "")
      : mi.specifier;
    // A name this component actually imports gets a REAL fixture; every other
    // export of the module gets a bare stub.
    //
    // Both halves matter. The full surface is what stops a transitive importer
    // receiving undefined from a module jest.mock has replaced wholesale. But
    // resolving a fixture for all ~70 exports of a real api client duplicates
    // those bodies into every spec — measured at 793 KB across 31 specs against
    // 113 KB, with a single 30 KB file. An export nobody in this render calls
    // only needs to EXIST.
    // MODULE-SIDE names, because `names` above comes from exportedFunctions and
    // is what the module exports. `mi.names` is what THIS file bound them to, so
    // comparing the two silently misses every aliased import:
    //
    //   import { listItems as fetchItems } from "../lib/api";
    //
    // `used.has("listItems")` was false, so listItems fell to the bare `{}` stub
    // — with NO marker — while the identical unaliased import got its real
    // inferred shape. That is R-3's poisoning shape exactly: the destructure
    // binds undefined, the screen renders its error state, and the failure looks
    // like the component. The web emitter has read importedNames since it was
    // added (mocks.ts membershipName); the native copy never did.
    const used = new Set(mi.names.map((local, i) => mi.importedNames?.[i] ?? local));
    // The reverse: module-side name -> what THIS file calls it. The three lookups
    // below all read facts collected from the component's own subtree, where the
    // name that appears is the LOCAL one. Querying them with the module-side name
    // made an aliased import lose its loaded-state test AND its skip — the
    // component simply vanished from that half of the emitter.
    const localOf = new Map(
      mi.names.map((local, i) => [mi.importedNames?.[i] ?? local, local] as const),
    );
    const bodies = names.map((n) => {
      if (!used.has(n)) return `  ${n}: jest.fn(async () => ({})),`;
      const value = annotatedReturnValue(mi.resolvedPath as string, n, resolver, cache);
      // Annotated `Promise<void>`: undefined IS the realistic return value, so
      // no marker. `logout`, `changePassword` and `forgotPassword` in the
      // dogfood app each carried a TODO telling the reader to invent a shape
      // for a function that returns nothing.
      if (value === VOID_RETURN) {
        return `  ${n}: jest.fn(async () => undefined), /* annotated Promise<void> */`;
      }
      if (value === undefined) {
        // No resolvable annotation: an honest empty object plus the marker, which
        // is the same bail resolveDepReturns makes rather than inventing a shape.
        todo?.("uninferred-return-shape");
        return `  ${n}: jest.fn(async () => ({})), // TODO(flawless): give this a realistic return value`;
      }
      // The same shape with ONE row, kept for a loaded-state test. The default
      // mock stays empty so the assertions derived from the initial render hold;
      // this is the declared, deliberate other state.
      // Only a function this component actually CALLS when it mounts. The
      // loaded-state test mocks one to return a row and asserts the row shows;
      // if mounting never reaches the call, the mock is irrelevant and the test
      // fails on a healthy screen. Eleven of the dogfood app's thirty-one failed
      // exactly so — `reportJob` is a submit handler's mutation, and
      // `listBuildingInvitations` sits behind `if (isTrustee)`.
      const local = localOf.get(n) ?? n;
      const rowFields = renderCalls.get(local);
      if (
        hasCollection(value) &&
        (mine?.has(local) ?? true) &&
        !(mountCalls.has(local) && rowFields !== undefined)
      ) {
        rejected.push({
          fn: n,
          reason: !mountCalls.has(local)
            ? "mounting this screen never calls it — it runs from an event handler, or behind a branch"
            : // Deliberately "nothing this emitter can trace" rather than "it is
              // never rendered". Both are reasons the test cannot be written, and
              // the emitter cannot tell them apart: it follows
              // `const { x } = await fn()` and Promise.all into a useState setter,
              // and not a `.then()` callback. Claiming the screen does not render
              // the rows is a statement about the COMPONENT, and on a screen that
              // loads through .then() it is simply false.
              "nothing this emitter can trace connects what it returns to a rendered list",
        });
      }
      if (hasCollection(value) && mountCalls.has(local) && rowFields !== undefined) {
        loaded.push({
          fn: n,
          from: spec,
          rows: JSON.stringify(value),
          // The row's OWN fields when this collection is mapped inline, and the
          // subtree's file-wide set only when it is handed to a FlatList, whose
          // renderItem is not read here.
          witness: displayWitness(value, rowFields.size > 0 ? rowFields : renderedFields),
        });
      }
      return `  ${n}: jest.fn(async () => (${JSON.stringify(emptyCollections(value))})), /* shape inferred from its Promise<T> annotation */`;
    });
    out.push(
      `// ${spec} performs fetch(), so an unmocked render would make a LIVE`,
      "// HTTP call — which is not a test.",
      `jest.mock(${JSON.stringify(spec)}, () => ({`,
      ...bodies,
      "}));",
      "",
    );
  }
  return out;
}

/** A string safe to interpolate into a double-quoted, non-template test title. */
function safeTitle(s: string): string {
  return titleSafe(s.replace(/"/g, "'"));
}

/**
 * The resolved shape, with every array emptied.
 *
 * Both halves matter, and neither is optional.
 *
 * The SHAPE has to be real: a bare `{}` means `const { items } = await list()`
 * binds items to undefined, `setItems(undefined)` follows, and the next
 * `items.length` throws into the app's own ErrorBoundary — so the screen renders
 * "Something went wrong" and every assertion fails for a reason that looks like
 * the component.
 *
 * The arrays have to be EMPTY, and this is the subtler half. Every assertion in
 * the spec describes the render `renderPath` evaluated, and it evaluates at the
 * component's INITIAL state — `useState([])`, an empty store. A fixture carrying
 * one row flips the component into its loaded branch, so the empty-state copy the
 * analyser harvested is genuinely no longer on screen and the spec fails while
 * both halves are behaving correctly. Measured: a one-row fixture put three of
 * the dogfood app's screens into exactly that mismatch.
 *
 * So the fixture is the richest one that does not change which branch renders.
 * Describing the loaded branch means teaching the analyser about it, which is a
 * different piece of work than mocking.
 */
function emptyCollections(value: unknown): unknown {
  if (Array.isArray(value)) return [];
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, emptyCollections(v)]),
    );
  }
  return value;
}

/** Whether a resolved shape contains a collection anywhere. */
function hasCollection(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasCollection);
  }
  return false;
}

/**
 * A string from the fixture that a row is actually likely to DISPLAY.
 *
 * The first string leaf is usually `id`, which almost nothing renders — the first
 * cut asserted `flawless-id` and 21 suites went red because the row shows a name,
 * not a key. So the search is by FIELD NAME, over the handful of keys that carry
 * display text, and it gives up rather than guessing when none is present.
 *
 * The synthesised values are `flawless-<field>`, which appear nowhere else in the
 * app — so finding one on screen proves the ROW rendered, rather than that some
 * other copy happened to match.
 */
/**
 * Fallback key names, used only when the subtree's own evidence is unavailable —
 * a component whose rows come from a child the analyser could not reach.
 */
const DISPLAY_KEYS = [
  "name",
  "title",
  "label",
  "subject",
  "heading",
  "business_name",
  "full_name",
  "display_name",
  "text",
  "body",
  "message",
  "description",
  "email",
];

function displayWitness(value: unknown, rendered: Set<string>): string | undefined {
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = displayWitness(v, rendered);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  // The subtree's own evidence first: a field some component renders as text.
  for (const [key, v] of Object.entries(obj)) {
    if (rendered.has(key) && typeof v === "string" && v.startsWith("flawless-")) return v;
  }
  for (const key of DISPLAY_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.startsWith("flawless-")) return v;
  }
  for (const v of Object.values(obj)) {
    const found = displayWitness(v, rendered);
    if (found) return found;
  }
  return undefined;
}

/**
 * A test for the screen's LOADED state.
 *
 * The default mock returns empty collections on purpose — every assertion the
 * analyser derived describes the render `renderPath` evaluated, which is the
 * component's initial state. But that leaves the loaded branch of every list
 * screen unexecuted, and on the dogfood app that branch is where most of the
 * missing BRANCH coverage lives (39.2% on mobile).
 *
 * So the loaded state gets its own test, which declares the state it is setting
 * up instead of changing the state every other test runs in. The witness is a
 * synthesised `flawless-<field>` value from the fixture, which appears nowhere
 * else in the app — so finding it on screen proves the row rendered, rather than
 * that some other copy happened to match.
 *
 * Skipped rather than asserted when the fixture has no string leaf to witness:
 * a collection of numbers renders nothing uniquely identifiable, and a test that
 * cannot tell the loaded render from the empty one is not a test.
 */
function loadedStateTests(
  fixtures: LoadedFixture[],
  rejected: RejectedFixture[],
  mocked: boolean,
  todo: TodoRecorder | undefined,
): string[] {
  if (!mocked) return [];
  if (fixtures.length === 0) {
    // Nothing qualified. Say which of the three it was, per function, rather
    // than emitting nothing — the absence of a loaded-state test on a list
    // screen is the kind of gap that reads as "covered" if it is silent.
    if (rejected.length === 0) return [];
    const out: string[] = [];
    for (const r of rejected.slice(0, 3)) {
      todo?.("other");
      out.push(`  test.skip("loaded state via ${r.fn} — ${safeTitle(r.reason)}", () => {});`, "");
    }
    return out;
  }
  const out: string[] = [];
  // ONE recipe per spec, not one per mocked collection. A detail screen mocks
  // half a dozen api functions and the rest are the same recipe with a different
  // fixture — repeating it turns a useful pointer into noise, and noise is how a
  // skip list stops being read. Prefer one with a witness.
  const chosen = fixtures.find((f) => f.witness !== undefined) ?? fixtures[0];
  for (const f of chosen ? [chosen] : []) {
    if (f.witness === undefined) {
      out.push(
        `  test.skip("${f.fn}: loaded state — its fixture has no unique string to witness, ` +
          `so a loaded render cannot be told from an empty one", () => {});`,
        "",
      );
      continue;
    }
    // A REAL test now, where it used to be a skip carrying a recipe.
    //
    // The skip existed because enabling it failed on eleven of the dogfood app's
    // thirty-one screens, and the note here blamed "an external store the
    // harness does not reach". That was a guess and it was wrong. Three causes,
    // all visible in the AST and all now filtered on:
    //
    //   the function is never called on mount   `reportJob` is a submit handler
    //   the call is behind a branch             `if (isTrustee) listBuilding…()`
    //   what it returns is never rendered       memberships decide a boolean
    //
    // plus one that was not a filter but a defect: a SIBLING call on the same
    // mount path whose shape could not be inferred mocked to `{}`, so
    // `const [{ poll: p }] = await Promise.all([getPoll(…), …])` bound p to
    // undefined, `p.my_vote_option_id` threw into the screen's own catch, and
    // the error state rendered while the test looked for a row. That is fixed at
    // the source — interface heritage and Record<K,V> resolve now — and the
    // dogfood app has no uninferred api shapes left.
    //
    // Fourteen screens qualify and all fourteen pass. The seventeen that do not
    // qualify get the skip below, which names which of the three it was.
    out.push(
      `  test("renders the loaded state when ${f.fn} returns a row", async () => {`,
      `    (${f.fn} as unknown as jest.Mock).mockResolvedValue(${f.rows});`,
      "    mount();",
      "    // The witness is a synthesised value from a field THIS list's row",
      "    // renders as a JSX child — so finding it proves the row rendered,",
      "    // rather than that some other element in the file happened to match.",
      `    expect((await screen.findAllByText(${JSON.stringify(f.witness)}, { exact: false })).length).toBeGreaterThan(0);`,
      "  });",
      "",
    );
  }
  return out;
}

/** The spec's import path for a component, relative to where the spec is written. */
function importPathOf(fromDir: string, info: { filePath: string }): string {
  return relativeToEmitted(fromDir, info.filePath).replace(/\.(tsx|jsx|ts|js)$/, "");
}

/**
 * The native peer of undecidableRenderSpec.
 *
 * Same reasoning: with no decidable initial render there is nothing to assert
 * that is not a claim about a branch the defaults may never take. On this plane
 * the mount test is `expect(screen.toJSON()).not.toBeNull()`, which is exactly
 * the assertion that fails on a boundary rendering its children — so emitting it
 * would be the false-red half of the same defect.
 */
function undecidableNativeSpec(specName: string, imported: string, importPath: string): string {
  return `// @flawless-generated
// Component — regenerate with --force.

import ${imported} from ${JSON.stringify(importPath)};

void ${specName};

// render() branches on a condition the analyser could not decide, and every
// branch returns content — so there is no single render to describe.
//
// To make it assertable, give the deciding value a knowable initial state (a
// useState with a literal, or a class \`state = { … }\` field this can read), or
// pass it as a prop the spec controls.
test.skip("${specName} — render() branches on a condition this analysis could not decide (class state, or a value from a hook it does not follow); no render can be described", () => {});
`;
}
