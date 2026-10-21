import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { declaresComponentName } from "../src/analyse/parseFile.ts";
import { followHandoff, reexportTableOf } from "../src/analyse/reexportTable.ts";
import { ModuleResolver } from "../src/analyse/resolveModule.ts";
import { SourceFileCache } from "../src/analyse/sourceCache.ts";

const tableOf = (source: string) =>
  reexportTableOf(ts.createSourceFile("barrel.ts", source, ts.ScriptTarget.Latest, true));

describe("reexportTableOf", () => {
  test("the bare star is read as a hand-off of every name", () => {
    // Measured shape: this parser gives `export * from './m'` no exportClause
    // at all, which is the only signal that distinguishes it from the named
    // and namespace forms below.
    const t = tableOf("export * from './model';\nexport * from './ui';");
    expect(t.stars).toEqual(["./model", "./ui"]);
    expect([...t.named.keys()]).toEqual([]);
  });

  test("a named hand-off keeps the module's own name", () => {
    const t = tableOf("export { useA, useB as useC } from './queries';");
    expect(t.stars).toEqual([]);
    expect(t.named.get("useA")).toEqual([{ specifier: "./queries", imported: "useA" }]);
    // `useB as useC`: the importer knows useC, the far end answers for useB.
    expect(t.named.get("useC")).toEqual([{ specifier: "./queries", imported: "useB" }]);
  });

  test("a namespace re-export hands the namespace, not the member", () => {
    const t = tableOf("export * as ns from './ns';");
    expect(t.stars).toEqual([]);
    expect(t.named.size).toBe(0);
  });

  test("a type-only hand-off is erased at runtime", () => {
    const t = tableOf("export type { Settings } from './types';");
    expect(t.stars).toEqual([]);
    expect(t.named.size).toBe(0);
  });

  test("exporting a local name is not a hand-off", () => {
    const t = tableOf("export function useLocal() { return 1; }\nexport { useLocal };");
    expect(t.stars).toEqual([]);
    expect(t.named.size).toBe(0);
  });

  test("a file with no hand-offs has an empty table", () => {
    const t = tableOf("export const value = 1;\nexport default function C() { return null; }");
    expect(t.stars).toEqual([]);
    expect(t.named.size).toBe(0);
  });
});

describe("followHandoff", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // Real files and the real resolver: which hand-off answers is a question about
  // what is on disk, and './model' meaning model/index.ts is part of it.
  function tree(files: Record<string, string>) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-handoff-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    const cache = new SourceFileCache();
    const resolver = new ModuleResolver();
    return {
      dir,
      reader: {
        read: (file: string) => cache.get(file),
        resolve: (specifier: string, from: string) => resolver.resolve(specifier, from),
        declares: (file: string, name: string) => declaresComponentName(file, name, cache),
      },
    };
  }

  const SLICE = {
    "model/queries.tsx": "export function CreateApiKeyModal() { return null; }",
    // Named hand-off plus a star into a module that is not on disk.
    "model/index.ts":
      "export * from './interfaces';\nexport { CreateApiKeyModal } from './queries';",
    // A dead star FIRST: a hop that ends the search on the first star would
    // lose the sibling that actually holds the name.
    "index.ts": "export * from './ui';\nexport * from './model';",
  };

  test("the star fan-out and the named hop together find the declaring file", async () => {
    const { dir, reader } = tree(SLICE);
    const held = await followHandoff(path.join(dir, "index.ts"), "CreateApiKeyModal", reader);
    expect(held?.file).toBe(path.join(dir, "model/queries.tsx"));
    expect(held?.name).toBe("CreateApiKeyModal");
  });

  test("a named hand-off's alias resolves to the module's own name", async () => {
    const { dir, reader } = tree({
      ...SLICE,
      "model/index.ts": "export { CreateApiKeyModal as Modal } from './queries';",
    });
    const held = await followHandoff(path.join(dir, "index.ts"), "Modal", reader);
    expect(held?.file).toBe(path.join(dir, "model/queries.tsx"));
    expect(held?.name).toBe("CreateApiKeyModal");
  });

  test("the exact named hop outranks a star that also answers", async () => {
    const { dir, reader } = tree({
      "named.tsx": "export function Modal() { return null; }",
      "other.tsx": "export function Modal() { return null; }",
      "index.ts": "export * from './other';\nexport { Modal } from './named';",
    });
    const held = await followHandoff(path.join(dir, "index.ts"), "Modal", reader);
    expect(held?.file).toBe(path.join(dir, "named.tsx"));
  });

  test("a name no module declares is no answer", async () => {
    const { dir, reader } = tree(SLICE);
    expect(await followHandoff(path.join(dir, "index.ts"), "Absent", reader)).toBeUndefined();
  });

  test("a barrel cycle terminates", async () => {
    const { dir, reader } = tree({
      "a.ts": "export * from './b';",
      "b.ts": "export * from './a';",
    });
    expect(await followHandoff(path.join(dir, "a.ts"), "Modal", reader)).toBeUndefined();
  });
});
