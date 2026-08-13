import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { scaffold } from "../src/scaffold/index.ts";
import { renderSuite } from "../src/scaffold/templates.ts";

const DASHBOARD = path.resolve(__dirname, "fixtures/Dashboard.tsx");
const API_SPEC = path.resolve(__dirname, "fixtures/_api.json");

async function tmpDir(): Promise<string> {
  const dir = path.join(
    import.meta.dir,
    ".tmp",
    `scaffold-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return dir;
}

describe("renderSuite", () => {
  test("writes expected files with expected anchors", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 3, includeChildren: true });
    const out = await tmpDir();
    const files = renderSuite({ tree, outDir: out, variants: 5, report: false });
    const paths = files.map((f) => f.relPath);
    expect(paths).toContain("package.json");
    expect(paths).toContain("tsconfig.json");
    expect(paths).toContain("playwright.config.ts");
    expect(paths).toContain("host/server.ts");
    expect(paths).toContain("host/index.html");
    expect(paths).toContain("host/main.tsx");
    expect(paths).toContain("profile/_helpers.ts");
    expect(paths).toContain("profile/_heap.ts");
    expect(paths).toContain("budgets.json");
    expect(paths).toContain("profile/Dashboard.profile.spec.ts");
    // "profile", not "tests": a suite emitted under flawless/tests/ is collected by
    // any project whose own test script filters on the substring "tests".
    expect(paths).toContain("profile/Hello.profile.spec.ts");
    expect(paths).toContain("profile/Card.profile.spec.ts");

    const main = files.find((f) => f.relPath === "host/main.tsx");
    expect(main).toBeDefined();
    const content = main?.content ?? "";
    expect(content).toContain("Profiler");
    expect(content).toContain('from "react-scan"');
    expect(content).toContain('"Dashboard": Dashboard');
    expect(content).toContain('"Hello": Hello');
    expect(content).toContain("window.__profile");

    const dashSpec = files.find((f) => f.relPath === "profile/Dashboard.profile.spec.ts");
    expect(dashSpec).toBeDefined();
    const sc = dashSpec?.content ?? "";
    expect(sc).toContain('NAME = "Dashboard"');
    expect(sc).toContain("mountComponent(page, NAME, DEFAULTS)");
    expect(sc).toContain("variant matrix");
    expect(sc).toContain("click rerender");
    expect(sc).toContain("forced rerender");
    // No .ts extension: the target project type-checks the emitted suite and
    // does not enable allowImportingTsExtensions.
    expect(sc).toContain('from "./_heap"');
    expect(sc).not.toContain('from "./_heap.ts"');
    expect(sc).toContain("bracketScenario");
    expect(sc).toContain("stress-click-rerender");

    const heap = files.find((f) => f.relPath === "profile/_heap.ts");
    expect(heap).toBeDefined();
    const hc = heap?.content ?? "";
    expect(hc).toContain("HeapProfiler.takeHeapSnapshot");
    expect(hc).toContain("HeapProfiler.collectGarbage");
    expect(hc).toContain("export async function bracketScenario");
    expect(hc).toContain("export async function takeHeapSnapshot");
    expect(hc).toContain("export async function repeatClick");
  });

  test("--report adds scripts/report.mjs", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const out = await tmpDir();
    const files = renderSuite({ tree, outDir: out, variants: 3, report: true });
    expect(files.some((f) => f.relPath === "scripts/report.mjs")).toBe(true);
  });
});

describe("renderSuite with --provider", () => {
  test("imports the provider and wraps the rendered tree", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const out = path.resolve(__dirname, ".tmp-provider");
    const files = renderSuite({
      tree,
      outDir: out,
      variants: 2,
      report: false,
      providerImportPath: "../../tests/fixtures/_AppProvider.tsx",
    });
    const main = files.find((f) => f.relPath === "host/main.tsx");
    expect(main).toBeDefined();
    const content = main?.content ?? "";
    // No .tsx: the target project type-checks the emitted host.
    expect(content).toContain('import AppProvider from "../../tests/fixtures/_AppProvider"');
    expect(content).toContain("createElement(AppProvider as never, null, tree)");
    expect(content).toContain("wrap(");
  });

  test("without --provider, wrap is the identity", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const out = await tmpDir();
    const files = renderSuite({ tree, outDir: out, variants: 2, report: false });
    const main = files.find((f) => f.relPath === "host/main.tsx");
    const content = main?.content ?? "";
    expect(content).not.toContain("AppProvider");
    expect(content).toContain("function wrap(tree: ReactNode): ReactNode {\n  return tree;\n}");
  });
});

describe("renderSuite with --api", () => {
  test("emits mock/server.ts + mock/routes.ts with routes from the spec", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const out = await tmpDir();
    const files = renderSuite({
      tree,
      outDir: out,
      variants: 2,
      report: false,
      mockRoutes: [
        { method: "GET", path: "/api/users", status: 200, body: [{ id: 1, name: "Alice" }] },
        { method: "POST", path: "/api/users", status: 201, body: { id: 0, name: "" } },
        { method: "GET", path: "/api/users/{id}", status: 200, body: { id: 1, name: "Alice" } },
      ],
    });
    const paths = files.map((f) => f.relPath);
    expect(paths).toContain("mock/server.ts");
    expect(paths).toContain("mock/routes.ts");

    const routesFile = files.find((f) => f.relPath === "mock/routes.ts");
    const rc = routesFile?.content ?? "";
    expect(rc).toContain('"path": "/api/users"');
    expect(rc).toContain('"path": "/api/users/{id}"');
    expect(rc).toContain('"method": "POST"');
    expect(rc).toContain('"status": 201');

    const serverFile = files.find((f) => f.relPath === "mock/server.ts");
    const sc = serverFile?.content ?? "";
    expect(sc).toContain("Bun.serve");
    expect(sc).toContain("process.env.MOCK_PORT");
    expect(sc).toContain("compile");

    const pwc = files.find((f) => f.relPath === "playwright.config.ts");
    const pc = pwc?.content ?? "";
    expect(pc).toContain("bun host/server.ts");
    expect(pc).toContain("bun mock/server.ts");
    expect(pc).toContain("http://127.0.0.1:5174");

    const host = files.find((f) => f.relPath === "host/server.ts");
    const hc = host?.content ?? "";
    expect(hc).toContain("MOCK_PORT");
    expect(hc).toContain("Proxy any other request");
  });

  test("without --api, no mock/ files or proxy in host", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const out = await tmpDir();
    const files = renderSuite({ tree, outDir: out, variants: 2, report: false });
    const paths = files.map((f) => f.relPath);
    expect(paths).not.toContain("mock/server.ts");
    expect(paths).not.toContain("mock/routes.ts");

    const host = files.find((f) => f.relPath === "host/server.ts");
    expect(host?.content ?? "").not.toContain("MOCK_PORT");
  });
});

describe("openapi extraction", () => {
  test("extractRoutes pulls examples and synthesises from schema", async () => {
    const { loadApiSpec, extractRoutes } = await import("../src/scaffold/openapi.ts");
    const spec = await loadApiSpec(API_SPEC);
    const routes = extractRoutes(spec);
    expect(routes.find((r) => r.method === "GET" && r.path === "/api/users")?.body).toEqual([
      { id: 1, name: "Alice" },
    ]);
    expect(routes.find((r) => r.method === "POST" && r.path === "/api/users")?.status).toBe(201);
    expect(routes.find((r) => r.method === "POST" && r.path === "/api/users")?.body).toEqual({
      id: 0,
      name: "",
    });
    expect(routes.find((r) => r.method === "GET" && r.path === "/api/users/{id}")?.body).toEqual({
      id: 1,
      name: "Alice",
    });
  });
});

describe("scaffold (file writes)", () => {
  test("writes the suite to disk and refuses to overwrite without --force", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 1, includeChildren: true });
    const out = await tmpDir();
    try {
      const written = await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: undefined,
      });
      expect(written.length).toBeGreaterThan(5);
      expect(existsSync(path.join(out, "package.json"))).toBe(true);
      expect(existsSync(path.join(out, "host/main.tsx"))).toBe(true);

      // Second write without --force should throw.
      let threw = false;
      try {
        await scaffold(tree, {
          outDir: out,
          variants: 3,
          force: false,
          report: false,
          provider: undefined,
          apiSpec: undefined,
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain("already exists");
      }
      expect(threw).toBe(true);

      // With --force, succeeds.
      const written2 = await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: true,
        report: false,
        provider: undefined,
        apiSpec: undefined,
      });
      expect(written2.length).toBeGreaterThan(5);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("renderUnitBrowser interaction-aware", () => {
  test("Toolbar unit spec targets each named button + asserts handler isolation", async () => {
    const { renderUnitBrowser } = await import("../src/scaffold-tests/templates.ts");
    const trees = [
      await analyse({
        entry: path.resolve(__dirname, "fixtures/Toolbar.tsx"),
        depth: 0,
        includeChildren: false,
      }),
    ];
    const files = renderUnitBrowser({ trees, outDir: await tmpDir(), variants: 3 });
    const unit = files.find((f) => f.relPath === "unit/Toolbar.test.tsx");
    expect(unit).toBeDefined();
    const src = unit?.content ?? "";
    expect(src).toContain("type Props = React.ComponentProps<typeof Toolbar>");
    expect(src).toContain("handlers: Record<string, ReturnType<typeof vi.fn>>");
    expect(src).toContain("merged as unknown as Props");
    expect(src).toContain('screen.getAllByRole("button", { name: "Save" })[0]');
    expect(src).toContain('screen.getAllByRole("button", { name: "Cancel" })[0]');
    expect(src).toContain('screen.getAllByRole("button", { name: "Delete" })[0]');
    expect(src).toContain("expect(handlers.onSave).toHaveBeenCalled()");
    expect(src).toContain("expect(handlers.onCancel).not.toHaveBeenCalled()");
    expect(src).toContain("expect(handlers.onDelete).not.toHaveBeenCalled()");
    // No fireEvent import (not used).
    expect(src).not.toContain("fireEvent");
    // No legacy first-button click fallback path.
    expect(src).not.toContain('container.querySelector("button")');
  });

  test("SignupForm unit spec fills labelled inputs + submits + asserts onSubmit", async () => {
    const { renderUnitBrowser } = await import("../src/scaffold-tests/templates.ts");
    const trees = [
      await analyse({
        entry: path.resolve(__dirname, "fixtures/SignupForm.tsx"),
        depth: 0,
        includeChildren: false,
      }),
    ];
    const files = renderUnitBrowser({ trees, outDir: await tmpDir(), variants: 3 });
    const unit = files.find((f) => f.relPath === "unit/SignupForm.test.tsx");
    expect(unit).toBeDefined();
    const src = unit?.content ?? "";
    expect(src).toContain('screen.getByLabelText("Name")');
    expect(src).toContain('screen.getByLabelText("Email")');
    expect(src).toContain('screen.getByLabelText("Password")');
    expect(src).toContain("expect(handlers.onSubmit).toHaveBeenCalled()");
  });

  test("IconButton unit spec uses aria-label locator + upgraded prop binding", async () => {
    const { renderUnitBrowser } = await import("../src/scaffold-tests/templates.ts");
    const trees = [
      await analyse({
        entry: path.resolve(__dirname, "fixtures/IconButton.tsx"),
        depth: 0,
        includeChildren: false,
      }),
    ];
    const files = renderUnitBrowser({ trees, outDir: await tmpDir(), variants: 3 });
    const unit = files.find((f) => f.relPath === "unit/IconButton.test.tsx");
    expect(unit).toBeDefined();
    const src = unit?.content ?? "";
    expect(src).toContain('screen.getAllByLabelText("close")[0]');
    expect(src).toContain("expect(handlers.onClose).toHaveBeenCalled()");
  });

  test("Toolbar perf spec targets a named button (not .first())", async () => {
    const tree = await analyse({
      entry: path.resolve(__dirname, "fixtures/Toolbar.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const out = await tmpDir();
    const files = renderSuite({ tree, outDir: out, variants: 3, report: false });
    const spec = files.find((f) => f.relPath === "profile/Toolbar.profile.spec.ts");
    expect(spec).toBeDefined();
    const sc = spec?.content ?? "";
    expect(sc).toContain('page.getByRole("button", { name: "Save" })');
    // Legacy fallback should be gone for components that have interactions.
    expect(sc).not.toContain('page.locator("button").first()');
  });
});
