import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
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
    await Bun.write(configPath, e2eConfig(ctx.nextjs.root, port));
    written.push(configPath);

    const setupPath = path.join(e2eDir, "global-setup.ts");
    if (!existsSync(setupPath)) {
      await Bun.write(setupPath, globalSetupStub());
      written.push(setupPath);
    }

    const readmePath = path.join(e2eDir, "README.md");
    if (!existsSync(readmePath)) {
      await Bun.write(readmePath, e2eReadme(port));
      written.push(readmePath);
    }

    for (const { tree, route } of pages) {
      const specPath = path.join(e2eDir, `${route.specStem}.spec.ts`);
      if (existsSync(specPath) && !ctx.force) {
        skipped.push(specPath);
        continue;
      }
      await Bun.write(specPath, routeSpec(tree, route));
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

function e2eConfig(nextRoot: string, port: number): string {
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
        cwd: ${JSON.stringify(nextRoot)},
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
): string {
  const paramLines = route.params
    .map((p) =>
      p.toUpperCase() === "ID"
        ? `const ID = process.env.FLAWLESS_E2E_ID ?? "REPLACE_WITH_SEEDED_ID"; // TODO(flawless)`
        : `const ${p.toUpperCase()} = process.env.FLAWLESS_E2E_${p.toUpperCase()} ?? process.env.FLAWLESS_E2E_ID ?? "REPLACE_WITH_SEEDED_${p.toUpperCase()}"; // TODO(flawless)`,
    )
    .join("\n");
  let urlExpr = `\`${route.urlPath}\``;
  for (const p of route.params) {
    urlExpr = urlExpr
      .replace(`[...${p}]`, `\${${p.toUpperCase()}}`)
      .replace(`[${p}]`, `\${${p.toUpperCase()}}`);
  }

  // Up to 3 interactions harvested from the page's component tree.
  const clicks = collectClicks(tree).slice(0, 3);
  const interactionBody = clicks
    .map((c) => {
      const locator = emitPlaywrightSelector(c.click);
      const dispatch = emitPlaywrightDispatch(c.click.event, locator);
      return `  // from <${c.component}> analysis
  {
    const target = ${locator};
    if (await target.count() > 0 && await target.first().isVisible()) {
      ${dispatch.replace(locator, `${locator}.first()`)};
      await page.waitForTimeout(150);
    }
  }`;
    })
    .join("\n");

  return `import { test, expect } from "@playwright/test";

${paramLines}
const ROUTE = ${urlExpr};

test("GET ${route.urlPath} renders without console or page errors", async ({ page }) => {
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
test("basic interactions from analysis stay error-free", async ({ page }) => {
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
