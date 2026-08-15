import { describe, expect, test } from "bun:test";
import path from "node:path";
import { type RenderedFile, renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import type {
  ClickHandler,
  ComponentInfo,
  ComponentTree,
  FetchCallInfo,
  ModuleImportInfo,
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
    expect(src).toContain("const ui: React.ReactNode = await Page(buildProps() as never);");
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
      'include: ["src/**/*.flawless.test.{ts,tsx}", "flawless/unit/**/*.test.{ts,tsx}"]',
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
    // with "Cannot read properties of null (reading 'useEffect')".
    expect(spec).toContain(
      "const ui = <RootLayout {...(props as React.ComponentProps<typeof RootLayout>)} />;",
    );
    expect(spec).not.toContain("RootLayout(props as never)");
    expect(spec).toContain("renderToStaticMarkup(ui as React.ReactElement)");
    expect(spec).toContain("expect(html).toMatch(/^<html/)");
  });

  test("an async server component is still invoked and awaited", () => {
    const spec = contentOf(docRoot({ isAsync: true }), "unit/RootLayout.test.tsx");
    // An async component cannot be created as an element — it must be called to
    // get its returned tree.
    expect(spec).toContain("const ui = await RootLayout(props as never);");
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

  test("no aliases → no alias list, but dedupe is always emitted", () => {
    const cfg = contentOf(
      renderUnitBrowser({ trees: [tree(comp("Widget"))], outDir: OUT, variants: 3 }),
      "vitest.config.mts",
    );
    expect(cfg).not.toContain("alias: [");
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
