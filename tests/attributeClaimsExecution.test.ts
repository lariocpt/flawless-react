import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * D1a items 1 and 2, EXECUTED.
 *
 * Each ships a Tier-1 assertion the emitter used to drop:
 *
 *   - item 1: an always-disabled control asserted with `expect(<el>).toBeDisabled()`
 *     instead of the `disabled-control` skip.
 *   - item 2: a string initial value that flows into an attribute asserted with
 *     `expect(<el>).toHaveAttribute(attr, initial)` instead of nothing.
 *
 * The acceptance bar (PLAN-01) is a falsifier, not a green run. For each item:
 * show the new assertion is present and GREEN against the correct component, then
 * apply the named mutation that must turn it RED and show it does — remove the
 * `disabled` attribute; change the initial string. The spec is never regenerated
 * between green and red; only the component moves, so the failure is the
 * assertion noticing the markup, which is the whole point of the tier.
 */

const CHECKOUT = `"use client";
import { useState } from "react";

export function Checkout() {
  const [placeholder] = useState("Enter your email");
  function addToCart() {}
  return (
    <div>
      <input placeholder={placeholder} />
      <button type="button" disabled onClick={addToCart}>
        Add to cart
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

describe("D1a attribute claims, executed", () => {
  test("toBeDisabled and toHaveAttribute run green; the named mutations go red", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-d1a-exec-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    const checkoutPath = path.join(app, "src", "Checkout.tsx");
    writeFileSync(checkoutPath, CHECKOUT);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "Checkout.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    const specPath = path.join(outDir, "unit", "Checkout.test.tsx");
    const spec = readFileSync(specPath, "utf8");

    // Emission: both dropped claims are now present. If either stopped being
    // derived, these fail here rather than at a green run that never asserted.
    expect(spec, "item 1: an always-disabled control is asserted disabled").toContain(
      "toBeDisabled()",
    );
    expect(
      spec.includes('toHaveAttribute("placeholder", "Enter your email")'),
      "item 2: the initial string is asserted on the attribute it flows to",
    ).toBe(true);
    // Neither may regress to a skip of the control or the attribute.
    expect(spec).not.toContain("disabled-control");

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
      const run = Bun.spawn([vitestBin, "run", "unit/Checkout.test.tsx"], {
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

    // Green against the correct component — the disabled control and the
    // placeholder attribute both hold at these props.
    const green = await vitest();
    if (green.code !== 0) console.error(green.output);
    expect(green.code).toBe(0);

    // M1 — the disabled attribute removed: the control is now enabled, so
    // toBeDisabled must go red. The spec is untouched; only the markup moved.
    writeFileSync(checkoutPath, CHECKOUT.replace('type="button" disabled onClick', 'type="button" onClick'));
    const noDisabled = await vitest();
    expect(noDisabled.code).not.toBe(0);
    expect(noDisabled.output).toContain("toBeDisabled");
    writeFileSync(checkoutPath, CHECKOUT);

    // M2 — the initial string changed: the attribute no longer equals the
    // literal the spec asserts, so toHaveAttribute must go red.
    writeFileSync(
      checkoutPath,
      CHECKOUT.replace('useState("Enter your email")', 'useState("Type your email")'),
    );
    const changedInitial = await vitest();
    expect(changedInitial.code).not.toBe(0);
    expect(changedInitial.output).toContain("toHaveAttribute");
    writeFileSync(checkoutPath, CHECKOUT);
  }, 180_000);
});
