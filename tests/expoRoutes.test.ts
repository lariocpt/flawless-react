// expo-router route mapping, the refusal helper, and the native writer.
//
// All three were reachable only through `bun src/bin.ts` subprocesses, so
// coverage read 0% on two of them. Route mapping in particular deserves direct
// tests: it is a table of conventions, and a table is exactly the thing that
// rots quietly.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyseFile } from "../src/analyse/index.ts";
import { detectExpo } from "../src/expo/detect.ts";
import { EXPO_IMPLEMENTED, expoNotImplemented } from "../src/expo/refusal.ts";
import { allocateRouteStems, expoFileToRoute, routeModuleId } from "../src/expo/routes.ts";
import { scaffoldNativeUnit } from "../src/scaffold-tests/nativeIndex.ts";
import { ALL_TASK_IDS } from "../src/tasks/index.ts";

const EXPOAPP = path.resolve(__dirname, "fixtures/expoapp");
const APP = path.join(EXPOAPP, "app");
const tmps: string[] = [];
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const route = (rel: string) => expoFileToRoute(path.join(APP, rel), APP);

describe("expoFileToRoute — the leaf file IS the route", () => {
  test.each([
    ["login.tsx", "/login"],
    ["signup.tsx", "/signup"],
    // index is its directory, not a segment.
    ["(tabs)/index.tsx", "/"],
    ["items/[id].tsx", "/items/[id]"],
  ])("%s -> %s", (rel, want) => {
    expect(`${rel} -> ${route(rel as string)?.urlPath}`).toBe(`${rel} -> ${want as string}`);
  });

  test("route groups vanish, including as the leaf's own directory", () => {
    // The case a Next.js-shaped mapper gets wrong: app/(tabs)/index.tsx is "/",
    // not "/(tabs)".
    expect(route("(tabs)/index.tsx")?.urlPath).toBe("/");
  });

  test("_layout and every + -prefixed file are excluded", () => {
    expect(route("_layout.tsx")).toBeUndefined();
    expect(route("(tabs)/_layout.tsx")).toBeUndefined();
    // The + prefix is RESERVED by expo-router, so it is excluded by rule rather
    // than by listing +not-found/+html/+api/+native-intent — a list that would
    // rot the moment expo-router adds a fifth.
    expect(route("+not-found.tsx")).toBeUndefined();
  });

  test("a file outside the router root is not a route", () => {
    expect(expoFileToRoute(path.join(EXPOAPP, "components/icon.tsx"), APP)).toBeUndefined();
    expect(expoFileToRoute(path.join(EXPOAPP, "lib/api.ts"), APP)).toBeUndefined();
  });

  test("dynamic params are captured in order", () => {
    const r = route("items/[id].tsx");
    expect(r?.params).toEqual(["id"]);
    expect(r?.specStem).toBe("items-id");
  });

  test("the layout chain is outermost-first and includes the root", () => {
    expect(route("(tabs)/index.tsx")?.layouts).toEqual(["_layout", "(tabs)/_layout"]);
    expect(route("login.tsx")?.layouts).toEqual(["_layout"]);
  });
});

describe("stem allocation", () => {
  test("two routes that stem identically get distinct names", () => {
    // Real on expo-router in a way it is not on Next: groups vanish, so
    // app/(a)/x.tsx and app/(b)/x.tsx are different routes with the same stem.
    // Allocating over the FULL list before filtering is the invariant
    // allocateSpecNames documents; doing it the other way silently overwrites
    // one route's spec with another's.
    const a = { urlPath: "/x", params: [], specStem: "x", layouts: [] };
    const b = { urlPath: "/y/x", params: [], specStem: "x", layouts: [] };
    const got = allocateRouteStems([a, b]);
    expect(got.get(a)).toBe("x");
    expect(got.get(b)).toBe("x-2");
    expect(new Set([...got.values()]).size).toBe(2);
  });
});

describe("routeModuleId — what renderRouter's context is keyed by", () => {
  test("posix-separated and extensionless", () => {
    expect(routeModuleId(path.join(APP, "items/[id].tsx"), APP)).toBe("items/[id]");
    expect(routeModuleId(path.join(APP, "(tabs)/index.tsx"), APP)).toBe("(tabs)/index");
    expect(routeModuleId(path.join(APP, "_layout.tsx"), APP)).toBe("_layout");
  });
});

describe("the refusal helper", () => {
  test("is a failed TaskResult, not a throw, and names the task, the wave and the escape", () => {
    const r = expoNotImplemented("e2e", "wave 6 — expo-router route specs");
    expect(r.ok).toBe(false);
    expect(r.id).toBe("e2e");
    expect(r.outputs).toEqual([]);
    expect(r.findings).toEqual([]);
    // A TaskResult reaches results[], the --ci blob and REPORT.md; a throw would
    // exit 1 with the reason only on stderr.
    expect(r.summary).toContain("no Expo implementation yet");
    expect(r.error).toContain("e2e");
    expect(r.error).toContain("wave 6");
    // The escape is spelled as the flag a reader would type, not as prose.
    expect(r.error).toContain(`--tasks ${EXPO_IMPLEMENTED.join(",")}`);
  });

  test("every task id produces a well-formed refusal", () => {
    for (const id of ALL_TASK_IDS) {
      const r = expoNotImplemented(id, "wave N — x");
      expect(`${id}:${r.ok}`).toBe(`${id}:false`);
      expect(r.error?.startsWith(id)).toBe(true);
    }
  });
});

describe("scaffoldNativeUnit — the writer", () => {
  test("writes the suite, and does not overwrite a write-once file", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-native-write-"));
    tmps.push(dir);
    const out = path.join(dir, "flawless");
    const expo = await detectExpo(EXPOAPP);
    const trees = await analyseFile({
      entry: path.join(APP, "login.tsx"),
      depth: 0,
      includeChildren: false,
      roots: "exported",
    });

    const first = await scaffoldNativeUnit({ trees, outDir: out, expo });
    expect(first.written.some((f) => f.endsWith("jest.config.cjs"))).toBe(true);
    expect(first.written.some((f) => f.endsWith("styleStub.js"))).toBe(true);
    expect(first.kept).toEqual([]);

    // jest.setup.ts is where hand-written module mocks live, and nothing can
    // rebuild those from the analysis — so a re-run must keep it.
    const setup = path.join(out, "jest.setup.ts");
    writeFileSync(setup, "// hand-written, must survive\n");
    const second = await scaffoldNativeUnit({ trees, outDir: out, expo });
    expect(second.kept).toContain(setup);
    expect(readFileSync(setup, "utf8")).toBe("// hand-written, must survive\n");
    // …while the derived config IS rewritten, so an existing suite gets later
    // versions' improvements.
    expect(second.written.some((f) => f.endsWith("jest.config.cjs"))).toBe(true);
    expect(existsSync(path.join(out, "unit"))).toBe(true);
  });
});
