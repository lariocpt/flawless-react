import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { resolveTypeNodeValue } from "../src/analyse/extractProps.ts";
import { analyse } from "../src/analyse/index.ts";
import { annotatedReturnValue } from "../src/analyse/resolveDepReturns.ts";
import { ModuleResolver } from "../src/analyse/resolveModule.ts";
import { SourceFileCache } from "../src/analyse/sourceCache.ts";
import { emitModuleMocks } from "../src/scaffold-tests/mocks.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import {
  type ComponentInfo,
  DATE_PROP_SENTINEL,
  type DataDepInfo,
  type ModuleImportInfo,
  type NextjsApiRoute,
} from "../src/types.ts";

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
  const extra = await fetch("/api/other");
  void extra;
  const res = await fetch("/api/users");
  return res.json();
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
  cb: () => void;
}

export async function getHoley(): Promise<Holey> {
  return db();
}

export interface Dated {
  id: string;
  createdAt: Date;
}

export async function getDated(): Promise<Dated> {
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
  getDated,
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
  const dated = await getDated();
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
      {opaque(dated)}
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
    // The fixture RETURNS a fetched json on purpose: with the exactly-one
    // gate dropped, fetches[0] (/api/other) would be recorded even though
    // the returned json is the OTHER fetch's — the wrong example joined.
    // Only the fetch-count gate stands between this shape and that record.
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

  test("an unresolvable member (function type) bails the whole fixture, not just the field", async () => {
    const deps = await analysedDeps();
    expect(depOf(deps, "getHoley")?.inferredReturn).toBeUndefined();
  });

  test("a Date member resolves to the live-Date sentinel, not a bail", async () => {
    // Children mount for real and call getTime/toLocaleTimeString — a
    // fixture that bailed on Date starved the mock; a string starves the
    // method. defaultsJson turns the sentinel back into new Date(...) in
    // the emitted spec.
    const deps = await analysedDeps();
    expect(depOf(deps, "getDated")?.inferredReturn?.value).toEqual({
      id: "flawless-id",
      createdAt: DATE_PROP_SENTINEL,
    });
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
  function fixtureOf(source: string, expr: string): unknown {
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
    expect(fixtureOf('interface Flags { ok: false; count: 0; tag: "" }', "Flags")).toEqual({
      ok: false,
      count: 0,
      tag: "",
    });
  });

  test("a union of literals resolves to its FIRST literal, untouched", () => {
    expect(fixtureOf("interface S { status: 0 | 2 }", "S")).toEqual({ status: 0 });
  });

  test("keyword types restyle to the truthy house values", () => {
    expect(fixtureOf("interface U { name: string; n: number; b: boolean }", "U")).toEqual({
      name: "flawless-name",
      n: 1,
      b: true,
    });
  });

  test("an unresolvable nested member bails the WHOLE value", () => {
    expect(fixtureOf("interface T { meta: { run: () => void; id: string } }", "T")).toBeUndefined();
  });

  test("a nested Date member resolves to the sentinel", () => {
    expect(fixtureOf("interface T { meta: { createdAt: Date; id: string } }", "T")).toEqual({
      meta: { createdAt: DATE_PROP_SENTINEL, id: "flawless-id" },
    });
  });

  test("a mutual type-alias cycle bails instead of hanging", () => {
    expect(fixtureOf("type A = B; type B = A;", "A")).toBeUndefined();
  });

  test("a local type shadowing a React attr name resolves to ITS members, not the DOM table", () => {
    expect(
      fixtureOf("interface ButtonHTMLAttributes { totallyCustom: number }", "ButtonHTMLAttributes"),
    ).toEqual({ totallyCustom: 1 });
  });

  test("member arrays are one-element too — an empty list renders no rows anywhere", () => {
    expect(fixtureOf("interface L { tags: string[] }", "L")).toEqual({ tags: ["flawless-tags"] });
  });

  test("optional members are included — type-legal and strictly richer", () => {
    expect(fixtureOf("interface O { name?: string }", "O")).toEqual({ name: "flawless-name" });
  });

  test("null/undefined union arms are discounted — the value is IN the declared union", () => {
    // The dominant real-app annotation shape (dogfood round 5): DB-backed
    // types carry X | null members everywhere, and Promise<T | null>
    // returns. Choosing the non-null arm is not a guess: the value is one
    // of the union's own members, unlike the restyle-forbidden class.
    expect(fixtureOf("interface J { scheduled_for: number | null }", "J")).toEqual({
      scheduled_for: 1,
    });
    expect(fixtureOf("interface S { note: string | null }", "S")).toEqual({
      note: "flawless-note",
    });
    expect(fixtureOf("interface U { name: string }", "U | null")).toEqual({
      name: "flawless-name",
    });
    expect(fixtureOf('interface O { tag: "a" | "b" | null }', "O")).toEqual({ tag: "a" });
    expect(fixtureOf("interface Q { n: number | undefined }", "Q")).toEqual({ n: 1 });
  });

  test("a union of ONLY null/undefined arms bails — nothing remains to choose", () => {
    expect(fixtureOf("interface Z { gone: null | undefined }", "Z")).toBeUndefined();
  });

  test("a union with TWO non-null arms still bails — that would be a choice", () => {
    expect(
      fixtureOf("interface A1 { a: string }\ninterface B1 { b: string }", "A1 | B1"),
    ).toBeUndefined();
  });

  test("an interface with heritage merges the base, own members last", () => {
    // Was a bail, on the reasoning that a partial fixture is worse than none.
    // The reasoning holds; the bail was wider than it — a base that resolves is
    // complete, not partial. Seven api functions in the dogfood app mocked to
    // `{}` for this, and one poisoned a whole screen: `const [{ poll: p }] =
    // await Promise.all([getPoll(…)])` bound p to undefined and the screen
    // rendered its error state.
    expect(
      fixtureOf("interface B1 { b: string }\ninterface A1 extends B1 { a: string }", "A1"),
    ).toEqual({ b: "flawless-b", a: "flawless-a" });
  });

  test("own members win over the base's — they are the more specific", () => {
    expect(
      fixtureOf("interface B2 { v: number }\ninterface A2 extends B2 { v: string }", "A2"),
    ).toEqual({ v: "flawless-v" });
  });

  test("heritage whose BASE does not resolve still bails — the invariant kept", () => {
    // The base has a member with two non-null arms, which bails on its own. The
    // derived interface must not come back holding only its own members.
    expect(
      fixtureOf(
        "interface B3 { pick: { a: string } | { b: string } }\ninterface A3 extends B3 { a: string }",
        "A3",
      ),
    ).toBeUndefined();
  });

  test("a base that is not in scope bails rather than resolving to own members", () => {
    expect(fixtureOf("interface A4 extends Nowhere { a: string }", "A4")).toBeUndefined();
  });

  test("Record<K,V> resolves to {} — a complete inhabitant, not a partial one", () => {
    // `read_by: Record<string, number>` bailed MessageSummary entirely, and with
    // it every mock of the three api functions returning one.
    expect(fixtureOf("interface R1 { read_by: Record<string, number>; id: string }", "R1")).toEqual(
      {
        read_by: {},
        id: "flawless-id",
      },
    );
  });

  test("a generic that is NOT Record/Partial still bails — substitution is real work", () => {
    expect(fixtureOf("interface R2 { p: Pick<{ a: string }, 'a'> }", "R2")).toBeUndefined();
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

describe("cache()-wrapped exports, and types re-exported from an import", () => {
  // Two defects that sat between the analyser and the standard Next.js DAL
  // idiom. Both are resolution SHAPES that were simply not handled, and the
  // dogfood app's src/lib/dal.ts hits both at once:
  //
  //   import type { User } from "@/lib/users";          <- users.ts re-exports
  //   export const getCurrentUser = cache(async (): Promise<User> => …);
  //
  // Before: the export was invisible (a CallExpression initializer), and even
  // once visible the type resolved to nothing.
  function projectOf(files: Record<string, string>): { dir: string } {
    const dir = mkdtempSync(path.join(os.tmpdir(), "dal-"));
    writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return { dir };
  }

  const BASE = {
    "shape.ts": "export interface Row { id: string; n: number }\n",
    "reexport.ts": 'import type { Row } from "./shape.ts";\nexport type { Row };\n',
  };

  function returnOf(files: Record<string, string>, file: string, name: string): unknown {
    const { dir } = projectOf({ ...BASE, ...files });
    return annotatedReturnValue(
      path.join(dir, file),
      name,
      new ModuleResolver(),
      new SourceFileCache(),
    );
  }

  test("cache(async (): Promise<T> => …) resolves like a bare arrow", () => {
    const src = `
      import { cache } from "react";
      import type { Row } from "./shape.ts";
      export const wrapped = cache(async (): Promise<Row> => ({ id: "x", n: 1 }));
      export const plain = async (): Promise<Row> => ({ id: "x", n: 1 });`;
    expect(returnOf({ "a.ts": src }, "a.ts", "wrapped")).toEqual({ id: "flawless-id", n: 1 });
    // The control: the same annotation without the wrapper always worked, so a
    // difference between these two is the wrapper and nothing else.
    expect(returnOf({ "a.ts": src }, "a.ts", "plain")).toEqual({ id: "flawless-id", n: 1 });
  });

  test("React.cache(…) resolves too — the member name is what identifies it", () => {
    const src = `
      import * as React from "react";
      import type { Row } from "./shape.ts";
      export const wrapped = React.cache(async (): Promise<Row> => ({ id: "x", n: 1 }));`;
    expect(returnOf({ "a.ts": src }, "a.ts", "wrapped")).toEqual({ id: "flawless-id", n: 1 });
  });

  test("unstable_cache(fn, keyParts, opts) resolves — only argument 0 is a function", () => {
    const src = `
      import { unstable_cache } from "next/cache";
      import type { Row } from "./shape.ts";
      export const wrapped = unstable_cache(async (): Promise<Row> => ({ id: "x", n: 1 }), ["k"], { revalidate: 60 });`;
    expect(returnOf({ "a.ts": src }, "a.ts", "wrapped")).toEqual({ id: "flawless-id", n: 1 });
  });

  test("an UNKNOWN wrapper still bails — it may not preserve the signature", () => {
    // The reason the original skip existed, and it is a real reason:
    // withPagination(async (): Promise<Row[]> => …) may well return
    // Promise<Page<Row>>, and unwrapping hands the emitter a shape the function
    // never produces. A closed table, not "any call with one function argument".
    const src = `
      import { withPagination } from "./wrap.ts";
      import type { Row } from "./shape.ts";
      export const wrapped = withPagination(async (): Promise<Row> => ({ id: "x", n: 1 }));`;
    expect(
      returnOf(
        { "a.ts": src, "wrap.ts": "export const withPagination = (f: unknown) => f;\n" },
        "a.ts",
        "wrapped",
      ),
    ).toBeUndefined();
  });

  test("a wrapper given TWO callbacks bails rather than pick one", () => {
    const src = `
      import { cache } from "react";
      import type { Row } from "./shape.ts";
      export const wrapped = cache(async (): Promise<Row> => ({ id: "x", n: 1 }), () => 1);`;
    expect(returnOf({ "a.ts": src }, "a.ts", "wrapped")).toBeUndefined();
  });

  test("a type reached through `export type { X }` resolves", () => {
    // ESM treats an imported binding re-exported by name as an export of THIS
    // module. The chase looked only for a local declaration, found none, and
    // stopped — so every export of the dogfood app's dal.ts resolved to nothing.
    const src = `
      import type { Row } from "./reexport.ts";
      export const viaReexport = async (): Promise<Row> => ({ id: "x", n: 1 });`;
    expect(returnOf({ "a.ts": src }, "a.ts", "viaReexport")).toEqual({ id: "flawless-id", n: 1 });
  });

  test("the re-export chase is rename-aware", () => {
    const files = {
      "ren.ts":
        'import type { Row as Inner } from "./shape.ts";\nexport type { Inner as Outer };\n',
      "a.ts":
        'import type { Outer } from "./ren.ts";\nexport const f = async (): Promise<Outer> => ({ id: "x", n: 1 });\n',
    };
    expect(returnOf(files, "a.ts", "f")).toEqual({ id: "flawless-id", n: 1 });
  });

  test("both defects at once — the shape the dogfood app actually has", () => {
    const src = `
      import { cache } from "react";
      import type { Row } from "./reexport.ts";
      export const getCurrentThing = cache(async (): Promise<Row> => ({ id: "x", n: 1 }));`;
    expect(returnOf({ "a.ts": src }, "a.ts", "getCurrentThing")).toEqual({
      id: "flawless-id",
      n: 1,
    });
  });

  test("a re-export naming something that is nowhere still bails", () => {
    const files = {
      "ghost.ts": "export type { Nowhere };\n",
      "a.ts":
        'import type { Nowhere } from "./ghost.ts";\nexport const f = async (): Promise<Nowhere> => ({} as never);\n',
    };
    expect(returnOf(files, "a.ts", "f")).toBeUndefined();
  });
});
