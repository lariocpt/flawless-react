import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { walkApiRoutes } from "../src/nextjs/apiRoutes.ts";
import {
  detectNextjs,
  ensureFormatterIgnores,
  mergeIntoNextPackageJson,
} from "../src/nextjs/detect.ts";
import { fetchLiveSwagger, loadLocalSpec, parseSpecRoutes } from "../src/nextjs/liveSpec.ts";
import {
  renderBrowserSetup,
  renderMswHandlers,
  renderNodeSetup,
} from "../src/nextjs/mswHandlers.ts";
import {
  ensureClientProviderWrapper,
  isUsableUnitProvider,
} from "../src/nextjs/providerWrapper.ts";
import { devScriptPort, pageFileToRoute } from "../src/nextjs/routes.ts";
import { buildSwagger } from "../src/nextjs/swagger.ts";
import { loadApiSpec } from "../src/scaffold/openapi.ts";
import type { NextjsContext } from "../src/types.ts";

const NEXTAPP = path.resolve(__dirname, "fixtures/nextapp");
const APP_DIR = path.join(NEXTAPP, "src", "app");
const LAYOUT = path.join(APP_DIR, "layout.tsx");
const PROVIDERS = path.join(NEXTAPP, "src", "components", "Providers.tsx");
const SPEC = path.join(NEXTAPP, "openapi.json");

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-nextjs-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("detectNextjs", () => {
  // The documented programmatic contract is "bad input throws UsageError";
  // detect.ts threw plain Error, so `--nextjs <bad-path>` exited 1 (internal
  // error) instead of 2 like every other usage mistake.
  test("bad --nextjs input throws UsageError", async () => {
    const { UsageError } = await import("../src/types.ts");
    try {
      await detectNextjs("/nonexistent-dir-for-this-test");
      throw new Error("expected detectNextjs to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
    }
  });

  test("finds the app router through src/app and uses layout.tsx as the app resolver", async () => {
    const ctx = await detectNextjs(NEXTAPP);
    expect(ctx.root).toBe(NEXTAPP);
    expect(ctx.router).toBe("app");
    // routerRoot is not on the context, but the resolver path proves it went through src/app.
    expect(ctx.appResolver).toBe(LAYOUT);
    expect(ctx.apiRoutes.length).toBeGreaterThan(0);
  });

  test("collects app-router API routes with the HTTP methods each file exports", async () => {
    const ctx = await detectNextjs(NEXTAPP);
    const items = ctx.apiRoutes.find((r) => r.path === "/api/items");
    expect(items).toBeDefined();
    expect(items?.methods).toEqual(["GET", "POST"]);
    expect(items?.file).toBe(path.join(APP_DIR, "api", "items", "route.ts"));

    const health = ctx.apiRoutes.find((r) => r.file.includes("health"));
    expect(health).toBeDefined();
    expect(health?.methods).toEqual(["GET"]);
  });

  test("rejects a directory that is not a Next.js project", async () => {
    const dir = tmpDir();
    let message = "";
    try {
      await detectNextjs(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("does not look like a Next.js project");
  });

  test("rejects a directory that does not exist", async () => {
    const missing = path.join(tmpDir(), "nope");
    let message = "";
    try {
      await detectNextjs(missing);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("directory not found");
  });
});

describe("walkApiRoutes route groups", () => {
  test("route groups vanish from the URL and no detected path has a double slash", async () => {
    const routes = await walkApiRoutes("app", APP_DIR);
    const health = routes.find((r) => r.file.includes("health"));
    // A (group) segment maps to "" and must be dropped before joining, or the
    // path grows a "//" that no request will ever match.
    expect(health?.path).toBe("/api/health");
    for (const r of routes) expect(r.path).not.toContain("//");
    expect(routes.find((r) => r.path === "/api/items")).toBeDefined();
  });
});

describe("pageFileToRoute", () => {
  test("maps a dynamic app-router page to its url path, params and spec stem", () => {
    const route = pageFileToRoute(path.join(APP_DIR, "items", "[id]", "page.tsx"), "app", APP_DIR);
    expect(route).toEqual({ urlPath: "/items/[id]", params: ["id"], specStem: "items-id" });
  });

  test("maps the root page to /", () => {
    const route = pageFileToRoute(path.join(APP_DIR, "page.tsx"), "app", APP_DIR);
    expect(route?.urlPath).toBe("/");
    expect(route?.params).toEqual([]);
    expect(route?.specStem).toBe("index");
  });

  test("returns undefined for non-page files, the pages router, and files outside the root", () => {
    expect(pageFileToRoute(path.join(APP_DIR, "layout.tsx"), "app", APP_DIR)).toBeUndefined();
    expect(pageFileToRoute(path.join(APP_DIR, "page.tsx"), "pages", APP_DIR)).toBeUndefined();
    expect(
      pageFileToRoute(path.resolve(__dirname, "fixtures/Card.tsx"), "app", APP_DIR),
    ).toBeUndefined();
  });
});

describe("devScriptPort", () => {
  test("parses the port out of the fixture's dev script and falls back to 3000", () => {
    const pkg = JSON.parse(readFileSync(path.join(NEXTAPP, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.dev).toBe("next dev -p 3123");
    expect(devScriptPort(pkg.scripts?.dev)).toBe(3123);
    expect(devScriptPort("next dev")).toBe(3000);
    expect(devScriptPort(undefined)).toBe(3000);
    // Both of these used to fall through to 3000, and the emitted e2e config
    // then waited out its full 120s webServer timeout on a port nobody served.
    expect(devScriptPort("next dev -p3001")).toBe(3001);
    expect(devScriptPort("PORT=4100 next dev")).toBe(4100);
    expect(devScriptPort("next dev --port=4000")).toBe(4000);
  });
});

describe("isUsableUnitProvider", () => {
  test("rejects the async layout that imports next/font", () => {
    expect(isUsableUnitProvider(LAYOUT)).toBe(false);
  });

  test("accepts a sync client provider component and rejects unreadable files", () => {
    expect(isUsableUnitProvider(PROVIDERS)).toBe(true);
    expect(isUsableUnitProvider(path.join(NEXTAPP, "src", "components", "Missing.tsx"))).toBe(
      false,
    );
  });

  test("rejects a sync layout that renders the <html> document shell", () => {
    // A sync root layout passes the async/server-import checks, so it used to
    // be mounted raw as the unit provider. RTL nests its <html> inside the
    // container div ("In HTML, <html> cannot be a child of <div>"); jsdom's
    // node-list invariants break under that nesting, and React's
    // continuous-event dispatch walks them — a pointer click wedges the
    // worker at 100% CPU forever (chanhdai's ThemeToggle click spec).
    const dir = tmpDir();
    const layout = path.join(dir, "layout.tsx");
    writeFileSync(
      layout,
      `import type { ReactNode } from "react";
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    );
    expect(isUsableUnitProvider(layout)).toBe(false);
  });
});

describe("ensureClientProviderWrapper", () => {
  test("derives provider.tsx from the {children}-enclosing client providers only", async () => {
    const ctx = await detectNextjs(NEXTAPP);
    const outDir = tmpDir();
    const result = ensureClientProviderWrapper(ctx, outDir);
    expect(result).toBeDefined();
    expect(result?.created).toBe(true);
    expect(result?.path).toBe(path.join(outDir, "provider.tsx"));
    expect(result?.included).toEqual(["Providers"]);

    const src = readFileSync(path.join(outDir, "provider.tsx"), "utf8");
    expect(src.startsWith('"use client";')).toBe(true);
    expect(src).toContain('import Providers from "@/components/Providers";');
    expect(src).toContain('<Providers theme="dark"');
    expect(src).toContain("{children}");
    expect(src).toContain("export default function FlawlessProvider");
    // The sibling <Toast /> does not enclose {children} and must stay out.
    expect(src).not.toContain("Toast");
    // A non-literal attribute becomes a typed hole in a sibling module rather
    // than a comment: an editor squiggle naming the exact shape beats a TODO.
    expect(src).toContain("fonts={providerFixtures.fonts}");
    expect(src).toContain('import { providerFixtures } from "./provider.fixtures";');

    const fixtures = readFileSync(path.join(outDir, "provider.fixtures.ts"), "utf8");
    expect(fixtures).toContain("export const providerFixtures");
    expect(fixtures).toContain('ComponentProps<typeof Providers>["fonts"]');
    // The comment cites where the layout passed it, so the hole is traceable.
    expect(fixtures).toMatch(/layout\.tsx:\d+ passed fonts=/);
  });

  test("skips auth-bound aggregate providers — the unit plane stubs auth libs", () => {
    // An app's Clerk/next-auth aggregate provider is an auth WALL: signed-out
    // (the stub state) its gates render nothing, so every wrapped spec mounts
    // an empty tree. The global stubs already satisfy context reads, so the
    // wrapper must pass children through without the wall (miro-clone dogfood).
    const root = tmpDir();
    const write = (rel: string, text: string) => {
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
    };
    write(
      "app/layout.tsx",
      `"use client";
import type { ReactNode } from "react";
import { ThemeWrap } from "./theme-wrap";
import { AuthProviders } from "./auth-providers";
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ThemeWrap>
      <AuthProviders>{children}</AuthProviders>
    </ThemeWrap>
  );
}
`,
    );
    write(
      "app/theme-wrap.tsx",
      `"use client";\nexport const ThemeWrap = ({ children }: any) => <div>{children}</div>;\n`,
    );
    write(
      "app/auth-providers.tsx",
      `"use client";\nimport { useSession } from "next-auth/react";\nexport const AuthProviders = ({ children }: any) => (useSession() ? children : children);\n`,
    );
    const ctx = {
      root,
      router: "app" as const,
      appResolver: path.join(root, "app/layout.tsx"),
      apiRoutes: [],
    };
    const result = ensureClientProviderWrapper(ctx, tmpDir());
    expect(result?.included).toEqual(["ThemeWrap"]);
    const src = readFileSync(result?.path as string, "utf8");
    expect(src).toContain("<ThemeWrap>");
    expect(src).not.toContain("AuthProviders");
  });

  test("--force refreshes the derived provider but never the fixtures", () => {
    // The asymmetry is the point: provider.tsx is derived from the layout and
    // can be rebuilt; the fixtures hold values a human typed against a real app
    // and nothing can reconstruct them.
    const outDir = tmpDir();
    const ctx = {
      root: NEXTAPP,
      router: "app" as const,
      appResolver: path.join(NEXTAPP, "src/app/layout.tsx"),
      apiRoutes: [],
    };
    ensureClientProviderWrapper(ctx, outDir);
    const fixturesPath = path.join(outDir, "provider.fixtures.ts");
    writeFileSync(fixturesPath, "export const providerFixtures = { fonts: MINE };\n");
    writeFileSync(path.join(outDir, "provider.tsx"), "// clobbered\n");

    const again = ensureClientProviderWrapper(ctx, outDir, undefined, true);
    expect(again?.created).toBe(true);
    expect(readFileSync(path.join(outDir, "provider.tsx"), "utf8")).toContain("FlawlessProvider");
    expect(readFileSync(fixturesPath, "utf8")).toContain("MINE");
  });

  test("never overwrites an existing provider.tsx", async () => {
    const ctx = await detectNextjs(NEXTAPP);
    const outDir = tmpDir();
    const first = ensureClientProviderWrapper(ctx, outDir);
    expect(first?.created).toBe(true);
    const before = readFileSync(path.join(outDir, "provider.tsx"), "utf8");

    const second = ensureClientProviderWrapper(ctx, outDir);
    expect(second?.created).toBe(false);
    expect(second?.path).toBe(path.join(outDir, "provider.tsx"));
    expect(second?.included).toEqual([]);
    expect(readFileSync(path.join(outDir, "provider.tsx"), "utf8")).toBe(before);
  });

  test("a dropped prop containing */ cannot terminate the emitted comments", () => {
    // The dropped-prop source is quoted inside a /** */ doc comment (fixtures)
    // and a {/* */} JSX comment (the spread TODO). A glob like "**/*" carries
    // the two characters that end both comment forms, so unsanitised it breaks
    // the write-once provider.fixtures.ts — the one file --force never repairs.
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, "providers.tsx"),
      `"use client";
import type { ReactNode } from "react";
export default function Cfg({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
`,
    );
    const layout = path.join(dir, "layout.tsx");
    writeFileSync(
      layout,
      `import type { ReactNode } from "react";
import Cfg from "./providers";
const extras = { "**/*": {} };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html>
      <body>
        <Cfg config={{ include: "**/*" }} {...extras["**/*"]}>{children}</Cfg>
      </body>
    </html>
  );
}
`,
    );
    const ctx: NextjsContext = { root: dir, router: "app", appResolver: layout, apiRoutes: [] };
    const outDir = tmpDir();
    const result = ensureClientProviderWrapper(ctx, outDir, layout);
    expect(result?.created).toBe(true);

    const parseDiags = (file: string, kind: ts.ScriptKind): readonly ts.Diagnostic[] => {
      const sf = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.ES2022,
        true,
        kind,
      );
      // Parser-level diagnostics live on the source file; the property is not
      // in the public .d.ts but is the only way to see them without a Program.
      return (sf as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    };

    const fixturesPath = path.join(outDir, "provider.fixtures.ts");
    expect(parseDiags(fixturesPath, ts.ScriptKind.TS)).toEqual([]);
    expect(parseDiags(path.join(outDir, "provider.tsx"), ts.ScriptKind.TSX)).toEqual([]);

    // Still illustrative: the quoted source survives, minus the lethal pair.
    const fixtures = readFileSync(fixturesPath, "utf8");
    expect(fixtures).toContain('include: "**');
    expect(fixtures).toContain("to <Cfg>");
    const wrapper = readFileSync(path.join(outDir, "provider.tsx"), "utf8");
    expect(wrapper).toContain("layout spread {...extras[");
  });

  test("returns undefined when there is no layout to derive from", () => {
    const ctx: NextjsContext = {
      root: NEXTAPP,
      router: "app",
      appResolver: undefined,
      apiRoutes: [],
    };
    const outDir = tmpDir();
    expect(ensureClientProviderWrapper(ctx, outDir)).toBeUndefined();
    expect(
      ensureClientProviderWrapper(ctx, outDir, path.join(APP_DIR, "no-such-layout.tsx")),
    ).toBeUndefined();
  });
});

describe("spec parsing", () => {
  test("parseSpecRoutes groups operations per path and keeps the example bodies", async () => {
    const spec = await loadApiSpec(SPEC);
    const routes = parseSpecRoutes(spec);
    expect(routes.map((r) => r.path)).toEqual(["/api/items", "/api/items/{id}"]);

    const items = routes.find((r) => r.path === "/api/items");
    expect(items?.methods).toEqual(["GET", "POST"]);
    expect(items?.file).toBe("");
    expect(items?.responseBodies?.GET).toEqual({ items: [{ id: 1, name: "Widget" }] });
    expect(items?.responseBodies?.POST).toEqual({ id: 2, name: "Gadget" });

    const one = routes.find((r) => r.path === "/api/items/{id}");
    expect(one?.methods).toEqual(["GET"]);
    expect(one?.responseBodies?.GET).toEqual({ id: 1, name: "Widget" });
  });

  test("loadLocalSpec reads the file and returns undefined for a missing one", async () => {
    const loaded = await loadLocalSpec(SPEC);
    expect(loaded?.routes.map((r) => r.path)).toEqual(["/api/items", "/api/items/{id}"]);
    expect((loaded?.rawSpec as { openapi?: string } | undefined)?.openapi).toBe("3.0.0");
    expect(await loadLocalSpec(path.join(NEXTAPP, "missing-spec.json"))).toBeUndefined();
  });

  test("fetchLiveSwagger reports the failure instead of throwing on an invalid url", async () => {
    const res = await fetchLiveSwagger("not-a-url");
    expect(res.ok).toBe(false);
    expect(res.url).toBe("not-a-url");
    expect(res.routes).toBeUndefined();
    expect(typeof res.error).toBe("string");
  });
});

describe("renderMswHandlers", () => {
  test("emits one handler per route+method and turns {id} into :id", async () => {
    const spec = await loadApiSpec(SPEC);
    const src = renderMswHandlers(parseSpecRoutes(spec));
    expect(src).toContain('import { http, HttpResponse } from "msw";');
    expect(src).toContain(
      'http.get("/api/items", () => HttpResponse.json({"items":[{"id":1,"name":"Widget"}]})),',
    );
    expect(src).toContain(
      'http.post("/api/items", () => HttpResponse.json({"id":2,"name":"Gadget"})),',
    );
    expect(src).toContain(
      'http.get("/api/items/:id", () => HttpResponse.json({"id":1,"name":"Widget"})),',
    );
    expect(src).not.toContain("{id}");
    expect(src.match(/http\.(get|post|put|patch|delete)\(/g)?.length).toBe(3);
  });

  test("falls back to an empty body for detected routes with no spec bodies", async () => {
    const ctx = await detectNextjs(NEXTAPP);
    const src = renderMswHandlers(ctx.apiRoutes);
    expect(src).toContain('http.get("/api/items", () => HttpResponse.json({})),');
    expect(src).toContain('http.post("/api/items", () => HttpResponse.json({})),');
    expect(renderBrowserSetup()).toContain("setupWorker(...handlers)");
    expect(renderNodeSetup()).toContain("setupServer(...handlers)");
  });
});

describe("buildSwagger", () => {
  test("derives a 3.0.0 spec with one lowercased operation per detected method", async () => {
    const ctx = await detectNextjs(NEXTAPP);
    const spec = buildSwagger(ctx.apiRoutes, "nextapp") as {
      openapi: string;
      info: { title: string };
      paths: Record<string, Record<string, { summary: string }>>;
    };
    expect(spec.openapi).toBe("3.0.0");
    expect(spec.info.title).toContain("nextapp");
    expect(Object.keys(spec.paths["/api/items"] ?? {})).toEqual(["get", "post"]);
    expect(spec.paths["/api/items"]?.get?.summary).toBe("GET /api/items");
  });
});

describe("merging into the target project's package.json", () => {
  const pkgDir = (body: unknown, indent = "\t"): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-merge-"));
    const json = JSON.stringify(body, null, indent === "\t" ? "\t" : Number(indent));
    writeFileSync(path.join(dir, "package.json"), `${json}\n`);
    return dir;
  };
  const read = (dir: string) =>
    JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Record<
      string,
      Record<string, string>
    >;

  // The tool's own pins, as core.ts passes them.
  const DEV = { vitest: "^2.1.0", jsdom: "^25.0.0", "@testing-library/react": "^16.0.0" };

  test("a version the project already pinned is NOT downgraded", async () => {
    // The defect: devDeps were spread LAST, so a project on vitest 3 was
    // silently rewritten to the tool's ^2.1.0 and the next `bun install`
    // acted on it. README calls this an "additive diff".
    const dir = pkgDir({ devDependencies: { vitest: "^3.2.0" } });
    await mergeIntoNextPackageJson(dir, {}, DEV, {});
    expect(read(dir).devDependencies?.vitest).toBe("^3.2.0");
  });

  test("but a package the project lacks is still added at the tool's version", async () => {
    const dir = pkgDir({ devDependencies: { vitest: "^3.2.0" } });
    await mergeIntoNextPackageJson(dir, {}, DEV, {});
    const after = read(dir).devDependencies as Record<string, string>;
    expect(after.jsdom).toBe("^25.0.0");
    expect(after["@testing-library/react"]).toBe("^16.0.0");
  });

  test("runtime dependencies are protected the same way", async () => {
    const dir = pkgDir({ dependencies: { react: "^19.0.0" } });
    await mergeIntoNextPackageJson(dir, { react: "^18.3.0", msw: "^2.6.0" }, {}, {});
    const after = read(dir).dependencies as Record<string, string>;
    expect(after.react).toBe("^19.0.0");
    expect(after.msw).toBe("^2.6.0");
  });

  test("a user-modified flawless:* script SURVIVES the merge, and the merge says so", async () => {
    // The old rule ("the tool owns its namespace, spread-last wins") destroyed
    // real work in dogfood round 5: the app's flawless:load carried
    // `--env-file flawless/load/.env.load` by hand, a refresh clobbered it,
    // and the load run failed at setup (FR-034's exact shape). Scripts are
    // now like every other file that can hold your work: a differing existing
    // value is YOURS, kept and reported — delete the key to take the tool's
    // current command.
    const dir = pkgDir({ scripts: { dev: "next dev", "flawless:load": "my own version" } });
    const result = await mergeIntoNextPackageJson(
      dir,
      {},
      {},
      {
        "flawless:load": "crust -c '…'",
        "flawless:unit": "vitest run --root flawless",
      },
    );
    const after = read(dir).scripts as Record<string, string>;
    expect(after["flawless:load"]).toBe("my own version");
    expect(after["flawless:unit"]).toBe("vitest run --root flawless");
    expect(after.dev).toBe("next dev");
    expect(result.keptScripts).toEqual(["flawless:load"]);
  });

  test("a RECOGNIZED older tool spelling upgrades — only unrecognized values are kept", async () => {
    // The keep rule alone froze the reverse direction: an adopter generated
    // without --colocate holds the tool's own `--root` spelling; re-running
    // WITH --colocate must upgrade it to the --config form, or --run-tests
    // executes the stale command and never runs the colocated specs it just
    // generated. A value the tool itself once wrote is tool-owned.
    const dir = pkgDir({ scripts: { "flawless:unit": "vitest run --root flawless" } });
    const result = await mergeIntoNextPackageJson(
      dir,
      {},
      {},
      { "flawless:unit": "vitest run --config flawless/vitest.config.mts" },
      { "flawless:unit": ["vitest run --root flawless"] },
    );
    const after = read(dir).scripts as Record<string, string>;
    expect(after["flawless:unit"]).toBe("vitest run --config flawless/vitest.config.mts");
    expect(result.keptScripts).toEqual([]);
  });

  test("an identical script value is not reported as kept — nothing was at stake", async () => {
    const dir = pkgDir({ scripts: { "flawless:unit": "vitest run --root flawless" } });
    const result = await mergeIntoNextPackageJson(
      dir,
      {},
      {},
      {
        "flawless:unit": "vitest run --root flawless",
      },
    );
    expect(result.keptScripts).toEqual([]);
  });

  test("the file's own indentation survives", async () => {
    const dir = pkgDir({ devDependencies: { vitest: "^3.2.0" } });
    await mergeIntoNextPackageJson(dir, {}, DEV, {});
    expect(readFileSync(path.join(dir, "package.json"), "utf8")).toContain('\n\t"devDependencies"');
  });
  test("a pnpm app gets its tool-introduced build scripts pre-IGNORED", async () => {
    // verifyDepsBeforeRun makes ERR_PNPM_IGNORED_BUILDS fatal: with no record
    // of the decision, `pnpm run dev` died in its install check over msw —
    // the app could not boot after a regeneration that only touched specs.
    const dir = pkgDir({});
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await mergeIntoNextPackageJson(
      dir,
      {},
      { msw: "^2.6.0", "@playwright/test": "^1.49.0", vitest: "^2.1.0" },
      {},
    );
    const after = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(after.pnpm.ignoredBuiltDependencies).toEqual(["@playwright/test", "msw"]);
  });

  test("an approval the app already gave is respected — never double-listed", async () => {
    const dir = pkgDir({ pnpm: { onlyBuiltDependencies: ["msw"] } });
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await mergeIntoNextPackageJson(dir, {}, { msw: "^2.6.0" }, {});
    const after = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(after.pnpm.onlyBuiltDependencies).toEqual(["msw"]);
    expect(after.pnpm.ignoredBuiltDependencies ?? []).toEqual([]);
  });
});

describe("ensureFormatterIgnores", () => {
  const repo = (files: Record<string, string>): string => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "repo" }));
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
    return dir;
  };
  const readIf = (dir: string, name: string): string | null => {
    try {
      return readFileSync(path.join(dir, name), "utf8");
    } catch {
      return null;
    }
  };

  test("prettier and eslintrc in use: both ignore files gain the suite entry, once", () => {
    const dir = repo({ ".prettierrc": "{}", ".eslintrc.json": "{}" });
    const touched = ensureFormatterIgnores(dir, "flawless");
    expect(touched.map((t) => t.file)).toEqual([".prettierignore", ".eslintignore"]);
    expect(readIf(dir, ".prettierignore")).toContain("flawless/");
    expect(readIf(dir, ".eslintignore")).toContain("flawless/");
    // Idempotent: a second run adds nothing, and the entry never duplicates.
    expect(ensureFormatterIgnores(dir, "flawless")).toEqual([]);
    expect(readIf(dir, ".prettierignore")?.match(/flawless\//g)).toHaveLength(1);
  });

  test("flat config does not read .eslintignore — do not write a dead file for it", () => {
    const dir = repo({ "eslint.config.js": "export default [];" });
    expect(ensureFormatterIgnores(dir, "flawless")).toEqual([]);
    expect(readIf(dir, ".eslintignore")).toBeNull();
  });

  test('prettier configured by the package.json "prettier" key counts as in use', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-ignore-pkg-"));
    tmpDirs.push(dir);
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ prettier: { quotes: "single" } }),
    );
    expect(ensureFormatterIgnores(dir, "qa").map((t) => t.file)).toEqual([".prettierignore"]);
    expect(readIf(dir, ".prettierignore")).toContain("qa/");
  });

  test("an existing ignore file keeps its content; the entry follows --out", () => {
    const dir = repo({ ".prettierrc": "{}", ".prettierignore": "dist/\n" });
    ensureFormatterIgnores(dir, "web/qa");
    const body = readIf(dir, ".prettierignore");
    expect(body).toContain("dist/");
    expect(body).toContain("web/qa/");
  });

  test("no formatter configured anywhere: nothing is written, no tool is summoned", () => {
    const dir = repo({});
    expect(ensureFormatterIgnores(dir, "flawless")).toEqual([]);
    expect(readIf(dir, ".prettierignore")).toBeNull();
    expect(readIf(dir, ".eslintignore")).toBeNull();
  });
});
