import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emitNextjsMocks } from "../src/nextjs/emit.ts";
import { classifyStamped, STAMP_RE, stamp } from "../src/scaffold-tests/stamp.ts";
import type { NextjsApiRoute, NextjsContext } from "../src/types.ts";

/**
 * The handlers.ts provenance contract (dogfood #5b). "File exists" was a trap:
 * `--api` refreshed swagger.json but never the handlers generated from the old
 * AST walk, so a project that ran once before it had a real spec kept a
 * catch-all stub forever, silently. The contract under test — spec unchanged →
 * kept; spec changed and the file still matches its generated stamp →
 * regenerated; hand-edited or unstamped → kept, always, with the escape hatch
 * named. Every "kept" branch must leave the file BYTE-identical.
 */

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-handlers-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "mocks"), { recursive: true });
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const routesA: NextjsApiRoute[] = [{ path: "/api/users", methods: ["GET"], file: "" }];
const routesB: NextjsApiRoute[] = [
  { path: "/api/users", methods: ["GET", "POST"], file: "" },
  { path: "/api/orders", methods: ["GET"], file: "" },
];

const specB = {
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
  paths: {
    "/api/users": { get: {}, post: {} },
    "/api/orders": { get: {} },
  },
};

async function emit(dir: string, opts: Parameters<typeof emitNextjsMocks>[2] = {}) {
  // root must be the SAME dir across runs of one test: the derived swagger's
  // title embeds its basename, so a fresh root per call would move the spec
  // digest and every "kept" would read as "regenerated from a newer spec".
  const c: NextjsContext = {
    root: dir,
    router: "app",
    appResolver: undefined,
    apiRoutes: opts.liveSpec ? routesB : routesA,
  };
  return emitNextjsMocks(c, dir, opts);
}

const handlersPath = (dir: string) => path.join(dir, "mocks", "handlers.ts");

describe("handlers.ts provenance", () => {
  test("a fresh run stamps the file with the tool stamp and a spec digest", async () => {
    const dir = tmpDir();
    const r = await emit(dir);
    expect(r.handlersReport).toBe("created");
    const text = await readFile(handlersPath(dir), "utf8");
    const first = text.split("\n")[0];
    // The existing stamp dialect, not a second one invented here.
    expect(STAMP_RE.test(`${first}\n`)).toBe(true);
    // The spec digest rides BELOW the stamp line, inside the hashed body, so
    // STAMP_RE keeps matching files already stamped by 0.3.1.
    expect(text.split("\n")[1]).toMatch(/^\/\/ @flawless-spec sha256:[0-9a-f]{16}$/);
    expect(r.handlersEmitted).toBe(1);
    expect(r.specPaths).toBe(1);
  });

  test("same spec, second run → handlers byte-identical, reported kept", async () => {
    const dir = tmpDir();
    await emit(dir);
    const before = await readFile(handlersPath(dir));
    const r = await emit(dir);
    expect(r.handlersReport).toBe("kept");
    expect(r.written).not.toContain(handlersPath(dir));
    expect(await readFile(handlersPath(dir))).toEqual(before);
  });

  test("changed spec, unedited handlers → regenerated and reported", async () => {
    const dir = tmpDir();
    await emit(dir);
    const r = await emit(dir, { liveSpec: specB });
    expect(r.handlersReport).toBe("regenerated from a newer spec");
    const text = await readFile(handlersPath(dir), "utf8");
    expect(text).toContain('http.post("/api/users"');
    expect(text).toContain('http.get("/api/orders"');
    expect(r.handlersEmitted).toBe(3);
    expect(r.specPaths).toBe(2);
    // And the refreshed file is stable again: a third run keeps it.
    const before = await readFile(handlersPath(dir));
    const r3 = await emit(dir, { liveSpec: specB });
    expect(r3.handlersReport).toBe("kept");
    expect(await readFile(handlersPath(dir))).toEqual(before);
  });

  test("hand-edited handlers → kept and reported, even when the spec changed", async () => {
    const dir = tmpDir();
    await emit(dir);
    const p = handlersPath(dir);
    const edited = `${await readFile(p, "utf8")}\n// my realistic fixture\n`;
    await writeFile(p, edited);
    const r = await emit(dir, { liveSpec: specB });
    expect(r.handlersReport).toBe("kept (hand-edited) — regenerate with --force or delete it");
    expect(await readFile(p, "utf8")).toBe(edited);
    // --force is the named escape hatch: it regenerates over the edit.
    const r2 = await emit(dir, { liveSpec: specB, force: true });
    expect(r2.handlersReport).toBe("regenerated (--force)");
    expect(await readFile(p, "utf8")).not.toContain("my realistic fixture");
  });

  test("unstamped handlers (a 0.3.1 or hand-written file) → kept, never overwritten", async () => {
    const dir = tmpDir();
    const p = handlersPath(dir);
    const hand = 'import { http } from "msw";\nexport const handlers = [];\n';
    await writeFile(p, hand);
    const r = await emit(dir, { liveSpec: specB });
    expect(r.handlersReport).toContain("kept (no provenance stamp");
    expect(r.handlersReport).toContain("--force or delete it");
    expect(await readFile(p, "utf8")).toBe(hand);
  });

  test("a file stamped by 0.3.1 (no spec digest) is still recognised and left alone", async () => {
    // The compatibility test: stamp.ts's format is untouched, so a body
    // stamped before spec digests existed still classifies as untouched —
    // NOT stampless, NOT edited — and is kept byte-identical rather than
    // silently reformatted or regenerated on a digest it cannot have.
    const dir = tmpDir();
    const p = handlersPath(dir);
    const legacyBody = 'import { http } from "msw";\nexport const handlers = [];\n';
    const legacy = stamp(legacyBody, "0.3.1");
    await writeFile(p, legacy);
    expect(classifyStamped(legacy)).toBe("untouched");
    const r = await emit(dir, { liveSpec: specB });
    expect(r.handlersReport).toBe(
      "kept (stamped before spec digests existed) — regenerate with --force or delete it",
    );
    expect(await readFile(p, "utf8")).toBe(legacy);
  });
});
