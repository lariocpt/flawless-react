import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";

/**
 * Chunk #10, by EXECUTION, on a host that declares its own vitest: the
 * vitest5-app fixture carries vitest `^5.0.0` in its OWN package.json (a
 * fresh install lands vitest 5.1.x + vite 8.3.x — measured: vitest 5.1.0
 * peers vite `^6.4.0 || ^7.0.0 || ^8.0.0`) with a tsconfig `jsx` of
 * "preserve" — the shape that killed every colocated spec at parse under
 * the old always-esbuild emission.
 *
 * That is the scenario the manifest-pin design would have gotten wrong: the
 * FRESH suite manifest the tool writes pins vitest `^2.1.0` (its generated
 * default), so a family computed from that pin alone would emit the esbuild
 * spelling — while the suite's test:unit script executes the APP store's
 * vitest 5, where an esbuild key is discarded beside vitest's
 * always-injected `oxc: { target }` and the jsx falls through to the
 * host's "preserve" — `RolldownError: Parse failure: Unexpected JSX
 * expression` on every spec (reproduced before the fix on this very
 * fixture shape: /tmp/opencode/c10/app5). The emission must therefore
 * follow the vitest the suite will ACTUALLY run: the installed store
 * answers hostViteFamily's leg 1 (the fixture's `bun install` runs before
 * the tool and drops the bun.lockb boundary the walk stops at), and the
 * emitted config is the oxc spelling.
 *
 * Both entry points a user has must be green: the suite's own
 * `test:unit: "vitest run"` script with cwd INSIDE the suite dir
 * (suiteDirExecution.test.ts's cwd semantics — the bin bun resolves is
 * the app store's vitest 5; the manifest's ^2.1.0 pin is never installed),
 * and the app-root `--config` run that predates all of it.
 */

const FIXTURE = path.resolve(__dirname, "fixtures", "vitest5-app");

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("a host on vitest 5 runs the tool's emitted colocated suite", () => {
  test("green from the app root and from the suite's own test:unit", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-vitest5-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(app, { recursive: true });
    cpSync(FIXTURE, app, { recursive: true });

    // The user's normal install, BEFORE the tool runs: the fixture's own
    // manifest lands its declared stack (vitest 5, vite 8, jsdom, RTL) in
    // the app's node_modules and drops the bun.lockb that bounds
    // hostViteFamily's store walk at the app.
    const install = Bun.spawn(["bun", "install"], {
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
        `could not install the fixture's stack (needs registry access):\n${installErr}`,
      );
    }

    // Pin the MAJORS actually installed, so "the suite ran on vitest 5 /
    // vite 8" below is a measured claim about this store, not an inference
    // from the declared ranges.
    const storePkg = (name: string): { version?: string } =>
      JSON.parse(readFileSync(path.join(app, "node_modules", name, "package.json"), "utf8"));
    expect(storePkg("vitest").version).toMatch(/^5\./);
    expect(storePkg("vite").version).toMatch(/^8\./);

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

    // The specs were emitted COLOCATED, in the app tree — where the
    // preserve host's tsconfig reaches them.
    expect(existsSync(path.join(app, "src", "Greeting.flawless.test.tsx"))).toBe(true);
    expect(existsSync(path.join(app, "src", "Counter.flawless.test.tsx"))).toBe(true);

    // The premise of the fall-through the emission just used: the fresh
    // manifest holds the tool's generated default, not a declaration.
    const suitePkg = JSON.parse(readFileSync(path.join(outDir, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(suitePkg.devDependencies.vitest).toBe("^2.1.0");
    // …and the host declares what its install actually is.
    const hostPkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(hostPkg.devDependencies.vitest).toBe("^5.0.0");

    // The emitted config: the mechanism for the vite the suite RUNS — oxc
    // present, the esbuild spelling absent, and the one comment that is
    // the whole explanation.
    const config = readFileSync(path.join(outDir, "vitest.config.mts"), "utf8");
    expect(config).toContain('oxc: { jsx: { runtime: "automatic" } }');
    expect(config).not.toContain("esbuild: { jsx");
    expect(config).toContain("JSX runtime, picked by the vite the suite RUNS");

    const vitestBin = path.join(app, "node_modules", ".bin", "vitest");
    if (!existsSync(vitestBin)) throw new Error(`vitest did not install at ${vitestBin}`);

    // Run 1 — the entry point a user actually types: the suite's own
    // test:unit script, cwd INSIDE the suite dir. bun resolves the bin from
    // the APP store (the suite's manifest is never installed), so this is
    // the vitest 5 / vite 8 execution the old emission died on.
    const fromSuite = Bun.spawn(["bun", "run", "test:unit"], {
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
    expect(suiteOut).toMatch(/2 passed/);
    // The old failure modes, named: the preserve host's parse death, and the
    // both-set warning that marks a config carrying the discarded esbuild key.
    expect(suiteOut).not.toContain("Parse failure");
    expect(suiteOut).not.toContain("Both esbuild and oxc");

    // Run 2 — the layout that was green before must stay green: from the app
    // root with an explicit --config (suiteDirExecution.test.ts's from-root
    // form).
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
    expect(rootOut).toMatch(/2 passed/);
    expect(rootOut).not.toContain("Parse failure");
    expect(rootOut).not.toContain("Both esbuild and oxc");
  }, 180_000);
});
