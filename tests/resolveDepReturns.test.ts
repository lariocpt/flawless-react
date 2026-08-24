import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { resolveTypeNodeValue } from "../src/analyse/extractProps.ts";
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

export async function getUsersViaBinding() {
  const res = await fetch("/api/users");
  const data = await res.json();
  return data;
}

export async function getUsersDirect() {
  return (await fetch("/api/users")).json();
}

export async function getAggregate() {
  const a = await fetch("/api/users");
  const b = await fetch("/api/other");
  return [await a.json(), await b.json()];
}

export async function getEnvelope() {
  const res = await fetch("/api/users");
  const envelope = await res.json();
  return envelope.data;
}

export async function getWithSideEffect() {
  void fetch("/api/audit", { method: "POST" });
  return db();
}

export interface Holey {
  id: string;
  createdAt: Date;
}

export async function getHoley(): Promise<Holey> {
  return db();
}

export async function getProfile(): Promise<{ handle: string }> {
  return db();
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
  getUsersViaBinding,
  getUsersDirect,
  getAggregate,
  getEnvelope,
  getWithSideEffect,
  getHoley,
  getProfile,
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
  const viaBinding = await getUsersViaBinding();
  const direct = await getUsersDirect();
  const aggregate = await getAggregate();
  const envelope = await getEnvelope();
  const sideEffect = await getWithSideEffect();
  const holey = await getHoley();
  const profile = await getProfile();
  const computed = await getComputed();
  return (
    <main>
      {opaque(user)}
      {opaque(items)}
      {opaque(meta)}
      {opaque(generic)}
      {opaque(users)}
      {opaque(viaBinding)}
      {opaque(direct)}
      {opaque(aggregate)}
      {opaque(envelope)}
      {opaque(sideEffect)}
      {opaque(holey)}
      <span>{profile.bio}</span>
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

  test("the awaited-json-binding and direct-chain idioms are wrappers too", async () => {
    const deps = await analysedDeps();
    expect(depOf(deps, "getUsersViaBinding")?.wrapsFetch).toEqual({
      method: "GET",
      path: "/api/users",
    });
    expect(depOf(deps, "getUsersDirect")?.wrapsFetch).toEqual({
      method: "GET",
      path: "/api/users",
    });
  });

  test("two fetches are an aggregator, not a wrapper — no recording", async () => {
    const deps = await analysedDeps();
    expect(depOf(deps, "getAggregate")?.wrapsFetch).toBeUndefined();
  });

  test("a function that returns something OTHER than the fetched json is not a wrapper", async () => {
    // The envelope unwrapper returns envelope.data — serving the WHOLE
    // envelope example would be a wrong-but-plausible fixture, false-pass
    // capable for a shape-tolerant component. Same for a side-effect fetch.
    const deps = await analysedDeps();
    expect(depOf(deps, "getEnvelope")?.wrapsFetch).toBeUndefined();
    expect(depOf(deps, "getWithSideEffect")?.wrapsFetch).toBeUndefined();
  });
});

describe("the enrichment gates (usage outranks declaration; wrong channels skipped)", () => {
  test("a dep whose USAGE resolved a shape is never overridden by its annotation", async () => {
    const deps = await analysedDeps();
    const profile = depOf(deps, "getProfile");
    expect(profile?.shape.kind).toBe("object");
    expect(profile?.uncertain).toBe(false);
    expect(profile?.inferredReturn).toBeUndefined();
  });

  test("an unresolvable member (Date) bails the whole fixture, not just the field", async () => {
    const deps = await analysedDeps();
    expect(depOf(deps, "getHoley")?.inferredReturn).toBeUndefined();
  });

  test('a "use server" module is serverActionMock\'s channel — its deps are not enriched', async () => {
    // serverActionMock never reads dataDeps, so an enriched dep here would
    // suppress the RSC skip escape while the mock still resolves {} — a
    // false RED blaming the app for a fixture that was never emitted.
    const dir = tmpProject();
    writeFileSync(
      path.join(dir, "src", "actions.ts"),
      `"use server";

export interface User {
  name: string;
}

export async function getUser(): Promise<User> {
  return db();
}

function db(): never {
  throw new Error("never runs");
}
`,
    );
    const page = path.join(dir, "src", "Page.tsx");
    writeFileSync(
      page,
      `import { getUser } from "./actions";

function opaque(x: unknown): string {
  return String(x);
}

export default async function Page() {
  const user = await getUser();
  return <main>{opaque(user)}</main>;
}
`,
    );
    const tree = await analyse({ entry: page, depth: 0, includeChildren: false });
    const dep = (tree.entry.dataDeps ?? []).find((d) => d.callee === "getUser");
    expect(dep?.inferredReturn).toBeUndefined();
    expect(dep?.wrapsFetch).toBeUndefined();
  });

  test("a DEFAULT-imported dep is enriched — its mock carries the value (see emit tests)", async () => {
    const dir = tmpProject();
    writeFileSync(
      path.join(dir, "src", "lib.ts"),
      `export interface User {
  name: string;
}

export default async function getUser(): Promise<User> {
  throw new Error("never runs");
}
`,
    );
    const page = path.join(dir, "src", "Page.tsx");
    writeFileSync(
      page,
      `import getUser from "./lib";

function opaque(x: unknown): string {
  return String(x);
}

export default async function Page() {
  const user = await getUser();
  return <main>{opaque(user)}</main>;
}
`,
    );
    const tree = await analyse({ entry: page, depth: 0, includeChildren: false });
    const dep = (tree.entry.dataDeps ?? []).find((d) => d.callee === "getUser");
    expect(dep?.inferredReturn).toEqual({
      provenance: "annotation",
      value: { name: "flawless-name" },
    });
  });
});

describe("resolveTypeNodeValue is provenance-aware and bails on every hole", () => {
  function valueOf(source: string, expr: string): unknown {
    const sf = ts.createSourceFile(
      "/proj/lib.ts",
      `${source}\ntype __T = ${expr};`,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    let node: ts.TypeNode | undefined;
    for (const stmt of sf.statements) {
      if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === "__T") node = stmt.type;
    }
    if (!node) throw new Error("fixture did not parse");
    return resolveTypeNodeValue(node, sf, "/proj/lib.ts", undefined, undefined);
  }

  test("declared LITERAL types are preserved exactly — never restyled into forbidden values", () => {
    // `success: false` restyled to true steers the component down a branch
    // production can never take; the restyle is only safe for keyword types.
    expect(valueOf('interface Flags { ok: false; count: 0; tag: "" }', "Flags")).toEqual({
      ok: false,
      count: 0,
      tag: "",
    });
  });

  test("a union of literals resolves to its FIRST literal, untouched", () => {
    expect(valueOf("interface S { status: 0 | 2 }", "S")).toEqual({ status: 0 });
  });

  test("keyword types restyle to the truthy house values", () => {
    expect(valueOf("interface U { name: string; n: number; b: boolean }", "U")).toEqual({
      name: "flawless-name",
      n: 1,
      b: true,
    });
  });

  test("an unresolvable nested member bails the WHOLE value", () => {
    expect(valueOf("interface T { meta: { createdAt: Date; id: string } }", "T")).toBeUndefined();
  });

  test("a mutual type-alias cycle bails instead of hanging", () => {
    expect(valueOf("type A = B; type B = A;", "A")).toBeUndefined();
  });

  test("a local type shadowing a React attr name resolves to ITS members, not the DOM table", () => {
    expect(
      valueOf("interface ButtonHTMLAttributes { totallyCustom: number }", "ButtonHTMLAttributes"),
    ).toEqual({ totallyCustom: 1 });
  });

  test("member arrays are one-element too — an empty list renders no rows anywhere", () => {
    expect(valueOf("interface L { tags: string[] }", "L")).toEqual({ tags: ["flawless-tags"] });
  });

  test("optional members are included — type-legal and strictly richer", () => {
    expect(valueOf("interface O { name?: string }", "O")).toEqual({ name: "flawless-name" });
  });

  test("an interface with heritage bails (v1) — silently partial would be worse", () => {
    expect(
      valueOf("interface B1 { b: string }\ninterface A1 extends B1 { a: string }", "A1"),
    ).toBeUndefined();
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

  test("a DEFAULT-imported dep's mock carries the value under the default key", () => {
    // The default branch used to return `default: vi.fn()` before the dep
    // lookup — the escape was suppressed for a fixture that was never
    // emitted, and `await getUser()` resolved undefined at runtime.
    const kinds: string[] = [];
    const dep = unknownDep("getUser", {
      inferredReturn: { provenance: "annotation", value: { name: "flawless-name" } },
    });
    const mi: ModuleImportInfo = {
      specifier: "@/lib/data",
      names: ["getUser"],
      kind: "value",
      isTypeOnly: false,
      hasDefault: true,
      pos: { file: "/proj/src/Page.tsx", line: 1, column: 1 },
    };
    const { statements } = emitModuleMocks(rscInfo([dep], [mi]), "rsc", undefined, (kind) =>
      kinds.push(kind),
    );
    const src = statements.join("\n");
    expect(src).toContain('default: vi.fn(async () => ({"name":"flawless-name"}))');
    expect(src).toContain("annotation");
    expect(kinds).toEqual([]);
  });

  test("a fetch path containing */ cannot terminate the provenance comment early", () => {
    const dep = unknownDep("getWeird", {
      wrapsFetch: { method: "GET", path: "/api/a/*/b" },
    });
    const routes: NextjsApiRoute[] = [
      {
        path: "/api/a/*/b",
        methods: ["GET"],
        file: "app/api/a/x/b/route.ts",
        responseBodies: { GET: { ok: 1 } },
      },
    ];
    const { statements } = emitModuleMocks(
      rscInfo([dep], [libImport(["getWeird"])]),
      "rsc",
      undefined,
      undefined,
      routes,
    );
    const src = statements.join("\n");
    expect(src).toContain('getWeird: vi.fn(async () => ({"ok":1}))');
    // Exactly one comment terminator: the real one. A raw */ from the path
    // would close the comment mid-way and leave the tail as broken code.
    expect(src.match(/\*\//g)?.length).toBe(1);
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

describe("constrained specs get the same emit-time join", () => {
  test("a document-root component's fetch-wrapper dep joins to the OpenAPI example", () => {
    const info: ComponentInfo = {
      ...rscInfo(
        [unknownDep("getUsers", { wrapsFetch: { method: "GET", path: "/api/users" } })],
        [libImport(["getUsers"])],
      ),
      componentName: "RootLayout",
      renderMode: "document-root",
    };
    const files = renderUnitBrowser({
      trees: [{ entry: info, children: [] }],
      outDir: "/proj/flawless",
      variants: 1,
      browserSpecs: false,
      apiRoutes: ROUTES,
    });
    const spec = files.find((f) => f.relPath === "unit/RootLayout.test.tsx")?.content ?? "";
    expect(spec).toContain('getUsers: vi.fn(async () => ([{"id":7,"name":"octavia"}]))');
  });
});
