import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * D1c items 5 and 6, by EXECUTING the emitted specs — the predicateInversion /
 * guardPolarity pattern: generate a fixture app whose component carries the
 * fact, show the new assertions present and green, apply the named mutation,
 * show it reds exactly the test that owns the mutated fact.
 *
 * Item 5's mutation is PLAN-01's "delete one dep from the guard": with the
 * `!org` operand gone, the leg that owned `!org` must red — and it can only
 * red if its assertion discriminates the guard's own throw from the crash the
 * page now takes on a later line (a TypeError off the unchecked dep). The
 * bare rejects.toThrow() the pre-D1c emitter would have written stays green
 * on that mutation; the message-specific assertion reds.
 *
 * Item 6's mutation is "rename a variant option": renaming an EXERCISED option
 * reds its matrix test (the value table makes the rename observable);
 * renaming a CUT option stays green — the honest limit of a cap, named in the
 * skip title but not executed.
 */

const GUARDED_PAGE = `import { getOrg, getUser } from "../../lib/data";

export default async function GuardedPage() {
  const [user, org] = await Promise.all([getUser(), getOrg()]);
  if (!user || !org) throw new Error("user and org are required");
  return <h1>{user.name} @ {org.name}</h1>;
}
`;

const LAYOUT = `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

const DATA = `export function getUser(): Promise<{ name: string }> {
  return Promise.resolve({ name: "Ada" });
}

export function getOrg(): Promise<{ name: string }> {
  return Promise.resolve({ name: "Acme" });
}
`;

// The P7 shape: eight literal options, a value table, and the option-space
// validation at MODULE scope — an in-body throw flags the render guarded and
// demotes the variant matrix to mount-only asserts.
const CHIP = `type ChipProps = {
  size: "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";
};

const SIZES: Record<string, string> = {
  xs: "chip chip-xs",
  sm: "chip chip-sm",
  md: "chip chip-md",
  lg: "chip chip-lg",
  xl: "chip chip-xl",
  "2xl": "chip chip-2xl",
  "3xl": "chip chip-3xl",
};

function requireSize(size: string): string {
  const cls = SIZES[size];
  if (cls === undefined) throw new Error(\`unknown size: \${size}\`);
  return cls;
}

export function Chip({ size }: ChipProps) {
  const cls = requireSize(size);
  return <span className={cls}>{size}</span>;
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

async function installRunners(app: string): Promise<string> {
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
  return vitestBin;
}

let tmpRoot: string | undefined;
const extraRoots: string[] = [];

async function mkRoot(): Promise<string> {
  if (tmpRoot !== undefined) return tmpRoot;
  const r = await mkdtemp(path.join(tmpdir(), "flawless-d1c-exec-"));
  extraRoots.push(r);
  return r;
}

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  for (const r of extraRoots) rmSync(r, { recursive: true, force: true });
});

describe("D1c: per-dep guard legs, executed", () => {
  test("each operand owns a leg; deleting an operand reds exactly that leg", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-d1c-exec-"));
    const app = path.join(tmpRoot, "guardapp");
    mkdirSync(path.join(app, "src/app/guarded"), { recursive: true });
    // detectNextjs refuses a directory that does not look like Next: a config
    // file is enough, and the emitted spec never imports next itself (the
    // guard throws, it does not redirect), so next stays uninstalled.
    writeFileSync(path.join(app, "next.config.ts"), `export default {};\n`);
    mkdirSync(path.join(app, "src/lib"), { recursive: true });
    writeFileSync(
      path.join(app, "package.json"),
      `${JSON.stringify({ name: "guardapp" }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(app, "src/app/layout.tsx"), LAYOUT);
    writeFileSync(path.join(app, "src/app/guarded/page.tsx"), GUARDED_PAGE);
    writeFileSync(path.join(app, "src/lib/data.ts"), DATA);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "**", "*.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      nextjs: app,
      log: false,
      inlineSummary: false,
      colocate: true,
    });
    expect(result.exitCode).toBe(0);

    // Emission: two legs, each asserting the guard's OWN message — the
    // discrimination the falsifier needs (a bare toThrow() would let the
    // post-mutation TypeError pass as the guard).
    const specPath = path.join(app, "src/app/guarded/page.flawless.test.tsx");
    const spec = readFileSync(specPath, "utf8");
    expect(spec).toContain(
      'test("GuardedPage: throw() when getUser returns undefined (operand 1 of 2: !user)"',
    );
    expect(spec).toContain(
      'test("GuardedPage: throw() when getOrg returns undefined (operand 2 of 2: !org)"',
    );
    expect(spec).toContain('rejects.toThrow("user and org are required")');

    const vitestBin = await installRunners(app);
    const config = path.join(outDir, "vitest.config.mts");
    const vitest = async (): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn(
        [vitestBin, "run", "--config", config, "src/app/guarded/page.flawless.test.tsx"],
        { cwd: app, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      return { code, output: out + err };
    };

    const green = await vitest();
    if (green.code !== 0) console.error(green.output);
    expect(green.code).toBe(0);
    expect(green.output).toContain("3 passed");

    const pagePath = path.join(app, "src/app/guarded/page.tsx");
    const orig = readFileSync(pagePath, "utf8");
    const failedLegs = (output: string): string =>
      output
        .split("\n")
        .filter((l) => /(×|✗|FAIL)/.test(l) && /operand \d of 2/.test(l))
        .join("\n");

    // Mutation 1 (PLAN-01's named mutation): delete the `!org` operand. The
    // spec is NOT regenerated — the leg that operand owned must red on its
    // own, through the message mismatch, while the other leg and the contract
    // test stay green.
    writeFileSync(pagePath, orig.replace("if (!user || !org)", "if (!user)"));
    const noOrg = await vitest();
    expect(noOrg.code).not.toBe(0);
    expect(failedLegs(noOrg.output)).toContain("operand 2 of 2");
    expect(failedLegs(noOrg.output)).not.toContain("operand 1 of 2");

    // Mutation 2: the mirror — delete the `!user` operand instead.
    writeFileSync(pagePath, orig.replace("if (!user || !org)", "if (!org)"));
    const noUser = await vitest();
    expect(noUser.code).not.toBe(0);
    expect(failedLegs(noUser.output)).toContain("operand 1 of 2");
    expect(failedLegs(noUser.output)).not.toContain("operand 2 of 2");
  }, 240_000);
});

describe("D1c: the variant cap, executed", () => {
  test("the cap names its cuts; renaming an exercised option reds the matrix, a cut option stays green", async () => {
    const app = path.join(await mkRoot(), "chipapp");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(
      path.join(app, "package.json"),
      `${JSON.stringify({ name: "chipapp" }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    const chipPath = path.join(app, "src", "Chip.tsx");
    writeFileSync(chipPath, CHIP);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: chipPath,
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // Emission: the cap statement in the spec, and every cut option skipped
    // by name under the stable `not-analysed` reason.
    const spec = readFileSync(path.join(outDir, "unit", "Chip.test.tsx"), "utf8");
    expect(spec).toContain("// variant cap: 5 of 7 exercised — the cap is --variants;");
    expect(spec).toContain(
      'test.skip("renders with {\\"size\\":\\"2xl\\"} — not-analysed", () => {});',
    );
    expect(spec).toContain(
      'test.skip("renders with {\\"size\\":\\"3xl\\"} — not-analysed", () => {});',
    );

    const vitestBin = await installRunners(app);
    const vitest = async (): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn([vitestBin, "run", "unit/Chip.test.tsx"], {
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

    const green = await vitest();
    if (green.code !== 0) console.error(green.output);
    expect(green.code).toBe(0);
    // 7 options, cap 5 → the two cut options (2xl, 3xl) skip by name.
    expect(green.output).toContain("2 skipped");

    const orig = readFileSync(chipPath, "utf8");

    // Mutation (PLAN-01's named mutation): rename an EXERCISED option — the
    // union member and its table entry together, which is what renaming an
    // option means. The spec still passes {"size":"sm"}; the table no longer
    // answers it; the matrix test that exercised it reds.
    writeFileSync(
      chipPath,
      orig.replace('"sm" |', '"small" |').replace('sm: "chip chip-sm"', 'small: "chip chip-small"'),
    );
    const exercised = await vitest();
    expect(exercised.code).not.toBe(0);
    expect(exercised.output).toContain('renders with {"size":"sm"}');

    // Control: rename a CUT option. Nothing exercised references it — the
    // skip names it but does not execute it — so the suite stays green. That
    // is the cap's honest limit, and the skip title is what makes it visible
    // rather than silent.
    writeFileSync(
      chipPath,
      orig.replace('"3xl"', '"3XL"').replace('"3xl": "chip chip-3xl"', '"3XL": "chip chip-3xl"'),
    );
    const cut = await vitest();
    if (cut.code !== 0) console.error(cut.output);
    expect(cut.code).toBe(0);
  }, 240_000);
});
