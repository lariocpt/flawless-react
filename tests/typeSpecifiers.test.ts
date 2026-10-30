import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * A `type` import specifier does not exist at runtime, and the mock emitter has
 * to treat it that way.
 *
 * shadcn/ui writes the same line in every `ui/*` module:
 *
 *   import { cva, type VariantProps } from "class-variance-authority"
 *
 * `collectModuleImports` recorded BOTH names as live imports of a statement that
 * is not `isTypeOnly`, so `VariantProps` — a name no importer can call — was the
 * non-pure binding that FORCED a factory over `class-variance-authority`. And
 * the factory re-supplied the module's pure binding with the class-string stub,
 * which is right for `cn` and wrong for `cva`: `cva(base, config)` returns a
 * FUNCTION, so the app's own `const buttonVariants = cva(…)` evaluated to a
 * string and every call site threw "buttonVariants is not a function".
 *
 * A fresh generation of a Next.js + shadcn app failed 76 of 79 specs on exactly
 * that. The witness was one line of emitted output:
 *
 *   vi.mock("class-variance-authority", () => ({
 *     cva: vi.fn((...args: unknown[]) => args.filter(Boolean).join(" ")),
 *     VariantProps: vi.fn((props: { children?: React.ReactNode }) => props.children ?? null),
 *   }));
 *
 * So this pins three things: the type specifier earns the package no mock at
 * all; the emitted spec runs; and the variant table is LIVE underneath it — the
 * button's class list carries a variant's classes, which a string-joining stub
 * could not produce.
 */

/** shadcn's button.tsx, in miniature: cva + a `type` specifier + a VariantProps use. */
const BUTTON = `import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva("inline-flex rounded-md text-sm", {
  variants: {
    variant: { default: "bg-primary text-primary-fg", ghost: "bg-transparent" },
  },
  defaultVariants: { variant: "default" },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant }), className)}>{props.children}</button>;
}

export { buttonVariants };
`;

const UTILS = `export function cn(...inputs: (string | false | undefined | null)[]): string {
  return inputs.filter(Boolean).join(" ");
}
`;

const DATA = `export interface Job { title: string }

export async function getJob(): Promise<Job> {
  throw new Error("the real data layer must never run under jsdom");
}
`;

/**
 * The page pulls the ui module into its render graph by rendering `<Button>`;
 * nothing imports `buttonVariants` itself. That keeps this case about the cva
 * factory alone — the module that gets mocked is the package, not the ui file.
 */
const PAGE = `import { getJob } from "./data";
import { Button } from "./components/ui/button";

export default async function Page() {
  const job = await getJob();
  return (
    <main>
      <h1>{job.title}</h1>
      <Button>Save</Button>
    </main>
  );
}
`;

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Everything the emitted suite imports that this repo does not install, plus
 * class-variance-authority itself — the module under test has to be REAL here,
 * since the whole point is that the app's variant table still runs.
 */
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
  ]
    .map((name) => {
      const range = all[name];
      if (range === undefined) throw new Error(`the emitted suite no longer pins ${name}`);
      return `${name}@${range}`;
    })
    .concat("class-variance-authority@0.7.1");
}

async function scaffold(name: string): Promise<{ app: string; outDir: string; spec: string }> {
  const app = path.join(tmpRoot ?? "", name);
  mkdirSync(path.join(app, "src/components/ui"), { recursive: true });
  mkdirSync(path.join(app, "src/lib"), { recursive: true });
  writeFileSync(
    path.join(app, "package.json"),
    `${JSON.stringify({ name, private: true }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(app, "tsconfig.json"),
    `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
  );
  writeFileSync(path.join(app, "src/components/ui/button.tsx"), BUTTON);
  writeFileSync(path.join(app, "src/lib/utils.ts"), UTILS);
  writeFileSync(path.join(app, "src/data.ts"), DATA);
  writeFileSync(path.join(app, "src/Page.tsx"), PAGE);

  const outDir = path.join(app, "flawless");
  const result = await runCore({
    pattern: path.join(app, "src", "Page.tsx"),
    outDir,
    taskIds: ["unit-browser"],
    force: true,
    log: false,
    inlineSummary: false,
  });
  expect(result.exitCode).toBe(0);
  const spec = readFileSync(path.join(outDir, "unit", "Page.test.tsx"), "utf8");
  return { app, outDir, spec };
}

async function runVitest(
  app: string,
  outDir: string,
  specFile: string,
): Promise<{ code: number; output: string }> {
  const vitestBin = path.join(app, "node_modules", ".bin", "vitest");
  if (!existsSync(vitestBin)) throw new Error(`vitest did not install at ${vitestBin}`);
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
}

describe("a `type` import specifier is not a runtime binding", () => {
  test("the emitted spec, executed: the cva table stays real and the button renders its variant classes", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-type-spec-"));
    const { app, outDir, spec } = await scaffold("app");

    // The emitted shape. `class-variance-authority` is imported by the render
    // graph for `cva` alone once the type specifier is discounted, and a module
    // whose every live binding is pure stays REAL — no factory, no lie.
    expect(spec).not.toContain('vi.mock("class-variance-authority"');
    expect(spec).not.toContain("VariantProps");
    // The data module the page awaits is still mocked: the exemption is about
    // what is live, not about mocking everything.
    expect(spec).toContain('vi.mock("../../src/data"');

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

    // The probe: the page mounted with the emitted vi.mock statements VERBATIM,
    // asserting the thing the emitter does not — that `buttonVariants` is a
    // FUNCTION and the variant table produced its classes. Revert the fix and
    // this file dies on "buttonVariants is not a function", because the emitted
    // factory above is what replaces `cva`.
    const lines = spec.split("\n");
    const from = lines.findIndex((l) => l.startsWith("vi.mock("));
    const to = lines.findIndex((l, i) => i > from && l.startsWith("import "));
    const mockLines = lines.slice(from, to).join("\n");
    expect(mockLines).toContain('vi.mock("../../src/data"');
    const probe = `import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import type * as React from "react";
${mockLines}
import Page from "../../src/Page";

test("the page renders through the real cva table", async () => {
  const ui: React.ReactNode = await Page();
  render(<>{ui}</>);
  const button = screen.getByRole("button", { name: "Save" });
  expect(button.className).toContain("bg-primary");
  expect(button.className).toContain("inline-flex");
});
`;
    const probePath = path.join(outDir, "unit", "CvaProbe.test.tsx");
    writeFileSync(probePath, probe);

    const probed = await runVitest(app, outDir, "unit/CvaProbe.test.tsx");
    if (probed.code !== 0) console.error(probed.output);
    expect(probed.code).toBe(0);
    // Anti-vacuity: the class list the probe reads is the variant's, so a stub
    // returning the base string alone could not pass it.
    expect(probed.output).not.toContain("not a function");
  }, 180_000);
});
