import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { SourceFileCache } from "../src/analyse/sourceCache.ts";
import { emitModuleMocks } from "../src/scaffold-tests/mocks.ts";
import type { ComponentInfo, ModuleImportInfo } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures/actions");
const POST_FORM = path.join(FIXTURES, "PostForm.tsx");

function importOf(imports: ModuleImportInfo[], endsWith: string): ModuleImportInfo | undefined {
  return imports.find((m) => m.specifier.endsWith(endsWith));
}

describe("SourceFileCache.hasPrologueDirective", () => {
  test('detects "use server", including behind a license header', () => {
    const cache = new SourceFileCache();
    expect(cache.hasPrologueDirective(path.join(FIXTURES, "submit.ts"), "use server")).toBe(true);
    expect(cache.hasPrologueDirective(path.join(FIXTURES, "licensed.ts"), "use server")).toBe(true);
  });

  test("a module without the directive is not flagged", () => {
    const cache = new SourceFileCache();
    expect(cache.hasPrologueDirective(path.join(FIXTURES, "plain.ts"), "use server")).toBe(false);
  });

  test('"use server" inside a function body is not a prologue', () => {
    const cache = new SourceFileCache();
    expect(cache.hasPrologueDirective(path.join(FIXTURES, "late-directive.ts"), "use server")).toBe(
      false,
    );
  });

  test("an unreadable path is a miss, not a throw", () => {
    const cache = new SourceFileCache();
    expect(cache.hasPrologueDirective(path.join(FIXTURES, "nope.ts"), "use server")).toBe(false);
  });
});

describe("isServerAction", () => {
  test("flags only the resolved module that carries the directive", async () => {
    const t = await analyse({ entry: POST_FORM, depth: 0, includeChildren: false });
    const imports = t.entry.moduleImports ?? [];

    expect(importOf(imports, "submit.ts")?.isServerAction).toBe(true);
    expect(importOf(imports, "plain.ts")?.isServerAction).toBeUndefined();
  });

  test("bare specifiers never resolve, so they are never flagged", async () => {
    const t = await analyse({ entry: POST_FORM, depth: 0, includeChildren: false });
    const nav = importOf(t.entry.moduleImports ?? [], "next/navigation");
    expect(nav).toBeDefined();
    expect(nav?.resolvedPath).toBeUndefined();
    expect(nav?.isServerAction).toBeUndefined();
  });
});

describe("emitModuleMocks in client mode", () => {
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

  test("server actions resolve to {} rather than undefined", () => {
    const { statements, mocked } = emitModuleMocks(
      info([mi({ specifier: "@/app/actions/posts", names: ["createPost"], isServerAction: true })]),
      "client",
    );
    expect(mocked).toEqual(["@/app/actions/posts"]);
    // These land in useActionState, whose state is read as `state && "error" in
    // state` — undefined would crash the first render.
    expect(statements.join("\n")).toContain("createPost: vi.fn(async () => ({}))");
  });

  test("the allowlist is exhaustive: an ordinary util is left real", () => {
    const { mocked } = emitModuleMocks(
      info([
        mi({ specifier: "@/lib/utils", names: ["cn"] }),
        mi({ specifier: "@/components/ui/button", names: ["Button"], kind: "component" }),
        mi({ specifier: "next/navigation", names: ["usePathname"] }),
      ]),
      "client",
    );
    // Mocking cn would strip every className off the markup; mocking Button
    // would replace the element the interaction tests click.
    expect(mocked).toEqual(["next/navigation"]);
  });

  test("the same specifier imported twice is mocked once", () => {
    const { statements } = emitModuleMocks(
      info([
        mi({ specifier: "next/navigation", names: ["usePathname"] }),
        mi({ specifier: "next/navigation", names: ["useRouter"] }),
      ]),
      "client",
    );
    expect(statements).toHaveLength(1);
  });

  test("type-only imports are never mocked", () => {
    const { mocked } = emitModuleMocks(
      info([mi({ specifier: "next/navigation", names: ["Route"], isTypeOnly: true })]),
      "client",
    );
    expect(mocked).toEqual([]);
  });

  test("next/font loaders are stubbed by the names actually imported", () => {
    const { statements } = emitModuleMocks(
      info([mi({ specifier: "next/font/google", names: ["Inter_Tight", "JetBrains_Mono"] })]),
      "client",
    );
    const src = statements.join("\n");
    // The loader runs at module scope and reads the filesystem, so the import
    // throws before any test body runs.
    expect(src).toContain("Inter_Tight: () => ({ className:");
    expect(src).toContain("JetBrains_Mono: () => ({ className:");
  });

  test("a relative specifier is re-based onto the spec's own directory", () => {
    // vitest resolves a relative vi.mock() against the file containing the call.
    // Emitting the component's own "./actions" would mock a sibling of the SPEC,
    // so the mock would silently do nothing and the real module would load.
    const { mocked } = emitModuleMocks(
      info([
        mi({
          specifier: "./actions",
          names: ["createPost"],
          isServerAction: true,
          resolvedPath: "/proj/src/features/actions.ts",
        }),
      ]),
      "client",
      "/proj/flawless/unit",
    );
    expect(mocked).toEqual(["../../src/features/actions"]);
  });

  test("bare and aliased specifiers are left alone", () => {
    const { mocked } = emitModuleMocks(
      info([
        mi({
          specifier: "@/app/actions/posts",
          names: ["createPost"],
          isServerAction: true,
          resolvedPath: "/proj/src/app/actions/posts.ts",
        }),
      ]),
      "client",
      "/proj/flawless/unit",
    );
    // They mean the same thing from any file, so re-basing them would break the
    // project's own alias resolution.
    expect(mocked).toEqual(["@/app/actions/posts"]);
  });

  test("rsc mode also mocks project-local data modules, client mode does not", () => {
    const imports = [mi({ specifier: "@/lib/dal", names: ["getCurrentUser"] })];
    expect(emitModuleMocks(info(imports), "client").mocked).toEqual([]);
    expect(emitModuleMocks(info(imports), "rsc").mocked).toEqual(["@/lib/dal"]);
  });
});
