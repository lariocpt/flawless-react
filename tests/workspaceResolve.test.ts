import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { ModuleResolver } from "../src/analyse/resolveModule.ts";
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

const SHARED_TYPES = `export interface CardProps {
  title: string;
  count: number;
}

export interface Meta {
  kind: "a" | "b";
}

export interface Thing {
  id: number;
  label: string | null;
  meta: Meta;
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

  test("a package whose src probe misses stays undefined — dist is never followed", () => {
    const { root, importer } = monorepo({ workspaces: BOTH });
    write(
      root,
      "packages/built/package.json",
      JSON.stringify({ name: "@scope/built", main: "./dist/index.js", types: "./dist/index.d.ts" }),
    );
    write(root, "packages/built/dist/index.js", "module.exports = {};\n");
    write(root, "packages/built/dist/index.d.ts", "export declare const x: number;\n");
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/built", importer)).toBeUndefined();
  });

  test("a package outside the workspaces globs does not resolve", () => {
    const { importer } = monorepo({ workspaces: ["apps/*"] });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBeUndefined();
  });

  test("fancy globs (** and negations) are skipped, not guessed", () => {
    const { importer } = monorepo({ workspaces: ["packages/**", "!packages/shared"] });
    const resolver = new ModuleResolver();
    expect(resolver.resolve("@scope/shared", importer)).toBeUndefined();
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
