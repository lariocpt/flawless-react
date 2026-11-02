import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * Candidate defect #12, by EXECUTION: colocated specs must run when vitest is
 * started from INSIDE the suite dir — which is exactly what the emitted
 * `flawless/package.json`'s own `test:unit: "vitest run"` script does, and
 * what any user gets from `cd flawless && npx vitest`.
 *
 * Measured before the fix (fixture: the aliased-next-app copy, colocate:true,
 * vitest 2.1.9): from the suite dir every colocated spec died with
 * `Failed to load url /src/….tsx … Does the file exist?` — 10 failed / 0
 * passed; from the app root the same suite was 16 passed / 1 skipped. On the
 * light layout generated below the same run reports the colocated spec as a
 * failed file with 0 tests collected. The
 * mechanism is vite's fs allow-list: vitest 2.1.9 roots it at the CONFIG
 * file's dir (plus the workspace root of the cwd), and the suite dir always
 * carries its own package.json, so the app files above it were refused. The
 * config's `root: projectRoot` does NOT widen fs.allow; an explicit
 * `server.fs.allow: [projectRoot]` does.
 *
 * The standalone layout is immune — its specs live under the suite dir, which
 * fs.allow already covers — so this test generates the COLOCATED layout.
 */

const WIDGET = `import { label } from "./label";

export function Widget({ name }: { name: string }) {
  return <h1>{label(name)}</h1>;
}
`;

const LABEL = `export function label(name: string): string {
  return \`hi \${name}\`;
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

describe("the emitted colocated suite runs from the suite dir", () => {
  test("vitest started with cwd = the suite dir loads and passes the colocated specs", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-suitedir-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(app, "src", "Widget.tsx"), WIDGET);
    writeFileSync(path.join(app, "src", "label.ts"), LABEL);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "*.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      colocate: true,
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // The emission this defect needs: a colocated spec in src/ (NOT under the
    // suite dir) plus the suite dir's own package.json — the package.json is
    // what makes searchForWorkspaceRoot(cwd) stop at the suite dir.
    const specPath = path.join(app, "src", "Widget.flawless.test.tsx");
    expect(existsSync(specPath)).toBe(true);
    expect(existsSync(path.join(outDir, "package.json"))).toBe(true);

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

    // The defect's exact command: cwd INSIDE the suite dir, bare `vitest run`
    // (the config resolves from the cwd). Before the fix this exited 1 with
    // "Failed to load url" on every colocated spec.
    const fromSuite = Bun.spawn([vitestBin, "run"], {
      cwd: outDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [suiteOut, suiteCode] = await Promise.all([
      new Response(fromSuite.stdout).text(),
      fromSuite.exited,
    ]);
    if (suiteCode !== 0) console.error(suiteOut);
    expect(suiteCode).toBe(0);
    expect(suiteOut).not.toContain("Failed to load url");
    // The spec really ran — vitest can exit 0 on zero tests only with
    // passWithNoTests, which is not set; pin the tally anyway.
    expect(suiteOut).toMatch(/1 passed/);

    // The layout that was already green must stay green: run from the app root
    // with an explicit --config (how chunk 4's execution tests run).
    const fromRoot = Bun.spawn([vitestBin, "run", "--config", "flawless/vitest.config.mts"], {
      cwd: app,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [rootOut, rootCode] = await Promise.all([
      new Response(fromRoot.stdout).text(),
      fromRoot.exited,
    ]);
    if (rootCode !== 0) console.error(rootOut);
    expect(rootCode).toBe(0);
    expect(rootOut).toMatch(/1 passed/);
  }, 180_000);
});
