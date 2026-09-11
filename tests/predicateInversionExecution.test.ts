import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * B-19 by EXECUTING the emitted inversion tests: the two-leg predicate flip,
 * the empty-side flip, and the null flip all run green against correct
 * components — and every mutation that breaks the predicate's wiring goes
 * red. Throw guards, not notFound(): the effect classifier treats them
 * identically and the temp app has no next to import.
 */

const BOARD = `import { isTrusteeOf, listAllItems, listContractors, listMyItems } from "./data";

export default async function TrusteeBoard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userIsTrustee = isTrusteeOf(id);
  const rows = await (userIsTrustee ? listAllItems(id) : listMyItems(id));
  const contractors = await listContractors(id);
  return (
    <main>
      <h1>Contractors</h1>
      {userIsTrustee ? <button type="button">Add contractor</button> : null}
      <p>{userIsTrustee ? "All items" : "My items"}</p>
      {contractors.length === 0 ? (
        <p>No contractors yet</p>
      ) : (
        <ul>
          {contractors.map((c) => (
            <li key={c.name}>{c.name}</li>
          ))}
        </ul>
      )}
      <span>{rows.length}</span>
    </main>
  );
}
`;

const LANDING = `import { verifySession } from "./data";

export default async function Landing() {
  const session = await verifySession();
  if (session) throw new Error("NEXT_REDIRECT: /dashboard");
  return (
    <main>
      <h1>Welcome to the landing page</h1>
      <p>Manage your building together.</p>
    </main>
  );
}
`;

const DATA = `export interface Sess {
  user: string;
}

export interface Contractor {
  name: string;
}

export function isTrusteeOf(id: string): boolean {
  throw new Error("the real data layer must never run under jsdom: " + id);
}

export async function verifySession(): Promise<Sess | null> {
  throw new Error("the real data layer must never run under jsdom");
}

export async function listContractors(id: string): Promise<Contractor[]> {
  throw new Error("the real data layer must never run under jsdom: " + id);
}

export async function listAllItems(id: string): Promise<string[]> {
  throw new Error("the real data layer must never run under jsdom: " + id);
}

export async function listMyItems(id: string): Promise<string[]> {
  throw new Error("the real data layer must never run under jsdom: " + id);
}
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

describe("predicate inversions, executed", () => {
  test("both flips run green; every wiring mutation goes red", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-b19-exec-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    const boardPath = path.join(app, "src", "TrusteeBoard.tsx");
    const landingPath = path.join(app, "src", "Landing.tsx");
    writeFileSync(boardPath, BOARD);
    writeFileSync(landingPath, LANDING);
    writeFileSync(path.join(app, "src", "data.ts"), DATA);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "{TrusteeBoard,Landing}.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // Emission: the two-leg flip with paired witnesses and callee deltas, the
    // empty-side flip, and the null flip.
    const board = readFileSync(path.join(outDir, "unit", "TrusteeBoard.test.tsx"), "utf8");
    expect(board).toContain("mockReturnValueOnce(false as never)");
    expect(board).toContain('expect(t0).toContain("All items")');
    expect(board).toContain('expect(t1).toContain("My items")');
    expect(board).toContain('expect(t1).not.toContain("Add contractor")');
    expect(board).toContain("mockResolvedValueOnce([] as never)");
    expect(board).toContain('expect(t1).toContain("No contractors yet")');
    const landing = readFileSync(path.join(outDir, "unit", "Landing.test.tsx"), "utf8");
    expect(landing).toContain("mockResolvedValueOnce(null as never)");
    expect(landing).toContain('toContain("Welcome to the landing page")');

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
    const vitest = async (specFile: string): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn([vitestBin, "run", specFile], {
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

    // Green against the correct components — the flips render the sides the
    // one-mount specs never reached.
    for (const spec of ["unit/TrusteeBoard.test.tsx", "unit/Landing.test.tsx"]) {
      const green = await vitest(spec);
      if (green.code !== 0) console.error(green.output);
      expect(green.code).toBe(0);
    }

    // M1 — arm swap: the defaults leg must catch it (the mutation-catcher
    // that keeps the inverted leg's absences honest).
    writeFileSync(boardPath, BOARD.replace('"All items" : "My items"', '"My items" : "All items"'));
    const swapped = await vitest("unit/TrusteeBoard.test.tsx");
    expect(swapped.code).not.toBe(0);

    // M2 — predicate hardwired truthy: the override stops mattering and the
    // inverted leg's absence assertions must redden.
    writeFileSync(boardPath, BOARD.replace("isTrusteeOf(id);", "isTrusteeOf(id) || true;"));
    const hardwired = await vitest("unit/TrusteeBoard.test.tsx");
    expect(hardwired.code).not.toBe(0);
    expect(hardwired.output).toContain("All items");

    // M3 — the empty side removed: the [] flip must redden, not pass.
    writeFileSync(boardPath, BOARD.replace("contractors.length === 0 ?", "false ?"));
    const noEmpty = await vitest("unit/TrusteeBoard.test.tsx");
    expect(noEmpty.code).not.toBe(0);
    expect(noEmpty.output).toContain("No contractors yet");
    writeFileSync(boardPath, BOARD);

    // M4 — the guard no longer reads the session: the null flip cannot
    // un-fire it, and the test reds on the throw instead of passing green.
    writeFileSync(landingPath, LANDING.replace("if (session)", "if (session ?? true)"));
    const stuckGuard = await vitest("unit/Landing.test.tsx");
    expect(stuckGuard.code).not.toBe(0);
    expect(stuckGuard.output).toContain("REDIRECT");
  }, 180_000);
});
