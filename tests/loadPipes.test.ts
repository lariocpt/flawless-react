import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
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

describe("heap snapshots are optional", () => {
  test("--heaps off compiles the capture out entirely", async () => {
    const { renderSuite } = await import("../src/scaffold/templates.ts");
    const trees = [
      await analyse({
        entry: path.resolve(__dirname, "fixtures", "Toolbar.tsx"),
        depth: 0,
        includeChildren: false,
      }),
    ];
    const tree = trees[0];
    if (!tree) throw new Error("fixture produced no tree");
    const files = renderSuite({
      tree,
      outDir: await tmpDir(),
      variants: 3,
      report: false,
      heaps: "off",
    });
    const heap = files.find((f) => f.relPath === "profile/_heap.ts")?.content ?? "";
    expect(heap).toContain('const HEAP_MODE: "off" | "stress" | "all" = "off"');
    // Not merely "do not persist": the capture itself is skipped, so the
    // measurement is the component's rather than the component's plus two full
    // heap walks.
    expect(heap).toContain('if (HEAP_MODE === "off") return Buffer.alloc(0);');
  });

  test("the default keeps what the suite has always kept", async () => {
    const { renderSuite } = await import("../src/scaffold/templates.ts");
    const trees = [
      await analyse({
        entry: path.resolve(__dirname, "fixtures", "Toolbar.tsx"),
        depth: 0,
        includeChildren: false,
      }),
    ];
    const tree = trees[0];
    if (!tree) throw new Error("fixture produced no tree");
    const files = renderSuite({ tree, outDir: await tmpDir(), variants: 3, report: false });
    const heap = files.find((f) => f.relPath === "profile/_heap.ts")?.content ?? "";
    expect(heap).toContain('= "stress"');
  });

  test("the flag is a closed set — a typo fails at the CLI", async () => {
    const { parseArgs } = await import("../src/cli.ts");
    expect(parseArgs(["x.tsx", "--heaps", "off"]).heaps).toBe("off");
    expect(parseArgs(["x.tsx", "--heaps=all"]).heaps).toBe("all");
    expect(parseArgs(["x.tsx"]).heaps).toBe("stress");
    expect(() => parseArgs(["x.tsx", "--heaps", "yes"])).toThrow(/--heaps must be/);
  });
});
