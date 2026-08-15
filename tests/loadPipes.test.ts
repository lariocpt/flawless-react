import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { ensureParamDefaults, writeParams } from "../src/tasks/e2eRoutes.ts";
import {
  collectTargets,
  type LoadTarget,
  mergePipes,
  readFilledParams,
  renderPipes,
} from "../src/tasks/loadPipes.ts";
import type { ComponentInfo, ComponentTree } from "../src/types.ts";

const tmpDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), "flawless-load-"));

/** The two paths renderPipes needs; `rel` comes out as "flawless". */
const OUT_DIR = "/app/flawless";
const NEXT_ROOT = "/app";

const target = (name: string, urlPath: string, params: string[] = []): LoadTarget => ({
  name,
  urlPath,
  params,
});

const INVITE = target("invite-token", "/invite/$LOAD_TOKEN", ["token"]);
const DASHBOARD = target("dashboard", "/dashboard");
const ASHA = target(
  "api-buildings-x-ai-conversations-x-messages",
  "/api/buildings/$LOAD_BUILDINGID/ai/conversations/$LOAD_CONVERSATIONID/messages",
  ["buildingId", "conversationId"],
);

const render = (targets: LoadTarget[], filled: string[]): string =>
  renderPipes(targets, OUT_DIR, NEXT_ROOT, new Set(filled));

const merge = (existing: string, targets: LoadTarget[], filled: string[]): string =>
  mergePipes(existing, targets, OUT_DIR, NEXT_ROOT, new Set(filled));

/** Pipe lines only — the header carries `# TODO(flawless): tune rate/duration`. */
const pipeLines = (text: string): string[] =>
  text.split("\n").filter((l) => l.startsWith("load ") || l.startsWith("# load "));

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

describe("every target gets a name of its own", () => {
  /**
   * A tree whose file is not a page route, carrying the GET fetches whose URLs
   * become API-route targets. `routerRoot` below points nowhere real, so
   * pageFileToRoute finds nothing and only the fetch path runs.
   */
  const treeFetching = (...urls: Array<[string, string[]]>): ComponentTree => ({
    entry: {
      componentName: "Widget",
      filePath: "/nowhere/Widget.tsx",
      fetchCalls: urls.map(([urlTemplate, holes]) => ({
        urlTemplate,
        holes,
        method: "GET",
        pos: { line: 1, column: 1 },
        inEffect: false,
      })),
    } as unknown as ComponentInfo,
    children: [],
  });

  const namesFor = (tree: ComponentTree): string[] =>
    collectTargets([tree], "app", "/nowhere/app").map((t) => t.name);

  test("two routes that slugify the same are told apart", () => {
    // slugify replaces every $LOAD_* with a bare `x`, so these collide. Sharing
    // a name means sharing one last-*.json — each run overwriting the other's
    // numbers — and mergePipes keys on it, so the second route would be read as
    // an update of the first and never get a pipe.
    const names = namesFor(treeFetching(["/api/a/:p/b", ["p"]], ["/api/a/:q/b", ["q"]]));
    expect(names).toEqual(["api-a-x-b", "api-a-x-b-2"]);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the first claimant keeps the plain name, so nothing on disk is renamed", () => {
    // Regenerating an existing suite must not rename its last-*.json files, or
    // every committed baseline stops matching the pipe it was captured for.
    const names = namesFor(
      treeFetching(["/api/a/:p/b", ["p"]], ["/api/a/:q/b", ["q"]], ["/api/a/:r/b", ["r"]]),
    );
    expect(names[0]).toBe("api-a-x-b");
    expect(names).toEqual(["api-a-x-b", "api-a-x-b-2", "api-a-x-b-3"]);
  });

  test("the same URL twice is still one target, not a suffixed pair", () => {
    // Deduplication is by URL and happens first: two components fetching the
    // same endpoint want one pipe, not `-2`.
    expect(namesFor(treeFetching(["/api/a/:p/b", ["p"]], ["/api/a/:p/b", ["p"]]))).toEqual([
      "api-a-x-b",
    ]);
  });

  test("distinct names are left alone", () => {
    expect(namesFor(treeFetching(["/api/one", []], ["/api/two", []]))).toEqual([
      "api-one",
      "api-two",
    ]);
  });

  test("disambiguated targets render as two pipes with two stats files", () => {
    const targets = collectTargets(
      [treeFetching(["/api/a/:p/b", ["p"]], ["/api/a/:q/b", ["q"]])],
      "app",
      "/nowhere/app",
    );
    const out = render(targets, ["P", "Q"]);
    expect(pipeLines(out)).toHaveLength(2);
    expect(out).toContain("--out flawless/load/last-api-a-x-b.json");
    expect(out).toContain("--out flawless/load/last-api-a-x-b-2.json");
  });

  test("merging keeps them separate rather than folding one into the other", () => {
    const targets = collectTargets(
      [treeFetching(["/api/a/:p/b", ["p"]], ["/api/a/:q/b", ["q"]])],
      "app",
      "/nowhere/app",
    );
    const merged = merge(render(targets, []), targets, ["P", "Q"]);
    expect(pipeLines(merged)).toHaveLength(2);
    expect(merged).not.toContain("TODO(flawless): no value");
    expect(merged).toContain("$LOAD_P");
    expect(merged).toContain("$LOAD_Q");
  });
});

describe("the e2e task does not undo the load task's ids", () => {
  const page = (urlPath: string, params: string[]) => ({ route: { urlPath, params } });

  test("an API-route id nothing on a page claims survives a rewrite", async () => {
    // The bug this guards: defaults were rebuilt from page-route params alone,
    // so `buildingId` — added by the load task for /api/buildings/[buildingId] —
    // went back to "" on the next run and re-gated the pipe it was filled for.
    // The fix looked like it had never been made.
    const file = await paramsFileWith({
      defaults: {
        buildingId: "seeded-building",
        conversationId: "seeded-thread",
        id: "seeded-id",
      },
      routes: {},
    });
    await writeParams(file, [page("/dashboard/buildings/[id]", ["id"])]);

    const after = await Bun.file(file).json();
    expect(after.defaults.buildingId).toBe("seeded-building");
    expect(after.defaults.conversationId).toBe("seeded-thread");
    expect(after.defaults.id).toBe("seeded-id");
  });

  test("an unclaimed id with no value is still pruned", async () => {
    // Kept for its value, not its name: a blank slot no route needs is noise,
    // and the load task re-adds it if its pipes still reference it.
    const file = await paramsFileWith({
      defaults: { id: "seeded-id", staleParam: "" },
      routes: {},
    });
    await writeParams(file, [page("/dashboard/buildings/[id]", ["id"])]);

    const after = await Bun.file(file).json();
    expect(Object.keys(after.defaults)).toEqual(["id"]);
  });

  test("a route key whose page is gone is still dropped", async () => {
    const file = await paramsFileWith({
      defaults: { id: "seeded-id" },
      routes: { "/gone/[id]": { id: "x" }, "/dashboard/buildings/[id]": { id: "y" } },
    });
    await writeParams(file, [page("/dashboard/buildings/[id]", ["id"])]);

    const after = await Bun.file(file).json();
    expect(Object.keys(after.routes)).toEqual(["/dashboard/buildings/[id]"]);
  });

  test("writeParams then ensureParamDefaults is stable across runs", async () => {
    const file = await paramsFileWith({
      defaults: { buildingId: "seeded-building", id: "seeded-id" },
      routes: { "/dashboard/buildings/[id]": { id: "" } },
    });
    const pages = [page("/dashboard/buildings/[id]", ["id"])];
    await writeParams(file, pages);
    await ensureParamDefaults(file, ["buildingId", "id"]);
    const first = await Bun.file(file).text();

    await writeParams(file, pages);
    await ensureParamDefaults(file, ["buildingId", "id"]);
    expect(await Bun.file(file).text()).toBe(first);
  });
});

describe("which ids count as supplied", () => {
  test("a blank string is not a value", async () => {
    const file = await paramsFileWith({ defaults: { id: "abc", token: "" }, routes: {} });
    const filled = await readFilledParams(file);
    expect(filled.has("ID")).toBe(true);
    expect(filled.has("TOKEN")).toBe(false);
  });

  test("a per-route override counts, so one filled route is enough", async () => {
    const file = await paramsFileWith({
      defaults: { token: "" },
      routes: { "/invite/[token]": { token: "seeded" } },
    });
    expect((await readFilledParams(file)).has("TOKEN")).toBe(true);
  });

  test("an unreadable params.json supplies nothing rather than throwing", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "params.json");
    await Bun.write(file, "{ not json");
    expect((await readFilledParams(file)).size).toBe(0);
  });
});

describe("a pipe whose ids are unfilled is commented out, not dropped", () => {
  test("every id supplied renders a live pipe", () => {
    const out = render([DASHBOARD], []);
    expect(pipeLines(out)).toEqual([expect.stringMatching(/^load .*GET \$LOAD_BASE\/dashboard /)]);
  });

  test("a missing id comments the pipe and names the key in the source's casing", () => {
    // Not "TOKEN": the fix is made in params.json, which is keyed as written.
    const out = render([INVITE], []);
    expect(out).toContain(
      '# TODO(flawless): no value for LOAD_TOKEN. Fill "token" in flawless/e2e/params.json',
    );
    expect(out).toContain("# load 10s 50/s | parallel 16 | GET $LOAD_BASE/invite/$LOAD_TOKEN");
    // The route stays visible, so the reader can see what is not being measured.
    expect(pipeLines(out).every((l) => l.startsWith("# "))).toBe(true);
  });

  test("filling one of two ids leaves a TODO naming only the other", () => {
    const out = render([ASHA], ["BUILDINGID"]);
    expect(out).toContain(
      '# TODO(flawless): no value for LOAD_CONVERSATIONID. Fill "conversationId" in flawless/e2e/params.json',
    );
    expect(out).not.toContain("LOAD_BUILDINGID.");
  });

  test("filling both turns it live", () => {
    const out = render([ASHA], ["BUILDINGID", "CONVERSATIONID"]);
    expect(out).not.toContain("TODO(flawless): no value for");
    expect(pipeLines(out)).toEqual([expect.stringMatching(/^load /)]);
  });
});

describe("--force merges routes.pipes rather than replacing it", () => {
  test("a hand-tuned rate survives, body untouched", () => {
    const tuned = render([DASHBOARD], []).replace("load 10s 50/s", "load 60s 5/s");
    const merged = merge(tuned, [DASHBOARD], []);
    expect(merged).toContain("load 60s 5/s");
    expect(merged).not.toContain("load 10s 50/s |");
  });

  test("a POST flow added by hand is never pruned", () => {
    const added = `${render([DASHBOARD], [])}
# my own smoke check
load 5s 1/s | POST $LOAD_BASE/api/things -H "$LOAD_AUTH" | expect 201
`;
    const merged = merge(added, [DASHBOARD], []);
    expect(merged).toContain("# my own smoke check");
    expect(merged).toContain("POST $LOAD_BASE/api/things");
  });

  test("filling the id un-gates the pipe and keeps the edits made to it", () => {
    // The whole point of the gate: fill the id, regenerate, and it turns back on.
    const gated = render([INVITE], []).replace("# load 10s 50/s", "# load 30s 20/s");
    const merged = merge(gated, [INVITE], ["TOKEN"]);
    expect(merged).not.toContain("TODO(flawless): no value for");
    expect(merged).toContain("load 30s 20/s | parallel 16 | GET $LOAD_BASE/invite/$LOAD_TOKEN");
    expect(pipeLines(merged)).toEqual([expect.stringMatching(/^load /)]);
  });

  test("blanking an id re-gates a live pipe without losing its body", () => {
    const live = render([INVITE], ["TOKEN"]).replace("load 10s 50/s", "load 45s 3/s");
    const merged = merge(live, [INVITE], []);
    expect(merged).toContain('# TODO(flawless): no value for LOAD_TOKEN. Fill "token"');
    expect(merged).toContain("# load 45s 3/s");
  });

  test("a pipe you commented out yourself is not resurrected", () => {
    const off = render([DASHBOARD], []).replace(/^load /m, "# load ");
    const merged = merge(off, [DASHBOARD], []);
    expect(pipeLines(merged)).toEqual([expect.stringMatching(/^# load /)]);
    expect(merged).not.toContain("TODO(flawless): no value for");
  });

  test("a route that appears since last time is appended", () => {
    const before = render([DASHBOARD], []);
    const merged = merge(before, [DASHBOARD, INVITE], ["TOKEN"]);
    expect(pipeLines(merged)).toHaveLength(2);
    expect(merged).toContain("/invite/$LOAD_TOKEN");
  });

  test("the header is refreshed, so an existing suite learns what a later version knows", () => {
    const stale = render([DASHBOARD], []).replace(
      "# Baseline gating: copy a good last-*.json to baseline-*.json; runs then fail",
      "# Baseline gating: something an older version said",
    );
    const merged = merge(stale, [DASHBOARD], []);
    expect(merged).toContain("# Baseline gating: copy a good last-*.json to baseline-*.json");
    expect(merged).not.toContain("something an older version said");
  });

  test("a header this tool did not write is left alone", () => {
    const mine = `# my own pipes file\n\n${render([DASHBOARD], []).split("\n\n").slice(1).join("\n\n")}`;
    const merged = merge(mine, [DASHBOARD], []);
    expect(merged.startsWith("# my own pipes file")).toBe(true);
    expect(merged).not.toContain("Env contract");
  });

  test("two merges in a row produce the same bytes", () => {
    const once = merge(render([DASHBOARD, INVITE], []), [DASHBOARD, INVITE], ["TOKEN"]);
    expect(merge(once, [DASHBOARD, INVITE], ["TOKEN"])).toBe(once);
  });

  test("merging a freshly rendered file changes nothing but the trailing newline", () => {
    const fresh = render([DASHBOARD, ASHA], ["BUILDINGID", "CONVERSATIONID"]);
    expect(merge(fresh, [DASHBOARD, ASHA], ["BUILDINGID", "CONVERSATIONID"])).toBe(fresh);
  });
});
