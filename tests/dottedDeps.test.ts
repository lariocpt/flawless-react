import { describe, expect, test } from "bun:test";
import { emitModuleMocks } from "../src/scaffold-tests/mocks.ts";
import type { ComponentInfo, DataDepInfo, ModuleImportInfo } from "../src/types.ts";

/**
 * FR-014: `const rows = await db.query.users.findMany()` used to mock the
 * ROOT binding as a function — `db: vi.fn(...)` — so `.query` was undefined,
 * the RSC spec threw on CORRECT code, and dep.uncertain was false so no skip
 * escape fired: a hard false failure. The mock must be a nested object with
 * vi.fn at the LEAF of dep.callee, merging deps that share a root.
 */

function rscInfo(deps: DataDepInfo[], moduleImports: ModuleImportInfo[]): ComponentInfo {
  return {
    componentName: "Page",
    filePath: "/proj/src/Page.tsx",
    importSpecifier: "./Page.tsx",
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    exportKind: "default",
    isAsync: true,
    renderMode: "rsc",
    moduleImports,
    dataDeps: deps,
  };
}

function dbImport(): ModuleImportInfo {
  return {
    specifier: "@/lib/db",
    names: ["db"],
    kind: "value",
    isTypeOnly: false,
    hasDefault: false,
    pos: { file: "/proj/src/Page.tsx", line: 1, column: 1 },
  };
}

function dep(callee: string, extra: Partial<DataDepInfo> = {}): DataDepInfo {
  return {
    varName: "rows",
    callee,
    calleeRoot: callee.split(".")[0] as string,
    specifier: "@/lib/db",
    awaited: true,
    shape: {
      kind: "array",
      element: {
        kind: "object",
        fields: [{ name: "name", shape: { kind: "string" }, rendersAsText: true }],
      },
    },
    uncertain: false,
    pos: { file: "/proj/src/Page.tsx", line: 3, column: 1 },
    ...extra,
  };
}

function emitted(deps: DataDepInfo[], kinds?: string[]): string {
  const { statements } = emitModuleMocks(
    rscInfo(deps, [dbImport()]),
    "rsc",
    undefined,
    kinds ? (kind) => kinds.push(kind) : undefined,
  );
  return statements.join("\n");
}

describe("dotted data-dep callees mock as nested objects (FR-014)", () => {
  test("the leaf carries the vi.fn, the path is plain objects", () => {
    const kinds: string[] = [];
    const src = emitted([dep("db.query.users.findMany")], kinds);
    expect(src).toContain(
      'db: { query: { users: { findMany: vi.fn(async () => ([{ name: "flawless-name" }])) } } }',
    );
    expect(kinds).toEqual([]);
  });

  test("deps sharing a root merge into one tree", () => {
    const src = emitted([
      dep("db.query.users.findMany"),
      dep("db.query.posts.findFirst", {
        varName: "post",
        shape: { kind: "truthy-object" },
      }),
    ]);
    expect(src).toContain('findMany: vi.fn(async () => ([{ name: "flawless-name" }]))');
    expect(src).toContain("findFirst: vi.fn(async () => ({}))");
    // One `db:` key — a second would be a duplicate object literal key.
    expect(src.match(/\bdb: /g)?.length).toBe(1);
  });

  test("an uncertain dotted leaf keeps the honest {} and the TODO", () => {
    const kinds: string[] = [];
    const src = emitted(
      [dep("db.query.users.findMany", { shape: { kind: "unknown" }, uncertain: true })],
      kinds,
    );
    expect(src).toContain("db: { query: { users: { findMany: vi.fn(async () => ({})) } } }");
    expect(kinds).toEqual(["uninferred-return-shape"]);
  });

  test("a non-awaited dotted dep gets a sync leaf", () => {
    const src = emitted([dep("db.tables.list", { awaited: false })]);
    expect(src).toContain("db: { tables: { list: vi.fn(() =>");
  });

  test("bare + dotted on one binding is guesswork — honest {} and the TODO", () => {
    // A callable object stub (Object.assign(vi.fn(), {...})) would be
    // inventing semantics; the conservative fallback keeps the escape alive.
    const kinds: string[] = [];
    const src = emitted([dep("db"), dep("db.query.users.findMany", { varName: "other" })], kinds);
    expect(src).toContain("db: vi.fn(async () => ({}))");
    expect(kinds).toEqual(["uninferred-return-shape"]);
  });

  test("a path that is a prefix of another is a conflict — honest fallback", () => {
    const kinds: string[] = [];
    const src = emitted(
      [dep("db.query"), dep("db.query.users.findMany", { varName: "other" })],
      kinds,
    );
    expect(src).toContain("db: vi.fn(async () => ({}))");
    expect(kinds).toEqual(["uninferred-return-shape"]);
  });
});
