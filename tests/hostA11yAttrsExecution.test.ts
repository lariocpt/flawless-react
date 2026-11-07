import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * D1 item 7 — host-element static attributes — EXECUTED.
 *
 * The analyser already carries a click's static `aria-label` and `role`
 * (string literals only; extractInteractions' collectHints). The salvaged
 * emitter gives them a render-only assertion of their own, bounded by the
 * locator's rung, because nothing else in the spec reads those attributes:
 *
 *   - testid rung: BOTH attributes asserted — the locator reads neither.
 *   - label rung: only the role — the locator already matches on the
 *     aria-label, so asserting it would be a tautology, not a check.
 *   - role rung: neither — a recorded aria-label is structurally absent
 *     there (the label rung sits above it), and the role IS the locator.
 *
 * The acceptance bar (PLAN-01) is a falsifier, not a green run. The two
 * asserts run GREEN against the two components, then the aria-label
 * literal is mutated without regenerating the spec and the run must go
 * RED — the assertion notices the markup. The anti-tautology shape is
 * checked on emission: the label-rung component asserts the role and does
 * not assert the aria-label.
 */

// testid rung: data-testid + static aria-label + static role, all on a
// button whose copy is "Submit" — the locator reads the testid only.
const HOST_ATTRS = `"use client";

export function HostAttrs() {
  function submit() {}
  return (
    <div>
      <button
        data-testid="host-submit"
        aria-label="Submit document"
        role="button"
        onClick={submit}
      >
        Submit
      </button>
    </div>
  );
}
`;

// label rung: no testid, so the locator is getAllByLabelText(aria-label) —
// the aria-label may not also be asserted; only the role may.
const MENU_BUTTON = `"use client";

export function MenuButton() {
  function openMenu() {}
  return (
    <div>
      <button aria-label="Open menu" role="button" onClick={openMenu}>
        Menu
      </button>
    </div>
  );
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

describe("D1 item 7, host-element static attributes, executed", () => {
  test("host-attribute asserts run green; mutating the aria-label literal goes red", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-host-attrs-exec-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    const hostPath = path.join(app, "src", "HostAttrs.tsx");
    const menuPath = path.join(app, "src", "MenuButton.tsx");
    writeFileSync(hostPath, HOST_ATTRS);
    writeFileSync(menuPath, MENU_BUTTON);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "*.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    const hostSpec = readFileSync(path.join(outDir, "unit", "HostAttrs.test.tsx"), "utf8");
    const menuSpec = readFileSync(path.join(outDir, "unit", "MenuButton.test.tsx"), "utf8");

    // Emission: the testid-rung element gets BOTH static attributes asserted.
    expect(hostSpec, "testid rung: aria-label is not read by the locator").toContain(
      'toHaveAttribute("aria-label", "Submit document")',
    );
    expect(hostSpec, "testid rung: role is not read by the locator").toContain(
      'toHaveAttribute("role", "button")',
    );
    // Anti-tautology: the label-rung element's locator matches on the
    // aria-label, so only the role may be asserted — asserting the label
    // would pass whatever value the locator was told to look for.
    expect(menuSpec, "label rung: role is asserted").toContain('toHaveAttribute("role", "button")');
    expect(menuSpec, "label rung: the aria-label is the locator — never asserted").not.toContain(
      'toHaveAttribute("aria-label"',
    );

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
    const vitest = async (): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn(
        [vitestBin, "run", "unit/HostAttrs.test.tsx", "unit/MenuButton.test.tsx"],
        {
          cwd: outDir,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      return { code, output: out + err };
    };

    // Green against the correct components — both attributes hold in the
    // rendered markup, and the label-rung role assertion is not a tautology
    // because it reads an attribute the locator does not match on.
    const green = await vitest();
    if (green.code !== 0) console.error(green.output);
    expect(green.code).toBe(0);

    // Falsification — the aria-label literal changes and the spec is NOT
    // regenerated: the emitted assertion must notice the markup. The click
    // canary stays green (its testid is untouched), so the red is the
    // attribute assertion, not the locator.
    writeFileSync(
      hostPath,
      HOST_ATTRS.replace('aria-label="Submit document"', 'aria-label="Mutated label"'),
    );
    const mutated = await vitest();
    expect(mutated.code).not.toBe(0);
    expect(mutated.output).toContain("toHaveAttribute");
    writeFileSync(hostPath, HOST_ATTRS);
  }, 240_000);
});
