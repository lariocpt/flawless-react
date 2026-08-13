import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractGuards } from "../src/analyse/extractGuards.ts";
import { parseFile } from "../src/analyse/parseFile.ts";
import type { GuardInfo } from "../src/types.ts";

const NOTFOUND = path.resolve(__dirname, "fixtures/rsc/guard-notfound.tsx");
const LOCAL_NAV = path.resolve(__dirname, "fixtures/rsc/guard-local-nav.tsx");
const COMPLEX = path.resolve(__dirname, "fixtures/rsc/guard-complex.tsx");
const THROWS = path.resolve(__dirname, "fixtures/rsc/guard-throw.tsx");

async function guardsOf(fixture: string, deps: string[]): Promise<GuardInfo[]> {
  const parsed = await parseFile(fixture);
  const unit = parsed.components[0];
  if (!unit) throw new Error(`no component parsed from ${fixture}`);
  return extractGuards(unit.bodyNode, parsed.sourceFile, parsed.imports, new Set(deps));
}

describe("extractGuards", () => {
  test("if (!building) notFound() — falsy guard on a next/navigation import", async () => {
    const guards = await guardsOf(NOTFOUND, ["building", "units", "audit"]);
    const guard = guards[0];
    expect(guard?.effect).toBe("notFound");
    expect(guard?.callee).toBe("notFound");
    expect(guard?.specifier).toBe("next/navigation");
    expect(guard?.conditionKind).toBe("falsy");
    expect(guard?.conditionRaw).toBe("!building");
    expect(guard?.depVars).toEqual(["building"]);
    expect(guard?.triggerValue).toBe("undefined");
    expect(guard?.pos).toEqual({ file: NOTFOUND, line: 15, column: 3 });
  });

  test("if (!items.length) notFound() — trigger is an empty array, not undefined", async () => {
    const guards = await guardsOf(NOTFOUND, ["building", "units", "audit"]);
    const guard = guards[1];
    expect(guard?.effect).toBe("notFound");
    expect(guard?.conditionKind).toBe("falsy");
    expect(guard?.conditionRaw).toBe("!units.length");
    expect(guard?.depVars).toEqual(["units"]);
    expect(guard?.triggerValue).toBe("empty-array");
    expect(guard?.pos.line).toBe(17);
  });

  test("notFound() imported from a project module is not a guard", async () => {
    const guards = await guardsOf(LOCAL_NAV, ["building"]);
    expect(guards).toEqual([]);
  });

  test("if (!a || !b) redirect() — complex, both deps, no trigger", async () => {
    const guards = await guardsOf(COMPLEX, ["user", "workspace", "invites"]);
    const guard = guards[0];
    expect(guard?.effect).toBe("redirect");
    expect(guard?.specifier).toBe("next/navigation");
    expect(guard?.conditionKind).toBe("complex");
    expect(guard?.depVars).toEqual(["user", "workspace"]);
    expect(guard?.triggerValue).toBeUndefined();
  });

  test("a throw is a guard with no specifier", async () => {
    const guards = await guardsOf(THROWS, ["session", "report"]);
    const guard = guards[0];
    expect(guard?.effect).toBe("throw");
    expect(guard?.callee).toBe("Error");
    expect(guard?.specifier).toBeUndefined();
    expect(guard?.conditionKind).toBe("falsy");
    expect(guard?.depVars).toEqual(["session"]);
    expect(guard?.triggerValue).toBe("undefined");
  });

  test("throw of a named error class, and `return notFound()` as a guard body", async () => {
    const guards = await guardsOf(THROWS, ["session", "report"]);
    expect(guards.map((g) => g.effect)).toEqual(["throw", "throw", "notFound"]);

    const missing = guards[1];
    expect(missing?.callee).toBe("ReportMissingError");
    expect(missing?.conditionKind).toBe("comparison");
    expect(missing?.triggerValue).toBe("null");
    expect(missing?.depVars).toEqual(["report"]);

    const returned = guards[2];
    expect(returned?.callee).toBe("notFound");
    expect(returned?.specifier).toBe("next/navigation");
    expect(returned?.triggerValue).toBe("undefined");
  });

  test("a guard block doing more than exiting is skipped, as is a nested if", async () => {
    // guard-notfound's `if (!audit) { console.warn(...); redirect(...) }` and
    // guard-throw's if-inside-if must not be reported: neither exits on the
    // condition alone, so a spec built from them would assert the wrong thing.
    const pages = await guardsOf(NOTFOUND, ["building", "units", "audit"]);
    expect(pages).toHaveLength(3);
    expect(pages.some((g) => g.depVars.includes("audit"))).toBe(false);

    const reports = await guardsOf(THROWS, ["session", "report"]);
    expect(reports).toHaveLength(3);
    expect(reports.some((g) => g.conditionRaw.includes("rows.length"))).toBe(false);
  });

  test("=== against a member access is a comparison with no invented trigger", async () => {
    const guards = await guardsOf(NOTFOUND, ["building", "units", "audit"]);
    const guard = guards[2];
    expect(guard?.effect).toBe("redirect");
    expect(guard?.conditionKind).toBe("comparison");
    expect(guard?.conditionRaw).toBe('building.status === "archived"');
    expect(guard?.depVars).toEqual(["building"]);
    expect(guard?.triggerValue).toBeUndefined();
  });

  test("a trigger survives || only when every operand names the same dep and value", async () => {
    const guards = await guardsOf(COMPLEX, ["user", "workspace", "invites"]);
    const sameDep = guards[1];
    expect(sameDep?.conditionKind).toBe("complex");
    expect(sameDep?.depVars).toEqual(["invites"]);
    expect(sameDep?.triggerValue).toBe("empty-array");

    const nullCheck = guards[2];
    expect(nullCheck?.conditionKind).toBe("comparison");
    expect(nullCheck?.triggerValue).toBe("null");

    const notOwner = guards[3];
    expect(notOwner?.conditionKind).toBe("comparison");
    expect(notOwner?.triggerValue).toBeUndefined();
  });

  test("depVars are filtered to the known data deps but the guard is still recorded", async () => {
    const guards = await guardsOf(NOTFOUND, ["units"]);
    expect(guards).toHaveLength(3);
    expect(guards[0]?.depVars).toEqual([]);
    expect(guards[0]?.conditionKind).toBe("falsy");
    expect(guards[0]?.triggerValue).toBe("undefined");
    expect(guards[1]?.depVars).toEqual(["units"]);
  });
});
