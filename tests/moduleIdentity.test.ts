import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * One module is one mock, however many ways the render spells its path.
 *
 * The page imports `<Button>` from "./components/ui/button" and a sibling
 * imports `buttonVariants` from "./ui/button". Same file, two specifier texts.
 * The component-tree walk keyed its per-module merge on the TEXT, so the
 * sibling's view was stored raw rather than merging into the unit's own
 * statement, and two things fell out of that together:
 *
 *   - the sibling's name was never marked graph-added, so a helper the page
 *     never named FORCED a whole-module factory — the documented invariant is
 *     that a graph-added name carries no evidence about whether to mock at all;
 *   - the factory that got forced enumerated only the sibling's names, so the
 *     module stopped exporting `Button`, the very element the page renders.
 *
 * Executed witness on the emitted mocks verbatim, control (this tree minus the
 * change) versus fixed:
 *
 *   [vitest] No "Button" export is defined on the "../../src/components/ui/button"
 *   mock. Did you forget to return it from "vi.mock"?
 *
 * The same shape is what the dogfood app's `next-themes` spec threw — a factory
 * for `{ useTheme }` while the real provider module behind it reads
 * `ThemeProvider` off that package.
 */

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

/** The sibling: same module, spelled from its own directory, calling the helper. */
const CHIP = `import { buttonVariants } from "./ui/button";

export function Chip() {
  return <span className={buttonVariants({ variant: "ghost" })}>chip</span>;
}
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

const PAGE = `import { getJob } from "./data";
import { Button } from "./components/ui/button";
import { Chip } from "./components/Chip";

export default async function Page() {
  const job = await getJob();
  return (
    <main>
      <h1>{job.title}</h1>
      <Button>Save</Button>
      <Chip />
    </main>
  );
}
`;

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

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

describe("one module, however many ways the render spells its path", () => {
  test("the sibling's helper joins the unit's view instead of forcing a factory that drops the component", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-module-identity-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src/components/ui"), { recursive: true });
    mkdirSync(path.join(app, "src/lib"), { recursive: true });
    writeFileSync(
      path.join(app, "package.json"),
      `${JSON.stringify({ name: "module-identity", private: true }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(app, "src/components/ui/button.tsx"), BUTTON);
    writeFileSync(path.join(app, "src/components/Chip.tsx"), CHIP);
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

    // The ui module is ONE module: the sibling's `buttonVariants` arrives as a
    // graph-added name on the unit's own statement, the module's live bindings
    // are pure helpers, so nothing here needs it mocked.
    expect(spec).not.toContain('vi.mock("../../src/components/ui/button"');
    expect(spec).not.toContain("buttonVariants:");
    // And the mock the page DOES need is still there — this is not the emitter
    // mocking less across the board.
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

    // The probe: the emitted mocks verbatim, and BOTH sides of the merge under
    // test — the component the page renders and the sibling that calls the
    // helper the graph added.
    const lines = spec.split("\n");
    const from = lines.findIndex((l) => l.startsWith("vi.mock("));
    const to = lines.findIndex((l, i) => i > from && l.startsWith("import "));
    const mockLines = lines.slice(from, to).join("\n");
    const probe = `import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import type * as React from "react";
${mockLines}
import Page from "../../src/Page";

test("the page renders its real Button next to the sibling that calls the helper", async () => {
  const ui: React.ReactNode = await Page();
  render(<>{ui}</>);
  expect(screen.getByRole("button", { name: "Save" }).className).toContain("bg-primary");
  expect(screen.getByText("chip")).toBeInTheDocument();
});
`;
    const probePath = path.join(outDir, "unit", "ModuleIdentityProbe.test.tsx");
    writeFileSync(probePath, probe);

    const probed = await runVitest(app, outDir, "unit/ModuleIdentityProbe.test.tsx");
    if (probed.code !== 0) console.error(probed.output);
    expect(probed.code).toBe(0);
    expect(probed.output).not.toContain('No "Button" export');

    const generated = await runVitest(app, outDir, "unit/Page.test.tsx");
    if (generated.code !== 0) console.error(generated.output);
    expect(generated.code).toBe(0);
  }, 240_000);
});
