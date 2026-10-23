import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { outDirRel, relativeToEmitted, underOutDir } from "../emitPaths.ts";
import { allocateRouteStems, type ExpoRoute, expoFileToRoute } from "../expo/routes.ts";
import { emitPlaywrightDispatch, emitPlaywrightSelector } from "../scaffold-tests/selectors.ts";
import type { ComponentTree, ExpoContext, RunContext, TaskResult, TodoTally } from "../types.ts";
import { paramsHelper, writeParams } from "./e2eRoutes.ts";

/**
 * Route-level Playwright e2e for an expo-router app, against `expo start --web`
 * — B-16 wave 6, the sibling of e2eRoutes.ts (one TaskId, one engine per
 * platform, the wave-3/wave-5 shape).
 *
 * The design leans on facts measured against the real stack on 2026-09-12
 * (docs/archive/2026-09-expo-probes.md):
 *
 *   - Metro under SDK 54's `web.output: "static"` serves PER-ROUTE rendered
 *     HTML with real status semantics — an unknown path answers 404, a dynamic
 *     deep link 200 — so the status assertion keeps its teeth on a dev server.
 *   - On web the app authenticates with a COOKIE against the API origin
 *     (`credentials: "include"`), so Playwright's storageState is mechanically
 *     the right vehicle; there is no localStorage token to inject.
 *   - A dead session has two faces, and the specs catch both: a route that
 *     client-redirects to the login screen fails the landing assertion, and a
 *     wall rendered IN PLACE at the same URL fails the console assertion (the
 *     API's 401s land there) and the copy assertion (the screen's own text
 *     never renders).
 *
 * What the specs deliberately do NOT assert: anything about styling (NativeWind
 * runs under Metro here, but the DOM is react-native-web's atomic classes), and
 * server 3xx redirects, which a SPA dev server does not produce.
 */

export async function runExpoE2e(ctx: RunContext): Promise<TaskResult> {
  const expo = ctx.expo as ExpoContext;
  if (expo.routerRoot === undefined) {
    return {
      id: "e2e",
      ok: false,
      outputs: [],
      findings: [],
      summary: "e2e under --expo needs expo-router — no router, no routes to test",
      error:
        "expo-router is not a dependency of this app, so there are no URL-addressable " +
        "routes for a Playwright spec to visit. The e2e task tests routes; an Expo app " +
        "without expo-router has none.",
    };
  }

  const routed: Array<{ tree: ComponentTree; route: ExpoRoute }> = [];
  for (const tree of ctx.trees) {
    const route = expoFileToRoute(tree.entry.filePath, expo.routerRoot);
    if (route) routed.push({ tree, route });
  }
  // Stems allocated over the FULL list: `(a)/x` and `(b)/x` are different
  // routes that both stem to "x" because groups vanish — a per-route stem
  // would silently overwrite one spec with the other.
  const stems = allocateRouteStems(routed.map((r) => r.route));

  const e2eDir = path.join(ctx.outDir, "e2e");
  await mkdir(e2eDir, { recursive: true });
  const written: string[] = [];
  const skipped: string[] = [];

  const webCommand = await readWebScript(expo.root);

  const configPath = path.join(e2eDir, "playwright.config.ts");
  await Bun.write(
    configPath,
    expoE2eConfig(relativeToEmitted(e2eDir, expo.root), expo.webPort, webCommand),
  );
  written.push(configPath);

  const setupPath = path.join(e2eDir, "global-setup.ts");
  if (!existsSync(setupPath)) {
    await Bun.write(setupPath, expoGlobalSetupStub());
    written.push(setupPath);
  }
  // B-12's visibility half, unchanged from the web task: byte-identity against
  // the stub, so the REPORT says the auth hook is a stub until a human edits it.
  const authUnfilled = readFileSync(setupPath, "utf8") === expoGlobalSetupStub();

  const paramsJsonPath = path.join(e2eDir, "params.json");
  const wroteParams = await writeParams(paramsJsonPath, routed, ctx.force);
  if (wroteParams) written.push(paramsJsonPath);

  const paramsHelperPath = path.join(e2eDir, "params.ts");
  await Bun.write(paramsHelperPath, paramsHelper());
  written.push(paramsHelperPath);

  const readmePath = path.join(e2eDir, "README.md");
  if (!existsSync(readmePath) || ctx.force) {
    await Bun.write(readmePath, expoE2eReadme(expo.webPort));
    written.push(readmePath);
  }

  const rel = outDirRel(ctx.outDir, expo.root);
  for (const { tree, route } of routed) {
    const stem = stems.get(route) as string;
    const specPath = path.join(e2eDir, `${stem}.spec.ts`);
    if (existsSync(specPath) && !ctx.force) {
      skipped.push(specPath);
      continue;
    }
    await Bun.write(specPath, expoRouteSpec(tree, route, rel));
    written.push(specPath);
  }

  const skippedNote =
    skipped.length > 0 ? `; kept ${skipped.length} existing spec(s) (--force to regenerate)` : "";
  const handWork: TodoTally[] =
    authUnfilled && routed.length > 0
      ? [{ kind: "e2e-auth-unfilled", count: 1, exemplar: setupPath }]
      : [];
  return {
    id: "e2e",
    ok: true,
    outputs: written,
    findings: [],
    handWork,
    summary:
      routed.length === 0
        ? "no analysed entry is an expo-router route — config emitted, no specs"
        : `e2e specs for ${routed.length} route(s): ${routed.map((r) => r.route.urlPath).join(", ")}${skippedNote}`,
  };
}

async function readWebScript(expoRoot: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(expoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    // The app's own spelling when it has one, so env plumbing the script does
    // (dotenv wrappers, EXPO_PUBLIC_* exports) rides along.
    if (pkg.scripts?.web) return "bun run web";
  } catch {
    // fall through to the direct invocation
  }
  return "bunx expo start --web";
}

function expoE2eConfig(toExpoRoot: string, port: number, webCommand: string): string {
  return `import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Runs against \`expo start --web\` (Metro, port ${port}). Two servers matter and
// this config boots only ONE of them:
//
//   - Metro serves the UI. Booted below unless FLAWLESS_E2E_BASEURL points at a
//     running instance (or a crust validation proxy in front of one).
//   - Your API is a PREREQUISITE, not something this config can know how to
//     start. The app reaches it through the origin baked into the bundle at
//     Metro start time (EXPO_PUBLIC_* vars are inlined), so set
//     EXPO_PUBLIC_API_URL before running — an unset value falls back to
//     whatever the source hardcodes, which on one dogfooded LAN was a
//     PRODUCTION container. global-setup.ts is where to fail loudly.
const baseURL = process.env.FLAWLESS_E2E_BASEURL ?? "http://localhost:${port}";
// global-setup.ts always (re)writes this file — empty until you wire up login.
// __dirname on purpose, with the same known limit as the Next.js flavour: fine
// under the CJS transpile, absent in a "type":"module" app.
const authState = path.join(__dirname, ".auth.json");

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: path.join(__dirname, "test-results"),
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL,
    storageState: authState,
    trace: "retain-on-failure",
    // Metro bundles a route the first time something asks for it, and the
    // first navigation of a cold run pays that build. 30s (the default) is a
    // flake at exactly one spec per run; this is not.
    navigationTimeout: 90_000,
  },
  webServer: process.env.FLAWLESS_E2E_BASEURL
    ? undefined
    : {
        command: ${JSON.stringify(webCommand)},
        cwd: path.resolve(__dirname, ${JSON.stringify(toExpoRoot)}),
        url: "http://localhost:${port}",
        reuseExistingServer: true,
        // Cold Metro start + first bundle, not a dev-server ping.
        timeout: 180_000,
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
`;
}

/**
 * Exported for tests ONLY, to pin the bytes — same contract as the Next.js
 * stub: the hand-work tally fires on byte-identity, the file is never
 * overwritten, so editing this text retires the tally for every generated,
 * never-filled suite. tests/e2eExpo.test.ts makes that loud.
 */
export function expoGlobalSetupStubForTest(): string {
  return expoGlobalSetupStub();
}

function expoGlobalSetupStub(): string {
  return `import { writeFileSync } from "node:fs";
import path from "node:path";

// TODO(flawless): authenticate here if your routes need a session. On Expo web
// the app talks to its API with credentials:"include", so the session is a
// COOKIE on the API origin — a request-context login captures it and
// storageState carries it into every spec's browser context. Example:
//
//   const api = process.env.EXPO_PUBLIC_API_URL;
//   if (!api) {
//     // Metro inlines EXPO_PUBLIC_* at bundle time; unset, the app falls back
//     // to whatever origin its source hardcodes. Refuse rather than test a
//     // server nobody chose.
//     throw new Error("EXPO_PUBLIC_API_URL is not set");
//   }
//   const ctx = await request.newContext();
//   await ctx.post(\`\${api}/api/auth/login\`, { data: { email, password } });
//   await ctx.storageState({ path: authState });
//   await ctx.dispose();
//
// flawless-react never overwrites this file.
export default async function globalSetup(config: { rootDir: string }): Promise<void> {
  // rootDir is the CONFIG's directory, handed in at runtime — the one anchor
  // that exists under both module loaders.
  const authState = path.join(config.rootDir, ".auth.json");
  // Empty state so the config's storageState reference always resolves.
  writeFileSync(authState, JSON.stringify({ cookies: [], origins: [] }));
}
`;
}

function expoE2eReadme(port: number): string {
  return `# flawless-react e2e (Expo)

Route-level Playwright specs against \`expo start --web\` (Metro, port ${port}).

- **Two servers.** Metro serves the UI (the emitted config boots it); your API
  is a prerequisite the config cannot start. Set \`EXPO_PUBLIC_API_URL\` before
  running — Metro bakes it into the bundle, and an unset value falls back to
  whatever the source hardcodes.
- Seed the database first (whatever your repo uses — e.g. \`bun run db:reset\`).
- Dynamic segments read \`e2e/params.json\` (same machinery as the Next.js
  flavour): \`FLAWLESS_E2E_<PARAM>\` env vars override it.
- Auth: fill in \`global-setup.ts\` (never overwritten). On Expo web the app
  authenticates with a cookie against the API origin, so the stub's
  request-context login + storageState example is the whole job. Until you do,
  a protected route fails on its landing assertion (client redirect to the
  login screen), or on its console/copy assertions (a wall rendered in place
  surfaces the API's 401s and never renders the screen's own text).
- A route that redirects ON PURPOSE — including an app whose cold start always
  lands on the login screen because it restores no session — records the truth
  in \`params.json\` under \`landing\`, e.g. \`{"landing": {"/": "/login"}}\`.
  Not in the spec: \`--force\` rewrites specs and leaves this file alone.
- Status codes are real here: Metro under \`web.output: "static"\` answers 404
  for unknown routes and renders each route's own HTML, so the specs' status
  and copy assertions have teeth on a dev server.
`;
}

function expoRouteSpec(tree: ComponentTree, route: ExpoRoute, rel: string): string {
  const dynamic = route.params.length > 0;
  const paramLines = dynamic
    ? `import { expectedLanding, routeUrl } from "./params";\n\nconst ROUTE_TEMPLATE = ${JSON.stringify(route.urlPath)};`
    : `import { expectedLanding } from "./params";`;
  const urlExpr = dynamic ? `routeUrl(ROUTE_TEMPLATE) as string` : JSON.stringify(route.urlPath);
  const skipLine = dynamic
    ? `\n    test.skip(\n      ROUTE === undefined,\n      \`no id fixture for ${route.urlPath} — fill ${underOutDir(rel, "e2e/params.json")}\`,\n    );`
    : "";

  // The longest literal the analysis proved this screen renders on its
  // happy path. It is the anti-vacuous rung the Next.js flavour never needed:
  // an auth wall rendered IN PLACE keeps the URL, answers 200 and can keep a
  // clean console — but it never renders the screen's own copy.
  const witness = witnessFor(tree);

  const clicks = collectPressClicks(tree).slice(0, 3);
  const interactionBody = clicks
    .map((c) => {
      const locator = emitPlaywrightSelector(c.click);
      if (!locator) return "";
      // An e2e spec has no DEFAULTS table — the prop-labelled rung belongs to
      // the unit/browser planes, where synthesised props exist to read.
      if (locator.includes("DEFAULTS[")) return "";
      const dispatch = emitPlaywrightDispatch(c.click.event, locator, { tag: c.click.tag });
      if (!dispatch) return "";
      return `    // from <${c.component}> analysis
    {
      const target = ${locator};
      if (await target.count() > 0 && await target.first().isVisible()) {
        ${dispatch.replace(locator, `${locator}.first()`)};
        await page.waitForTimeout(150);
      }
    }`;
    })
    .filter((s) => s !== "")
    .join("\n");

  return `import { test, expect, type Page } from "@playwright/test";

${paramLines}
const ROUTE = ${urlExpr};
const ROUTE_KEY = ${JSON.stringify(route.urlPath)};

/** Trailing slashes are not a difference: "/items/" and "/items" are one route. */
function normalisePath(p: string): string {
  return p.replace(/\\/+$/, "") || "/";
}

/**
 * Assert the browser is on the route this spec asked for.
 *
 * On Expo web an auth wall has two shapes, and this catches ONE of them: the
 * client-side redirect that changes the URL (an unauthenticated "/" landing on
 * "/login"). The other shape — a wall rendered IN PLACE at the requested URL —
 * keeps the URL, so the console assertion (the API's 401s land there) and the
 * copy assertion below are what catch it. Between the three, an
 * unauthenticated suite cannot pass.
 */
async function assertOnRoute(page: Page): Promise<void> {
  const landed = normalisePath(new URL(page.url()).pathname);
  const wanted = normalisePath(
    expectedLanding(ROUTE_KEY, new URL(ROUTE, "http://flawless.invalid").pathname),
  );
  expect(
    landed,
    \`navigation left the route: asked for \\\`\${wanted}\\\`, landed on \\\`\${landed}\\\`. \` +
      \`If this is an auth wall, authenticate in ${underOutDir(rel, "e2e/global-setup.ts")} — \` +
      \`on Expo web that is a request-context login against the API origin plus storageState. \` +
      \`If the redirect is what this route is SUPPOSED to do (a cold start that lands on the \` +
      \`login screen included), record the destination in ${underOutDir(rel, "e2e/params.json")} \` +
      \`under "landing": { "\${ROUTE_KEY}": "\${landed}" } — that file survives --force, this spec does not.\`,
  ).toBe(wanted);
}

// The route rides on the describe: a --changed run's "\\bGET <route> " pattern
// must select EVERY test in this file.
test.describe("GET ${route.urlPath}", () => {
  test("renders without console or page errors", async ({ page }) => {${skipLine}
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const resp = await page.goto(ROUTE);
    expect(resp, "navigation returned a response").toBeTruthy();
    // Metro's statuses are real: unknown routes 404, served routes 200 —
    // measured, not assumed (docs/archive/2026-09-expo-probes.md).
    expect(resp?.status(), "no 5xx").toBeLessThan(500);
    await page.waitForLoadState("networkidle");
    await assertOnRoute(page);
    // A dead session's other face lands here: a wall rendered in place
    // surfaces every API call as a 401 console error.
    expect(errors).toEqual([]);
  });
${
  witness === undefined
    ? ""
    : `
  test("renders its own copy", async ({ page }) => {${skipLine}
    // A route that DELIBERATELY lands elsewhere (a params.json landing
    // override — the redirect-only index of an app with no session hydration
    // is the dogfood shape) never renders its own copy THERE, and asserting
    // this screen's text on the screen it redirects to would be a red spec
    // about a recorded decision. The other two tests still run: the landing
    // assertion proves the redirect goes where the override says.
    {
      const wanted = normalisePath(new URL(ROUTE, "http://flawless.invalid").pathname);
      test.skip(
        normalisePath(expectedLanding(ROUTE_KEY, wanted)) !== wanted,
        "this route deliberately lands elsewhere (params.json landing) — its own copy cannot be asserted there",
      );
    }
    await page.goto(ROUTE);
    await page.waitForLoadState("networkidle");
    await assertOnRoute(page);
    // The longest literal the analysis proved this screen renders on its happy
    // path. An auth wall, an error state or the wrong screen renders none of
    // it — this is the claim that cannot be true of a login page.
    await expect(page.getByText(${JSON.stringify(witness)}).first()).toBeVisible();
  });
`
}${
  clicks.length > 0
    ? `
  test("basic interactions from analysis stay error-free", async ({ page }) => {${skipLine}
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ROUTE);
    await page.waitForLoadState("networkidle");
    // Carries real weight here: every harvested press is guarded by
    // count()/isVisible(), so on a login screen this test would do NOTHING and
    // report an empty error list — a green claim about work that never happened.
    await assertOnRoute(page);
${interactionBody}
    expect(errors).toEqual([]);
  });
`
    : ""
}});
`;
}

/**
 * The screen's most identifying happy-path literal, from the same analysis the
 * unit plane trusts. Fragments below 4 characters identify nothing ("OK" is on
 * half the screens of any app).
 */
function witnessFor(tree: ComponentTree): string | undefined {
  const texts = tree.entry.staticText ?? [];
  const best = [...texts].sort((a, b) => b.length - a.length)[0];
  return best !== undefined && best.length >= 4 ? best : undefined;
}

interface HarvestedClick {
  component: string;
  click: NonNullable<ComponentTree["entry"]["interactions"]>["clicks"][number];
}

/** onPress, not onClick: the native event vocabulary — the sibling of the web
 *  task's collectClicks for the same reason the emitters are siblings. */
function collectPressClicks(tree: ComponentTree): HarvestedClick[] {
  const out: HarvestedClick[] = [];
  const walk = (t: ComponentTree): void => {
    for (const c of t.entry.interactions?.clicks ?? []) {
      if (c.event === "onPress") out.push({ component: t.entry.componentName, click: c });
    }
    for (const child of t.children) walk(child);
  };
  walk(tree);
  return out;
}
