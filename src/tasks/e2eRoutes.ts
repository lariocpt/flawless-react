import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { outDirRel, relativeToEmitted, underOutDir } from "../emitPaths.ts";
import { devScriptPort, findRouterRoot, pageFileToRoute } from "../nextjs/routes.ts";
import { emitPlaywrightDispatch, emitPlaywrightSelector } from "../scaffold-tests/selectors.ts";
import type { ComponentTree, RunContext, Task, TaskResult, TodoTally } from "../types.ts";

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
    // B-12. Every route spec now asserts it landed on the route it asked for,
    // so an unauthenticated suite fails loudly instead of testing the login
    // screen. That is the correctness half; this is the VISIBILITY half — the
    // REPORT should say the auth hook is still a stub before anyone runs it.
    //
    // Byte-identity against the stub, not a grep for the TODO marker: the
    // marker wording is presentation (types.ts says so), and a user who filled
    // the file in while leaving the comment would be reported as unfilled
    // forever. Identity clears the moment a human edits the file, and stays
    // honest across re-runs because the stub is never overwritten.
    const authUnfilled = readFileSync(setupPath, "utf8") === globalSetupStub();

    const paramsJsonPath = path.join(e2eDir, "params.json");
    const wroteParams = await writeParams(paramsJsonPath, pages, ctx.force);
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
    // One tally for the run, not one per spec: the stub being unfilled is a
    // single fact about the suite, and counting it per route would report the
    // same hand-work N times.
    const handWork: TodoTally[] =
      authUnfilled && pages.length > 0
        ? [{ kind: "e2e-auth-unfilled", count: 1, exemplar: setupPath }]
        : [];
    return {
      id: "e2e",
      ok: true,
      outputs: written,
      findings: [],
      handWork,
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
// __dirname on purpose, with a known limit: in a CJS package (every Next.js
// default) playwright transpiles this config and __dirname exists; a
// "type":"module" app loads it as ESM where it does not — and playwright
// offers no loader-neutral anchor a config can use for use.storageState
// (relative storageState resolves against the CWD, probed, and import.meta
// breaks the CJS transpile). Standalone suites never emit this file.
const authState = path.join(__dirname, ".auth.json");

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

/**
 * Exported for tests ONLY, to pin the bytes.
 *
 * The B-12 hand-work tally fires on byte-identity with this string, and this
 * file is never overwritten once emitted — so editing the text here retires
 * the tally for every already-generated, never-filled suite. That coupling is
 * invisible from either side; tests/tasks.test.ts makes it fail loudly.
 */
export function globalSetupStubForTest(): string {
  return globalSetupStub();
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
//   await ctx.storageState({ path: authState });
//
// flawless-react never overwrites this file.
export default async function globalSetup(config: { rootDir: string }): Promise<void> {
  // rootDir is the CONFIG's directory, handed in at runtime — the one anchor
  // that exists under both module loaders (__dirname is CJS-only and this
  // file is loaded as ESM in a "type":"module" app).
  const authState = path.join(config.rootDir, ".auth.json");
  // Empty state so the config's storageState reference always resolves.
  writeFileSync(authState, JSON.stringify({ cookies: [], origins: [] }));
}
`;
}

function e2eReadme(port: number): string {
  return `# flawless-react e2e

Route-level Playwright specs against the real \`next dev\` server (port ${port}).

- Seed the database first (whatever your repo uses — e.g. \`bun run db:reset\`).
- Dynamic segments read env vars: \`FLAWLESS_E2E_ID=<seeded-id> bun run flawless:e2e\`.
- Auth: fill in \`global-setup.ts\` (never overwritten). Until you do, every
  spec fails on its landing assertion rather than testing your login page —
  an unauthenticated route redirects there and it answers 200.
- A route that redirects ON PURPOSE: record where it really ends up in
  \`params.json\` under \`landing\`, e.g. \`{"landing": {"/dash": "/dash/overview"}}\`.
  Not in the spec — \`--force\` rewrites specs and leaves this file alone.

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
  // expectedLanding is imported by EVERY spec, dynamic or not: the redirect
  // assertion needs its override, and a static route is exactly as likely to
  // redirect on purpose as a parameterised one.
  const paramLines = dynamic
    ? `import { expectedLanding, routeUrl } from "./params";\n\nconst ROUTE_TEMPLATE = ${JSON.stringify(route.urlPath)};`
    : `import { expectedLanding } from "./params";`;
  // `as string` after the skip below: test.skip() ends the test at runtime but
  // TypeScript cannot see that, and every navigation would otherwise be an error.
  const urlExpr = dynamic ? `routeUrl(ROUTE_TEMPLATE) as string` : JSON.stringify(route.urlPath);
  const skipLine = dynamic
    ? `\n    test.skip(\n      ROUTE === undefined,\n      \`no id fixture for ${route.urlPath} — fill ${underOutDir(rel, "e2e/params.json")}\`,\n    );`
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
 * Without it the spec's other claims — a response came back, status < 500, a
 * clean console — are all true of a LOGIN SCREEN: an unauthenticated request to
 * a protected page redirects, and the login page answers 200.
 *
 * Scope, stated precisely because the failure mode here is an overclaim: this
 * catches redirects that CHANGE THE URL and have landed by the time it runs —
 * a server 3xx, and a client-side navigation that completes before the caller's
 * await does. It does NOT catch a middleware rewrite that serves the login page
 * at the requested path, a 401 body, or a redirect that fires later than the
 * caller waited. Call it after whatever settle the caller needs.
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
      \`an unauthenticated request redirects to a login page, which answers 200, so the \` +
      \`status check above cannot see it. If the redirect is what this route is SUPPOSED \` +
      \`to do, record the destination in ${underOutDir(rel, "e2e/params.json")} under \` +
      \`"landing": { "\${ROUTE_KEY}": "\${landed}" } — that file survives --force, this spec does not.\`,
  ).toBe(wanted);
}

// The route rides on the describe: playwright matches --grep against the
// space-joined full title path, so a --changed run's "\\bGET <route> " pattern
// (grepForRoutes) must select EVERY test in this file — a route embedded in
// only one test's own title left the others invisible to a narrowed run.
test.describe("GET ${route.urlPath}", () => {
  test("renders without console or page errors", async ({ page }) => {${skipLine}
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    const resp = await page.goto(ROUTE);
    expect(resp, "navigation returned a response").toBeTruthy();
    expect(resp?.status(), "no 5xx").toBeLessThan(500);
    await page.waitForLoadState("networkidle");
    await assertOnRoute(page);
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
    // Same check as above, and it carries more weight here: every harvested
    // click is guarded by count()/isVisible(), so on a login screen this test
    // does NOTHING and then reports an empty error list — a green claim about
    // work that never happened.
    await assertOnRoute(page);
${interactionBody}
    expect(errors).toEqual([]);
  });
`
    : ""
}});
`;
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

/** Key order is part of the bytes: two runs must produce the same file. */
function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k] as T;
  return out;
}

/**
 * The shared id fixture, merged rather than overwritten.
 *
 * A value here was typed by a human against a seeded database and cannot be
 * recovered from the tool's inputs, so nothing this function does may lose one.
 * That rules out rebuilding the file from a single run's view of the project:
 *
 *  - `defaults` also holds the load task's API-route ids, which no page route
 *    claims. Dropping the blank ones each run left writeParams and
 *    ensureParamDefaults deleting and re-adding the same key forever, both
 *    reporting a write on every run of the suite's life.
 *  - `routes` rows were rebuilt from the pages in THIS run, so pointing
 *    flawless at one page deleted the ids you had filled for every other one.
 *    A narrower glob is a smaller view of the project, not an instruction to
 *    discard the rest of it.
 *
 * So it is additive by default. `prune` — set from `--force` — is the one door
 * that tidies, and even then it only removes entries that hold nothing: a
 * filled id survives every flag, the same rule routes.pipes follows for a pipe
 * you commented out yourself.
 *
 * Two levels because most params are global — one seeded building — but some
 * routes need a consistent PAIR: a poll that actually belongs to that building.
 * Per-route overrides express that without forcing it everywhere.
 */
export async function writeParams(
  file: string,
  pages: Array<{ route: { urlPath: string; params: string[] } }>,
  prune = false,
): Promise<boolean> {
  interface ParamsFile {
    defaults: Record<string, string>;
    routes: Record<string, Record<string, string>>;
    /**
     * Route template -> the path that route is SUPPOSED to end on, for pages
     * that redirect on purpose (a default sub-tab, a locale landing). Never
     * written by the tool, only carried: the emitted spec's landing assertion
     * reads it, and this file survives --force while the spec does not.
     */
    landing: Record<string, string>;
  }
  let existing: ParamsFile = { defaults: {}, routes: {}, landing: {} };
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ParamsFile>;
      existing = {
        defaults: parsed.defaults ?? {},
        routes: parsed.routes ?? {},
        landing: parsed.landing ?? {},
      };
    } catch {
      // A hand-edited file with a syntax error must not be silently replaced.
      throw new Error(`${file} is not valid JSON — fix or delete it and re-run`);
    }
  }

  const next: ParamsFile = { defaults: {}, routes: {}, landing: {} };
  const allParams = new Set<string>();
  for (const p of pages) for (const name of p.route.params) allParams.add(name);
  // Every id already in the file, blank ones included.
  //
  // The load task adds slots for API-route params the page router never sees —
  // `buildingId` beside the page's `id` — and rebuilding `defaults` from pages
  // plus only the FILLED existing ones deleted those blanks on every run. The
  // two writers then fought forever: writeParams dropped the slot,
  // ensureParamDefaults put it back, both reporting the file as written on
  // every run for the lifetime of the suite. `--tasks e2e` on its own just
  // deleted it, and the id the user was about to fill was gone.
  //
  // Blanks are only noise once nothing needs them, and this function cannot
  // know that: the task that needs them runs after it. So it keeps them, and
  // `--prune` (--force) is the one door that tidies.
  for (const name of Object.keys(existing.defaults)) {
    if (prune && (existing.defaults[name] ?? "") === "" && !allParams.has(name)) continue;
    allParams.add(name);
  }
  for (const name of [...allParams].sort()) next.defaults[name] = existing.defaults[name] ?? "";

  // Rows this run did not look at are carried over untouched. Rebuilding
  // `routes` from `pages` alone meant running flawless on one page deleted the
  // ids you had filled for every other one — not a blank slot, a value you
  // typed. A narrower glob is a smaller view of the project, not a decision to
  // discard the rest of it.
  for (const [urlPath, row] of Object.entries(existing.routes)) {
    const seen = pages.some((p) => p.route.urlPath === urlPath);
    if (seen) continue;
    // Under --prune a row is dropped only when it holds nothing. A filled id
    // survives every flag: the tool does not delete what a person typed.
    if (prune && Object.values(row).every((v) => v === "")) continue;
    next.routes[urlPath] = row;
  }
  for (const p of pages) {
    if (p.route.params.length === 0) continue;
    const prior = existing.routes[p.route.urlPath] ?? {};
    const row: Record<string, string> = {};
    for (const name of [...p.route.params].sort()) row[name] = prior[name] ?? "";
    // An id this route no longer declares, but which someone filled in, is kept
    // for the same reason.
    for (const [name, value] of Object.entries(prior)) {
      if (!(name in row) && (value !== "" || !prune)) row[name] = value;
    }
    next.routes[p.route.urlPath] = sortKeys(row);
  }
  next.routes = sortKeys(next.routes);
  // Carried verbatim, never invented and never pruned. The tool has no way to
  // know a route redirects on purpose — that is the user telling it something —
  // so an entry here is hand-work, and hand-work in this file is the one thing
  // --force must not touch. Written even when empty, so the knob is visible in
  // the file rather than only in the README.
  next.landing = sortKeys(existing.landing);

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
  if (names.length === 0) return false;
  interface ParamsFile {
    defaults: Record<string, string>;
    routes: Record<string, Record<string, string>>;
  }
  let parsed: ParamsFile = { defaults: {}, routes: {} };
  if (existsSync(file)) {
    try {
      parsed = JSON.parse(await readFile(file, "utf8")) as ParamsFile;
    } catch {
      return false;
    }
  } else {
    // Created rather than skipped. `--tasks load` on its own never runs the e2e
    // task, so nothing else writes this file — while every piece of prose that
    // run emits (the gate comment on each pipe, load/README.md, env.sh) tells
    // the reader to fill in ids in a file that was not there. The pipes stayed
    // commented out and the instruction for turning them on pointed at nothing.
    await mkdir(path.dirname(file), { recursive: true });
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
  /** Route template -> the path that route is SUPPOSED to end on. */
  landing?: Record<string, string>;
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

/**
 * Where this route is expected to end up, which is normally the route itself.
 *
 * A page that deliberately redirects — a default sub-tab, a locale landing —
 * would otherwise fail the landing assertion forever. Record the real
 * destination here rather than editing the spec: specs are regenerated by
 * --force, this file is not.
 */
export function expectedLanding(route: string, fallback: string): string {
  return FIXTURE.landing?.[route] ?? fallback;
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
