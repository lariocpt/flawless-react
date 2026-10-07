import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataConstantExports } from "../src/analyse/dataExports.ts";
import { ModuleResolver } from "../src/analyse/resolveModule.ts";
import { SourceFileCache } from "../src/analyse/sourceCache.ts";
import { emitModuleMocks } from "../src/scaffold-tests/mocks.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import type { ComponentInfo, ModuleImportInfo } from "../src/types.ts";

/**
 * Data-constant exports keep config-style modules REAL in RSC mode. The
 * chanhdai dogfood is the cautionary tale it exists for: one component's
 * `SOURCE_CODE_GITHUB_REPO` earned `@/config/site` a wholesale factory mock,
 * and every transitive importer (json-ld reading `SITE_INFO`) died at
 * collection on an export the mock had never enumerated.
 */

const tmpDirs: string[] = [];

function moduleFile(source: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-data-"));
  tmpDirs.push(dir);
  const abs = path.join(dir, "mod.ts");
  writeFileSync(abs, source);
  return abs;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function dataOf(source: string, names: string[], hasDefault = false): string[] {
  return dataConstantExports(
    { names, isTypeOnly: false, hasDefault },
    moduleFile(source),
    new ModuleResolver(),
    new SourceFileCache(),
  );
}

describe("dataConstantExports", () => {
  const CONFIG = `
import { USER } from "./user";
export const SOURCE_CODE_GITHUB_REPO = "ncdai/chanhdai.com";
export const SITE_INFO = {
  name: USER.displayName,
  url: process.env.NEXT_PUBLIC_APP_URL || "https://chanhdai.com",
};
export const MAIN_NAV = [{ title: "Components", href: "/components" }];
export const env = ENV_SCHEMA.parse(process.env);
export function getSite() { return SITE_INFO; }
export class Widget {}
export enum Direction { Up }
export const fromBinding = SOURCE_CODE_GITHUB_REPO;
`;

  test("literal, property-access, logical and collection constants are data", () => {
    expect(dataOf(CONFIG, ["SOURCE_CODE_GITHUB_REPO", "SITE_INFO", "MAIN_NAV"])).toEqual([
      "SOURCE_CODE_GITHUB_REPO",
      "SITE_INFO",
      "MAIN_NAV",
    ]);
  });

  test("call initializers, functions, classes, enums and bare identifiers are not", () => {
    expect(dataOf(CONFIG, ["env", "getSite", "Widget", "Direction", "fromBinding"])).toEqual([]);
  });

  test("a renamed `export { CFG as CONFIG }` clause binds the private declaration", () => {
    const src = `const CFG = { theme: "system" };\nexport { CFG as CONFIG };\n`;
    expect(
      dataConstantExports(
        { names: ["CONFIG"], importedNames: ["CONFIG"], isTypeOnly: false, hasDefault: false },
        moduleFile(src),
        new ModuleResolver(),
        new SourceFileCache(),
      ),
    ).toEqual(["CONFIG"]);
  });

  test('`export default { … }` is data under the "default" convention', () => {
    expect(dataOf("export default { a: 1, b: [2, 3] };", ["site"], true)).toEqual(["default"]);
    // A default export that computes stays undeclared-as-data.
    expect(dataOf("export default buildSite();", ["site"], true)).toEqual([]);
  });

  test("type-only imports claim nothing", () => {
    const located = dataConstantExports(
      { names: ["SITE_INFO"], isTypeOnly: true, hasDefault: false },
      moduleFile(CONFIG),
      new ModuleResolver(),
      new SourceFileCache(),
    );
    expect(located).toEqual([]);
  });

  test("computed keys, shorthand props and nested calls disqualify an object", () => {
    expect(dataOf("export const A = { [K]: 1 };", ["A"])).toEqual([]);
    expect(dataOf("export const K = 1;\nexport const A = { K };", ["A"])).toEqual([]);
    expect(dataOf("export const A = { url: load() };", ["A"])).toEqual([]);
    // The positive control: the same shape spelled out is data.
    expect(dataOf('export const A = { url: "https://x.dev" };', ["A"])).toEqual(["A"]);
  });
});

describe("emitModuleMocks data-constant exemption (rsc)", () => {
  const OUT = "/proj/flawless";

  function info(moduleImports: ModuleImportInfo[]): ComponentInfo {
    return {
      componentName: "Widget",
      filePath: "/proj/src/Widget.tsx",
      importSpecifier: "./Widget.tsx",
      propsShape: {},
      variants: [],
      hooks: [],
      unresolvedProps: [],
      moduleImports,
    };
  }
  function mi(over: Partial<ModuleImportInfo> & { specifier: string }): ModuleImportInfo {
    return {
      names: [],
      kind: "value",
      isTypeOnly: false,
      hasDefault: false,
      pos: { file: "/proj/src/Widget.tsx", line: 1, column: 1 },
      ...over,
    };
  }

  test("a module imported only for data constants is not mocked at all", () => {
    const { statements, mocked } = emitModuleMocks(
      info([
        mi({
          specifier: "@/config/site",
          names: ["SOURCE_CODE_GITHUB_REPO"],
          dataExports: ["SOURCE_CODE_GITHUB_REPO"],
        }),
      ]),
      "rsc",
      OUT,
    );
    expect(mocked).toEqual([]);
    expect(statements.join("\n")).not.toContain("@/config/site");
  });

  test("two data-only statements of the same module stay out together", () => {
    const { mocked } = emitModuleMocks(
      info([
        mi({
          specifier: "@/config/site",
          names: ["SOURCE_CODE_GITHUB_REPO"],
          dataExports: ["SOURCE_CODE_GITHUB_REPO"],
        }),
        mi({ specifier: "@/config/site", names: ["SITE_INFO"], dataExports: ["SITE_INFO"] }),
      ]),
      "rsc",
      OUT,
    );
    expect(mocked).toEqual([]);
  });

  test("one non-data name re-mocks the whole module — the {} fallback stays honest", () => {
    const { statements, mocked } = emitModuleMocks(
      info([
        mi({
          specifier: "@/config/site",
          names: ["SITE_INFO", "getPost"],
          dataExports: ["SITE_INFO"],
        }),
      ]),
      "rsc",
      OUT,
    );
    expect(mocked).toEqual(["@/config/site"]);
    expect(statements.join("\n")).toContain('vi.mock("@/config/site"');
  });

  test("a statement mixing a pure utility and a data constant is exempt too", () => {
    const { mocked } = emitModuleMocks(
      info([
        mi({
          specifier: "@/lib/config",
          names: ["cn", "BRAND"],
          dataExports: ["BRAND"],
        }),
      ]),
      "rsc",
      OUT,
    );
    expect(mocked).toEqual([]);
  });
});

describe("renderUnitBrowser setup.ts next/font mocks", () => {
  const OUT = "/proj/flawless";

  const entry: ComponentInfo = {
    componentName: "Widget",
    filePath: "/proj/src/Widget.tsx",
    importSpecifier: "./Widget.tsx",
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    moduleImports: [],
  };
  const files = renderUnitBrowser({
    trees: [{ entry, children: [] }],
    outDir: OUT,
    variants: 3,
  });
  const setup = files.find((f) => f.relPath === "setup.ts")?.content ?? "";
  const config = files.find((f) => f.relPath === "vitest.config.mts")?.content ?? "";

  test("the vitest config aliases the server-component marker to the inert stub", () => {
    // vi.mock("server-only") only reaches DIRECT importers; chanhdai's MDX
    // crash was transitive (MDX -> a server table -> the marker) and vite's
    // resolver failed at collection, before any mock could run. The alias
    // resolves the specifier itself; the stub is emitted next to the config.
    expect(config).toContain("find: /^server-only$/");
    expect(config).toContain("server-only-stub.ts");
    expect(files.some((f) => f.relPath === "server-only-stub.ts")).toBe(true);
  });

  test("all three loader entry points are mocked globally, name-agnostic", () => {
    // A factory listing only `default` starves named loaders: the chanhdai
    // layout graph asked for Caveat/IBM_Plex_Serif and vitest threw
    // "No export is defined on the mock" for every spec. The Proxy hands
    // every requested name the same callable stub.
    expect(setup).toContain('vi.mock("next/font",');
    expect(setup).toContain('vi.mock("next/font/local",');
    expect(setup).toContain('vi.mock("next/font/google",');
    expect(setup).toContain("new Proxy(");
  });

  test("the resolve hook is registered inline via registerHooks with data-URL stubs", () => {
    // vi.mock cannot reach node_modules packages the runner loads through
    // native import() — geist's module-scope loader call and @bprogress's
    // real next/navigation both bypass the vite graph entirely. The hook is
    // registered with registerHooks (synchronous, in-thread — register()
    // spawns a hooks thread Node deprecates), and the stubs ride as data:
    // URLs because import.meta.url is an http: URL under vite-node, which
    // the native ESM loader rejects.
    expect(setup).toContain("registerHooks");
    expect(setup).toContain("__flNodeModule");
    expect(setup).toContain("next\\/font(\\/.*)?");
    // Bundled output imports "next/navigation.js" — the extension rides.
    expect(setup).toContain("next\\/navigation(\\.js)?");
    expect(setup).toContain("data:text/javascript,");
    // The font default must be CALLABLE — wrapper packages run it at module scope.
    expect(setup).toContain("export default function fontLoader");
    expect(setup).toContain("export function useRouter");
    expect(setup).toContain("NEXT_REDIRECT");
    // No companion files: everything the hook needs is inline.
    expect(files.some((f) => f.relPath === "native-import-hooks.mjs")).toBe(false);
    expect(files.some((f) => f.relPath === "font-stub.mjs")).toBe(false);
  });

  test("jsdom's Web Audio silence is planted over with an inert graph", () => {
    // jsdom has no AudioContext: chanhdai's click-sound hook rejected
    // UNHANDLED at mount and exited the run rc=1 on an otherwise-green
    // plane. decodeAudioData must resolve (awaiting loaders complete),
    // and the param chain must answer (setValueAtTime(...)).
    expect(setup).toContain("window.AudioContext ??=");
    expect(setup).toContain("webkitAudioContext");
    expect(setup).toContain("OfflineAudioContext");
    expect(setup).toContain("decodeAudioData");
    expect(setup).toContain("setValueAtTime");
    expect(setup).toContain("createBufferSource");
  });
});
