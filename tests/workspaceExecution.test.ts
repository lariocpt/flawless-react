import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * B-8 end to end, by EXECUTING the emitted spec against a real monorepo: a
 * dep annotated in a WORKSPACE package (bare specifier, star barrel) gains a
 * concrete fixture, and the coverage is live, not vestigial.
 *
 * The proof triangle:
 *  - the enriched spec runs green with nothing skipped;
 *  - the fixture hand-corrupted to {} goes RED (the spec really executes);
 *  - the shared interface mutated at its SOURCE + a regeneration re-derives
 *    the fixture from the new shape — and the stale component goes red
 *    against it, which is exactly what live resolution means.
 */

const ROOT_PKG = JSON.stringify({
  name: "exec-monorepo",
  private: true,
  workspaces: ["apps/*", "packages/*"],
});

const SHARED_PKG = JSON.stringify({
  // main points at src so the RUNTIME (vitest transform) can resolve the
  // workspace symlink; the analyser deliberately never reads it (B-8
  // resolves src by probe, dist mappings stay unread).
  name: "@exec/shared",
  main: "./src/index.ts",
});

const SHARED_BARREL = `export * from "./types";
export * from "./data";
`;

const SHARED_TYPES = `export interface Account {
  name: string;
}
`;

const SHARED_DATA = `import type { Account } from "./types";

export async function getAccount(): Promise<Account> {
  throw new Error("the real data layer must never run under jsdom");
}
`;

const PANEL = `import { getAccount } from "@exec/shared";

function caption(u: { name: string }): string {
  return u.name.toUpperCase();
}

export default async function AccountPanel() {
  const account = await getAccount();
  return <h1>{caption(account)}</h1>;
}
`;

function suitePins(): Record<string, string> {
  const pkg = JSON.parse(suitePackageJson("/x/flawless", false)) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const pins: Record<string, string> = {};
  for (const name of [
    "react",
    "react-dom",
    "vitest",
    "jsdom",
    "@testing-library/react",
    "@testing-library/user-event",
    "@testing-library/jest-dom",
  ]) {
    const range = all[name];
    if (range === undefined) throw new Error(`the emitted suite no longer pins ${name}`);
    pins[name] = range;
  }
  return pins;
}

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("workspace-package dep fixtures, executed", () => {
  test("barrel-resolved annotation runs green; source mutation re-derives the fixture", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-ws-exec-"));
    const root = tmpRoot;
    const app = path.join(root, "apps", "web");
    const shared = path.join(root, "packages", "shared");
    mkdirSync(path.join(app, "src"), { recursive: true });
    mkdirSync(path.join(shared, "src"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), ROOT_PKG);
    // The app declares the workspace dep the way a real monorepo member does
    // — that link is what lets vitest resolve the bare specifier at runtime.
    writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({
        name: "web",
        private: true,
        dependencies: { "@exec/shared": "workspace:*" },
        devDependencies: suitePins(),
      }),
    );
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(shared, "package.json"), SHARED_PKG);
    writeFileSync(path.join(shared, "src", "index.ts"), SHARED_BARREL);
    const typesPath = path.join(shared, "src", "types.ts");
    writeFileSync(typesPath, SHARED_TYPES);
    writeFileSync(path.join(shared, "src", "data.ts"), SHARED_DATA);
    writeFileSync(path.join(app, "src", "AccountPanel.tsx"), PANEL);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "AccountPanel.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // Emission first: the fixture was derived through workspace map + star
    // barrel, carries provenance, and left NO gap markers behind.
    const specPath = path.join(outDir, "unit", "AccountPanel.test.tsx");
    const spec = readFileSync(specPath, "utf8");
    expect(spec).toContain('getAccount: vi.fn(async () => ({"name":"flawless-name"}))');
    expect(spec).toContain("return annotation");
    expect(spec).not.toContain("data fixture missing");
    expect(spec).not.toContain("TODO(flawless): some return shapes");

    // One root install wires the whole workspace: runner pins for the app
    // plus the @exec/shared symlink vitest needs to resolve the bare spec.
    const install = Bun.spawn(["bun", "install"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [installErr, installCode] = await Promise.all([
      new Response(install.stderr).text(),
      install.exited,
    ]);
    if (installCode !== 0) {
      throw new Error(
        `could not install the suite's runners (needs registry access):\n${installErr}`,
      );
    }
    const vitestBin = path.join(app, "node_modules", ".bin", "vitest");
    if (!existsSync(vitestBin)) throw new Error(`vitest did not install at ${vitestBin}`);
    const vitest = async (): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn([vitestBin, "run", "unit/AccountPanel.test.tsx"], {
        cwd: outDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      return { code, output: out + err };
    };

    // Green with nothing skipped — before B-8 this exact component was the
    // "some return shapes could not be inferred" TODO wall.
    const enriched = await vitest();
    if (enriched.code !== 0) console.error(enriched.output);
    expect(enriched.code).toBe(0);
    expect(enriched.output).not.toContain("skipped");
    expect(enriched.output).not.toContain("data fixture missing");

    // Guard-the-guard on the ARTEFACT: the old {} must crash the component.
    writeFileSync(specPath, spec.replace('({"name":"flawless-name"})', "({})"));
    const corrupted = await vitest();
    expect(corrupted.code).not.toBe(0);
    expect(corrupted.output).toContain("toUpperCase");
    // Restore the exact bytes: the stamp must match again or the next --force
    // run would KEEP the hand-corrupted spec instead of refreshing it (B-4).
    writeFileSync(specPath, spec);

    // Liveness: mutate the shared interface at its SOURCE and regenerate —
    // the fixture must be re-derived from the new shape, and the stale
    // component goes red against it. Resolution that only appeared to work
    // (a cached or vestigial value) fails this.
    const mutated = SHARED_TYPES.replace("name: string;", "fullName: string;");
    expect(mutated).not.toBe(SHARED_TYPES);
    writeFileSync(typesPath, mutated);
    const regen = await runCore({
      pattern: path.join(app, "src", "AccountPanel.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(regen.exitCode).toBe(0);
    const respec = readFileSync(specPath, "utf8");
    expect(respec).toContain('getAccount: vi.fn(async () => ({"fullName":"flawless-fullName"}))');
    const stale = await vitest();
    expect(stale.code).not.toBe(0);
    expect(stale.output).toContain("toUpperCase");
  }, 120_000);
});
