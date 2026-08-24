import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * B-3 end to end, by EXECUTING the emitted specs with the real runners: the
 * resolved server-action return must turn a spec green that the {} stub made
 * red. The paired opaque module is the guard-the-guard — its return is not
 * literal-derivable, so its spec keeps the {} stub and MUST fail, proving the
 * crash mechanism is real and the green file isn't green vacuously.
 *
 * Both components store the action's result and render `result.message
 * .toUpperCase()` — with {} that throws inside the click's act() and fails
 * the smoke-click test; with the real literal it renders.
 */

const SAVE_CARD = `"use client";

import { useState } from "react";
import { saveProfile } from "./actions";

export function SaveCard() {
  const [saved, setSaved] = useState<{ message: string } | null>(null);
  return (
    <div>
      {saved ? <p>{saved.message.toUpperCase()}</p> : <p>not saved</p>}
      <button type="button" onClick={() => { void saveProfile().then(setSaved); }}>
        Save
      </button>
    </div>
  );
}
`;

const ACTIONS = `"use server";

export async function saveProfile() {
  return { message: "saved" };
}
`;

const OPAQUE_CARD = SAVE_CARD.replace("./actions", "./opaque")
  .replaceAll("saveProfile", "saveOpaque")
  .replaceAll("SaveCard", "OpaqueCard");

const OPAQUE_ACTIONS = `"use server";

export async function saveOpaque() {
  return buildResult();
}

function buildResult() {
  return { message: String(Math.random()) };
}
`;

/** The runtime the emitted suite declares, pinned from its own package.json. */
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

describe("resolved server-action returns, executed", () => {
  test("the enriched mock turns the spec green; the {} stub control stays red", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-action-exec-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    // Any real React host carries a tsconfig with the automatic JSX runtime;
    // without one, vitest's esbuild falls back to the classic transform and
    // every render dies on "React is not defined" before proving anything.
    await Bun.write(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    await Bun.write(path.join(app, "src", "SaveCard.tsx"), SAVE_CARD);
    await Bun.write(path.join(app, "src", "actions.ts"), ACTIONS);
    await Bun.write(path.join(app, "src", "OpaqueCard.tsx"), OPAQUE_CARD);
    await Bun.write(path.join(app, "src", "opaque.ts"), OPAQUE_ACTIONS);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "*Card.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // Emission sanity before the expensive part: the resolved value is in the
    // one spec and the honest stub + TODO in the other.
    const saveSpec = readFileSync(path.join(outDir, "unit", "SaveCard.test.tsx"), "utf8");
    expect(saveSpec).toContain('saveProfile: vi.fn(async () => ({"message":"saved"}))');
    expect(saveSpec).not.toContain("TODO(flawless): server action stubbed");
    const opaqueSpec = readFileSync(path.join(outDir, "unit", "OpaqueCard.test.tsx"), "utf8");
    expect(opaqueSpec).toContain("saveOpaque: vi.fn(async () => ({}))");
    expect(opaqueSpec).toContain("TODO(flawless): server action stubbed");

    // The real runners, at the ranges the emitted package.json pins — the
    // emittedSelection.test.ts discipline: unpinned answers a different
    // question and breaks with the registry's morning mood.
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
        `could not install the suite's runners — this test executes the emitted specs, so ` +
          `it cannot be skipped past (needs registry access).\n${installErr}`,
      );
    }

    // One vitest run per spec file, because the {} crash surfaces AFTER the
    // click's act() window — as an unhandled error that fails the RUN while
    // the file's tests still read "passed". Per-file exit codes attribute it
    // exactly: the run with only the control must be red, the run with only
    // the enriched spec must be entirely green, unhandled errors included.
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

    // The control first: if the {} stub no longer crashes the component, the
    // green run below proves nothing — fail HERE, on the guard.
    const control = await vitest("unit/OpaqueCard.test.tsx");
    expect(control.output).toContain("toUpperCase");
    expect(control.code).not.toBe(0);

    const enriched = await vitest("unit/SaveCard.test.tsx");
    if (enriched.code !== 0) console.error(enriched.output);
    expect(enriched.code).toBe(0);
    expect(enriched.output).not.toContain("toUpperCase");
  }, 120_000);
});
