import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { analyse } from "../src/analyse/index.ts";
import { ModuleResolver } from "../src/analyse/resolveModule.ts";
import { findExportedDecl, SourceFileCache } from "../src/analyse/sourceCache.ts";
import { runCore } from "../src/core.ts";
import type { DataDepInfo } from "../src/types.ts";

// B-8: bare workspace specifiers (@scope/shared) resolve through the
// monorepo's workspace map to the package's SOURCE tree, and names land
// through barrel re-exports. Dogfood evidence: the entire ~42-TODO
// return-shapes remainder on mybodycorpai was types imported from
// @mybodycorp-ai/shared, a spec the resolver refused on principle.

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-workspace-"));
  tmpDirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

// Meta lives in its OWN file: resolving Thing spends one cross-file hop and
// Meta the second, so the chain works only if barrel relocation charges NO
// hop of its own — the exact budget rule a mutation probe found untested.
const SHARED_TYPES = `import type { Meta } from "./meta";

export interface CardProps {
  title: string;
  count: number;
}

export interface Thing {
  id: number;
  label: string | null;
  meta: Meta;
}
`;

const SHARED_META = `export interface Meta {
  kind: "a" | "b";
}
`;

const SHARED_API = `import type { Thing } from "./types";

export async function fetchThings(): Promise<Thing[]> {
  return [];
}
`;

// Star barrels first (the mybodycorpai shape), a rename re-export, and a
// cyclic pair LAST so every miss also proves the walk terminates.
const SHARED_BARREL = `export * from "./types";
export * from "./api";
export { fetchThings as loadThings } from "./api";
export { CardProps as PanelProps } from "./types";
export * from "./loop-a";
`;

const LOOP_A = `export * from "./loop-b";
`;
const LOOP_B = `export * from "./loop-a";
`;

interface MonorepoOpts {
  /** package.json "workspaces" value; omitted entirely when undefined. */
  workspaces?: unknown;
  pnpmYaml?: string;
  appTsconfig?: boolean;
}

function monorepo(opts: MonorepoOpts = {}): { root: string; importer: string } {
  const root = tmpRoot();
  const pkg: Record<string, unknown> = { name: "monorepo-fixture", private: true };
  if (opts.workspaces !== undefined) pkg.workspaces = opts.workspaces;
  write(root, "package.json", JSON.stringify(pkg));
  if (opts.pnpmYaml !== undefined) write(root, "pnpm-workspace.yaml", opts.pnpmYaml);
  write(root, "packages/shared/package.json", JSON.stringify({ name: "@scope/shared" }));
  write(root, "packages/shared/src/index.ts", SHARED_BARREL);
  write(root, "packages/shared/src/types.ts", SHARED_TYPES);
  write(root, "packages/shared/src/meta.ts", SHARED_META);
  write(root, "packages/shared/src/api.ts", SHARED_API);
  write(root, "packages/shared/src/loop-a.ts", LOOP_A);
  write(root, "packages/shared/src/loop-b.ts", LOOP_B);
  write(root, "packages/shared/src/sub.ts", "export const marker = 1;\n");
  if (opts.appTsconfig !== false) {
    write(
      root,
      "apps/web/tsconfig.json",
      JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }),
    );
  }
  const importer = write(root, "apps/web/src/Page.tsx", "export {};\n");
  return { root, importer };
}

const BOTH = ["apps/*", "packages/*"];

describe("ModuleResolver: workspace packages", () => {
  test("a bare workspace specifier resolves to the package's src index", () => {
    const { root, importer } = monorepo({ workspaces: BOTH });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBe(
      path.join(root, "packages/shared/src/index.ts"),
    );
  });

  test("resolves with NO tsconfig anywhere above the importer", () => {
    // The pre-B-8 resolver bailed the moment nearestConfig came back null —
    // a workspace branch reachable only after a paths/baseUrl miss would
    // silently never run for an app without its own tsconfig.
    const { root, importer } = monorepo({ workspaces: BOTH, appTsconfig: false });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBe(
      path.join(root, "packages/shared/src/index.ts"),
    );
  });

  test("a subpath resolves inside the package's src tree", () => {
    const { root, importer } = monorepo({ workspaces: BOTH });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared/sub", importer)).toBe(
      path.join(root, "packages/shared/src/sub.ts"),
    );
  });

  test("the { packages: [...] } object form of workspaces works", () => {
    const { root, importer } = monorepo({ workspaces: { packages: BOTH } });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBe(
      path.join(root, "packages/shared/src/index.ts"),
    );
  });

  test("pnpm-workspace.yaml supplies the map when package.json has none", () => {
    const { root, importer } = monorepo({
      pnpmYaml: "packages:\n  - 'packages/*'\n  - apps/*\n",
    });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBe(
      path.join(root, "packages/shared/src/index.ts"),
    );
  });

  test("a package with index.ts at its root (no src/) resolves", () => {
    const { root, importer } = monorepo({ workspaces: BOTH });
    write(root, "packages/flat/package.json", JSON.stringify({ name: "@scope/flat" }));
    write(root, "packages/flat/index.ts", "export const flat = 1;\n");
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/flat", importer)).toBe(
      path.join(root, "packages/flat/index.ts"),
    );
  });

  test("a tsconfig paths alias still wins over the workspace map", () => {
    const { root, importer } = monorepo({ workspaces: BOTH });
    const override = write(root, "apps/web/src/override.ts", "export const local = 1;\n");
    write(
      root,
      "apps/web/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          paths: { "@scope/shared": ["./src/override.ts"] },
        },
      }),
    );
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBe(override);
  });

  test("react stays undefined even with a probeable node_modules copy — never walked", () => {
    const { root, importer } = monorepo({ workspaces: BOTH });
    write(root, "node_modules/react/package.json", JSON.stringify({ name: "react" }));
    write(root, "node_modules/react/index.ts", "export const notReal = 1;\n");
    const resolver = new ModuleResolver();
    expect(resolver.resolve("react", importer)).toBeUndefined();
    expect(resolver.resolve("next/link", importer)).toBeUndefined();
  });

  test("a workspaces glob naming node_modules is refused outright", () => {
    const { root, importer } = monorepo({ workspaces: ["node_modules/*"] });
    write(root, "node_modules/react/package.json", JSON.stringify({ name: "react" }));
    write(root, "node_modules/react/index.ts", "export const notReal = 1;\n");
    const resolver = new ModuleResolver();
    expect(resolver.resolve("react", importer)).toBeUndefined();
  });

  test("a LITERAL node_modules/<pkg> glob is refused too — the no-star branch has its own guard", () => {
    const { root, importer } = monorepo({ workspaces: ["node_modules/react"] });
    write(root, "node_modules/react/package.json", JSON.stringify({ name: "react" }));
    write(root, "node_modules/react/index.ts", "export const notReal = 1;\n");
    const resolver = new ModuleResolver();
    expect(resolver.resolve("react", importer)).toBeUndefined();
  });

  test("a package whose src probe misses stays undefined — dist is never followed", () => {
    const { root, importer } = monorepo({ workspaces: BOTH });
    write(
      root,
      "packages/built/package.json",
      JSON.stringify({ name: "@scope/built", main: "./dist/index.js", types: "./dist/index.d.ts" }),
    );
    write(root, "packages/built/dist/index.js", "module.exports = {};\n");
    write(root, "packages/built/dist/index.d.ts", "export declare const x: number;\n");
    // A probeable .ts in dist pins the refusal as a DECISION, not a side
    // effect of probeModuleFile's extension-blindness (mutation-probe find).
    write(root, "packages/built/dist/index.ts", "export const x = 1;\n");
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/built", importer)).toBeUndefined();
  });

  test("a package outside the workspaces globs does not resolve", () => {
    const { importer } = monorepo({ workspaces: ["apps/*"] });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBeUndefined();
  });

  test("fancy positive globs (**) are skipped, not guessed", () => {
    const { importer } = monorepo({ workspaces: ["packages/**", "!packages/shared"] });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBeUndefined();
  });

  test("a negation glob EXCLUDES its package — ignoring it would widen the map", () => {
    // Review finding: a package excluded from workspaces (the app depends on
    // its published registry version) must not have fixtures derived from
    // local source the runtime never sees.
    const { root, importer } = monorepo({
      workspaces: ["apps/*", "packages/*", "!packages/legacy"],
    });
    write(root, "packages/legacy/package.json", JSON.stringify({ name: "@scope/legacy" }));
    write(root, "packages/legacy/src/index.ts", "export const legacy = 1;\n");
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/legacy", importer)).toBeUndefined();
    expect(resolver.resolve("@scope/shared", importer)).toBe(
      path.join(root, "packages/shared/src/index.ts"),
    );
  });

  test("an unsupported negation disables the whole root — it cannot be applied, so nothing is vouched for", () => {
    const { importer } = monorepo({ workspaces: ["packages/*", "!packages/**"] });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBeUndefined();
  });

  test("zero-indent pnpm-workspace.yaml list items parse — pnpm accepts them", () => {
    const { root, importer } = monorepo({ pnpmYaml: "packages:\n- 'packages/*'\n- apps/*\n" });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBe(
      path.join(root, "packages/shared/src/index.ts"),
    );
  });
});

// ---------------------------------------------------------------------------
// findExportedDecl semantics the review pinned: breadth must not starve the
// walk, and local export clauses map aliases to their declarations.

function interfaceFinder(
  sf: ts.SourceFile,
  name: string,
  viaReexport?: boolean,
): ts.InterfaceDeclaration | undefined {
  for (const stmt of sf.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== name) continue;
    const exported =
      ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (viaReexport && !exported) return undefined;
    return stmt;
  }
  return undefined;
}

describe("findExportedDecl", () => {
  test("a wide star barrel (40 arms) still finds a name in arm 35 — the bound is depth, not breadth", () => {
    // Review finding: counting every failed sibling probe against the cap
    // silently reinstated the TODO wall for shadcn-sized generated barrels.
    const root = tmpRoot();
    const arms: string[] = [];
    for (let i = 0; i < 40; i++) arms.push(`export * from "./m${i}";`);
    const index = write(root, "src/index.ts", `${arms.join("\n")}\n`);
    for (let i = 0; i < 40; i++) {
      write(
        root,
        `src/m${i}.ts`,
        i === 34
          ? "export interface Deep {\n  x: string;\n}\n"
          : `export const filler${i} = ${i};\n`,
      );
    }
    const hit = findExportedDecl(
      index,
      "Deep",
      new SourceFileCache(),
      new ModuleResolver(),
      interfaceFinder,
    );
    expect(hit?.file).toBe(path.join(root, "src/m34.ts"));
  });

  test("export { Real as Renamed } without a specifier maps the alias to the local declaration", () => {
    const root = tmpRoot();
    const index = write(root, "src/index.ts", `export * from "./local";\n`);
    write(root, "src/local.ts", "interface Real {\n  n: number;\n}\nexport { Real as Renamed };\n");
    const hit = findExportedDecl(
      index,
      "Renamed",
      new SourceFileCache(),
      new ModuleResolver(),
      interfaceFinder,
    );
    expect(hit?.file).toBe(path.join(root, "src/local.ts"));
    expect(hit?.decl.name.text).toBe("Real");
  });
});

// ---------------------------------------------------------------------------
// Through the analyser: props types and dep returns land through the
// workspace map AND the package's barrel.

function writeComponent(root: string, source: string): string {
  return write(root, "apps/web/src/Card.tsx", source);
}

async function analysedEntry(entry: string) {
  const tree = await analyse({ entry, depth: 0, includeChildren: false });
  return tree.entry;
}

describe("workspace types through the analyser", () => {
  test("a props interface star-re-exported by the barrel resolves", async () => {
    const { root } = monorepo({ workspaces: BOTH });
    const entry = writeComponent(
      root,
      `import type { CardProps } from "@scope/shared";

export function Card(props: CardProps) {
  return <div>{props.title}</div>;
}
`,
    );
    const info = await analysedEntry(entry);
    expect(info.propsShape).toEqual({ title: "", count: 0 });
  });

  test("a rename re-export (export { A as B } from) resolves under the exported name", async () => {
    const { root } = monorepo({ workspaces: BOTH });
    const entry = writeComponent(
      root,
      `import type { PanelProps } from "@scope/shared";

export function Card(props: PanelProps) {
  return <div>{props.title}</div>;
}
`,
    );
    const info = await analysedEntry(entry);
    expect(info.propsShape).toEqual({ title: "", count: 0 });
  });

  test("a non-exported same-named interface in an earlier star arm cannot shadow the real one", async () => {
    // Review finding: findTypeDecl has no export check, so a PRIVATE decl in
    // the first star target used to win — a wrong-shape fixture on valid TS.
    const { root } = monorepo({ workspaces: BOTH });
    write(
      root,
      "packages/shared/src/private-shape.ts",
      "interface Shape {\n  wrong: boolean;\n}\nexport const unrelated = 1;\n",
    );
    write(
      root,
      "packages/shared/src/real-shape.ts",
      "export interface Shape {\n  title: string;\n}\n",
    );
    write(
      root,
      "packages/shared/src/index.ts",
      `export * from "./private-shape";\nexport * from "./real-shape";\n${SHARED_BARREL}`,
    );
    const entry = writeComponent(
      root,
      `import type { Shape } from "@scope/shared";

export function Card(props: Shape) {
  return <div>{props.title}</div>;
}
`,
    );
    const info = await analysedEntry(entry);
    expect(info.propsShape).toEqual({ title: "" });
  });

  test("an explicit re-export clause shadows a star arm exporting the same name — ESM semantics", async () => {
    const { root } = monorepo({ workspaces: BOTH });
    write(root, "packages/shared/src/wa.ts", "export interface Widget {\n  fromA: string;\n}\n");
    write(root, "packages/shared/src/wb.ts", "export interface Widget {\n  fromB: string;\n}\n");
    write(
      root,
      "packages/shared/src/index.ts",
      `export * from "./wa";\nexport { Widget } from "./wb";\n${SHARED_BARREL}`,
    );
    const entry = writeComponent(
      root,
      `import type { Widget } from "@scope/shared";

export function Card(props: Widget) {
  return <div>{props.fromB}</div>;
}
`,
    );
    const info = await analysedEntry(entry);
    expect(info.propsShape).toEqual({ fromB: "" });
  });

  test("a name the barrel never exports stays unresolved — and the cyclic barrel terminates", async () => {
    const { root } = monorepo({ workspaces: BOTH });
    const entry = writeComponent(
      root,
      `import type { Missing } from "@scope/shared";

export function Card(props: Missing) {
  return <div />;
}
`,
    );
    const info = await analysedEntry(entry);
    expect(info.propsShape).toEqual({});
  });
});

describe("workspace dep returns through the analyser", () => {
  async function depsFor(importClause: string, callee: string): Promise<DataDepInfo | undefined> {
    const { root } = monorepo({ workspaces: BOTH });
    const entry = writeComponent(
      root,
      `import { ${importClause} } from "@scope/shared";

function opaque(x: unknown): string {
  return String(x);
}

export default async function Card() {
  const things = await ${callee}();
  return <div>{opaque(things)}</div>;
}
`,
    );
    const info = await analysedEntry(entry);
    return (info.dataDeps ?? []).find((d) => d.callee === callee);
  }

  const THING_FIXTURE = [{ id: 1, label: "flawless-label", meta: { kind: "a" } }];

  test("a star-re-exported annotated function gains inferredReturn through the barrel", async () => {
    const dep = await depsFor("fetchThings", "fetchThings");
    expect(dep?.inferredReturn).toEqual({
      provenance: "annotation",
      value: THING_FIXTURE,
    });
  });

  test("a renamed re-export resolves to the declaration behind the alias", async () => {
    const dep = await depsFor("loadThings", "loadThings");
    expect(dep?.inferredReturn).toEqual({
      provenance: "annotation",
      value: THING_FIXTURE,
    });
  });
});

// ---------------------------------------------------------------------------
// --colocate must never write into a SIBLING package: the emitted vitest
// config roots at the outDir's parent and can never run a spec there, while
// the sibling's own test glob WOULD pick it up — red CI in a package the user
// never targeted (review finding).

describe("colocate stays inside the app", () => {
  test("a workspace child's spec falls back to the outDir instead of the sibling package", async () => {
    const { root } = monorepo({ workspaces: BOTH });
    write(
      root,
      "packages/shared/src/badge.tsx",
      "export function Badge() {\n  return <span>badge</span>;\n}\n",
    );
    const entry = writeComponent(
      root,
      `import { Badge } from "@scope/shared/badge";

export default function Page() {
  return (
    <main>
      <Badge />
    </main>
  );
}
`,
    );
    const outDir = path.join(root, "apps", "web", "flawless");
    const result = await runCore({
      pattern: entry,
      outDir,
      taskIds: ["unit-browser"],
      colocate: true,
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);
    const spill = readdirSync(path.join(root, "packages/shared/src")).filter((f) =>
      f.includes(".flawless.test."),
    );
    expect(spill).toEqual([]);
    // The child's coverage still exists — where the config can reach it.
    const unitDir = path.join(outDir, "unit");
    const unitSpecs = existsSync(unitDir) ? readdirSync(unitDir) : [];
    expect(unitSpecs.some((f) => /badge/i.test(f))).toBe(true);
    // The app's own component still colocates beside its source.
    expect(existsSync(path.join(root, "apps/web/src/Card.flawless.test.tsx"))).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// B-9 × B-8: a zod schema DECLARED in the workspace package, re-exported
// through the star barrel, feeding a z.infer member of a shared interface.

const ZOD_SCHEMAS = `import { z } from "zod";

export const RoleSchema = z.enum(["host", "cohost", "guest"]);
export type Role = z.infer<typeof RoleSchema>;

const InternalId = z.string().uuid();
export const ParticipantSchema = z.object({
  id: InternalId,
  role: RoleSchema,
  attended: z.coerce.boolean().default(false),
});
export type ParticipantInput = z.infer<typeof ParticipantSchema>;

export const TransformedSchema = z.string().transform((s) => s.length);
export type Transformed = z.infer<typeof TransformedSchema>;
`;

const ZOD_TYPES = `import type { Role, Transformed } from "./zod-schemas";

export interface Participant {
  name: string;
  role: Role;
}

export interface Poisoned {
  name: string;
  score: Transformed;
}
`;

const ZOD_API = `import type { Participant, Poisoned } from "./zod-types";

export async function fetchParticipants(): Promise<Participant[]> {
  return [];
}

export async function fetchPoisoned(): Promise<Poisoned[]> {
  return [];
}
`;

describe("zod schemas through the workspace barrel", () => {
  async function zodDeps() {
    const { root } = monorepo({ workspaces: BOTH });
    write(root, "packages/shared/src/zod-schemas.ts", ZOD_SCHEMAS);
    write(root, "packages/shared/src/zod-types.ts", ZOD_TYPES);
    write(root, "packages/shared/src/zod-api.ts", ZOD_API);
    write(
      root,
      "packages/shared/src/index.ts",
      `export * from "./zod-schemas";\nexport * from "./zod-types";\nexport * from "./zod-api";\n${SHARED_BARREL}`,
    );
    const entry = writeComponent(
      root,
      `import { fetchParticipants, fetchPoisoned } from "@scope/shared";

function opaque(x: unknown): string {
  return String(x);
}

export default async function Card() {
  const people = await fetchParticipants();
  const poisoned = await fetchPoisoned();
  return <div>{opaque(people)}{opaque(poisoned)}</div>;
}
`,
    );
    const info = await analysedEntry(entry);
    return info.dataDeps ?? [];
  }

  test("a NON-exported same-named schema const in an earlier star arm cannot shadow the real one", async () => {
    // Mutation-probe finding: findSchemaConst's export enforcement on the
    // barrel chase was otherwise untested — deleting it made the private
    // const in the first arm win. The schema must be IMPORTED through a
    // barrel for the star chase to run: the alias file pulls RoleSchema
    // from ./inner, whose first arm hides the private decoy.
    const { root } = monorepo({ workspaces: BOTH });
    write(
      root,
      "packages/shared/src/private-schemas.ts",
      `import { z } from "zod";
const RoleSchema = z.enum(["wrong"]);
export const unrelated = 1;
`,
    );
    write(
      root,
      "packages/shared/src/real-schemas.ts",
      `import { z } from "zod";
export const RoleSchema = z.enum(["host", "guest"]);
`,
    );
    write(
      root,
      "packages/shared/src/inner.ts",
      `export * from "./private-schemas";
export * from "./real-schemas";
`,
    );
    write(
      root,
      "packages/shared/src/shadow-types.ts",
      `import { z } from "zod";
import { RoleSchema } from "./inner";

export type Role = z.infer<typeof RoleSchema>;

export interface Participant {
  name: string;
  role: Role;
}
`,
    );
    write(
      root,
      "packages/shared/src/shadow-api.ts",
      `import type { Participant } from "./shadow-types";

export async function fetchParticipants(): Promise<Participant[]> {
  return [];
}
`,
    );
    write(
      root,
      "packages/shared/src/index.ts",
      `export * from "./shadow-types";
export * from "./shadow-api";
${SHARED_BARREL}`,
    );
    const entry = writeComponent(
      root,
      `import { fetchParticipants } from "@scope/shared";

function opaque(x: unknown): string {
  return String(x);
}

export default async function Card() {
  const people = await fetchParticipants();
  return <div>{opaque(people)}</div>;
}
`,
    );
    const info = await analysedEntry(entry);
    const dep = (info.dataDeps ?? []).find((d) => d.callee === "fetchParticipants");
    expect(dep?.inferredReturn).toEqual({
      provenance: "annotation",
      value: [{ name: "flawless-name", role: "host" }],
    });
  });

  test("a private same-named const in the DIRECTLY-resolved module cannot shadow the star re-export", async () => {
    // Correctness-lens finding (depth-0): for an import-reached lookup, TS
    // binds the star re-export — a private local never blocks it. The
    // directly-resolved file must vouch only for its EXPORTS too.
    const { root } = monorepo({ workspaces: BOTH });
    write(
      root,
      "packages/shared/src/real-schemas.ts",
      `import { z } from "zod";
export const RoleSchema = z.enum(["host", "guest"]);
`,
    );
    write(
      root,
      "packages/shared/src/inner.ts",
      `import { z } from "zod";
const RoleSchema = z.enum(["internal"]);
export * from "./real-schemas";
`,
    );
    write(
      root,
      "packages/shared/src/shadow-types.ts",
      `import { z } from "zod";
import { RoleSchema } from "./inner";

export type Role = z.infer<typeof RoleSchema>;

export interface Participant {
  name: string;
  role: Role;
}
`,
    );
    write(
      root,
      "packages/shared/src/shadow-api.ts",
      `import type { Participant } from "./shadow-types";

export async function fetchParticipants(): Promise<Participant[]> {
  return [];
}
`,
    );
    write(
      root,
      "packages/shared/src/index.ts",
      `export * from "./shadow-types";
export * from "./shadow-api";
${SHARED_BARREL}`,
    );
    const entry = writeComponent(
      root,
      `import { fetchParticipants } from "@scope/shared";

function opaque(x: unknown): string {
  return String(x);
}

export default async function Card() {
  const people = await fetchParticipants();
  return <div>{opaque(people)}</div>;
}
`,
    );
    const info = await analysedEntry(entry);
    const dep = (info.dataDeps ?? []).find((d) => d.callee === "fetchParticipants");
    expect(dep?.inferredReturn).toEqual({
      provenance: "annotation",
      value: [{ name: "flawless-name", role: "host" }],
    });
  });

  test("the TYPE path has the same depth-0 rule: a private interface in the resolved module cannot shadow", async () => {
    const { root } = monorepo({ workspaces: BOTH });
    write(
      root,
      "packages/shared/src/real-shape.ts",
      "export interface Shape {\n  title: string;\n}\n",
    );
    write(
      root,
      "packages/shared/src/index.ts",
      `interface Shape {
  wrong: boolean;
}
export * from "./real-shape";
${SHARED_BARREL}`,
    );
    const entry = writeComponent(
      root,
      `import type { Shape } from "@scope/shared";

export function Card(props: Shape) {
  return <div>{props.title}</div>;
}
`,
    );
    const info = await analysedEntry(entry);
    expect(info.propsShape).toEqual({ title: "" });
  });

  test("an interface member typed by a barrel-re-exported z.enum alias enriches the dep", async () => {
    const deps = await zodDeps();
    const dep = deps.find((d) => d.callee === "fetchParticipants");
    expect(dep?.inferredReturn).toEqual({
      provenance: "annotation",
      value: [{ name: "flawless-name", role: "host" }],
    });
  });

  test("a .transform-typed member keeps the WHOLE interface bailed — bail-on-any-hole through the chain", async () => {
    const deps = await zodDeps();
    const dep = deps.find((d) => d.callee === "fetchPoisoned");
    expect(dep?.inferredReturn).toBeUndefined();
  });

  test("a z.infer alias used directly as the annotation arg resolves through the barrel", async () => {
    const { root } = monorepo({ workspaces: BOTH });
    write(root, "packages/shared/src/zod-schemas.ts", ZOD_SCHEMAS);
    write(root, "packages/shared/src/index.ts", `export * from "./zod-schemas";\n${SHARED_BARREL}`);
    write(
      root,
      "apps/web/src/lib.ts",
      `import type { ParticipantInput } from "@scope/shared";

export async function loadOne(): Promise<ParticipantInput> {
  throw new Error("never runs under analysis");
}
`,
    );
    const entry = writeComponent(
      root,
      `import { loadOne } from "./lib";

function opaque(x: unknown): string {
  return String(x);
}

export default async function Card() {
  const one = await loadOne();
  return <div>{opaque(one)}</div>;
}
`,
    );
    // The annotation lives in the app's own lib, but its alias is imported
    // from the workspace package — the z.infer chase crosses the barrel.
    const info = await analysedEntry(entry);
    const dep = (info.dataDeps ?? []).find((d) => d.callee === "loadOne");
    expect(dep?.inferredReturn?.value).toEqual({
      id: "flawless-id",
      role: "host",
      attended: false,
    });
  });
});
