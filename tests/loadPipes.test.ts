import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureParamDefaults } from "../src/tasks/e2eRoutes.ts";

const tmpDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), "flawless-load-"));

async function paramsFileWith(body: unknown): Promise<string> {
  const dir = await tmpDir();
  const file = path.join(dir, "params.json");
  await Bun.write(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

describe("params.json gains the ids other tasks need", () => {
  test("an API-route id the page routes never mention gets a slot", async () => {
    // /api/buildings/[buildingId] beside the page's /dashboard/buildings/[id]:
    // without the slot, $LOAD_BUILDINGID expanded to nothing and 500 requests
    // to a malformed URL were reported as the route failing.
    const file = await paramsFileWith({ defaults: { id: "abc" }, routes: {} });
    expect(await ensureParamDefaults(file, ["buildingId", "id"])).toBe(true);

    const after = await Bun.file(file).json();
    expect(after.defaults).toEqual({ buildingId: "", id: "abc" });
  });

  test("it never overwrites a value the user filled in", async () => {
    const file = await paramsFileWith({
      defaults: { id: "seeded-id", token: "seeded-token" },
      routes: { "/invite/[token]": { token: "per-route" } },
    });
    await ensureParamDefaults(file, ["id", "token"]);

    const after = await Bun.file(file).json();
    expect(after.defaults.id).toBe("seeded-id");
    expect(after.defaults.token).toBe("seeded-token");
    expect(after.routes["/invite/[token]"]).toEqual({ token: "per-route" });
  });

  test("nothing to add means nothing written — the idempotence gate depends on it", async () => {
    const file = await paramsFileWith({ defaults: { id: "abc" }, routes: {} });
    const before = await Bun.file(file).text();
    expect(await ensureParamDefaults(file, ["id"])).toBe(false);
    expect(await Bun.file(file).text()).toBe(before);
  });

  test("keys come out sorted, so two runs produce the same bytes", async () => {
    const file = await paramsFileWith({ defaults: { zebra: "z" }, routes: {} });
    await ensureParamDefaults(file, ["alpha", "middle"]);
    const after = await Bun.file(file).json();
    expect(Object.keys(after.defaults)).toEqual(["alpha", "middle", "zebra"]);
  });
});
