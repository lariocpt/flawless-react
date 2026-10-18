import { describe, expect, test } from "bun:test";
import path from "node:path";
import { type RenderedFile, renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import type {
  ClickHandler,
  ComponentInfo,
  ComponentTree,
  DataDepInfo,
  FetchCallInfo,
  ModuleImportInfo,
  ProviderRef,
  SourcePosition,
} from "../src/types.ts";

const OUT = "/proj/flawless";
const SRC = "/proj/src";

function pos(line = 1, column = 1, file = `${SRC}/T.tsx`): SourcePosition {
  return { file, line, column };
}

function comp(name: string, extra: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    componentName: name,
    filePath: `${SRC}/${name}.tsx`,
    importSpecifier: `./${name}.tsx`,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    ...extra,
  };
}

function tree(entry: ComponentInfo, children: ComponentTree[] = []): ComponentTree {
  return { entry, children };
}

function click(over: Partial<ClickHandler> = {}): ClickHandler {
  return {
    event: "onClick",
    tag: "button",
    label: { kind: "none" },
    hints: {},
    binding: { kind: "inline" },
    ...over,
  };
}

function moduleImport(over: Partial<ModuleImportInfo> & { specifier: string }): ModuleImportInfo {
  return {
    names: [],
    kind: "value",
    isTypeOnly: false,
    hasDefault: false,
    pos: pos(1),
    ...over,
  };
}

function dataDep(over: Partial<DataDepInfo> & { callee: string }): DataDepInfo {
  return {
    // A destructured binding has no local name, and these template tests are
    // about the call, not the binding. `pos` is required by the type, so the
    // fixture says which line it is on like every other builder in this file.
    varName: undefined,
    calleeRoot: over.callee,
    awaited: true,
    shape: { kind: "unknown" },
    uncertain: true,
    pos: pos(1),
    ...over,
  };
}

function fetchCall(over: Partial<FetchCallInfo> & { urlTemplate: string }): FetchCallInfo {
  return {
    holes: [],
    method: "GET",
    pos: pos(7),
    inEffect: true,
    ...over,
  };
}

function relPaths(files: RenderedFile[]): string[] {
  return files.map((f) => f.relPath);
}

function contentOf(files: RenderedFile[], relPath: string): string {
  const found = files.find((f) => f.relPath === relPath);
  expect(found).toBeDefined();
  return found?.content ?? "";
}

describe("renderUnitBrowser component import", () => {
  test("default export imports the bare name, named export imports a binding", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(comp("Widget", { exportKind: "default" })),
        tree(comp("Chip", { exportKind: "named" })),
      ],
      outDir: OUT,
      variants: 3,
    });
    const widget = contentOf(files, "unit/Widget.test.tsx");
    const chip = contentOf(files, "unit/Chip.test.tsx");
    expect(widget).toContain('import Widget from "../../src/Widget";');
    expect(widget).not.toContain("import { Widget }");
    expect(chip).toContain('import { Chip } from "../../src/Chip";');
    // The .tsx extension is stripped from the resolved relative specifier.
    expect(widget).not.toContain('"../../src/Widget.tsx"');
  });

  test("missing exportKind falls back to a named import", () => {
    const files = renderUnitBrowser({ trees: [tree(comp("Widget"))], outDir: OUT, variants: 3 });
    expect(contentOf(files, "unit/Widget.test.tsx")).toContain(
      'import { Widget } from "../../src/Widget";',
    );
  });

  test("a renamed export imports the boundary name aliased back", () => {
    // `export { Internal as Public }` — Public is the module binding; the
    // spec body keeps naming the component Internal.
    const files = renderUnitBrowser({
      trees: [tree(comp("Internal", { exportKind: "named", exportedAs: "Public" }))],
      outDir: OUT,
      variants: 3,
    });
    const spec = contentOf(files, "unit/Internal.test.tsx");
    expect(spec).toContain('import { Public as Internal } from "../../src/Internal";');
    expect(spec).not.toContain("import { Internal } from");
  });
});

describe("emitted import paths", () => {
  test("carry no .ts/.tsx extension — the target project type-checks these specs", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Widget", { exportKind: "default" }))],
      outDir: OUT,
      variants: 3,
      provider: "/proj/test/AppProvider.tsx",
      mswSetup: true,
    });
    // TS rejects .ts/.tsx import specifiers unless allowImportingTsExtensions
    // is on. flawless's own source uses them (Bun); its output must not.
    for (const f of files) {
      const bad = [...f.content.matchAll(/from "([^"]+)"/g)]
        .map((m) => m[1] as string)
        .filter((spec) => /^\.{1,2}\//.test(spec) && /\.(tsx?|jsx?)$/.test(spec));
      expect(bad).toEqual([]);
    }
  });

  test("a component with no props is rendered without a props spread", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Bare"))],
      outDir: OUT,
      variants: 3,
    });
    const src = contentOf(files, "unit/Bare.test.tsx");
    // ComponentProps<typeof Bare> is `unknown` for a zero-parameter component,
    // and spreading that is a type error in the target project.
    expect(src).toContain("render(<Bare />)");
    expect(src).not.toContain("as unknown as Props");
  });
});

describe("renderUnitBrowser provider option", () => {
  test("unit spec imports the provider and wraps the render", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Widget", { exportKind: "default" }))],
      outDir: OUT,
      variants: 3,
      provider: "/proj/test/AppProvider.tsx",
    });
    const src = contentOf(files, "unit/Widget.test.tsx");
    expect(src).toContain('import AppProvider from "../../test/AppProvider";');
    expect(src).toContain("render(<AppProvider><Widget /></AppProvider>)");
  });

  test("without a provider the render is unwrapped", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Widget", { exportKind: "default" }))],
      outDir: OUT,
      variants: 3,
    });
    const src = contentOf(files, "unit/Widget.test.tsx");
    expect(src).not.toContain("AppProvider");
    expect(src).toContain("render(<Widget />)");
  });
});

describe("renderUnitBrowser providerWraps option", () => {
  // The kiranism shape: SidebarTrigger needs the SidebarProvider that only a
  // route layout used to supply. Derivation found it; the spec must mount it.
  const wraps = new Map<string, ProviderRef[]>([
    [
      `${SRC}/Widget.tsx::Widget`,
      [{ componentName: "SidebarProvider", filePath: `${SRC}/sidebar.tsx`, exportKind: "named" }],
    ],
  ]);

  test("unit spec imports the derived provider aliased and wraps the render", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Widget", { exportKind: "default" }))],
      outDir: OUT,
      variants: 3,
      providerWraps: wraps,
    });
    const src = contentOf(files, "unit/Widget.test.tsx");
    expect(src).toContain(
      'import { SidebarProvider as __ProvSidebarProvider } from "../../src/sidebar";',
    );
    expect(src).toContain("render(<__ProvSidebarProvider><Widget /></__ProvSidebarProvider>)");
  });

  test("the explicit AppProvider stays outermost over the derived wraps", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Widget"))],
      outDir: OUT,
      variants: 3,
      provider: "/proj/test/AppProvider.tsx",
      providerWraps: wraps,
    });
    const src = contentOf(files, "unit/Widget.test.tsx");
    expect(src).toContain(
      "render(<AppProvider><__ProvSidebarProvider><Widget /></__ProvSidebarProvider></AppProvider>)",
    );
  });

  test("the map is keyed by providerKey — unmapped components stay bare", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Other"))],
      outDir: OUT,
      variants: 3,
      providerWraps: wraps,
    });
    const src = contentOf(files, "unit/Other.test.tsx");
    expect(src).not.toContain("__Prov");
    expect(src).toContain("render(<Other />)");
  });

  test("rsc spec wraps the resolved tree in the derived provider", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Page", { exportKind: "default", isAsync: true }))],
      outDir: OUT,
      variants: 3,
      providerWraps: new Map([
        [
          `${SRC}/Page.tsx::Page`,
          [
            {
              componentName: "ThemeProvider",
              filePath: `${SRC}/theme-provider.tsx`,
              exportKind: "default",
            },
          ],
        ],
      ]),
    });
    const src = contentOf(files, "unit/Page.test.tsx");
    expect(src).toContain('import __ProvThemeProvider from "../../src/theme-provider";');
    expect(src).toContain("render(<__ProvThemeProvider>{ui}</__ProvThemeProvider>)");
  });
});

describe("renderUnitBrowser async server components", () => {
  test("RSC spec awaits the component, mocks value imports, and emits no browser spec", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            promiseProps: ["params"],
            propsShape: { params: { id: "" } },
            moduleImports: [
              moduleImport({ specifier: "react", names: ["React"], hasDefault: true }),
              moduleImport({ specifier: "next/link", names: ["Link"], kind: "component" }),
              moduleImport({ specifier: "./styles.css" }),
              moduleImport({ specifier: "server-only" }),
              moduleImport({ specifier: "next/navigation", names: ["notFound"] }),
              moduleImport({ specifier: "next/headers", names: ["headers"] }),
              moduleImport({
                specifier: "@/lib/db",
                names: ["db", "getUser"],
                hasDefault: true,
              }),
              moduleImport({
                specifier: "@/lib/types",
                names: ["User"],
                isTypeOnly: true,
              }),
            ],
          }),
        ),
        tree(comp("Chip", { exportKind: "named" })),
      ],
      outDir: OUT,
      variants: 3,
    });

    const paths = relPaths(files);
    expect(paths).toContain("unit/Page.test.tsx");
    // Async server components cannot mount client-side — no Playwright spec.
    expect(paths).not.toContain("browser/Page.spec.ts");
    expect(paths).toContain("browser/Chip.spec.ts");

    const src = contentOf(files, "unit/Page.test.tsx");
    // Async children are resolved too: an async RSC that returns elements of
    // other async components would otherwise stop render() at the first one
    // (react-dom refuses async client components) and assert against empty
    // markup.
    expect(src).toContain(
      "const ui: React.ReactNode = await resolveAsyncUi(await Page(buildProps() as never));",
    );
    expect(src).toContain("async function resolveAsyncUi(");
    // render() sits INSIDE the try: the throw often happens there rather than in
    // the component call, and a guard outside it would miss the case entirely.
    expect(src).toMatch(/try \{[\s\S]*render\(<>\{ui\}<\/>\);[\s\S]*\} catch/);
    // notFound()/redirect() abort rendering; anything else is rethrown as
    // itself rather than asserted against the guard pattern.
    expect(src).toContain("notFound\\(\\) called|NEXT_REDIRECT");
    expect(src).toContain("throw err;");
    expect(src).toContain('redirect: vi.fn(() => { throw new Error("NEXT_REDIRECT"); })');
    expect(src).toContain('import Page from "../../src/Page";');
    expect(src).toContain('const PROMISE_PROPS: string[] = ["params"];');
    // value imports get mocks…
    expect(src).toContain('vi.mock("server-only", () => ({}));');
    expect(src).toContain('vi.mock("next/navigation", () => ({');
    expect(src).toContain('vi.mock("next/headers", () => ({');
    // A called-but-unexplained data export resolves to {} rather than undefined:
    // {} survives member access and only fails on .length/.map, which reads as a
    // legible failure instead of a crash on the first property read.
    expect(src).toContain(
      'vi.mock("@/lib/db", () => ({ default: vi.fn(), getUser: vi.fn(async () => ({})) }));',
    );
    expect(src).toContain("TODO(flawless): some return shapes could not be inferred");
    // next/link IS mocked, deliberately: the real <Link> reads Next's
    // AppRouterContext, which jsdom cannot provide, so it throws on render. The
    // passthrough keeps the anchor and its href queryable — the opposite of the
    // blanket-mock problem, since it preserves what a test would assert on.
    expect(src).toContain('vi.mock("next/link", async () => {');
    expect(src).toContain('const { createElement } = await import("react");');
    // …while react, assets and type-only imports stay real.
    expect(src).not.toContain('vi.mock("react"');
    expect(src).not.toContain('vi.mock("./styles.css"');
    expect(src).not.toContain('vi.mock("@/lib/types"');
  });

  test("RSC auto-mocking leaves pure class-string utilities (cn/clsx/cva) real", () => {
    // The blanket rsc-mode mock turned `cn` into vi.fn(async () => ({})) — an
    // async stub for a sync classnames join, so className rendered as
    // "[object Promise]". The tool's own docs say never to mock cn.
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            moduleImports: [
              moduleImport({ specifier: "@/lib/utils", names: ["cn"] }),
              moduleImport({ specifier: "@/lib/variants", names: ["cva", "twMerge"] }),
              moduleImport({ specifier: "@/lib/db", names: ["getUser"] }),
            ],
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
    const src = contentOf(files, "unit/Page.test.tsx");
    expect(src).not.toContain('vi.mock("@/lib/utils"');
    expect(src).not.toContain('vi.mock("@/lib/variants"');
    // A data module is still stubbed — the exemption is by imported bindings.
    expect(src).toContain('vi.mock("@/lib/db"');
  });

  const PURE_STUB = 'vi.fn((...args: unknown[]) => args.filter(Boolean).join(" "))';

  test("a module mixing cn with a data export is still mocked", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            moduleImports: [moduleImport({ specifier: "@/lib/utils", names: ["cn", "getUser"] })],
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
    const src = contentOf(files, "unit/Page.test.tsx");
    expect(src).toContain('vi.mock("@/lib/utils"');
    // The mock must not drop `cn`: the module factory replaces EVERY export, so
    // omitting it is "cn is not a function" at render — and the generic async
    // stub is just as wrong ("[object Promise]" as className).
    expect(src).toContain(`cn: ${PURE_STUB}`);
    expect(src).toContain("getUser: vi.fn(async () => ({}))");
  });

  test("a second statement importing data does not defeat the first statement's cn exemption", () => {
    // collectModuleImports emits one ModuleImportInfo per import STATEMENT.
    // Per-statement exemption let `import { getUser } from "@/lib/utils"` mock
    // the whole module without a cn export.
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            moduleImports: [
              moduleImport({ specifier: "@/lib/utils", names: ["cn"], importedNames: ["cn"] }),
              moduleImport({
                specifier: "@/lib/utils",
                names: ["getUser"],
                importedNames: ["getUser"],
              }),
            ],
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
    const src = contentOf(files, "unit/Page.test.tsx");
    const mocks = src.match(/vi\.mock\("@\/lib\/utils".*/g) ?? [];
    expect(mocks).toHaveLength(1);
    expect(mocks[0]).toContain(`cn: ${PURE_STUB}`);
    expect(mocks[0]).toContain("getUser: vi.fn(async () => ({}))");
    expect(mocks[0]).not.toContain("cn: vi.fn(async");
  });

  test("an aliased pure import (cn as cx) is exempt by its IMPORTED name", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            moduleImports: [
              moduleImport({ specifier: "@/lib/utils", names: ["cx"], importedNames: ["cn"] }),
            ],
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
    expect(contentOf(files, "unit/Page.test.tsx")).not.toContain('vi.mock("@/lib/utils"');
  });

  test("in a mixed module an aliased pure binding is stubbed under the MODULE-side name", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            moduleImports: [
              moduleImport({
                specifier: "@/lib/utils",
                names: ["cx", "getUser"],
                importedNames: ["cn", "getUser"],
              }),
            ],
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
    const src = contentOf(files, "unit/Page.test.tsx");
    // A vi.mock factory REPLACES the module: importers read exports by the
    // module's own names — `import { cn as cx }` resolves `cn` off the mock —
    // so the alias key would strand the real importer on a missing export.
    expect(src).toContain(`cn: ${PURE_STUB}`);
    expect(src).not.toContain("cx:");
    expect(src).toContain("getUser: vi.fn(async () => ({}))");
  });

  test("a graph-only name never forces a pure module into a mock", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            moduleImports: [moduleImport({ specifier: "@/lib/utils", names: ["cn"] })],
            treeImports: [
              moduleImport({
                specifier: "@/lib/utils",
                names: ["cn", "timeAgo"],
                importedNames: ["cn", "timeAgo"],
                mergedNames: ["timeAgo"],
              }),
            ],
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
    // The graph's RelativeTime imports timeAgo from lib/utils, but no file
    // relying on a mock CALLS it. Mocking the module then stubs timeAgo
    // `async () => ({})`: a promise rendered as a JSX child silently
    // suspends the whole tree — three aurorascharff specs woke up with
    // empty containers. Coverage must never drive the mock DECISION.
    expect(contentOf(files, "unit/Page.test.tsx")).not.toContain('vi.mock("@/lib/utils"');
  });

  test("a mocked module covers every name the graph imports from it", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            dataDeps: [
              dataDep({
                callee: "toast",
                calleeRoot: "toast",
                specifier: "sonner",
              }),
            ],
            moduleImports: [moduleImport({ specifier: "sonner", names: ["toast"] })],
            treeImports: [
              moduleImport({
                specifier: "sonner",
                names: ["toast", "SonnerToaster"],
                importedNames: ["toast", "Toaster"],
                mergedNames: ["SonnerToaster"],
              }),
            ],
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
    // components/toaster's { Toaster as SonnerToaster } used to be dropped by
    // the tree walk's first-wins dedup; the real importer then died at import
    // time on the missing export. The module-side name keys the factory —
    // importers read exports by it, never by the local alias.
    const src = contentOf(files, "unit/Page.test.tsx");
    expect(src).toContain("toast: vi.fn(async () => ({}))");
    expect(src).toContain(
      "Toaster: vi.fn((props: { children?: React.ReactNode }) => props.children ?? null)",
    );
  });

  test("a renamed dep is stubbed under the module-side export name", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            dataDeps: [
              dataDep({
                callee: "fetchUser",
                calleeRoot: "fetchUser",
                specifier: "@/api",
              }),
            ],
            moduleImports: [
              moduleImport({
                specifier: "@/api",
                names: ["fetchUser"],
                importedNames: ["getUser"],
              }),
            ],
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
    const src = contentOf(files, "unit/Page.test.tsx");
    expect(src).toContain("getUser: vi.fn(async () => ({}))");
    expect(src).not.toContain("fetchUser:");
  });

  test("a graph-only helper with no evidence mocks synchronously", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            dataDeps: [
              dataDep({
                callee: "getUser",
                calleeRoot: "getUser",
                specifier: "@/lib",
              }),
            ],
            moduleImports: [moduleImport({ specifier: "@/lib", names: ["getUser"] })],
            treeImports: [
              moduleImport({
                specifier: "@/lib",
                names: ["getUser", "timeAgo"],
                importedNames: ["getUser", "timeAgo"],
                mergedNames: ["timeAgo"],
              }),
            ],
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
    // The dep forces the mock; timeAgo rides along for coverage. An async {}
    // stub rendered as a child suspends the tree WITHOUT a word; sync {}
    // fails loudly where it appears — and `await {}` still resolves.
    const src = contentOf(files, "unit/Page.test.tsx");
    expect(src).toContain("timeAgo: vi.fn(() => ({}))");
    expect(src).not.toContain("timeAgo: vi.fn(async");
  });

  test("a module kept pure across several statements still gets no mock", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("Page", {
            exportKind: "default",
            isAsync: true,
            moduleImports: [
              moduleImport({ specifier: "@/lib/utils", names: ["cn"], importedNames: ["cn"] }),
              moduleImport({ specifier: "@/lib/utils", names: ["cx"], importedNames: ["clsx"] }),
            ],
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
    expect(contentOf(files, "unit/Page.test.tsx")).not.toContain('vi.mock("@/lib/utils"');
  });

  test("RSC spec wraps the resolved tree in the provider when one is given", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Page", { exportKind: "default", isAsync: true }))],
      outDir: OUT,
      variants: 3,
      provider: "/proj/test/AppProvider.tsx",
    });
    const src = contentOf(files, "unit/Page.test.tsx");
    expect(src).toContain('import AppProvider from "../../test/AppProvider";');
    expect(src).toContain("render(<AppProvider>{ui}</AppProvider>)");
  });
});

describe("renderUnitBrowser spec-name collisions", () => {
  test("second Card keeps its own file as Parent__Card", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(comp("Card", { filePath: `${SRC}/a/Card.tsx` })),
        tree(comp("Page", { filePath: `${SRC}/Page.tsx` }), [
          tree(comp("Card", { filePath: `${SRC}/b/Card.tsx` })),
        ]),
      ],
      outDir: OUT,
      variants: 3,
    });
    const paths = relPaths(files);
    expect(paths).toContain("unit/Card.test.tsx");
    expect(paths).toContain("unit/Page__Card.test.tsx");
    expect(paths).toContain("browser/Card.spec.ts");
    expect(paths).toContain("browser/Page__Card.spec.ts");
    // Each spec still imports from its own source file.
    expect(contentOf(files, "unit/Card.test.tsx")).toContain('from "../../src/a/Card";');
    expect(contentOf(files, "unit/Page__Card.test.tsx")).toContain('from "../../src/b/Card";');
  });

  test("the same component reached twice is emitted once", () => {
    const shared = comp("Card", { filePath: `${SRC}/Card.tsx` });
    const files = renderUnitBrowser({
      trees: [tree(comp("Page"), [tree(shared), tree(shared)])],
      outDir: OUT,
      variants: 3,
    });
    expect(relPaths(files).filter((p) => p.startsWith("unit/Card"))).toEqual([
      "unit/Card.test.tsx",
    ]);
  });
});

describe("renderUnitBrowser colocate", () => {
  test("single-component file writes <base>.flawless.test.tsx beside the source", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Card", { filePath: `${SRC}/widgets/Card.tsx`, exportKind: "default" }))],
      outDir: OUT,
      variants: 3,
      colocate: true,
    });
    const spec = files.find((f) => f.relPath === "unit/Card.test.tsx");
    expect(spec).toBeDefined();
    expect(spec?.absPath).toBe(path.join(SRC, "widgets", "Card.flawless.test.tsx"));
    expect(spec?.absPath?.endsWith("Card.flawless.test.tsx")).toBe(true);
    expect(spec?.skipIfExists).toBe(true);
    expect(spec?.content).toContain('import Card from "./Card";');
  });

  test("multi-component file gets one spec per component", () => {
    const files = renderUnitBrowser({
      trees: [
        tree(comp("Card", { filePath: `${SRC}/widgets/card.tsx`, exportKind: "named" }), [
          tree(comp("CardHeader", { filePath: `${SRC}/widgets/card.tsx`, exportKind: "named" })),
        ]),
      ],
      outDir: OUT,
      variants: 3,
      colocate: true,
    });
    const card = files.find((f) => f.relPath === "unit/Card.test.tsx");
    const header = files.find((f) => f.relPath === "unit/CardHeader.test.tsx");
    expect(card?.absPath).toBe(path.join(SRC, "widgets", "card.Card.flawless.test.tsx"));
    expect(header?.absPath).toBe(path.join(SRC, "widgets", "card.CardHeader.flawless.test.tsx"));
    expect(card?.skipIfExists).toBe(true);
    expect(header?.skipIfExists).toBe(true);
    // Both import from the shared module basename.
    expect(card?.content).toContain('import { Card } from "./card";');
    expect(header?.content).toContain('import { CardHeader } from "./card";');
  });

  test("colocate vitest config includes the colocated specs and the flawless setup", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Card"))],
      outDir: OUT,
      variants: 3,
      colocate: true,
    });
    const cfg = contentOf(files, "vitest.config.mts");
    // Vite roots itself at the config file's directory, so the config must set
    // root back to the project — otherwise "src/**" resolves under flawless/
    // and the run reports "no tests" while looking perfectly correct.
    expect(cfg).toContain("root: projectRoot");
    expect(cfg).toContain('path.join(configDir, "setup.ts")');
    expect(cfg).toContain(
      'include: ["**/*.flawless.test.{ts,tsx}", "flawless/unit/**/*.test.{ts,tsx}"]',
    );
  });

  test("colocate honours the out dir's own name, not the literal 'flawless'", () => {
    // setupFiles and the unit include were hardcoded to "flawless/", so
    // --colocate with the standalone default (.flawless) or any --out produced a
    // config pointing at a setup file that does not exist, and vitest died at
    // startup. tests/templatesUnit.test.ts pinned the literal, so it stayed.
    const files = renderUnitBrowser({
      trees: [tree(comp("Card"))],
      outDir: "/proj/.flawless",
      variants: 3,
      colocate: true,
    });
    const cfg = contentOf(files, "vitest.config.mts");
    expect(cfg).toContain('".flawless/unit/**/*.test.{ts,tsx}"');
    // Anchored to the config's own directory, so the name cannot drift again.
    expect(cfg).toContain('path.join(configDir, "setup.ts")');
    expect(cfg).not.toContain('"flawless/unit');
  });

  test("the root-wide include matches specs under src/, components/, and app/ alike", () => {
    // The include used to be derived per top-level directory from THIS run's
    // emitted files. The root-wide glob covers every layout in one form.
    const files = renderUnitBrowser({
      trees: [
        tree(comp("Button", { filePath: `${SRC}/ui/Button.tsx`, exportKind: "named" })),
        tree(comp("Card", { filePath: "/proj/components/Card.tsx", exportKind: "default" })),
        tree(comp("Header", { filePath: "/proj/app/nav/Header.tsx", exportKind: "named" })),
      ],
      outDir: OUT,
      variants: 3,
      colocate: true,
    });
    const cfg = contentOf(files, "vitest.config.mts");
    const match = cfg.match(/include: (\[[^\]]*\])/);
    expect(match).not.toBeNull();
    const include = JSON.parse(match?.[1] ?? "[]") as string[];
    expect(include[0]).toBe("**/*.flawless.test.{ts,tsx}");
    const rootWide = new Bun.Glob(include[0] as string);
    const colocated = files.filter((f) => f.absPath);
    expect(colocated.length).toBe(3);
    for (const f of colocated) {
      const rel = path.relative("/proj", f.absPath as string);
      expect(rootWide.match(rel), `${rel} matched by ${include[0]}`).toBe(true);
    }
  });

  test("two runs over disjoint spec dirs emit byte-identical include lists", () => {
    // vitest.config.mts is always rewritten. Deriving the include from THIS
    // run's files meant run 1 over src/** followed by run 2 over app/** left a
    // config selecting only app/**, silently deselecting run 1's specs. The
    // include must not depend on which files this particular run touched.
    const includeOf = (filePath: string): string => {
      const files = renderUnitBrowser({
        trees: [tree(comp("Card", { filePath, exportKind: "default" }))],
        outDir: OUT,
        variants: 3,
        colocate: true,
      });
      const match = contentOf(files, "vitest.config.mts").match(/include: \[[^\]]*\]/);
      expect(match).not.toBeNull();
      return match?.[0] ?? "";
    };
    expect(includeOf(`${SRC}/deep/Card.tsx`)).toBe(includeOf("/proj/app/nav/Card.tsx"));
  });

  test("include keeps the root-wide form when nothing is colocated this run", () => {
    // Nothing derivable used to mean a src/** fallback — wrong root for a
    // src-less project, and different bytes than a run that emitted specs.
    const files = renderUnitBrowser({
      trees: [tree(comp("Hidden", { exportKind: "none" }))],
      outDir: OUT,
      variants: 3,
      colocate: true,
    });
    const cfg = contentOf(files, "vitest.config.mts");
    expect(cfg).toContain(
      'include: ["**/*.flawless.test.{ts,tsx}", "flawless/unit/**/*.test.{ts,tsx}"]',
    );
  });

  test("node_modules is excluded explicitly, and the exclude is load-bearing", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Card"))],
      outDir: OUT,
      variants: 3,
      colocate: true,
    });
    const cfg = contentOf(files, "vitest.config.mts");
    const match = cfg.match(/include: (\[[^\]]*\])/);
    const include = JSON.parse(match?.[1] ?? "[]") as string[];
    // The emitted include DOES match spec-shaped paths under node_modules and
    // dist, so the exclude line is load-bearing — remove it and a dependency
    // shipping *.flawless.test.* files (or a build step copying raw specs
    // into dist/) runs inside the user's suite.
    expect(
      include.some((g) => new Bun.Glob(g).match("node_modules/pkg/dist/x.flawless.test.ts")),
    ).toBe(true);
    expect(include.some((g) => new Bun.Glob(g).match("dist/x.flawless.test.ts"))).toBe(true);
    // Setting exclude replaces vitest's defaults, so the standard set must
    // ride along explicitly.
    expect(cfg).toContain(
      'exclude: ["**/node_modules/**", "**/dist/**", "**/.{idea,git,cache,output,temp}/**"]',
    );
  });

  test("without colocate the unit specs stay under outDir", () => {
    const files = renderUnitBrowser({ trees: [tree(comp("Card"))], outDir: OUT, variants: 3 });
    const spec = files.find((f) => f.relPath === "unit/Card.test.tsx");
    expect(spec?.absPath).toBeUndefined();
    expect(spec?.skipIfExists).toBeUndefined();
    const cfg = contentOf(files, "vitest.config.mts");
    expect(cfg).toContain('setupFiles: ["./setup.ts"]');
    expect(cfg).toContain('include: ["unit/**/*.test.{ts,tsx}"]');
  });
});

describe("renderUnitBrowser setup.ts", () => {
  test("mswSetup on wires the MSW node server", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Widget"))],
      outDir: OUT,
      variants: 3,
      mswSetup: true,
    });
    const setup = contentOf(files, "setup.ts");
    expect(setup).toContain('import { server } from "./mocks/node";');
    expect(setup).toContain('beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));');
    expect(setup).toContain("afterEach(() => server.resetHandlers());");
    expect(setup).toContain("afterAll(() => server.close());");
  });

  test("mswSetup off leaves the MSW wiring out but keeps the jsdom polyfills", () => {
    const off = contentOf(
      renderUnitBrowser({ trees: [tree(comp("Widget"))], outDir: OUT, variants: 3 }),
      "setup.ts",
    );
    const on = contentOf(
      renderUnitBrowser({
        trees: [tree(comp("Widget"))],
        outDir: OUT,
        variants: 3,
        mswSetup: true,
      }),
      "setup.ts",
    );
    expect(off).not.toContain("server.listen");
    expect(off).not.toContain("./mocks/node");
    for (const setup of [off, on]) {
      expect(setup).toContain('import "@testing-library/jest-dom/vitest";');
      expect(setup).toContain("window.matchMedia ??=");
      expect(setup).toContain("window.ResizeObserver ??=");
      expect(setup).toContain("window.IntersectionObserver ??=");
    }
  });

  test("installs an in-memory Storage fallback for persistence middleware", () => {
    const setup = contentOf(
      renderUnitBrowser({ trees: [tree(comp("Widget"))], outDir: OUT, variants: 3 }),
      "setup.ts",
    );
    // Node >= 22 exposes an inert `localStorage` global; under jsdom
    // window.localStorage can resolve to it, handing zustand's persist
    // middleware undefined and throwing on the first write.
    expect(setup).toContain('typeof window.localStorage?.setItem !== "function"');
    expect(setup).toContain('typeof window.sessionStorage?.setItem !== "function"');
    expect(setup).toContain('Object.defineProperty(window, "localStorage"');
  });
});

describe("renderUnitBrowser document-root components", () => {
  function docRoot(extra: Partial<ComponentInfo> = {}) {
    return renderUnitBrowser({
      trees: [
        tree(
          comp("RootLayout", {
            exportKind: "default",
            renderMode: "document-root",
            renderNotes: ["renders <html> at its root"],
            ...extra,
          }),
        ),
      ],
      outDir: OUT,
      variants: 3,
    });
  }

  test("a sync component is rendered as an element, never called directly", () => {
    const spec = contentOf(docRoot(), "unit/RootLayout.test.tsx");
    // Calling it directly runs its hooks with no React dispatcher, which fails
    // with "Cannot read properties of null (reading 'useEffect')". The element
    // is still run through resolveAsyncUi: renderToStaticMarkup cannot await a
    // thenable, and a SYNC root can hide async server children behind
    // <Suspense> (aurorascharff layout: TrendingTags, WhoToFollow).
    expect(spec).toContain(
      "const ui = await resolveAsyncUi(<RootLayout {...(props as React.ComponentProps<typeof RootLayout>)} />);",
    );
    expect(spec).not.toContain("RootLayout(props as never)");
    expect(spec).toContain("renderToReadableStream(ui as React.ReactElement)");
    expect(spec).toContain("expect(html).toMatch(/^<html/)");
  });

  test("an async server component is still invoked and awaited", () => {
    const spec = contentOf(docRoot({ isAsync: true }), "unit/RootLayout.test.tsx");
    // An async component cannot be created as an element — it must be called to
    // get its returned tree.
    expect(spec).toContain("const ui = await resolveAsyncUi(await RootLayout(props as never));");
  });

  test("the children slot is asserted only when the component renders children", () => {
    const withChildren = contentOf(docRoot({ acceptsChildren: true }), "unit/RootLayout.test.tsx");
    expect(withChildren).toContain('const SLOT = "flawless-slot";');
    expect(withChildren).toContain("expect(html).toContain(SLOT);");

    // A root error boundary takes {error, reset} and renders neither, so
    // injecting a slot and demanding it appear is a test it can never satisfy.
    const withoutChildren = contentOf(docRoot(), "unit/RootLayout.test.tsx");
    expect(withoutChildren).not.toContain("flawless-slot");
    expect(withoutChildren).toContain("expect(html).toMatch(/^<html/);");
    expect(withoutChildren).toContain('expect(html).toContain("<body");');
  });
});

describe("renderUnitBrowser resolveAliases", () => {
  test("prefix and exact aliases become vitest resolve.alias entries", () => {
    const files = renderUnitBrowser({
      trees: [tree(comp("Widget"))],
      outDir: OUT,
      variants: 3,
      resolveAliases: [
        { find: "@/", replacement: "/proj/src", prefix: true },
        { find: "react", replacement: "/proj/node_modules/react", prefix: false },
      ],
    });
    const cfg = contentOf(files, "vitest.config.mts");
    expect(cfg).toContain("resolve: {");
    expect(cfg).toContain("alias: [");
    // Resolved against the config's own directory, not baked in absolute: this
    // file is committed, and the react pin pointed into a node_modules path that
    // exists only on the machine that generated it.
    expect(cfg).toContain(
      '{ find: /^@\\//, replacement: path.resolve(configDir, "../src") + "/" },',
    );
    expect(cfg).toContain(
      '{ find: /^react$/, replacement: path.resolve(configDir, "../node_modules/react") },',
    );
    expect(cfg).toContain("const configDir = path.dirname(fileURLToPath(import.meta.url));");
    expect(cfg).not.toContain('"/proj/');
  });

  test("no aliases → the alias list holds only the server-only marker, dedupe always", () => {
    const cfg = contentOf(
      renderUnitBrowser({ trees: [tree(comp("Widget"))], outDir: OUT, variants: 3 }),
      "vitest.config.mts",
    );
    // User aliases are gone, but the marker alias is unconditional: the
    // package is missing-or-throwing and a transitive importer cannot be
    // saved by a per-spec vi.mock.
    expect(cfg).toContain("alias: [");
    expect(cfg).toContain("find: /^server-only$/");
    expect(cfg.match(/find: \/\^/g)?.length).toBe(1);
    // Without dedupe, a workspace where react resolves to the repo root and
    // react-dom to the package gives every hook call "Cannot read properties of
    // null (reading 'useEffect')" — react-dom-server sets its dispatcher on a
    // different React instance than the component reads from.
    expect(cfg).toContain('dedupe: ["react", "react-dom"],');
  });
});

describe("renderUnitBrowser variant matrix", () => {
  test("empty variants emit no describe block (vitest fails on empty suites)", () => {
    const src = contentOf(
      renderUnitBrowser({
        trees: [tree(comp("Plain", { variants: [] }))],
        outDir: OUT,
        variants: 5,
      }),
      "unit/Plain.test.tsx",
    );
    expect(src).not.toContain('describe("Plain variants"');
    expect(src).toContain("no literal-union props");
    expect(src).toContain("void VARIANTS;");
    expect(src).toContain("const VARIANTS: Array<Record<string, unknown>> = [];");
  });

  test("populated variants emit the describe block, capped at the variants option", () => {
    const withVariants = comp("Chip", {
      variants: [{ variant: "primary" }, { variant: "secondary" }],
    });
    const all = contentOf(
      renderUnitBrowser({ trees: [tree(withVariants)], outDir: OUT, variants: 5 }),
      "unit/Chip.test.tsx",
    );
    expect(all).toContain('describe("Chip variants", () => {');
    expect(all).toContain(
      'const VARIANTS: Array<Record<string, unknown>> = [{"variant":"primary"},{"variant":"secondary"}];',
    );

    const capped = contentOf(
      renderUnitBrowser({ trees: [tree(withVariants)], outDir: OUT, variants: 1 }),
      "unit/Chip.test.tsx",
    );
    expect(capped).toContain(
      'const VARIANTS: Array<Record<string, unknown>> = [{"variant":"primary"}];',
    );
    expect(capped).toContain('describe("Chip variants", () => {');

    const none = contentOf(
      renderUnitBrowser({ trees: [tree(withVariants)], outDir: OUT, variants: 0 }),
      "unit/Chip.test.tsx",
    );
    expect(none).not.toContain('describe("Chip variants"');
  });
});

describe("renderUnitBrowser effect fetch specs", () => {
  const feed = comp("Feed", {
    exportKind: "default",
    propsShape: { id: "" },
    fetchCalls: [
      fetchCall({ urlTemplate: "/api/feed/:id", holes: ["id"], method: "GET", inEffect: true }),
      fetchCall({ urlTemplate: "/api/never-called", inEffect: false }),
    ],
  });

  test("inEffect fetches + mswSetup produce success/delay/500/empty cases", () => {
    const src = contentOf(
      renderUnitBrowser({
        trees: [tree(feed)],
        outDir: OUT,
        variants: 3,
        mswSetup: true,
      }),
      "unit/Feed.test.tsx",
    );
    expect(src).toContain('import { http, HttpResponse, delay } from "msw";');
    expect(src).toContain('import { server } from "../mocks/node";');
    expect(src).toContain('describe("Feed GET /api/feed/:id", () => {');
    expect(src).toContain('const URL = "/api/feed/:id";');
    expect(src).toContain("http.get(URL");
    expect(src).toContain("await delay(150)");
    expect(src).toContain("new HttpResponse(null, { status: 500 })");
    expect(src).toContain('test("renders the empty state for an empty payload"');
    expect(src).toContain('test("mount fetches and renders with a successful response"');
    expect(src).toContain('test("stays stable while the response is delayed (loading state)"');
    expect(src).toContain('test("survives a 500 without crashing (error state)"');
    // URL holes that are props are rendered with real values, never "".
    expect(src).toContain('renderTarget({"id":"test-id"})');
    // No spec for the fetch that does not run in an effect.
    expect(src).not.toContain("/api/never-called");
    // Without an API spec the fixture is a TODO placeholder.
    expect(src).toContain("TODO(flawless): no example found in the API spec");
    expect(src).toContain("const FIXTURE: unknown = {};");
  });

  test("no mswSetup → no fetch specs at all", () => {
    const src = contentOf(
      renderUnitBrowser({ trees: [tree(feed)], outDir: OUT, variants: 3 }),
      "unit/Feed.test.tsx",
    );
    expect(src).not.toContain('from "msw"');
    expect(src).not.toContain("http.get(URL");
    expect(src).not.toContain('describe("Feed GET');
  });

  test("apiRoutes supply the fixture and its emptied envelope", () => {
    const src = contentOf(
      renderUnitBrowser({
        trees: [tree(comp("Feed", { fetchCalls: [fetchCall({ urlTemplate: "/api/feed/:id" })] }))],
        outDir: OUT,
        variants: 3,
        mswSetup: true,
        apiRoutes: [
          {
            path: "/api/feed/{id}",
            methods: ["GET"],
            file: "/proj/app/api/feed/[id]/route.ts",
            responseBodies: { GET: { total: 2, items: [{ id: 1 }] } },
          },
        ],
      }),
      "unit/Feed.test.tsx",
    );
    expect(src).toContain("Fixture from the project's OpenAPI spec examples.");
    expect(src).toContain('const FIXTURE: unknown = {"total":2,"items":[{"id":1}]};');
    // The empty-payload case keeps the envelope and empties every array member.
    expect(src).toContain('HttpResponse.json({"total":2,"items":[]})');
  });

  test("a detected click is fired before awaiting a gated effect fetch", () => {
    const src = contentOf(
      renderUnitBrowser({
        trees: [
          tree(
            comp("Panel", {
              fetchCalls: [fetchCall({ urlTemplate: "/api/panel" })],
              interactions: {
                clicks: [click({ hints: { testid: "open" } })],
                forms: [],
              },
            }),
          ),
        ],
        outDir: OUT,
        variants: 3,
        mswSetup: true,
      }),
      "unit/Panel.test.tsx",
    );
    expect(src).toContain("Effects can be gated behind UI state");
    expect(src).toContain('const trigger = screen.queryByTestId("open");');
    expect(src).toContain("if (trigger) await userEvent.click(trigger as HTMLElement);");
  });

  test("the trigger is a non-throwing query for the getAllBy* selector shapes", () => {
    const src = contentOf(
      renderUnitBrowser({
        trees: [
          tree(
            comp("Panel", {
              fetchCalls: [fetchCall({ urlTemplate: "/api/panel" })],
              interactions: {
                clicks: [click({ hints: { ariaLabel: "Open panel" } })],
                forms: [],
              },
            }),
          ),
        ],
        outDir: OUT,
        variants: 3,
        mswSetup: true,
      }),
      "unit/Panel.test.tsx",
    );
    // The aria-label shape emits getAllBy* — the forms a bare getBy→queryBy
    // rewrite leaves untouched. Left as getAllBy, an absent trigger throws at
    // render instead of resolving to undefined, and the thrown error fails all
    // four fetch scenarios on a correct component. (The separate interaction
    // test keeps the throwing form on purpose: a spec that drives the click
    // must fail when the element is not there.)
    expect(src).toContain(
      'const trigger = screen.queryAllByLabelText("Open panel")[0] as HTMLElement;',
    );
    expect(src).not.toContain("const trigger = screen.getAllBy");
    expect(src).toContain("if (trigger) await userEvent.click(trigger as HTMLElement);");
  });
});

describe("renderUnitBrowser always-emitted files", () => {
  test("config + setup + playwright config ship with every render", () => {
    const files = renderUnitBrowser({ trees: [tree(comp("Widget"))], outDir: OUT, variants: 3 });
    const paths = relPaths(files);
    expect(paths).toContain("vitest.config.mts");
    expect(paths).toContain("setup.ts");
    expect(paths).toContain("browser/playwright.config.ts");
    const pw = contentOf(files, "browser/playwright.config.ts");
    expect(pw).toContain('testMatch: "*.spec.ts"');
    expect(pw).toContain('command: "bun ../host/server.ts"');
    expect(contentOf(files, "vitest.config.mts")).toContain('environment: "jsdom"');
  });
});

describe("variant distinctness unit spec", () => {
  const toast = comp("Toast", {
    variantClasses: { variant: { default: "bg-background", destructive: "bg-destructive" } },
  });

  test("probes for a class before comparing options, and skips by name", () => {
    // invoify's Toast: Radix's Toast.Root hands jsdom an element with no class
    // attribute, so the cva table has no observable to compare and EVERY
    // option failed. A named skip states that; a red spec blames the component.
    const src = contentOf(
      renderUnitBrowser({ trees: [tree(toast)], outDir: OUT, variants: 3 }),
      "unit/Toast.test.tsx",
    );
    expect(src).toContain('const probeCarriesClass = probe.container.querySelector("[class]")');
    expect(src).toContain("ctx.skip(");
    expect(src).toContain("nothing to compare");
    // The probe is unmounted before the comparison, so the options are each
    // measured against a clean container.
    expect(src).toMatch(/probe\.unmount\(\);\s*\n\s*if \(!probeCarriesClass\)/);
  });

  test("the comparison itself is untouched when a class is there to compare", () => {
    const src = contentOf(
      renderUnitBrowser({ trees: [tree(toast)], outDir: OUT, variants: 3 }),
      "unit/Toast.test.tsx",
    );
    expect(src).toContain('test("Toast: every `variant` option renders distinct markup"');
    expect(src).toMatch(
      /expect\(el, `variant=\$\{option\} rendered no element carrying a class`\)/,
    );
    expect(src).toContain('expect(new Set(seen).size, "two options rendered identical markup")');
  });
});
