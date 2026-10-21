import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { reexportTableOf } from "../src/analyse/reexportTable.ts";

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
