import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { outDirRel, relativeToEmitted, underOutDir } from "../emitPaths.ts";
import { devScriptPort, findRouterRoot, pageFileToRoute } from "../nextjs/routes.ts";
import { emitPlaywrightDispatch, emitPlaywrightSelector } from "../scaffold-tests/selectors.ts";
import type { ComponentTree, RunContext, Task, TaskResult } from "../types.ts";

/**
 * Route-level Playwright e2e against the target's real `next dev` server.
 * MSW cannot intercept RSC data access (direct DB calls), so v1 runs against
 * the app with its real backing services — seed the DB first. The emitted
 * config honors FLAWLESS_E2E_BASEURL so the whole suite can be pointed at a
 * crust validation proxy for contract-checked runs.
 */
export const e2eRoutes: Task = {
  id: "e2e",
  label: "Generate route-level Playwright e2e specs",
  description: "One spec per analysed app-router page: error-free load + basic interactions",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    if (!ctx.nextjs) {
      return {
        id: "e2e",
        ok: false,
        outputs: [],
        findings: [],
        summary: "e2e task requires --nextjs mode",
        error: "not a Next.js run",
      };
    }
    const routerRoot = findRouterRoot(ctx.nextjs.root);
    const pages: Array<{
      tree: ComponentTree;
      route: NonNullable<ReturnType<typeof pageFileToRoute>>;
    }> = [];
    for (const tree of ctx.trees) {
      const route = pageFileToRoute(tree.entry.filePath, ctx.nextjs.router, routerRoot);
      if (route) pages.push({ tree, route });
    }

    const e2eDir = path.join(ctx.outDir, "e2e");
    await mkdir(e2eDir, { recursive: true });
    const written: string[] = [];
    const skipped: string[] = [];

    const devScript = await readDevScript(ctx.nextjs.root);
    const port = devScriptPort(devScript);

    const configPath = path.join(e2eDir, "playwright.config.ts");
    await Bun.write(configPath, e2eConfig(relativeToEmitted(e2eDir, ctx.nextjs.root), port));
    written.push(configPath);

    const setupPath = path.join(e2eDir, "global-setup.ts");
    if (!existsSync(setupPath)) {
      await Bun.write(setupPath, globalSetupStub());
      written.push(setupPath);
    }

    const paramsJsonPath = path.join(e2eDir, "params.json");
    const wroteParams = await writeParams(paramsJsonPath, pages);
    if (wroteParams) written.push(paramsJsonPath);

    const paramsHelperPath = path.join(e2eDir, "params.ts");
    await Bun.write(paramsHelperPath, paramsHelper());
    written.push(paramsHelperPath);

    // Refreshed by --force, like load/README.md beside it: generated prose with
    // nothing of yours in it, and freezing it means an existing suite never
    // learns what a later version worked out.
    const readmePath = path.join(e2eDir, "README.md");
    if (!existsSync(readmePath) || ctx.force) {
      await Bun.write(readmePath, e2eReadme(port));
      written.push(readmePath);
    }

    for (const { tree, route } of pages) {
      const specPath = path.join(e2eDir, `${route.specStem}.spec.ts`);
      if (existsSync(specPath) && !ctx.force) {
        skipped.push(specPath);
        continue;
      }
      await Bun.write(specPath, routeSpec(tree, route, outDirRel(ctx.outDir, ctx.nextjs.root)));
      written.push(specPath);
    }

    const skippedNote =
      skipped.length > 0 ? `; kept ${skipped.length} existing spec(s) (--force to regenerate)` : "";
    return {
      id: "e2e",
      ok: true,
      outputs: written,
      findings: [],
      summary:
        pages.length === 0
          ? "no analysed entry is an app-router page.tsx — config emitted, no specs"
          : `e2e specs for ${pages.length} route(s): ${pages.map((p) => p.route.urlPath).join(", ")}${skippedNote}`,
    };
  },
};

async function readDevScript(nextRoot: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(path.join(nextRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts?.dev;
  } catch {
    return undefined;
  }
}

/**
 * @param toNextRoot Path from this config's own directory to the app root.
 *   Relative, deliberately: the config is committed, and an absolute path in it
 *   names the machine that generated it. The same repo lives under a different
 *   root on other machines, so the checked-in file would both fail to resolve
 *   there and rewrite itself on every regeneration.
 */
function e2eConfig(toNextRoot: string, port: number): string {
  return `import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Runs against the target app's real dev server (RSC pages hit the real DB —
// seed it first). Override the base URL to point at a crust validation proxy
// for contract-checked runs: FLAWLESS_E2E_BASEURL=http://localhost:4747.
const baseURL = process.env.FLAWLESS_E2E_BASEURL ?? "http://localhost:${port}";
// global-setup.ts always (re)writes this file — empty until you wire up login.
const authState = path.join(__dirname, ".auth.json"); // playwright transpiles configs to CJS

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  // Keep traces/screenshots inside flawless/ instead of littering the project root.
  outputDir: path.join(__dirname, "test-results"),
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  use: {
    baseURL,
    storageState: authState,
    trace: "retain-on-failure",
  },
  webServer: process.env.FLAWLESS_E2E_BASEURL
    ? undefined
    : {
        command: "bun run dev",
        cwd: path.resolve(__dirname, ${JSON.stringify(toNextRoot)}),
        url: "http://localhost:${port}",
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
`;
}

function globalSetupStub(): string {
  return `import { writeFileSync } from "node:fs";
import path from "node:path";

// TODO(flawless): authenticate here if your routes need a session — request
// your login endpoint with a playwright request context and persist its
// storageState to .auth.json (the config already points at it). Example:
//
//   const ctx = await request.newContext({ baseURL });
//   await ctx.post("/api/auth/login", { data: { email, password } });
//   await ctx.storageState({ path: AUTH_STATE });
//
// flawless-react never overwrites this file.
const AUTH_STATE = path.join(__dirname, ".auth.json"); // CJS under playwright

export default async function globalSetup(): Promise<void> {
  // Empty state so the config's storageState reference always resolves.
  writeFileSync(AUTH_STATE, JSON.stringify({ cookies: [], origins: [] }));
}
`;
}

function e2eReadme(port: number): string {
  return `# flawless-react e2e

Route-level Playwright specs against the real \`next dev\` server (port ${port}).

- Seed the database first (whatever your repo uses — e.g. \`bun run db:reset\`).
- Dynamic segments read env vars: \`FLAWLESS_E2E_ID=<seeded-id> bun run flawless:e2e\`.
- Auth: fill in \`global-setup.ts\` (never overwritten).

## Contract-checked runs (crust)

Put the crust validation proxy in front of the dev server, run the suite
through it, then assert zero response violations:

\`\`\`bash
crust -c 'mock-server --swagger openapi.json --port 4747 --proxy http://localhost:${port}' &
FLAWLESS_E2E_BASEURL=http://localhost:4747 bun run flawless:e2e
crust -c 'GET :4747/__crust/violations | (v => v.violations.filter(x => x.direction === "response")) | assert (a => a.length === 0)'
\`\`\`
`;
}

function routeSpec(
  tree: ComponentTree,
  route: NonNullable<ReturnType<typeof pageFileToRoute>>,
  rel: string,
): string {
  // A parameterised route reads its ids from the shared fixture rather than from
  // a const per spec. The old form defaulted to "REPLACE_WITH_SEEDED_ID", which
  // navigated to a URL that 404s — so an unfilled fixture was reported as an
  // application bug, thirty times over.
  const dynamic = route.params.length > 0;
  const paramLines = dynamic
    ? `import { routeUrl } from "./params";\n\nconst ROUTE_TEMPLATE = ${JSON.stringify(route.urlPath)};`
    : "";
  // `as string` after the skip below: test.skip() ends the test at runtime but
  // TypeScript cannot see that, and every navigation would otherwise be an error.
  const urlExpr = dynamic ? `routeUrl(ROUTE_TEMPLATE) as string` : JSON.stringify(route.urlPath);
  const skipLine = dynamic
    ? `\n  test.skip(\n    ROUTE === undefined,\n    \`no id fixture for ${route.urlPath} — fill ${underOutDir(rel, "e2e/params.json")}\`,\n  );`
    : "";

  // Up to 3 interactions harvested from the page's component tree.
  const clicks = collectClicks(tree).slice(0, 3);
  const interactionBody = clicks
    .map((c) => {
      const locator = emitPlaywrightSelector(c.click);
      // Nothing in the source identifies the element — a locator built from a
      // component name matches nothing and the step would silently no-op.
      if (!locator) return "";
      // A change event on something that holds no text (a delegating <form>)
      // has no drivable target here either.
      const dispatch = emitPlaywrightDispatch(c.click.event, locator, { tag: c.click.tag });
      if (!dispatch) return "";
      return `  // from <${c.component}> analysis
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

  return `import { test, expect } from "@playwright/test";

${paramLines}
const ROUTE = ${urlExpr};

test("GET ${route.urlPath} renders without console or page errors", async ({ page }) => {${skipLine}
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const resp = await page.goto(ROUTE);
  expect(resp, "navigation returned a response").toBeTruthy();
  expect(resp?.status(), "no 5xx").toBeLessThan(500);
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
});
${
  clicks.length > 0
    ? `
test("basic interactions from analysis stay error-free", async ({ page }) => {${skipLine}
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(ROUTE);
  await page.waitForLoadState("networkidle");
${interactionBody}
  expect(errors).toEqual([]);
});
`
    : ""
}`;
}

interface HarvestedClick {
  component: string;
  click: NonNullable<ComponentTree["entry"]["interactions"]>["clicks"][number];
}

function collectClicks(tree: ComponentTree): HarvestedClick[] {
  const out: HarvestedClick[] = [];
  const walk = (t: ComponentTree): void => {
    for (const c of t.entry.interactions?.clicks ?? []) {
      if (c.event === "onClick") out.push({ component: t.entry.componentName, click: c });
    }
    for (const child of t.children) walk(child);
  };
  walk(tree);
  return out;
}

/**
 * The shared id fixture, merged rather than overwritten.
 *
 * A value here was typed by a human against a seeded database and cannot be
 * recovered from the tool's inputs, so `--force` regenerates the HELPER and
 * never the DATA. Route keys whose page no longer exists are dropped, because a
 * stale entry silently stops matching anything — but a DEFAULT holding a value
 * is kept whether or not a page route claims it, since the load task's API-route
 * ids live there too and nothing else remembers them.
 *
 * Two levels because most params are global — one seeded building — but some
 * routes need a consistent PAIR: a poll that actually belongs to that building.
 * Per-route overrides express that without forcing it everywhere.
 */
export async function writeParams(
  file: string,
  pages: Array<{ route: { urlPath: string; params: string[] } }>,
): Promise<boolean> {
  interface ParamsFile {
    defaults: Record<string, string>;
    routes: Record<string, Record<string, string>>;
  }
  let existing: ParamsFile = { defaults: {}, routes: {} };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ParamsFile>;
      existing = { defaults: parsed.defaults ?? {}, routes: parsed.routes ?? {} };
    } catch {
      // A hand-edited file with a syntax error must not be silently replaced.
      throw new Error(`${file} is not valid JSON — fix or delete it and re-run`);
    }
  }

  const next: ParamsFile = { defaults: {}, routes: {} };
  const allParams = new Set<string>();
  for (const p of pages) for (const name of p.route.params) allParams.add(name);
  // Ids no page route claims, but which someone filled in anyway. The load task
  // adds slots for API-route params the page router never sees — `buildingId`
  // beside the page's `id` — and rebuilding `defaults` from pages alone dropped
  // them back to "" on the next run. That silently re-gated the pipe they were
  // filled for, so the fix looked like it had never been made.
  for (const [name, value] of Object.entries(existing.defaults)) {
    if (value !== "") allParams.add(name);
  }
  for (const name of [...allParams].sort()) next.defaults[name] = existing.defaults[name] ?? "";

  for (const p of pages) {
    if (p.route.params.length === 0) continue;
    const prior = existing.routes[p.route.urlPath] ?? {};
    const row: Record<string, string> = {};
    for (const name of [...p.route.params].sort()) row[name] = prior[name] ?? "";
    next.routes[p.route.urlPath] = row;
  }

  const body = `${JSON.stringify(next, null, 2)}\n`;
  if (existsSync(file) && (await readFile(file, "utf8")) === body) return false;
  await Bun.write(file, body);
  return true;
}

/**
 * Add ids another task needs to `defaults`, without touching anything else.
 *
 * The load pipes cover API routes as well as pages, and an API route's segment
 * is often named differently from the page's — `/api/buildings/[buildingId]`
 * beside `/dashboard/buildings/[id]`. params.json only knew about the page
 * ones, so `$LOAD_BUILDINGID` expanded to nothing, the URL had an empty segment,
 * and 500 requests to a malformed path were reported as the route failing.
 *
 * Additive only: existing values, route overrides and key order are preserved,
 * so this is safe to call after writeParams in the same run and idempotent
 * across runs.
 */
export async function ensureParamDefaults(file: string, names: string[]): Promise<boolean> {
  if (names.length === 0 || !existsSync(file)) return false;
  interface ParamsFile {
    defaults: Record<string, string>;
    routes: Record<string, Record<string, string>>;
  }
  let parsed: ParamsFile;
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as ParamsFile;
  } catch {
    return false;
  }
  const defaults = { ...(parsed.defaults ?? {}) };
  let added = false;
  for (const n of names) {
    if (!(n in defaults)) {
      defaults[n] = "";
      added = true;
    }
  }
  if (!added) return false;
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(defaults).sort()) sorted[k] = defaults[k] as string;
  await Bun.write(file, `${JSON.stringify({ ...parsed, defaults: sorted }, null, 2)}\n`);
  return true;
}

function paramsHelper(): string {
  return `import params from "./params.json" with { type: "json" };

/**
 * Ids for parameterised routes, resolved in this order:
 *
 *   1. FLAWLESS_E2E_<PARAM>              per-param environment override
 *   2. params.json routes[<route>][<p>]  when this route needs a consistent set
 *   3. params.json defaults[<p>]         the usual case: one seeded record
 *   4. FLAWLESS_E2E_ID                   legacy single-id escape hatch
 *
 * undefined when nothing resolves — the spec skips with a reason rather than
 * navigating to a URL that 404s and blaming the app for it.
 */
type ParamsFile = {
  defaults: Record<string, string>;
  routes: Record<string, Record<string, string>>;
};

const FIXTURE = params as ParamsFile;

export function param(route: string, name: string): string | undefined {
  const env = process.env[\`FLAWLESS_E2E_\${name.toUpperCase()}\`];
  if (env) return env;
  const perRoute = FIXTURE.routes[route]?.[name];
  if (perRoute) return perRoute;
  const fallback = FIXTURE.defaults[name];
  if (fallback) return fallback;
  return process.env.FLAWLESS_E2E_ID || undefined;
}

/** The template with every [param] / [...param] filled in, or undefined. */
export function routeUrl(template: string): string | undefined {
  let url = template;
  for (const match of template.matchAll(/\\[(?:\\.\\.\\.)?([^\\]]+)\\]/g)) {
    const name = match[1] as string;
    const value = param(template, name);
    if (!value) return undefined;
    url = url.replace(match[0], encodeURIComponent(value));
  }
  return url;
}
`;
}
