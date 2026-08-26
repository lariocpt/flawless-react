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
  renderLoadSetup,
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

  test("it creates the file when nothing else has, so --tasks load can point at it", async () => {
    // `--tasks load` never runs the e2e task, so nothing else writes params.json
    // — while every piece of prose that run emits (the gate comment on each
    // pipe, load/README.md, env.sh) tells the reader to fill in ids there. The
    // pipes stayed commented out and the instructions for turning them on named
    // a file that was not on disk.
    const dir = await tmpDir();
    const file = path.join(dir, "e2e", "params.json");
    expect(await ensureParamDefaults(file, ["buildingId", "token"])).toBe(true);

    const after = await Bun.file(file).json();
    expect(after.defaults).toEqual({ buildingId: "", token: "" });
    // The shape the e2e task and the params.ts helper both expect, so a later
    // run that does include e2e merges into it rather than tripping over it.
    expect(after.routes).toEqual({});
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

  test("an unclaimed blank slot is kept, because the task that needs it runs later", async () => {
    // It used to be pruned as noise, on the reasoning that the load task re-adds
    // it if its pipes still reference it. It does — and then writeParams deletes
    // it again on the next run, forever. See the two-writer test below.
    const file = await paramsFileWith({
      defaults: { id: "seeded-id", staleParam: "" },
      routes: {},
    });
    await writeParams(file, [page("/dashboard/buildings/[id]", ["id"])]);

    const after = await Bun.file(file).json();
    expect(Object.keys(after.defaults)).toEqual(["id", "staleParam"]);
  });

  test("--force prunes the blank slot, and never a filled one", async () => {
    const file = await paramsFileWith({
      defaults: { id: "seeded-id", staleParam: "", staleButFilled: "typed-by-hand" },
      routes: {},
    });
    await writeParams(file, [page("/dashboard/buildings/[id]", ["id"])], true);

    const after = await Bun.file(file).json();
    // No page claims staleButFilled either — but somebody typed it against a
    // seeded database, and nothing in this tool can recover that.
    expect(Object.keys(after.defaults)).toEqual(["id", "staleButFilled"]);
  });

  test("a route this run never looked at keeps the ids you filled for it", async () => {
    // The destructive one: `routes` was rebuilt from the pages in THIS run, so
    // pointing flawless at a single page deleted the ids filled for every other
    // one. Not a blank slot — a value typed against a seeded database.
    const file = await paramsFileWith({
      defaults: { id: "seeded-id" },
      routes: { "/gone/[id]": { id: "x" }, "/dashboard/buildings/[id]": { id: "y" } },
    });
    await writeParams(file, [page("/dashboard/buildings/[id]", ["id"])]);

    const after = await Bun.file(file).json();
    expect(Object.keys(after.routes)).toEqual(["/dashboard/buildings/[id]", "/gone/[id]"]);
    expect(after.routes["/gone/[id]"].id).toBe("x");
  });

  test("--force drops a route row holding nothing, and keeps one holding something", async () => {
    const file = await paramsFileWith({
      defaults: {},
      routes: {
        "/blank/[id]": { id: "" },
        "/filled/[id]": { id: "x" },
        "/dashboard/buildings/[id]": { id: "y" },
      },
    });
    await writeParams(file, [page("/dashboard/buildings/[id]", ["id"])], true);

    const after = await Bun.file(file).json();
    expect(Object.keys(after.routes)).toEqual(["/dashboard/buildings/[id]", "/filled/[id]"]);
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

  test("the two writers stop fighting: a settled file is written by neither", async () => {
    // The bug in one assertion. writeParams rebuilt defaults from page params
    // plus only the FILLED existing ones, so the blank slot ensureParamDefaults
    // adds for an API-route id was deleted on every run and re-added on every
    // run — both reporting the file as written, for the life of the suite.
    // Stable bytes hid it: the file was the same at the END of each run.
    const file = await paramsFileWith({ defaults: {}, routes: {} });
    const pages = [page("/dashboard/buildings/[id]", ["id"])];
    const settle = async (): Promise<[boolean, boolean]> => [
      await writeParams(file, pages),
      await ensureParamDefaults(file, ["buildingId", "id"]),
    ];

    await settle();
    expect(await settle()).toEqual([false, false]);
    expect(Object.keys((await Bun.file(file).json()).defaults)).toEqual(["buildingId", "id"]);
  });

  test("e2e alone does not delete what only the load task knows about", async () => {
    // Same defect from the other side, and here nothing puts it back: a run
    // without the load task deleted the API-route slot outright.
    const file = await paramsFileWith({ defaults: { buildingId: "", id: "" }, routes: {} });
    await writeParams(file, [page("/dashboard/buildings/[id]", ["id"])]);
    expect(Object.keys((await Bun.file(file).json()).defaults)).toEqual(["buildingId", "id"]);
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

describe("env.sh finds params.json whatever shell sources it", () => {
  /**
   * Emit env.sh into `<root>/<outName>`, the way a real run lays it out.
   *
   * The out dir is a CHILD of the project root here rather than the root
   * itself, because every path this script emits is written relative to the
   * root — collapsing the two made the interesting part of the string empty
   * and the assertions below unable to tell "flawless" from anything else.
   */
  async function envScript(outName = "flawless"): Promise<string> {
    const { loadPipes } = await import("../src/tasks/loadPipes.ts");
    const root = await tmpDir();
    const outDir = path.join(root, outName);
    await Bun.write(
      path.join(outDir, "e2e", "params.json"),
      JSON.stringify({ defaults: { id: "seeded-1", token: "" }, routes: {} }),
    );
    await loadPipes.run({
      trees: [],
      outDir,
      variants: 3,
      heaps: "stress",
      force: true,
      report: false,
      provider: undefined,
      apiSpec: undefined,
      inlineSummary: false,
      json: false,
      changed: undefined,
      nextjs: { root, router: "app", apiRoutes: [], appResolver: undefined },
    } as never);
    return Bun.file(path.join(outDir, "load", "env.sh")).text();
  }

  test("does not rely on BASH_SOURCE alone", async () => {
    const env = await envScript();
    // The shebang does not apply to a sourced file, so under zsh BASH_SOURCE is
    // empty, dirname returned ".", and every LOAD_<PARAM> went unset — 22 of 33
    // pipes then requested URLs with empty path segments and measured the 404
    // handler while reporting the application.
    expect(env).toContain("ZSH_VERSION");
    expect(env).toMatch(/BASH_SOURCE(:-)?/);
  });

  test("keeps the zsh-only expansion behind eval, so bash never parses it", async () => {
    const env = await envScript();
    const zshLine = env.split("\n").find((l) => l.includes("%x")) ?? "";
    expect(zshLine).toContain("eval");
  });

  test("falls back to the directory the pipes' own paths assume", async () => {
    const env = await envScript();
    expect(env).toContain("$PWD/flawless/e2e/params.json");
  });

  test("--out names the real out dir, not the literal flawless", async () => {
    // The fallback exists for the one case where self-location fails, so
    // hardcoding "flawless" broke it in exactly that case: under --out qa it
    // resolved to a directory the run never created and silently exported
    // nothing, which is the LOAD_<PARAM>-unset failure wearing a new hat.
    const env = await envScript("qa");
    expect(env).toContain("$PWD/qa/e2e/params.json");
    expect(env).not.toContain("flawless/e2e/params.json");
    // The header tells you what to source; naming a path that does not exist
    // is the same defect one line higher up.
    expect(env).toContain("# source qa/load/env.sh");
  });
});

// ---------------------------------------------------------------------------
// The load setup module
// ---------------------------------------------------------------------------

/**
 * An expired LOAD_AUTH is the silent failure of this plane. crust follows
 * redirects, so a dead session turns every route into a login page answering
 * 200: `expect 200` passes, `stats` reports healthy percentiles, and the file
 * goes green having measured a login form. Reproduced on the dogfood app —
 * 20/20 status 200, p50 19.7ms, exit 0, every request served /login.
 *
 * No assertion inside a load pipe can see it: in load mode crust's record is
 * {status, ms, url} and that url is the REQUESTED one, byte-identical whether
 * the session is live or dead.
 */
describe("the load setup module", () => {
  const targets: LoadTarget[] = [
    { name: "dashboard-buildings-id", urlPath: "/dashboard/buildings/$LOAD_ID", params: ["id"] },
    { name: "dashboard", urlPath: "/dashboard", params: [] },
    { name: "forgot-password", urlPath: "/forgot-password", params: [] },
    { name: "index", urlPath: "/", params: [] },
  ];

  test("probes every static route, and no dynamic one", () => {
    const src = renderLoadSetup(targets, "flawless");
    const routes = JSON.parse(
      /const ROUTES: string\[\] = ([\s\S]*?);\n/.exec(src)?.[1] as string,
    ) as string[];
    expect(routes).toContain("/dashboard");
    // An earlier cut probed ONE static route and drew /forgot-password on the
    // dogfood app — a public page a dead cookie does not redirect, i.e. a check
    // that cannot fail. Every static route is probed precisely so the authed
    // ones are always among them.
    expect(routes).toContain("/forgot-password");
    // An unfilled id must not read as an auth failure.
    expect(routes.some((r) => r.includes("$LOAD_ID"))).toBe(false);
    // "/" redirects by design in most apps, before the user can record where to.
    expect(routes).not.toContain("/");
  });

  test("asserts where the response landed, not merely its status", () => {
    const src = renderLoadSetup(targets, "flawless");
    expect(src).toContain("new URL(res.url).pathname");
    expect(src).toContain("landed.startsWith(want)");
    // Reuses the e2e landing map rather than opening a second place to record
    // a by-design redirect.
    expect(src).toContain("flawless/e2e/params.json");
  });

  test("refuses to run at all without the env it needs", () => {
    const src = renderLoadSetup(targets, "flawless");
    expect(src).toContain("LOAD_BASE and LOAD_AUTH are required");
    expect(src).toContain("must be a header line");
  });

  test("honours a non-default --out in every path it emits", () => {
    const src = renderLoadSetup(targets, "qa");
    expect(src).toContain("qa/e2e/params.json");
    expect(src).toContain("qa/load/.env.load");
    expect(src).not.toContain("flawless/");
  });

  // env.sh, which this replaces, has two documented incidents in its own
  // comments where it exported NOTHING silently — the pipes then requested URLs
  // with empty path segments and measured the 404 handler while reporting the
  // application. Seeding here instead is the design the first real user of this
  // plane arrived at by hand, for exactly that reason.
  test("seeds LOAD_<PARAM> ids from params.json, and says so when there are none", () => {
    const src = renderLoadSetup(targets, "flawless");
    // Split so this assertion is not itself a template-literal-in-a-string:
    // the emitted line is process.env[`LOAD_${k.toUpperCase()}`] = v.
    expect(src).toContain("process.env[`LOAD_");
    expect(src).toContain("k.toUpperCase()");
    // defaults first, per-route overrides after, blanks never clobbering.
    expect(src).toContain("...(params.defaults ?? {})");
    expect(src).toContain('if (v !== "") merged[k] = v;');
    expect(src).toContain("measure the 404 handler");
  });

  test("the emitted module is valid TypeScript that exports a default", async () => {
    // Emitted code is a program, not text: it has to parse and expose the shape
    // test-pipes will await.
    const dir = await mkdtemp(path.join(tmpdir(), "flawless-setup-"));
    const file = path.join(dir, "routes.setup.ts");
    await Bun.write(file, renderLoadSetup(targets, "flawless"));
    const mod = (await import(file)) as { default: unknown };
    expect(typeof mod.default).toBe("function");
  });

  test("routes.pipes no longer carries guard lines of its own", () => {
    // They were the first design and were replaced: N failures among the
    // results is worse than one before any measurement starts.
    const text = renderPipes(targets, "/proj/flawless", "/proj", new Set(["ID"]));
    expect(text).not.toMatch(/^GET /m);
  });
});

describe("the setup module reaches disk", () => {
  /** Drive the real task into a temp project, the way a run lays it out. */
  async function runLoad(root: string, outName = "flawless"): Promise<string> {
    const { loadPipes } = await import("../src/tasks/loadPipes.ts");
    const outDir = path.join(root, outName);
    await Bun.write(
      path.join(outDir, "e2e", "params.json"),
      JSON.stringify({ defaults: { id: "seeded-1" }, routes: {} }),
    );
    await loadPipes.run({
      trees: [],
      outDir,
      variants: 3,
      heaps: "stress",
      force: true,
      report: false,
      provider: undefined,
      apiSpec: undefined,
      inlineSummary: false,
      json: false,
      changed: undefined,
      nextjs: { root, router: "app", apiRoutes: [], appResolver: undefined },
    } as never);
    return path.join(outDir, "load", "routes.setup.ts");
  }

  test("a run writes it when it is absent", async () => {
    const setup = await runLoad(await tmpDir());
    expect(await Bun.file(setup).exists()).toBe(true);
    expect(await Bun.file(setup).text()).toContain("LOAD_BASE and LOAD_AUTH are required");
  });

  // Write-once is the whole reason this can be emitted at all. The first app to
  // hit the underlying bug had already written its own module BY HAND, with a
  // sharper check than this one (an authenticated /api/me answering 401). A
  // regeneration that overwrote it would replace a real guard with a weaker one
  // — the "escape hatch a --force deletes" failure, again.
  test("--force does not overwrite one you wrote", async () => {
    const root = await tmpDir();
    await runLoad(root);
    const setup = path.join(root, "flawless", "load", "routes.setup.ts");
    await Bun.write(setup, "// mine\nexport default async () => {};\n");
    await runLoad(root);
    expect(await Bun.file(setup).text()).toBe("// mine\nexport default async () => {};\n");
  });
});
