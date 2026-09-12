// The Expo e2e emitter — wave 6 of the Expo mode.
//
// These are the artifact contracts: what a generated suite CONTAINS and what
// survives a re-run. The behavioural half — red before auth is filled, green
// after, the landing override, the copy witness reddening — is executed in
// tests/e2eExpoExecution.test.ts against a real chromium, gated the way the
// Next.js flavour's execution proof is.
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { affectedSpecs, grepForRoutes } from "../src/changed.ts";
import { runCore } from "../src/core.ts";
import { expoGlobalSetupStubForTest, runExpoE2e } from "../src/tasks/e2eExpo.ts";
import type { ExpoContext, RunContext, TaskResult } from "../src/types.ts";

const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "expoapp");

let tmpRoot: string | undefined;
afterAll(() => {
  if (tmpRoot) {
    // rm through Bun to avoid a half-typed recursive delete ever running loose.
    require("node:fs").rmSync(tmpRoot, { recursive: true, force: true });
  }
});

async function generate(): Promise<{ app: string; run: () => Promise<number> }> {
  tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-e2e-expo-"));
  const app = path.join(tmpRoot, "app");
  cpSync(FIXTURE, app, { recursive: true });
  const run = async (): Promise<number> => {
    const result = await runCore({
      pattern: path.join(app, "app", "**", "*.tsx"),
      expo: app,
      taskIds: ["e2e"],
      force: false,
      log: false,
      inlineSummary: false,
    });
    return result.exitCode;
  };
  return { app, run };
}

describe("the emitted expo e2e suite", () => {
  test("artifacts, spec contracts, and the re-run lifecycle", async () => {
    const { app, run } = await generate();
    expect(await run()).toBe(0);
    const e2eDir = path.join(app, "flawless", "e2e");

    // ——— the route inventory: one spec per routable file, groups vanish ———
    for (const stem of ["index", "login", "signup", "hostile", "props-route", "items-id"]) {
      expect(`${stem}: ${existsSync(path.join(e2eDir, `${stem}.spec.ts`))}`).toBe(`${stem}: true`);
    }
    // _layout and +not-found are not routes and must not become specs.
    expect(existsSync(path.join(e2eDir, "not-found.spec.ts"))).toBe(false);

    // ——— the config: Metro's port, the app's own web script, the cold-bundle
    //     navigation timeout ———
    const config = readFileSync(path.join(e2eDir, "playwright.config.ts"), "utf8");
    expect(config).toContain('?? "http://localhost:8081"');
    expect(config).toContain('command: "bun run web"');
    expect(config).toContain("navigationTimeout");
    expect(config).toContain("EXPO_PUBLIC_API_URL");

    // ——— the stub: byte-pinned, because the hand-work tally fires on identity ———
    expect(readFileSync(path.join(e2eDir, "global-setup.ts"), "utf8")).toBe(
      expoGlobalSetupStubForTest(),
    );

    // ——— params: the dynamic route declared its hole, landing is present and
    //     empty (carried, never invented) ———
    const params = JSON.parse(readFileSync(path.join(e2eDir, "params.json"), "utf8")) as {
      defaults: Record<string, string>;
      routes: Record<string, Record<string, string>>;
      landing: Record<string, string>;
    };
    // Indexed directly: toHaveProperty parses "[id]" as a path expression.
    expect(params.defaults.id).toBe("");
    expect(params.routes["/items/[id]"]).toEqual({ id: "" });
    expect(params.landing).toEqual({});

    // ——— the dynamic spec: skip-until-filled, template in the describe title
    //     so --grep narrowing selects the whole file ———
    const dynamicSpec = readFileSync(path.join(e2eDir, "items-id.spec.ts"), "utf8");
    expect(dynamicSpec).toContain('test.describe("GET /items/[id]"');
    expect(dynamicSpec).toContain("routeUrl(ROUTE_TEMPLATE)");
    expect(dynamicSpec).toContain("test.skip(");

    // ——— the login spec: status teeth, landing assertion, console listener,
    //     and the copy witness — the claim that cannot be true of a wall ———
    const loginSpec = readFileSync(path.join(e2eDir, "login.spec.ts"), "utf8");
    expect(loginSpec).toContain('test.describe("GET /login"');
    expect(loginSpec).toContain('"no 5xx"');
    expect(loginSpec).toContain("assertOnRoute(page)");
    expect(loginSpec).toContain("renders its own copy");
    // The LONGEST static literal wins — most identifying, hardest to fake.
    expect(loginSpec).toContain('getByText("Create an account")');

    // ——— interactions ride the analysis: hostile.tsx's testID pressable is an
    //     onPress target the DOM ladder can address in the RNW DOM ———
    const hostileSpec = readFileSync(path.join(e2eDir, "hostile.spec.ts"), "utf8");
    expect(hostileSpec).toContain("basic interactions from analysis stay error-free");
    expect(hostileSpec).toContain("getByTestId");
    // No spec may reference the unit plane's DEFAULTS table — it does not
    // exist here, and a prop-labelled role rung would smuggle it in.
    expect(hostileSpec).not.toContain("DEFAULTS[");

    // ——— re-run lifecycle: specs and the stub are kept, mutating one is safe ———
    const marker = "// hand-hardened, do not clobber\n";
    writeFileSync(path.join(e2eDir, "login.spec.ts"), marker + loginSpec);
    expect(await run()).toBe(0);
    expect(readFileSync(path.join(e2eDir, "login.spec.ts"), "utf8").startsWith(marker)).toBe(true);

    // ——— the package merge: the runner script and its dependency exist where
    //     the suite will actually run ———
    const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.scripts?.["flawless:e2e"]).toContain("e2e/playwright.config.ts");
    expect(pkg.devDependencies?.["@playwright/test"]).toBeTruthy();
  }, 120_000);

  test("an expo app without expo-router is a named refusal, not a zero-spec pass", async () => {
    const expo: ExpoContext = {
      root: ".",
      routerRoot: undefined,
      sdkMajor: 54,
      routerMajor: undefined,
      reactCompiler: false,
      nativewind: false,
      webPort: 8081,
    };
    const ctx = {
      trees: [],
      outDir: "/tmp/never-written",
      variants: 3,
      heaps: "off",
      force: false,
      report: false,
      provider: undefined,
      apiSpec: undefined,
      inlineSummary: false,
      nextjs: undefined,
      expo,
    } as unknown as RunContext;
    const result: TaskResult = await runExpoE2e(ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("expo-router");
    expect(result.error).toContain("no URL-addressable routes");
    expect(result.outputs).toEqual([]);
  });
});

describe("--changed narrowing on expo routes", () => {
  test("a changed route file maps to its URL template, and the grep embeds it", async () => {
    const file = path.join(FIXTURE, "app", "items", "[id].tsx");
    const tree = await analyse({ entry: file, depth: 1, includeChildren: true });
    const affected = affectedSpecs([tree], [file], undefined, {
      routerRoot: path.join(FIXTURE, "app"),
    });
    expect(affected.routes).toEqual(["/items/[id]"]);
    // The emitted describe title is `GET /items/[id]` — the same template,
    // bracket-escaped in the pattern.
    expect(grepForRoutes(affected.routes)).toContain("GET");
    expect(grepForRoutes(affected.routes)).toContain("\\[id\\]");
  });
});
