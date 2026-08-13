import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractDataDeps } from "../src/analyse/extractDataDeps.ts";
import { parseFile } from "../src/analyse/parseFile.ts";
import { mockLiteral } from "../src/scaffold-tests/mockValues.ts";
import type { DataDepInfo, MockShape } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures/rsc");

async function loadDeps(fixture: string): Promise<DataDepInfo[]> {
  const parsed = await parseFile(path.join(FIXTURES, fixture));
  const unit = parsed.components[0];
  if (!unit) throw new Error(`${fixture} did not parse into a component`);
  return extractDataDeps(unit.bodyNode, parsed.sourceFile, parsed.imports);
}

function byVar(deps: DataDepInfo[], varName: string): DataDepInfo {
  const found = deps.find((d) => d.varName === varName);
  if (!found) throw new Error(`no data dep for ${varName}`);
  return found;
}

describe("extractDataDeps", () => {
  test("array shape with element fields from the map callback", async () => {
    const deps = await loadDeps("InsightsPage.tsx");
    expect(deps.map((d) => d.callee)).toEqual(["params", "listRecentInsights"]);

    const items = byVar(deps, "items");
    expect(items.calleeRoot).toBe("listRecentInsights");
    expect(items.specifier).toBe("./data-helpers.ts");
    expect(items.awaited).toBe(true);
    expect(items.uncertain).toBe(false);
    expect(items.pos.file.endsWith("InsightsPage.tsx")).toBe(true);
    expect(items.shape).toEqual({
      kind: "array",
      element: {
        kind: "object",
        fields: [
          { name: "id", shape: { kind: "string" }, rendersAsText: false },
          { name: "title", shape: { kind: "string" }, rendersAsText: true },
          { name: "body", shape: { kind: "string" }, rendersAsText: true },
        ],
      },
    });
  });

  test("destructured await records the binding names, not a variable", async () => {
    const deps = await loadDeps("InsightsPage.tsx");
    const params = deps.find((d) => d.callee === "params");
    expect(params?.varName).toBeUndefined();
    expect(params?.awaited).toBe(true);
    // `params` is a prop, so nothing was imported under that name.
    expect(params?.specifier).toBeUndefined();
    expect(params?.shape).toEqual({
      kind: "object",
      fields: [{ name: "id", shape: { kind: "unknown" }, rendersAsText: false }],
    });
  });

  test("member access beside a falsy guard yields object fields", async () => {
    const deps = await loadDeps("BuildingPage.tsx");
    const building = byVar(deps, "building");
    expect(building.callee).toBe("getBuildingById");
    expect(building.specifier).toBe("./data-helpers.ts");
    expect(building.uncertain).toBe(false);
    expect(building.shape).toEqual({
      kind: "object",
      fields: [
        { name: "name", shape: { kind: "string" }, rendersAsText: true },
        { name: "floors", shape: { kind: "string" }, rendersAsText: true },
      ],
    });
  });

  test("contradictory array + object evidence settles on object and flags it", async () => {
    const deps = await loadDeps("EnvelopePage.tsx");
    const insights = byVar(deps, "insights");
    expect(insights.shape.kind).toBe("object");
    expect(insights.uncertain).toBe(true);
    // `.length` proved nothing about the payload's own keys, so it is not one.
    const shape = insights.shape as Extract<MockShape, { kind: "object" }>;
    expect(shape.fields.map((f) => f.name)).toEqual(["total"]);
  });

  test("bare local call is unknown; Promise.all is not a dependency", async () => {
    const deps = await loadDeps("MembersPage.tsx");
    expect(deps.map((d) => d.varName)).toEqual([undefined, "db", "memberIds"]);

    const db = byVar(deps, "db");
    expect(db.awaited).toBe(false);
    expect(db.callee).toBe("getDb");
    expect(db.specifier).toBe("./data-helpers.ts");
    expect(db.shape).toEqual({ kind: "unknown" });
    expect(db.uncertain).toBe(true);

    expect(byVar(deps, "memberIds").shape).toEqual({ kind: "array" });
  });
});

describe("mockLiteral", () => {
  test("emits a one-element array for an inferred list", async () => {
    const deps = await loadDeps("InsightsPage.tsx");
    expect(mockLiteral(byVar(deps, "items").shape, "items")).toBe(
      '[{ id: "flawless-id", title: "flawless-title", body: "flawless-body" }]',
    );
  });

  test("unknown is {} and never undefined", () => {
    expect(mockLiteral({ kind: "unknown" }, "db")).toBe("{}");
    expect(mockLiteral({ kind: "truthy-object" }, "session")).toBe("{}");
    expect(mockLiteral({ kind: "array" }, "rows")).toBe("[]");
    expect(mockLiteral({ kind: "string" }, "title")).toBe('"flawless-title"');
    expect(
      mockLiteral(
        {
          kind: "object",
          fields: [
            { name: "createdAt", shape: { kind: "date-string" }, rendersAsText: true },
            { name: "floors", shape: { kind: "number" }, rendersAsText: false },
            { name: "notes", shape: { kind: "unknown" }, rendersAsText: false },
          ],
        },
        "building",
      ),
    ).toBe('{ createdAt: "2024-01-01T00:00:00.000Z", floors: 1, notes: "flawless-notes" }');
  });
});
