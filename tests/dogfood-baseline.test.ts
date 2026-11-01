import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { STAMP_RE } from "../src/scaffold-tests/stamp.ts";

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
const stderrLines: string[] = [];

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
  // runCore's warn() writes to stderr even with log:false; chunk 5's marker
  // asserts a warning, so the run's stderr is captured here once.
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrLines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
  let result: Awaited<ReturnType<typeof runCore>>;
  try {
    result = await runCore({
      pattern: path.join(app, "src", "**", "*.tsx"),
      outDir,
      taskIds: [
        "perf-harness",
        "unit-browser",
        "perf-static",
        "a11y",
        "react-rules",
        "e2e",
        "load",
      ],
      nextjs: app,
      log: false,
      inlineSummary: false,
      colocate: true,
    });
  } finally {
    process.stderr.write = original;
  }
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

test("defect 2: the run excludes the suite dir from the app's own tsconfig", () => {
  // FIX-PLAN: chunk 2 — FLIPPED. The run now merges the suite dir into the
  // app tsconfig's `exclude` (src/tsconfigJson.ts), preserving the file's
  // formatting: a line-level insert after the last existing entry, nothing
  // else moved. Before the fix the app tsconfig was byte-identical after the
  // run and the generated files sat inside the app's TypeScript program:
  // measured on a copy of this fixture (deps installed), `bunx tsc --noEmit`
  // went from clean to 29 errors — all in `flawless/` (Bun-only host server
  // code) — and the app's own build died type-checking them. The native
  // TS2708 half (`Cannot use namespace 'jest' as a value` across
  // `flawless/unit/`) is the Expo twin of the same mechanism and stays
  // static here: a Next fixture emits vitest specs, not jest ones.
  const appTsconfig = JSON.parse(read("tsconfig.json")) as {
    exclude?: string[];
  };
  expect(appTsconfig.exclude).toContain("flawless");
  expect(read("tsconfig.json")).toContain('"exclude": ["node_modules", "flawless"]');
});

test("defect 3: the document-root spec imports renderToReadableStream from react-dom/server.browser", () => {
  // FIX-PLAN: chunk 3 — FLIPPED. The specifier is now MEASURED against the
  // react-dom the suite is pinned to (src/reactDomServerStream.ts): bare
  // "react-dom/server" is aliased by the emitted config to the file
  // server.js → require("./server.node") — the node build — which on the
  // fixture's react-dom 19.1.0 exports only renderToPipeableStream
  // renderToStaticMarkup renderToString version (measured). server.browser.js
  // carries renderToReadableStream on 19.1 AND 19.2 (19.2's node build gained
  // it too; the browser build kept it), so the specifier swap is safe across
  // the version gate. Before the fix this spec died with
  // "renderToReadableStream is not a function" — the same failure as in the
  // dogfood. The guard over rendered output lives in
  // tests/documentRootStream.test.ts.
  const spec = read("src", "app", "layout.flawless.test.tsx");
  expect(spec).toContain('import { renderToReadableStream } from "react-dom/server.browser"');
  expect(spec).not.toContain('from "react-dom/server";');
});

test("defect 4: a synchronous zustand hook is mocked as an async guess", () => {
  // FIX-PLAN: chunk 4 — FLIPPED. Measured 1 Nov: the layout spec mocked the
  // whole zustand family `vi.fn(async () => ({}))` — the 50-times pattern
  // that made `toasts.map is not a function`. Both mechanisms ran through
  // the emitter's no-evidence fallback (mocks.ts entry()), NOT through
  // `awaited`: the callers are SYNC components, which recorded no deps at
  // all. Now: (a) sync call sites are evidence (mockDeps), so the page's
  // `useToasts` gets a sync array fixture from its `.map` use site; (b) a
  // use*-shaped binding is sync by contract whatever `awaited` says; (c) a
  // package module no analysed file CALLS is not mocked at all — the
  // hand-verified dogfood fix was "zustand left real", and a curried sync
  // factory like `createStore<AppState>()((set) => …)` cannot survive any
  // guessed stub. The layout spec now carries no vi.mock at all and its
  // runtime went from `createStore(...) is not a function` to green.
  const layout = read("src", "app", "layout.flawless.test.tsx");
  expect(layout).not.toContain("vi.mock(");
  const page = read("src", "app", "page.flawless.test.tsx");
  expect(page).toMatch(/useToasts: vi\.fn\(\(\) => \(?\[\{/);
  expect(page).not.toMatch(/useToasts: vi\.fn\(async/);
});

test("defect 5: the catch-all flattening warns, and the handlers carry provenance", () => {
  // FIX-PLAN: chunk 5 — FLIPPED. The derived spec still has exactly the one
  // flattened path (the flattening is inherent to an AST walk over a hono
  // catch-all; the fix is that it stopped being silent): the run now warns,
  // naming the file and pointing at --api, and mocks/handlers.ts opens with a
  // provenance stamp plus a spec digest so a newer spec refreshes it instead
  // of it hiding behind "file exists" forever.
  const swagger = JSON.parse(readOut("swagger.json")) as { paths: Record<string, unknown> };
  expect(Object.keys(swagger.paths)).toEqual(["/api/{route}"]);
  const warning = stderrLines.find((l) => /catch-all/i.test(l));
  expect(warning, "the flattening warns on stderr").toBeDefined();
  expect(warning).toContain("src/app/api/[[...route]]/route.ts");
  expect(warning).toContain("--api");
  expect(warning).toMatch(/1 path derived from a catch-all router/);
  const handlers = readOut("mocks", "handlers.ts");
  // STAMP_RE includes the line terminator, so it is matched against the line
  // with its newline back — the same way splitStamp reads it.
  expect(`${handlers.split("\n")[0]}\n`).toMatch(STAMP_RE);
  expect(handlers).toMatch(/^\/\/ @flawless-spec sha256:[0-9a-f]{16}$/m);
});

test("defect 6: both playwright configs bound the default workers and pass the dev-shm flag", () => {
  // FIX-PLAN: chunk 6 — flipped. The emitted configs bound the local default
  // to min(4, cpus/2) and launch chromium with --disable-dev-shm-usage.
  //
  // Measured 1 Nov: `undefined` fell through to playwright's ½-CPU default;
  // the dogfood saw 1–3 renderer crashes per full run at that width.
  for (const cfg of ["playwright.config.ts", path.join("browser", "playwright.config.ts")]) {
    const text = readOut(cfg);
    expect(text).toMatch(
      /workers: process\.env\.FLAWLESS_WORKERS[\s\S]*?Math\.max\(1, Math\.min\(4, Math\.floor\(os\.cpus\(\)\.length \/ 2\)\)\),/,
    );
    expect(text).not.toMatch(/workers:[\s\S]*?: undefined,/);
    expect(text).toContain('args: ["--disable-dev-shm-usage"]');
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

test("defect 8: MCP stdio exit has a permanent stdio-client test", () => {
  // FIX-PLAN: chunk 7 — FLIPPED. The stdio client landed: the
  // "mcp exit contract" tests in tests/mcp.test.ts spawn a real
  // `bun src/bin.ts mcp` child, speak the protocol, and time the process from
  // its last answer (or from stdin closing) to exit — idle server and one
  // that just drained a flawless_run. Measured 1 Nov: 4–31 ms on the clean
  // paths; the dogfood's >60 s hang was the client keeping stdin open (the
  // session is meant to stay alive) plus one real hole — a straggler holding
  // the child's output pipes — which chunk 7's run.ts fix bounds. The
  // contract is in docs/mcp.md.
  const mcpTests = readFileSync(path.resolve(__dirname, "mcp.test.ts"), "utf8");
  expect(mcpTests).toContain("mcp exit contract");
  expect(mcpTests).toContain("exitClock");
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
