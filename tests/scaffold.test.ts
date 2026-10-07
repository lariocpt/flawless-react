import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyse } from "../src/analyse/index.ts";
import { scaffold } from "../src/scaffold/index.ts";
import { renderSuite } from "../src/scaffold/templates.ts";
import { stamp } from "../src/scaffold-tests/stamp.ts";

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
    expect(paths).toContain("host/registry.ts");
    expect(paths).toContain("profile/_helpers.ts");
    expect(paths).toContain("profile/_heap.ts");
    expect(paths).toContain("budgets.json");
    expect(paths).toContain("profile/Dashboard.profile.spec.ts");
    // "profile", not "tests": a suite emitted under flawless/tests/ is collected by
    // any project whose own test script filters on the substring "tests".
    expect(paths).toContain("profile/Hello.profile.spec.ts");
    expect(paths).toContain("profile/Card.profile.spec.ts");

    // FR-016 split: the mount tables live in a REGENERATED registry.ts; the
    // write-once main.tsx is only the wrapper and reads them via ./registry.
    const registry = files.find((f) => f.relPath === "host/registry.ts");
    expect(registry).toBeDefined();
    expect(registry?.writeOnce).toBeUndefined();
    const rc = registry?.content ?? "";
    expect(rc).toContain("export type Component");
    expect(rc).toContain("export const REGISTRY");
    expect(rc).toContain("export const FN_PROPS");
    expect(rc).toContain("export const WRAP_IN");
    expect(rc).toContain('"Dashboard": Dashboard');
    expect(rc).toContain('"Hello": Hello');

    const main = files.find((f) => f.relPath === "host/main.tsx");
    expect(main).toBeDefined();
    expect(main?.writeOnce).toBe(true);
    const content = main?.content ?? "";
    expect(content).toContain("Profiler");
    expect(content).toContain('from "react-scan"');
    expect(content).toContain('from "./registry"');
    // The extension points: internal lookups go through the ALL_* spreads,
    // so a hand-registered entry — component, function-prop stubs, wrapper
    // chain alike — behaves like a generated one.
    expect(content).toContain("...REGISTRY");
    expect(content).toContain("ALL[name]");
    expect(content).toContain("...FN_PROPS");
    expect(content).toContain("ALL_FN_PROPS[name]");
    expect(content).toContain("...WRAP_IN");
    expect(content).toContain("ALL_WRAP_IN[name]");
    expect(content).not.toContain('"Dashboard": Dashboard');
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

  test("the emitted README states facts about the suite that are true", async () => {
    // The prose guard in emittedExecution.test.ts checks that every `bun run
    // <name>` names a declared script. These three are wrong FACTS rather than
    // wrong script names, so nothing structural can catch them.
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const files = renderSuite({ tree, outDir: await tmpDir(), variants: 3, report: false });
    const entry = files.find((f) => f.relPath === "README.md");
    const md = entry?.content ?? "";

    // The link is the only pointer home from inside a suite the user committed.
    expect(md).toContain("github.com/lariocpt/flawless-react");

    // It credited `react-performance-testing`, which the suite neither uses nor
    // installs — hostMain measures with React's own Profiler, and the emitted
    // package.json pins react, react-dom and react-scan only.
    expect(md).toContain("<Profiler>");
    expect(md).not.toContain("react-performance-testing");

    // It claimed "there is no regeneration step that overwrites you" while
    // carrying no writeOnce flag, so --force discarded every edit that sentence
    // invited. The sibling READMEs (load/, e2e/) are regenerated deliberately,
    // so the fix is the sentence, not the behaviour — this asserts both halves
    // agree.
    expect(entry?.writeOnce).toBeUndefined();
    expect(md).toContain("regenerated by");
  });

  test("the emitted tsconfig type-checks every emitted directory of TypeScript", async () => {
    // mock/ was outside `include`, so `bunx tsc --noEmit` inside a generated
    // suite checked everything except the server the README tells you to run.
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const files = renderSuite({ tree, outDir: await tmpDir(), variants: 3, report: false });
    const tsconfig = files.find((f) => f.relPath === "tsconfig.json");
    expect(tsconfig).toBeDefined();
    const { include } = JSON.parse(tsconfig?.content ?? "{}") as { include: string[] };

    expect(include).toContain("mock/**/*");
    expect(include).toContain("host/**/*");
    expect(include).toContain("profile/**/*");
    // scripts/ stays out on purpose: it holds one .mjs, and tsc ignores JS
    // without allowJs, so the glob would look like coverage and give none.
    expect(include).not.toContain("scripts/**/*");
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
    // Evaluation order across the split must match the monolith: the provider
    // module evaluates before ./registry pulls every component module, so
    // component-module side effects still see the provider's (i18n init,
    // interceptor installs).
    expect(content.indexOf("import AppProvider")).toBeLessThan(
      content.indexOf('from "./registry"'),
    );
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
  // FR-028: the old guard threw "already exists" here, which core.ts converted
  // into a failed TaskResult — a healthy adopted suite exited 1 on every
  // no-force run. The lifecycle: generated → refreshed → kept (FR-028).
  test("a second no-force scaffold refreshes derived files and keeps the write-once set", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 1, includeChildren: true });
    const out = await tmpDir();
    try {
      const first = await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: API_SPEC,
      });
      expect(first.status).toBe("generated");
      expect(first.written.length).toBeGreaterThan(5);
      expect(existsSync(path.join(out, "package.json"))).toBe(true);
      expect(existsSync(path.join(out, "host/main.tsx"))).toBe(true);

      // The full writeOnce set since wave 1, each carrying a sentinel byte.
      const budgets = path.join(out, "budgets.json");
      const main = path.join(out, "host/main.tsx");
      const routes = path.join(out, "mock/routes.ts");
      const wsYaml = path.join(out, "pnpm-workspace.yaml");
      await Bun.write(budgets, '{"sentinel":true}\n');
      await Bun.write(main, "// sentinel\n");
      await Bun.write(routes, "// sentinel\n");
      const spec = path.join(out, "profile/Dashboard.profile.spec.ts");
      await Bun.write(spec, "// stale\n");

      const second = await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: API_SPEC,
      });
      expect(second.status).toBe("refreshed");
      expect([...second.kept].sort()).toEqual([budgets, main, routes, wsYaml].sort());
      expect(await Bun.file(budgets).text()).toBe('{"sentinel":true}\n');
      expect(await Bun.file(main).text()).toBe("// sentinel\n");
      expect(await Bun.file(routes).text()).toBe("// sentinel\n");
      // Derived files are rewritten exactly as a fresh scaffold would.
      expect(await Bun.file(spec).text()).not.toBe("// stale\n");

      // --force: unchanged semantics — a full regenerate is also "refreshed",
      // and the write-once set is still not --force's to take.
      await Bun.write(spec, "// stale\n");
      const third = await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: true,
        report: false,
        provider: undefined,
        apiSpec: API_SPEC,
      });
      expect(third.status).toBe("refreshed");
      expect(await Bun.file(budgets).text()).toBe('{"sentinel":true}\n');
      expect(await Bun.file(spec).text()).not.toBe("// stale\n");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("a newly analysed tree lands in registry.ts while the kept main.tsx is byte-identical", async () => {
    // FR-016: the registry used to be trapped inside the write-once main.tsx,
    // so a component the analyser learned to see could never mount. Now a plain
    // no-force re-run refreshes host/registry.ts.
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const toolbar = await analyse({
      entry: path.resolve(__dirname, "fixtures/Toolbar.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const out = await tmpDir();
    try {
      await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: undefined,
      });
      const registry = path.join(out, "host/registry.ts");
      const main = path.join(out, "host/main.tsx");
      expect(await Bun.file(registry).text()).not.toContain('"Toolbar":');
      // Sentinel: hand wiring in the wrapper — the edits the split protects.
      const wired = `${await Bun.file(main).text()}// hand wiring sentinel\n`;
      await Bun.write(main, wired);

      const second = await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: undefined,
        extraTrees: [toolbar],
      });
      expect(second.status).toBe("refreshed");
      expect(await Bun.file(registry).text()).toContain(
        '"Toolbar": Toolbar as unknown as Component,',
      );
      expect(await Bun.file(main).text()).toBe(wired);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("keepExisting writes nothing over an existing suite and reads its banner", async () => {
    // The --changed contract: changed narrows the run, never churns generation,
    // so the harness scaffold must not touch even a derived file.
    const { VERSION } = await import("../src/version.ts");
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const out = await tmpDir();
    try {
      await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: undefined,
      });
      const spec = path.join(out, "profile/Dashboard.profile.spec.ts");
      await Bun.write(spec, "// stale\n");
      // A FOREIGN version in the banner: with the tool's own VERSION here, a
      // parse that ignores its capture and echoes VERSION passes identically
      // (a mutation proved it). The banner exists to name an OLDER generating
      // tool after an upgrade — assert the captured value comes back verbatim.
      const marker = path.join(out, "playwright.config.ts");
      const markerBytes = (await Bun.file(marker).text()).replace(
        /Generated by flawless-react \S+/,
        "Generated by flawless-react 9.9.9-test",
      );
      await Bun.write(marker, markerBytes);

      const kept = await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: undefined,
        keepExisting: true,
      });
      expect(kept.status).toBe("kept");
      expect(kept.written).toEqual([]);
      expect(kept.kept).toEqual([]);
      expect(kept.existingVersion).toBe("9.9.9-test");
      expect(kept.existingVersion).not.toBe(VERSION);
      expect(await Bun.file(spec).text()).toBe("// stale\n");
      // The marker itself is part of "writes nothing": a kept path that
      // helpfully bumped the banner would corrupt the provenance it records.
      expect(await Bun.file(marker).text()).toBe(markerBytes);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("keepExisting over a fresh outDir still generates in full", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const out = await tmpDir();
    try {
      const res = await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: undefined,
        keepExisting: true,
      });
      expect(res.status).toBe("generated");
      expect(res.written.length).toBeGreaterThan(5);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  test("a suite without the banner reports no version rather than guessing", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 0, includeChildren: false });
    const out = await tmpDir();
    try {
      await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: undefined,
      });
      // A pre-banner suite: its marker file predates the generated-by header.
      const marker = path.join(out, "playwright.config.ts");
      const stripped = (await Bun.file(marker).text())
        .split("\n")
        .filter((l) => !l.includes("Generated by flawless-react"))
        .join("\n");
      await Bun.write(marker, stripped);

      const kept = await scaffold(tree, {
        outDir: out,
        variants: 3,
        force: false,
        report: false,
        provider: undefined,
        apiSpec: undefined,
        keepExisting: true,
      });
      expect(kept.status).toBe("kept");
      expect(kept.existingVersion).toBeUndefined();
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
    // getAllBy*[0], not getBy*: a labelled field rendered inside .map() resolves
    // to one element per row, and getBy* throws on that rather than picking one.
    expect(src).toContain('screen.getAllByLabelText("Name")[0]');
    expect(src).toContain('screen.getAllByLabelText("Email")[0]');
    expect(src).toContain('screen.getAllByLabelText("Password")[0]');
    expect(src).toContain("expect(handlers.onSubmit).toHaveBeenCalled()");
    // The submit control comes from the markup — <button type="submit">Sign up</button>
    // — not from matching its copy against a list of likely verbs.
    expect(src).toContain('screen.getAllByRole("button", { name: "Sign up" })[0]');
    expect(src).not.toContain("sign\\s*up|save|send");
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
    // exact: true — Playwright's `name` is a case-insensitive substring match by
    // default, so { name: "Save" } would also claim "Save and close".
    expect(sc).toContain('page.getByRole("button", { name: "Save", exact: true })');
    // Legacy fallback should be gone for components that have interactions.
    expect(sc).not.toContain('page.locator("button").first()');
  });
});

// FR-062: a profile spec is only rewritten while its component stays in the
// host. When the component leaves the host set (a new undecidable guard, a
// render-mode change, a deleted file) the spec is no longer rendered — and
// without a sweep it sits in profile/ forever, failing at mount with
// "unknown component": the suite red by the tool's own doing. The sweep
// retires the ones whose stamp proves them untouched tool output, and names
// the ones it refuses to touch (hand work or unprovable) — the same
// provenance model as the colocated and browser specs.
describe("stale profile spec sweep (FR-062)", () => {
  async function setup(): Promise<{
    out: string;
    tree: Awaited<ReturnType<typeof analyse>>;
    plant: (name: string, content: string) => Promise<string>;
  }> {
    const tree = await analyse({ entry: DASHBOARD, depth: 3, includeChildren: true });
    const out = await tmpDir();
    await scaffold(tree, {
      outDir: out,
      variants: 3,
      force: false,
      report: false,
      provider: undefined,
      apiSpec: API_SPEC,
    });
    const profileDir = path.join(out, "profile");
    await mkdir(profileDir, { recursive: true });
    const plant = async (name: string, content: string): Promise<string> => {
      const abs = path.join(profileDir, `${name}.profile.spec.ts`);
      await writeFile(abs, content);
      return abs;
    };
    return { out, tree, plant };
  }

  test("profile specs carry the provenance stamp", async () => {
    const tree = await analyse({ entry: DASHBOARD, depth: 3, includeChildren: true });
    const out = await tmpDir();
    const files = renderSuite({ tree, outDir: out, variants: 3, report: false });
    const spec = files.find((f) => f.relPath === "profile/Dashboard.profile.spec.ts");
    expect(spec).toBeDefined();
    expect(spec?.content).toMatch(
      /^\/\/ @flawless-generated sha256:[0-9a-f]{16} flawless-react@\S+\n/,
    );
  });

  test("removes a stale profile spec whose stamp is untouched", async () => {
    const { out, tree, plant } = await setup();
    const ghost = await plant("Ghost", stamp("export {};\n"));
    const second = await scaffold(tree, {
      outDir: out,
      variants: 3,
      force: false,
      report: false,
      provider: undefined,
      apiSpec: API_SPEC,
    });
    expect(second.staleRemoved).toContain(ghost);
    expect(second.staleKept).toEqual([]);
    expect(existsSync(ghost)).toBe(false);
  });

  test("keeps a stale profile spec whose body no longer matches its stamp (hand work)", async () => {
    const { out, tree, plant } = await setup();
    const ghost = await plant("GhostEdited", `${stamp("export {};\n")}// hand note\n`);
    const second = await scaffold(tree, {
      outDir: out,
      variants: 3,
      force: false,
      report: false,
      provider: undefined,
      apiSpec: API_SPEC,
    });
    expect(second.staleRemoved).toEqual([]);
    expect(second.staleKept).toEqual([{ abs: ghost, verdict: "edited" }]);
    expect(existsSync(ghost)).toBe(true);
  });

  test("keeps a stale profile spec with no stamp (unprovable)", async () => {
    const { out, tree, plant } = await setup();
    const ghost = await plant("GhostStampless", "export {};\n");
    const second = await scaffold(tree, {
      outDir: out,
      variants: 3,
      force: false,
      report: false,
      provider: undefined,
      apiSpec: API_SPEC,
    });
    expect(second.staleRemoved).toEqual([]);
    expect(second.staleKept).toEqual([{ abs: ghost, verdict: "stampless" }]);
    expect(existsSync(ghost)).toBe(true);
  });

  test("does not touch profile specs that are still rendered", async () => {
    const { out, tree } = await setup();
    const live = path.join(out, "profile", "Dashboard.profile.spec.ts");
    expect(existsSync(live)).toBe(true);
    const second = await scaffold(tree, {
      outDir: out,
      variants: 3,
      force: false,
      report: false,
      provider: undefined,
      apiSpec: API_SPEC,
    });
    // Still rendered: re-written (not swept), and absent from both sweep lists.
    expect(second.staleRemoved).toEqual([]);
    expect(second.staleKept).toEqual([]);
    expect(existsSync(live)).toBe(true);
    expect((await Bun.file(live).text()).length).toBeGreaterThan(0);
  });
});
