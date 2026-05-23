import path from "node:path";
import type { ComponentInfo, ComponentTree, PropsShape } from "../types.ts";

export interface FlatComponent {
  info: ComponentInfo;
  importPath: string;
}

export interface RenderedFile {
  relPath: string;
  content: string;
}

export interface UnitBrowserRenderOptions {
  trees: ComponentTree[];
  outDir: string;
  variants: number;
  mswSetup?: boolean;
}

export function renderUnitBrowser(opts: UnitBrowserRenderOptions): RenderedFile[] {
  const unitFlat = flattenForDir(opts.trees, opts.outDir, "unit");
  const browserFlat = flattenForDir(opts.trees, opts.outDir, "browser");
  const files: RenderedFile[] = [
    { relPath: "vitest.config.ts", content: vitestConfig() },
    { relPath: "setup.ts", content: setupTs(Boolean(opts.mswSetup)) },
    { relPath: "browser/playwright.config.ts", content: browserPlaywrightConfig() },
  ];
  for (const c of unitFlat) {
    files.push({
      relPath: `unit/${c.info.componentName}.test.tsx`,
      content: unitSpec(c, opts.variants),
    });
  }
  for (const c of browserFlat) {
    files.push({
      relPath: `browser/${c.info.componentName}.spec.ts`,
      content: browserSpec(c),
    });
  }
  return files;
}

function flattenForDir(trees: ComponentTree[], outDir: string, subdir: string): FlatComponent[] {
  const out: FlatComponent[] = [];
  const seen = new Set<string>();
  const fromDir = path.resolve(outDir, subdir);
  const walk = (t: ComponentTree): void => {
    if (seen.has(t.entry.filePath)) return;
    seen.add(t.entry.filePath);
    out.push({ info: t.entry, importPath: toRel(fromDir, t.entry.filePath) });
    for (const c of t.children) walk(c);
  };
  for (const t of trees) walk(t);
  return out;
}

function toRel(fromDir: string, absFile: string): string {
  let rel = path.relative(fromDir, absFile);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel.split(path.sep).join("/");
}

function vitestConfig(): string {
  return `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./setup.ts"],
    include: ["unit/**/*.test.{ts,tsx}"],
    globals: true,
  },
});
`;
}

function setupTs(mswSetup: boolean): string {
  if (!mswSetup) {
    return `import "@testing-library/jest-dom/vitest";
`;
  }
  return `import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./mocks/node.ts";

// MSW node server intercepts fetch() inside jsdom — same handlers your browser
// suite uses, so unit and browser layers agree on what /api/* returns.
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
`;
}

function unitSpec(c: FlatComponent, variants: number): string {
  const name = c.info.componentName;
  const propsLiteral = JSON.stringify(c.info.propsShape);
  const variantsLiteral = JSON.stringify(c.info.variants.slice(0, variants));
  const handlerProps = findHandlerProps(c.info.propsShape);

  const handlerTests = handlerProps
    .map(
      (p) => `
test("${name} invokes ${p} when clicked", async () => {
  const handler = vi.fn();
  const { container } = render(<${name} {...DEFAULTS} ${p}={handler} />);
  const button = container.querySelector("button");
  if (button) {
    await userEvent.click(button);
    expect(handler).toHaveBeenCalled();
  }
});`,
    )
    .join("\n");

  return `import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ${name} } from "${c.importPath}";

const DEFAULTS = ${propsLiteral} as Record<string, unknown>;
const VARIANTS = ${variantsLiteral} as Array<Record<string, unknown>>;

test("${name} renders at defaults without crashing", () => {
  render(<${name} {...DEFAULTS} />);
  void screen;
});

describe("${name} variants", () => {
  for (const v of VARIANTS) {
    test(\`renders with \${JSON.stringify(v)}\`, () => {
      render(<${name} {...DEFAULTS} {...v} />);
    });
  }
});${handlerTests}
`;
}

function browserSpec(c: FlatComponent): string {
  const name = c.info.componentName;
  const propsLiteral = JSON.stringify(c.info.propsShape);

  return `import { test, expect } from "@playwright/test";

const NAME = ${JSON.stringify(name)};
const DEFAULTS = ${propsLiteral} as Record<string, unknown>;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => typeof window.__profile?.mount === "function");
});

test(\`\${NAME}: mounts in the browser without console errors\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [NAME, DEFAULTS],
  );
  await page.waitForTimeout(100);
  expect(errors).toEqual([]);
  const rootHtml = await page.locator("#root").innerHTML();
  expect(rootHtml.length).toBeGreaterThan(0);
});

test(\`\${NAME}: click each button without errors\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [NAME, DEFAULTS],
  );
  const buttons = page.locator("button");
  const count = await buttons.count();
  for (let i = 0; i < Math.min(count, 5); i++) {
    await buttons.nth(i).click();
  }
  expect(errors).toEqual([]);
});
`;
}

function browserPlaywrightConfig(): string {
  return `import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun ../host/server.ts",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
`;
}

function findHandlerProps(shape: PropsShape): string[] {
  return Object.keys(shape).filter((k) => /^on[A-Z]/.test(k));
}
