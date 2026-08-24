import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { SourceFileCache } from "../src/analyse/sourceCache.ts";
import { renderSuite } from "../src/scaffold/templates.ts";
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

  test("the analyser records each action's literal return beside the export list", async () => {
    const t = await analyse({ entry: POST_FORM, depth: 0, includeChildren: false });
    const submit = importOf(t.entry.moduleImports ?? [], "submit.ts");
    expect(submit?.serverActionReturns).toEqual({
      createPost: { ok: true },
      deletePost: { ok: true },
    });
    // Non-action modules never carry the field.
    expect(importOf(t.entry.moduleImports ?? [], "plain.ts")?.serverActionReturns).toBeUndefined();
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

  test("a resolved return replaces the {} stub and retires the TODO", () => {
    const kinds: string[] = [];
    const { statements } = emitModuleMocks(
      info([
        mi({
          specifier: "@/app/actions/posts",
          names: ["createPost"],
          isServerAction: true,
          serverActionExports: ["createPost"],
          serverActionReturns: { createPost: { ok: true, message: "saved" } },
        }),
      ]),
      "client",
      undefined,
      (kind) => kinds.push(kind),
    );
    const src = statements.join("\n");
    expect(src).toContain('createPost: vi.fn(async () => ({"ok":true,"message":"saved"}))');
    expect(src).not.toContain("TODO(flawless)");
    expect(kinds).toEqual([]);
  });

  test("one unresolved export keeps the TODO, even when the imported name resolved", () => {
    // The vi.mock factory replaces the WHOLE module — a transitive importer
    // gets the sibling exports from this same factory, so an unresolved
    // sibling means the stub surface is still partly fake.
    const kinds: string[] = [];
    const { statements } = emitModuleMocks(
      info([
        mi({
          specifier: "@/app/actions/posts",
          names: ["createPost"],
          isServerAction: true,
          serverActionExports: ["createPost", "deletePost"],
          serverActionReturns: { createPost: { ok: true } },
        }),
      ]),
      "client",
      undefined,
      (kind) => kinds.push(kind),
    );
    const src = statements.join("\n");
    expect(src).toContain('createPost: vi.fn(async () => ({"ok":true}))');
    expect(src).toContain("TODO(flawless)");
    expect(kinds).toEqual(["server-action-stub"]);
  });

  test("an aliased import mocks the MODULE-side name and joins returns by it", () => {
    // `import { createPost as saveIt }` — the module exports createPost, so
    // the factory must too; a factory keyed by the local alias exports a name
    // the module never had and leaves the real one unmocked.
    const { statements } = emitModuleMocks(
      info([
        mi({
          specifier: "@/app/actions/posts",
          names: ["saveIt"],
          importedNames: ["createPost"],
          isServerAction: true,
          serverActionExports: ["createPost"],
          serverActionReturns: { createPost: { ok: true } },
        }),
      ]),
      "client",
    );
    const src = statements.join("\n");
    expect(src).toContain('createPost: vi.fn(async () => ({"ok":true}))');
    expect(src).not.toContain("saveIt:");
  });

  test('a default-imported action resolves through the "default" key', () => {
    const kinds: string[] = [];
    const { statements } = emitModuleMocks(
      info([
        mi({
          specifier: "@/app/actions/submit",
          names: ["submit"],
          hasDefault: true,
          isServerAction: true,
          serverActionExports: [],
          serverActionReturns: { default: { done: true } },
        }),
      ]),
      "client",
      undefined,
      (kind) => kinds.push(kind),
    );
    expect(statements.join("\n")).toContain('default: vi.fn(async () => ({"done":true}))');
    expect(kinds).toEqual([]);
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

describe("host server stubs consume the resolved returns", () => {
  test("a resolved export stubs with its literal; an unresolved sibling keeps {}", () => {
    const files = renderSuite({
      tree: {
        entry: {
          componentName: "X",
          filePath: "/app/src/X.tsx",
          importSpecifier: "./X",
          propsShape: {},
          variants: [],
          hooks: [],
          unresolvedProps: [],
          exportKind: "named",
          isAsync: false,
          moduleImports: [
            {
              specifier: "./actions",
              names: ["doThing"],
              kind: "value",
              isTypeOnly: false,
              hasDefault: false,
              resolvedPath: "/app/src/actions.ts",
              isServerAction: true,
              serverActionExports: ["doThing", "opaqueThing"],
              serverActionReturns: { doThing: { ok: true } },
              pos: { file: "/app/src/X.tsx", line: 1, column: 1 },
            },
          ],
        },
        children: [],
      } as never,
      outDir: "/app/flawless",
      variants: 3,
      report: false,
    });
    const server = files.find((f) => f.relPath === "host/server.ts")?.content ?? "";
    // The stub module source is embedded JSON-encoded as one string; assert on
    // the encoded whole so this fails if the join ever detaches.
    const body =
      'export const doThing = async () => ({"ok":true});\n' +
      "export const opaqueThing = async () => ({});";
    expect(server).toContain(JSON.stringify(body));
  });
});
