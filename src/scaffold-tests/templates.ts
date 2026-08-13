import path from "node:path";
import type { ClickHandler, ComponentInfo, ComponentTree, FormInfo, PropsShape } from "../types.ts";
import {
  emitPlaywrightDispatch,
  emitPlaywrightSelector,
  emitVitestDispatch,
  emitVitestSelector,
} from "./selectors.ts";

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
  const interactions = c.info.interactions;

  const allHandlers = collectPropHandlers(c.info);
  const handlerObjectLiteral =
    allHandlers.length > 0 ? `{ ${allHandlers.map((h) => `${h}: vi.fn()`).join(", ")} }` : `{}`;

  const interactionTests = interactions
    ? emitInteractionTests(name, interactions, allHandlers)
    : emitFallbackHandlerTests(name, c.info.propsShape, c.info.unresolvedProps);

  return `import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { ${name} } from "${c.importPath}";

type Props = React.ComponentProps<typeof ${name}>;

const DEFAULTS: Record<string, unknown> = ${propsLiteral};
const VARIANTS: Array<Record<string, unknown>> = ${variantsLiteral};
const handlers: Record<string, ReturnType<typeof vi.fn>> = ${handlerObjectLiteral};

beforeEach(() => {
  for (const v of Object.values(handlers)) v.mockClear();
});

function renderTarget(extra: Record<string, unknown> = {}) {
  const merged: Record<string, unknown> = { ...DEFAULTS, ...handlers, ...extra };
  return render(<${name} {...(merged as unknown as Props)} />);
}

test("${name} renders at defaults without crashing", () => {
  renderTarget();
  void screen;
});

describe("${name} variants", () => {
  for (const v of VARIANTS) {
    test(\`renders with \${JSON.stringify(v)}\`, () => {
      renderTarget(v);
    });
  }
});

${interactionTests}
`;
}

function collectPropHandlers(info: ComponentInfo): string[] {
  const out = new Set<string>();
  // Anything matching /^on[A-Z]/ that flowed through extractProps as "unresolved"
  // (callback type) or appears explicitly in interactions.
  for (const u of info.unresolvedProps) if (/^on[A-Z]/.test(u)) out.add(u);
  for (const k of Object.keys(info.propsShape)) if (/^on[A-Z]/.test(k)) out.add(k);
  const inter = info.interactions;
  if (inter) {
    for (const c of inter.clicks) {
      if (c.binding.kind === "prop") out.add(c.binding.propName);
    }
    for (const f of inter.forms) {
      if (f.submit?.kind === "prop") out.add(f.submit.propName);
    }
  }
  return [...out];
}

function emitInteractionTests(
  name: string,
  info: NonNullable<ComponentInfo["interactions"]>,
  allHandlers: string[],
): string {
  const parts: string[] = [];
  for (let i = 0; i < info.clicks.length; i++) {
    const click = info.clicks[i];
    if (!click) continue;
    parts.push(emitClickTest(name, click, allHandlers, i));
  }
  for (let i = 0; i < info.forms.length; i++) {
    const form = info.forms[i];
    if (!form) continue;
    parts.push(emitFormTest(name, form, allHandlers, i));
  }
  if (parts.length === 0) {
    parts.push(`// no interactions detected — render-only smoke is above.`);
  }
  return parts.join("\n\n");
}

function emitClickTest(
  name: string,
  click: ClickHandler,
  allHandlers: string[],
  idx: number,
): string {
  const labelDesc = describeClickLabel(click);
  const selector = emitVitestSelector(click);
  const dispatch = emitVitestDispatch(click.event, selector);
  if (click.binding.kind === "prop") {
    const propName = click.binding.propName;
    const others = allHandlers.filter((h) => h !== propName);
    const isolationAsserts = others
      .map((h) => `  expect(handlers.${h}).not.toHaveBeenCalled();`)
      .join("\n");
    return `test("${name} fires ${propName} when ${labelDesc} (${click.event})", async () => {
  const { container } = renderTarget();
  void container;
  ${dispatch};
  expect(handlers.${propName}).toHaveBeenCalled();
${isolationAsserts || "  // no other handlers to isolate"}
});`;
  }
  // local / inline — smoke: no thrown error, no prop handler accidentally called.
  const isolationAsserts = allHandlers
    .map((h) => `  expect(handlers.${h}).not.toHaveBeenCalled();`)
    .join("\n");
  return `test("${name} ${click.event} on ${labelDesc} #${idx} is a smoke click", async () => {
  const { container } = renderTarget();
  void container;
  ${dispatch};
${isolationAsserts || "  // no prop handlers declared"}
});`;
}

function describeClickLabel(c: ClickHandler): string {
  // Used inside double-quoted JS test names — escape internal double quotes.
  const safe = (s: string): string => s.replace(/"/g, "'");
  if (c.label.kind === "text") return `'${safe(c.label.value)}'`;
  if (c.label.kind === "prop") return `the {${c.label.propName}} ${c.tag}`;
  if (c.label.kind === "aria") return `[aria-label='${safe(c.label.value)}']`;
  if (c.label.kind === "testid") return `[data-testid='${safe(c.label.value)}']`;
  return `the ${c.tag}`;
}

function emitFormTest(name: string, form: FormInfo, allHandlers: string[], idx: number): string {
  const fillSteps: string[] = [];
  for (const field of form.fields) {
    if (field.tag !== "input" && field.tag !== "textarea") continue;
    const sampleValue =
      field.type === "email"
        ? "user@example.com"
        : field.type === "password"
          ? "pa55word!"
          : field.type === "number"
            ? "42"
            : (field.label ?? field.name ?? "value");
    const lookup = field.label
      ? `screen.getByLabelText(${JSON.stringify(field.label)})`
      : field.placeholder
        ? `screen.getByPlaceholderText(${JSON.stringify(field.placeholder)})`
        : field.id
          ? `container.querySelector(${JSON.stringify(`#${field.id}`)})!`
          : field.name
            ? `container.querySelector(${JSON.stringify(`[name=${field.name}]`)})!`
            : undefined;
    if (!lookup) continue;
    fillSteps.push(
      `  await userEvent.type(${lookup} as HTMLElement, ${JSON.stringify(sampleValue)});`,
    );
  }
  const submitClick = `await userEvent.click(screen.getByRole("button", { name: /submit|sign\\s*up|save/i }));`;
  if (form.submit?.kind === "prop") {
    const propName = form.submit.propName;
    const others = allHandlers.filter((h) => h !== propName);
    const isolation = others
      .map((h) => `  expect(handlers.${h}).not.toHaveBeenCalled();`)
      .join("\n");
    return `test("${name} submits form #${idx} → ${propName} called once", async () => {
  const { container } = renderTarget();
  void container;
${fillSteps.join("\n")}
  ${submitClick}
  expect(handlers.${propName}).toHaveBeenCalled();
${isolation || "  // no other handlers to isolate"}
});`;
  }
  return `test("${name} form #${idx} fills + submits without error (smoke)", async () => {
  const { container } = renderTarget();
  void container;
${fillSteps.join("\n")}
  ${submitClick}
});`;
}

function emitFallbackHandlerTests(
  name: string,
  propsShape: PropsShape,
  unresolvedProps: string[],
): string {
  const handlers = [
    ...Object.keys(propsShape).filter((k) => /^on[A-Z]/.test(k)),
    ...unresolvedProps.filter((k) => /^on[A-Z]/.test(k)),
  ];
  if (handlers.length === 0) return `// no interactions and no handler props detected.`;
  return handlers
    .map(
      (p) => `
test("${name} invokes ${p} when first button clicked (fallback)", async () => {
  const { container } = renderTarget();
  const button = container.querySelector("button");
  if (button) {
    await userEvent.click(button);
    expect(handlers.${p}).toHaveBeenCalled();
  }
});`,
    )
    .join("\n");
}

function browserSpec(c: FlatComponent): string {
  const name = c.info.componentName;
  const propsLiteral = JSON.stringify(c.info.propsShape);
  const interactions = c.info.interactions;

  const interactionTests = interactions
    ? emitBrowserInteractionTests(interactions)
    : `
test(\`\${NAME}: click first button without errors (fallback)\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [NAME, DEFAULTS],
  );
  const btn = page.locator("button").first();
  if (await btn.count() > 0) await btn.click();
  expect(errors).toEqual([]);
});`;

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
${interactionTests}
`;
}

function emitBrowserInteractionTests(info: NonNullable<ComponentInfo["interactions"]>): string {
  const parts: string[] = [];
  for (let i = 0; i < info.clicks.length; i++) {
    const click = info.clicks[i];
    if (!click) continue;
    const labelDesc = describeClickLabel(click);
    const selector = emitPlaywrightSelector(click);
    const dispatch = emitPlaywrightDispatch(click.event, selector);
    parts.push(`
test(\`\${NAME}: ${click.event} on ${labelDesc} fires without error\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [NAME, DEFAULTS],
  );
  ${dispatch};
  await page.waitForTimeout(50);
  expect(errors).toEqual([]);
});`);
  }
  for (let i = 0; i < info.forms.length; i++) {
    const form = info.forms[i];
    if (!form) continue;
    const fillSteps: string[] = [];
    for (const field of form.fields) {
      if (field.tag !== "input" && field.tag !== "textarea") continue;
      const sampleValue =
        field.type === "email"
          ? "user@example.com"
          : field.type === "password"
            ? "pa55word!"
            : field.type === "number"
              ? "42"
              : (field.label ?? field.name ?? "value");
      const locator = field.label
        ? `page.getByLabel(${JSON.stringify(field.label)})`
        : field.placeholder
          ? `page.getByPlaceholder(${JSON.stringify(field.placeholder)})`
          : field.id
            ? `page.locator(${JSON.stringify(`#${field.id}`)})`
            : field.name
              ? `page.locator(${JSON.stringify(`[name=${field.name}]`)})`
              : undefined;
      if (!locator) continue;
      fillSteps.push(`  await ${locator}.fill(${JSON.stringify(sampleValue)});`);
    }
    parts.push(`
test(\`\${NAME}: form #${i} fills + submits without error\`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.evaluate(
    ([n, p]) => window.__profile.mount(n as string, p as Record<string, unknown>),
    [NAME, DEFAULTS],
  );
${fillSteps.join("\n")}
  await page.getByRole("button", { name: /submit|sign\\s*up|save/i }).click();
  await page.waitForTimeout(50);
  expect(errors).toEqual([]);
});`);
  }
  if (parts.length === 0) {
    parts.push(`
test(\`\${NAME}: no interactions detected — mount-only smoke above is sufficient\`, () => {});`);
  }
  return parts.join("\n");
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
