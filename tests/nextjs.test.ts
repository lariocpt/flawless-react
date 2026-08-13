import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkApiRoutes } from "../src/nextjs/apiRoutes.ts";
import { detectNextjs } from "../src/nextjs/detect.ts";
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
