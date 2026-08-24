import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * B-1 end to end, by EXECUTING the emitted specs: an annotation-enriched dep
 * turns what used to be an admitted-gap SKIP into real, running coverage.
 *
 * Three runs carry the proof:
 *  - the enriched spec passes with NOTHING skipped (the coverage exists);
 *  - the same spec with its fixture hand-corrupted to {} goes RED (the RSC
 *    test really executes the component against the fixture, and no skip
 *    escape hides the crash — guard-the-guard);
 *  - the paired opaque dep still takes the skip path (what every enriched
 *    dep would be without B-1: exit 0, but coverage that does not exist).
 */

const USER_PANEL = `import { getUser } from "./data";

function caption(u: { name: string }): string {
  return u.name.toUpperCase();
}

export default async function UserPanel() {
  const user = await getUser();
  return <h1>{caption(user)}</h1>;
}
`;

const DATA = `export interface User {
  name: string;
}

export async function getUser(): Promise<User> {
  throw new Error("the real data layer must never run under jsdom");
}
`;

const OPAQUE_PANEL = `import { getOpaque } from "./opaque";

function caption(u: { name: string }): string {
  return u.name.toUpperCase();
}

export default async function OpaquePanel() {
  const user = await getOpaque();
  return <h1>{caption(user)}</h1>;
}
`;

const OPAQUE_DATA = `export async function getOpaque() {
  return compute();
}

function compute(): never {
  throw new Error("the real data layer must never run under jsdom");
}
`;

const DB_PANEL = `import { db } from "./db";

export default async function DbPanel() {
  const rows = await db.query.users.findMany();
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.name}>{r.name}</li>
      ))}
    </ul>
  );
}
`;

const DB = `export const db = {
  query: {
    users: {
      findMany: async (): Promise<Array<{ name: string }>> => {
        throw new Error("the real db must never run under jsdom");
      },
    },
  },
};
`;

function suitePins(): string[] {
  const pkg = JSON.parse(suitePackageJson("/x/flawless", false)) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return [
    "react",
    "react-dom",
    "vitest",
    "jsdom",
    "@testing-library/react",
    "@testing-library/user-event",
    "@testing-library/jest-dom",
  ].map((name) => {
    const range = all[name];
    if (range === undefined) throw new Error(`the emitted suite no longer pins ${name}`);
    return `${name}@${range}`;
  });
}

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("annotation-derived dep fixtures, executed", () => {
  test("skip becomes coverage; a corrupted fixture goes red, not skipped", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-dep-exec-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(app, "src", "UserPanel.tsx"), USER_PANEL);
    writeFileSync(path.join(app, "src", "data.ts"), DATA);
    writeFileSync(path.join(app, "src", "OpaquePanel.tsx"), OPAQUE_PANEL);
    writeFileSync(path.join(app, "src", "opaque.ts"), OPAQUE_DATA);
    writeFileSync(path.join(app, "src", "DbPanel.tsx"), DB_PANEL);
    writeFileSync(path.join(app, "src", "db.ts"), DB);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "*Panel.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // Emission first: the enriched spec carries the fixture and NO escape,
    // the opaque one keeps the honest gap markers.
    const userSpecPath = path.join(outDir, "unit", "UserPanel.test.tsx");
    const userSpec = readFileSync(userSpecPath, "utf8");
    expect(userSpec).toContain('getUser: vi.fn(async () => ({"name":"flawless-name"}))');
    expect(userSpec).toContain("return annotation");
    expect(userSpec).not.toContain("data fixture missing");
    expect(userSpec).not.toContain("TODO(flawless): some return shapes");
    const opaqueSpec = readFileSync(path.join(outDir, "unit", "OpaquePanel.test.tsx"), "utf8");
    expect(opaqueSpec).toContain("data fixture missing");
    expect(opaqueSpec).toContain("TODO(flawless)");

    const install = Bun.spawn(["bun", "add", "-d", ...suitePins()], {
      cwd: app,
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
    const vitest = async (spec: string): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn([vitestBin, "run", spec], {
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

    // The enriched spec: green with nothing skipped — this used to be the
    // skip below, and "passed" vs "skipped" is the entire point of B-1.
    const enriched = await vitest("unit/UserPanel.test.tsx");
    if (enriched.code !== 0) console.error(enriched.output);
    expect(enriched.code).toBe(0);
    expect(enriched.output).not.toContain("skipped");
    expect(enriched.output).not.toContain("data fixture missing");

    // Guard-the-guard, on the ARTEFACT: corrupt the fixture to the old {}
    // and the run must go red — no escape hides a crash in an enriched spec,
    // so a wrong inferred value can never pass silently.
    writeFileSync(
      userSpecPath,
      readFileSync(userSpecPath, "utf8").replace('({"name":"flawless-name"})', "({})"),
    );
    const corrupted = await vitest("unit/UserPanel.test.tsx");
    expect(corrupted.code).not.toBe(0);
    expect(corrupted.output).toContain("toUpperCase");

    // The control: without enrichment the same shape of component is a SKIP —
    // exit 0, no coverage. This is what B-1 converts.
    const control = await vitest("unit/OpaquePanel.test.tsx");
    expect(control.code).toBe(0);
    expect(control.output).toContain("skipped");
    expect(control.output).toContain("data fixture missing");

    // FR-014: a dotted callee's mock must be a nested object with the vi.fn
    // at the LEAF. The root-as-function mock made db.query undefined and the
    // spec threw on CORRECT code with no escape (uncertain was false) — a
    // hard false failure, which this run would reproduce.
    const dbSpec = readFileSync(path.join(outDir, "unit", "DbPanel.test.tsx"), "utf8");
    expect(dbSpec).toContain("db: { query: { users: { findMany: vi.fn(");
    const dotted = await vitest("unit/DbPanel.test.tsx");
    if (dotted.code !== 0) console.error(dotted.output);
    expect(dotted.code).toBe(0);
    expect(dotted.output).not.toContain("skipped");
  }, 120_000);
});
