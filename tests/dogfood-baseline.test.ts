import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";

/**
 * The dogfood baseline harness (DOGFOOD-0.3.1-FIX-PLAN.md, Chunk 0).
 *
 * Generates a suite against `tests/fixtures/aliased-next-app/` — a tiny Next
 * app carrying every shape the 0.3.1 dogfood report needed: a `paths`-only
 * tsconfig (no `baseUrl`), an async root layout, an async RSC page awaiting a
 * data function, a client component reading a synchronous zustand hook, and a
 * hono-style catch-all API route.
 *
 * Every test below asserts the CURRENT behaviour measured on 1 Nov 2026, one
 * `// FIX-PLAN: chunk N` marker per planned fix. Each chunk flips its own
 * marker to the correct behaviour instead of inventing a harness. Defect 1's
 * marker is flipped in the same PR that fixes it (chunk 1). A defect that does
 * not reproduce here is recorded as such — that is a result, not a gap.
 *
 * The runtime reproduction of defect #1 (browser plane webServer exit 1)
 * cannot live here: it needs installed react/playwright. It was measured by
 * hand on a copy of this fixture; the numbers are in `tests/fixtures/README.md`
 * and the PR that added this file. What IS asserted here is the mechanism:
 * the harness tsconfig is emitted for a Next host and carries no aliases.
 */

const FIXTURE = path.resolve(__dirname, "fixtures", "aliased-next-app");

const tmpDirs: string[] = [];

let app: string;
let outDir: string;

function read(...rel: string[]): string {
  return readFileSync(path.join(app, ...rel), "utf8");
}

function readOut(...rel: string[]): string {
  return readFileSync(path.join(outDir, ...rel), "utf8");
}

beforeAll(async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "flawless-dogfood-baseline-"));
  tmpDirs.push(root);
  app = path.join(root, "app");
  cpSync(FIXTURE, app, { recursive: true });
  outDir = path.join(app, "flawless");
  const result = await runCore({
    pattern: path.join(app, "src", "**", "*.tsx"),
    outDir,
    taskIds: ["perf-harness", "unit-browser", "perf-static", "a11y", "react-rules", "e2e", "load"],
    nextjs: app,
    log: false,
    inlineSummary: false,
    colocate: true,
  });
  expect(result.exitCode).toBe(0);
}, 120_000);

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("the generation run itself is green and every selected task reports ok", () => {
  // The control for every assertion below: if this reddens, the defect
  // assertions below measure a broken run, not the tool.
  expect(existsSync(path.join(outDir, "provider.tsx"))).toBe(true);
  expect(existsSync(path.join(outDir, "vitest.config.mts"))).toBe(true);
});

test("defect 1: the harness tsconfig carries the app's path aliases, relative to the app root", () => {
  // FIX-PLAN: chunk 1 — FLIPPED. The harness tsconfig is emitted for Next
  // hosts by src/scaffold-tests/index.ts (write-once, guarded only by
  // skipInnerPackageJson, which no caller sets — NOT the scaffold
  // templates.ts:158 non-Next branch the plan blamed), and it now carries
  // every target paths alias rewritten from the app root, plus the target
  // baseUrl. Before the fix this file had neither, Bun resolved provider.tsx's
  // `@/…` through it, and the browser/perf webServers died at startup with
  // `Could not resolve: "@/components/providers/store-provider"`.
  const harness = JSON.parse(readOut("tsconfig.json")) as {
    compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  };
  expect(harness.compilerOptions?.baseUrl).toBe("..");
  expect(harness.compilerOptions?.paths).toEqual({ "@/*": ["src/*"] });
  // Relative bytes only — the suite is committed and must not name its machine.
  expect(readOut("tsconfig.json")).not.toContain(app);
  // The import this exists to resolve:
  expect(read("flawless", "provider.tsx")).toContain(
    'import { StoreProvider } from "@/components/providers/store-provider"',
  );
});

test("defect 2: the run never touches the app's own tsconfig exclude", () => {
  // FIX-PLAN: chunk 2 — flip to: the app tsconfig's exclude contains the
  // suite dir ("flawless"), added with the file's formatting preserved.
  //
  // Measured 1 Nov: the app tsconfig is byte-identical after the run; the
  // generated files sit inside the app's TypeScript program, so the host's
  // own `tsc`/`next build` chokes on them (TS2708 across unit specs in the
  // dogfood's native app).
  const appTsconfig = JSON.parse(read("tsconfig.json")) as {
    exclude?: string[];
  };
  expect(appTsconfig.exclude).toEqual(["node_modules"]);
  expect(read("tsconfig.json")).toContain('"exclude": ["node_modules"]');
});

test("defect 3: the document-root spec imports renderToReadableStream from react-dom/server", () => {
  // FIX-PLAN: chunk 3 — flip to: the import names react-dom/server.browser,
  // which the generated vitest config actually aliases to the build that
  // exports renderToReadableStream.
  //
  // Measured 1 Nov on the fixture's async root layout spec — the same import
  // that failed with "renderToReadableStream is not a function" in the dogfood.
  const spec = read("src", "app", "layout.flawless.test.tsx");
  expect(spec).toContain('import { renderToReadableStream } from "react-dom/server"');
});

test("defect 4: a synchronous zustand hook is mocked as an async guess", () => {
  // FIX-PLAN: chunk 4 — flip to: hooks the source calls synchronously get
  // sync mocks with a shape implied by the use sites ([] for .map), not
  // `vi.fn(async () => ({}))`.
  //
  // Measured 1 Nov: the layout spec (which mounts the derived provider around
  // the store) mocks the whole zustand family as async — exactly the 50-times
  // pattern that made `toasts.map is not a function` in the dogfood.
  const spec = read("src", "app", "layout.flawless.test.tsx");
  expect(spec).toMatch(/vi\.mock\("zustand", \(\) => \(\{ useStore: vi\.fn\(async/);
  expect(spec).toContain("zustand/react/shallow");
});

test("defect 5: the catch-all router flattens to one swagger path and nothing warns", () => {
  // FIX-PLAN: chunk 5 — flip to: a warning naming the catch-all file and
  // pointing at --api, and handlers provenance so a newer spec refreshes them.
  //
  // Measured 1 Nov: the derived spec has exactly the one flattened path, the
  // same "/api/{route}" the dogfood derived from its hono catch-all (71 real
  // paths behind it there).
  const swagger = JSON.parse(readOut("swagger.json")) as { paths: Record<string, unknown> };
  expect(Object.keys(swagger.paths)).toEqual(["/api/{route}"]);
  const report = readOut("REPORT.md");
  expect(report).not.toMatch(/catch-all/i);
});

test("defect 6: both playwright configs leave workers unbounded and pass no dev-shm flag", () => {
  // FIX-PLAN: chunk 6 — flip to: a bounded default (FLAWLESS_WORKERS ??
  // (CI ? 1 : min(4, cpus/2))) and --disable-dev-shm-usage.
  //
  // Measured 1 Nov: `undefined` falls through to playwright's ½-CPU default;
  // the dogfood saw 1–3 renderer crashes per full run at that width.
  for (const cfg of ["playwright.config.ts", path.join("browser", "playwright.config.ts")]) {
    const text = readOut(cfg);
    expect(text).toMatch(/workers: process\.env\.FLAWLESS_WORKERS[\s\S]*?: undefined,/);
    expect(text).not.toContain("--disable-dev-shm-usage");
  }
});

test("defect 7: the RSC page spec resolves async components by flattening children through cloneElement", () => {
  // FIX-PLAN: chunk 9 — flip to: promise-valued props/children awaited,
  // static children not flattened into a keyless array, render inside
  // Suspense + act.
  //
  // Measured 1 Nov: the emitted spec for the fixture's async page carries the
  // mechanism the dogfood probe identified — resolveAsyncUi rebuilds children
  // as a flat array via cloneElement(el, {}, resolved) and nothing wraps the
  // render in Suspense/act. The runtime symptom (empty container, "A
  // suspended resource finished loading inside a test") needs the unit plane
  // actually running (installed vitest + jsdom), which this generation-only
  // harness does not start; chunk 9 proves the symptom on this fixture.
  const spec = read("src", "app", "page.flawless.test.tsx");
  expect(spec).toContain("async function resolveAsyncUi(");
  expect(spec).toContain("cloneElement(el, {}, resolved)");
  expect(spec).not.toMatch(/Suspense/);
});

test("defect 8: MCP stdio exit is not asserted here", () => {
  // FIX-PLAN: chunk 7 — the exit-after-stdin-close contract needs a stdio
  // client (spawn `flawless-react mcp`, initialize, tools/call, close stdin,
  // measure teardown). That test belongs to chunk 7 with a bounded time
  // assertion; a timing assertion here would only prove the runner is not
  // slower than the bound. This marker exists so chunk 7 flips a named
  // placeholder instead of inventing one.
  expect(existsSync(path.resolve(__dirname, "..", "src", "mcp", "server.ts"))).toBe(true);
});

test("defect 9: the emitted setup.ts is not lint-clean under a noExplicitAny host config", () => {
  // FIX-PLAN: chunk 8 — flip to: zero `: any` occurrences (or scoped
  // suppression comments naming the rule, each with a reason).
  //
  // Measured 1 Nov on this fixture: 4 occurrences (the dogfood app counted 5;
  // the count tracks the emitted canvas-stub surface, not the app). The
  // fixture's biome.json raises noExplicitAny to error, so a host with that
  // gate could not commit this file.
  const anyCount = (readOut("setup.ts").match(/: any\b/g) ?? []).length;
  expect(anyCount).toBeGreaterThan(0);
});
