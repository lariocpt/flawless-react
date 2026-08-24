import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { emitModuleMocks } from "../src/scaffold-tests/mocks.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import type { ComponentInfo, DataDepInfo, ModuleImportInfo, NextjsApiRoute } from "../src/types.ts";

/**
 * B-1: deps whose usage-based shape inference came up empty (uncertain /
 * unknown) get a second chance from the dep function's own DECLARATION —
 * a Promise<T> return annotation (provenance "annotation"), or the body
 * being a single-fetch wrapper joined to the OpenAPI example at emit time
 * (provenance "openapi"). Everything the resolver cannot fully derive stays
 * an honest TODO: a wrong-but-plausible fixture is worse than {}.
 */

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-dep-returns-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const LIB = `export interface User {
  name: string;
  count: number;
  active: boolean;
}

export interface Item {
  id: number;
  label: string;
}

export type Meta = {
  kind: "a" | "b";
};

interface ApiResult<T> {
  data: T;
}

export async function getUser(): Promise<User> {
  return db();
}

export async function getItems(): Promise<Item[]> {
  return db();
}

export async function getMeta(): Promise<Meta> {
  return db();
}

export async function getGeneric(): Promise<ApiResult<User>> {
  return db();
}

export async function getUsers() {
  const res = await fetch("/api/users");
  return res.json();
}

export async function getComputed() {
  return db();
}

function db(): never {
  throw new Error("never runs under analysis");
}
`;

// Every awaited value is handed to helpers, which is NO usage evidence — the
// deps land as unknown/uncertain, which is the population B-1 enriches.
const PAGE = `import {
  getUser,
  getItems,
  getMeta,
  getGeneric,
  getUsers,
  getComputed,
} from "./lib";

function opaque(x: unknown): string {
  return String(x);
}

export default async function Page() {
  const user = await getUser();
  const items = await getItems();
  const meta = await getMeta();
  const generic = await getGeneric();
  const users = await getUsers();
  const computed = await getComputed();
  return (
    <main>
      {opaque(user)}
      {opaque(items)}
      {opaque(meta)}
      {opaque(generic)}
      {opaque(users)}
      {opaque(computed)}
    </main>
  );
}
`;

async function analysedDeps(): Promise<DataDepInfo[]> {
  const dir = tmpProject();
  writeFileSync(path.join(dir, "src", "lib.ts"), LIB);
  const page = path.join(dir, "src", "Page.tsx");
  writeFileSync(page, PAGE);
  const tree = await analyse({ entry: page, depth: 0, includeChildren: false });
  return tree.entry.dataDeps ?? [];
}

function depOf(deps: DataDepInfo[], callee: string): DataDepInfo | undefined {
  return deps.find((d) => d.callee === callee);
}

describe("annotation-derived dep returns (Path A)", () => {
  test("Promise<Interface> resolves to a truthy house-style fixture value", async () => {
    const deps = await analysedDeps();
    const user = depOf(deps, "getUser");
    expect(user?.uncertain || user?.shape.kind === "unknown").toBe(true);
    expect(user?.inferredReturn).toEqual({
      provenance: "annotation",
      value: { name: "flawless-name", count: 1, active: true },
    });
  });

  test("Promise<T[]> resolves to a ONE-element array — empty would render no rows", async () => {
    const deps = await analysedDeps();
    expect(depOf(deps, "getItems")?.inferredReturn).toEqual({
      provenance: "annotation",
      value: [{ id: 1, label: "flawless-label" }],
    });
  });

  test("a type alias resolves like an interface, unions to their first literal", async () => {
    const deps = await analysedDeps();
    expect(depOf(deps, "getMeta")?.inferredReturn).toEqual({
      provenance: "annotation",
      value: { kind: "a" },
    });
  });

  test("a generic return bails — substituting type params is guessing", async () => {
    const deps = await analysedDeps();
    expect(depOf(deps, "getGeneric")?.inferredReturn).toBeUndefined();
    expect(depOf(deps, "getGeneric")?.wrapsFetch).toBeUndefined();
  });

  test("no annotation and no fetch stays an honest unknown", async () => {
    const deps = await analysedDeps();
    const computed = depOf(deps, "getComputed");
    expect(computed?.inferredReturn).toBeUndefined();
    expect(computed?.wrapsFetch).toBeUndefined();
  });
});

describe("single-fetch wrappers (Path B, recorded for the emit-time join)", () => {
  test("an unannotated single-fetch wrapper records its method and path", async () => {
    const deps = await analysedDeps();
    expect(depOf(deps, "getUsers")?.wrapsFetch).toEqual({ method: "GET", path: "/api/users" });
    expect(depOf(deps, "getUsers")?.inferredReturn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Emit side
// ---------------------------------------------------------------------------

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

function libImport(names: string[]): ModuleImportInfo {
  return {
    specifier: "@/lib/data",
    names,
    kind: "value",
    isTypeOnly: false,
    hasDefault: false,
    pos: { file: "/proj/src/Page.tsx", line: 1, column: 1 },
  };
}

function unknownDep(callee: string, extra: Partial<DataDepInfo> = {}): DataDepInfo {
  return {
    varName: callee,
    callee,
    calleeRoot: callee,
    specifier: "@/lib/data",
    awaited: true,
    shape: { kind: "unknown" },
    uncertain: true,
    pos: { file: "/proj/src/Page.tsx", line: 3, column: 1 },
    ...extra,
  };
}

const ROUTES: NextjsApiRoute[] = [
  {
    path: "/api/users",
    methods: ["GET"],
    file: "app/api/users/route.ts",
    responseBodies: { GET: [{ id: 7, name: "octavia" }] },
  },
];

describe("the mock emitter consumes inferred returns", () => {
  test("an annotation value replaces {} with a provenance comment and no TODO", () => {
    const kinds: string[] = [];
    const dep = unknownDep("getUser", {
      inferredReturn: { provenance: "annotation", value: { name: "flawless-name" } },
    });
    const { statements } = emitModuleMocks(
      rscInfo([dep], [libImport(["getUser"])]),
      "rsc",
      undefined,
      (kind) => kinds.push(kind),
    );
    const src = statements.join("\n");
    expect(src).toContain('getUser: vi.fn(async () => ({"name":"flawless-name"}))');
    expect(src).toContain("annotation");
    expect(src).not.toContain("TODO(flawless)");
    expect(kinds).toEqual([]);
  });

  test("a fetch wrapper joins to the OpenAPI example at emit time", () => {
    const kinds: string[] = [];
    const dep = unknownDep("getUsers", {
      wrapsFetch: { method: "GET", path: "/api/users" },
    });
    const { statements } = emitModuleMocks(
      rscInfo([dep], [libImport(["getUsers"])]),
      "rsc",
      undefined,
      (kind) => kinds.push(kind),
      ROUTES,
    );
    const src = statements.join("\n");
    expect(src).toContain('getUsers: vi.fn(async () => ([{"id":7,"name":"octavia"}]))');
    expect(src).toContain("OpenAPI example for GET /api/users");
    expect(src).not.toContain("TODO(flawless)");
    expect(kinds).toEqual([]);
  });

  test("a fetch wrapper with no matching route keeps the honest {} and the TODO", () => {
    const kinds: string[] = [];
    const dep = unknownDep("getUsers", {
      wrapsFetch: { method: "GET", path: "/api/unknown" },
    });
    const { statements } = emitModuleMocks(
      rscInfo([dep], [libImport(["getUsers"])]),
      "rsc",
      undefined,
      (kind) => kinds.push(kind),
      ROUTES,
    );
    expect(statements.join("\n")).toContain("getUsers: vi.fn(async () => ({}))");
    expect(kinds).toEqual(["uninferred-return-shape"]);
  });

  test("one enriched binding does not silence the module's other gaps", () => {
    const kinds: string[] = [];
    const enriched = unknownDep("getUser", {
      inferredReturn: { provenance: "annotation", value: { name: "flawless-name" } },
    });
    const opaque = unknownDep("getComputed");
    const { statements } = emitModuleMocks(
      rscInfo([enriched, opaque], [libImport(["getUser", "getComputed"])]),
      "rsc",
      undefined,
      (kind) => kinds.push(kind),
    );
    const src = statements.join("\n");
    expect(src).toContain('getUser: vi.fn(async () => ({"name":"flawless-name"}))');
    expect(src).toContain("getComputed: vi.fn(async () => ({}))");
    expect(src).toContain("TODO(flawless)");
    expect(kinds).toEqual(["uninferred-return-shape"]);
  });
});

describe("the RSC skip escape treats enriched deps as resolved", () => {
  const render = (deps: DataDepInfo[]): string => {
    const files = renderUnitBrowser({
      trees: [{ entry: rscInfo(deps, [libImport(deps.map((d) => d.callee))]), children: [] }],
      outDir: "/proj/flawless",
      variants: 1,
      browserSpecs: false,
      apiRoutes: ROUTES,
    });
    return files.find((f) => f.relPath === "unit/Page.test.tsx")?.content ?? "";
  };

  test("an admitted gap still emits the fixture-missing skip", () => {
    expect(render([unknownDep("getComputed")])).toContain("data fixture missing");
  });

  test("an enriched dep is coverage, not a gap — the crash must report as itself", () => {
    const spec = render([
      unknownDep("getUser", {
        inferredReturn: { provenance: "annotation", value: { name: "flawless-name" } },
      }),
      unknownDep("getUsers", { wrapsFetch: { method: "GET", path: "/api/users" } }),
    ]);
    expect(spec).not.toContain("data fixture missing");
  });

  test("a fetch wrapper with no route to join to is still a gap", () => {
    expect(
      render([unknownDep("getUsers", { wrapsFetch: { method: "GET", path: "/api/unknown" } })]),
    ).toContain("data fixture missing");
  });
});
