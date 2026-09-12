// The Expo load engine — B-16 wave 7, API-only pipes.
//
// Two things are new to this wave and everything else is the Next flavour's
// machinery reused: the HARVEST (screen → api function → apiFetch, one hop
// through the app's own fetch wrapper, because a React Native screen never has
// a bare fetch()), and the AUTH PROBE (a 401 from the API, not a redirect to a
// login page). Both are pinned here; the shared pipe/param/merge machinery is
// already covered by tests/loadPipes.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { runCore } from "../src/core.ts";
import { collectExpoTargets } from "../src/tasks/loadExpo.ts";
import type { ComponentTree } from "../src/types.ts";

const REPO_ROOT = path.resolve(__dirname, "..");
const EXPOAPP = path.join(REPO_ROOT, "tests", "fixtures", "expoapp");

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});
function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `flawless-${prefix}-`));
  created.push(dir);
  return dir;
}

async function tree(entry: string): Promise<ComponentTree> {
  return analyse({ entry, depth: 3, includeChildren: true, roots: "exported" });
}

describe("the one-hop api-endpoint harvest", () => {
  test("resolves screen → api function → apiFetch to a GET endpoint", async () => {
    // (tabs)/index.tsx calls listItems(), which is `apiFetch("/api/items")`.
    const t = await tree(path.join(EXPOAPP, "app", "(tabs)", "index.tsx"));
    const eps = (t.entry.apiCalls ?? []).concat(t.children.flatMap((c) => c.entry.apiCalls ?? []));
    const items = eps.find((e) => e.urlTemplate === "/api/items");
    expect(items).toBeDefined();
    expect(items?.method).toBe("GET");
    expect(items?.holes).toEqual([]);
  });

  test("a bare fetch() in the screen is NOT what this reads — apiCalls is the wrapper hop", async () => {
    // login.tsx calls login(), a POST wrapper — harvested (as a mutation), so
    // the field is populated, proving the hop fired rather than being empty.
    const t = await tree(path.join(EXPOAPP, "app", "login.tsx"));
    const eps = t.entry.apiCalls ?? [];
    const login = eps.find((e) => e.urlTemplate === "/api/auth/login");
    expect(login?.method).toBe("POST");
  });

  test("web files never carry apiCalls — the harvest is native-only", async () => {
    // A DOM fixture with a real fetch(): its fetchCalls fill, its apiCalls stay
    // empty, so the web load path is byte-identical to before this wave.
    const domFixture = path.join(REPO_ROOT, "tests", "fixtures");
    // The offender fixture is dom-dialect; any dom tree will do — assert the
    // field is absent rather than asserting a specific fetch.
    const t = await analyse({
      entry: path.join(domFixture, "A11yOffender.tsx"),
      depth: 0,
      includeChildren: false,
    });
    expect(t.entry.apiCalls).toBeUndefined();
  });
});

describe("collectExpoTargets", () => {
  test("GET only, dynamic segments become $LOAD_ vars, sorted and deduped", () => {
    const trees: ComponentTree[] = [
      treeWith([
        { urlTemplate: "/api/buildings/:id", holes: ["id"], method: "GET" },
        { urlTemplate: "/api/buildings", holes: [], method: "GET" },
        // a mutation — must be dropped
        { urlTemplate: "/api/buildings", holes: [], method: "POST" },
        // a duplicate GET from another screen — deduped
        { urlTemplate: "/api/buildings", holes: [], method: "GET" },
      ]),
    ];
    const targets = collectExpoTargets(trees);
    expect(targets.map((t) => t.urlPath)).toEqual(["/api/buildings", "/api/buildings/$LOAD_ID"]);
    const dyn = targets.find((t) => t.urlPath.includes("$LOAD_ID"));
    expect(dyn?.params).toEqual(["id"]);
  });
});

describe("the expo load task", () => {
  test("emits API-only pipes, a 401 auth probe, and the shared param/env machinery", async () => {
    const app = path.join(tmp("load-expo"), "app");
    require("node:fs").cpSync(EXPOAPP, app, { recursive: true });
    const result = await runCore({
      pattern: path.join(app, "app", "**", "*.tsx"),
      expo: app,
      taskIds: ["load"],
      force: false,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    const loadDir = path.join(app, "flawless", "load");
    const pipes = readFileSync(path.join(loadDir, "routes.pipes"), "utf8");
    // The harvested GET endpoint is a live pipe; the POST is never emitted.
    expect(pipes).toContain("GET $LOAD_BASE/api/items");
    expect(pipes).not.toContain("/api/auth/login");
    // API-only: no page-route pipe (the app has no server routes).
    expect(pipes).not.toMatch(/GET \$LOAD_BASE\/ /);

    // The auth probe is the 401 variant, not the redirect check.
    const setup = readFileSync(path.join(loadDir, "routes.setup.ts"), "utf8");
    expect(setup).toContain("401");
    expect(setup).toContain("/api/items");
    expect(setup).not.toContain("landed on"); // the Next redirect-probe wording

    // Shared machinery rode along.
    expect(existsSync(path.join(loadDir, "env.sh"))).toBe(true);
    expect(existsSync(path.join(loadDir, "README.md"))).toBe(true);

    const load = result.results.find((r) => r.id === "load");
    expect(load?.summary).toContain("API endpoint(s)");
  }, 120_000);
});

function treeWith(
  apiCalls: Array<{ urlTemplate: string; holes: string[]; method: string }>,
): ComponentTree {
  return {
    entry: {
      componentName: "Screen",
      filePath: "/x/Screen.tsx",
      importSpecifier: "/x/Screen.tsx",
      propsShape: {},
      variants: [],
      hooks: [],
      unresolvedProps: [],
      apiCalls: apiCalls.map((c, i) => ({
        ...c,
        pos: { file: "/x/Screen.tsx", line: i + 1, column: 1 },
        inEffect: false,
      })),
    },
    children: [],
  };
}
