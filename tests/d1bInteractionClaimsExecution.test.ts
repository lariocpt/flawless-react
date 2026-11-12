import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * D1 items 3 and 4 — interaction claims — EXECUTED (PLAN-01 acceptance: a
 * falsifier, not a green run).
 *
 * Item 3: a fetch fired from an event handler (not an effect) gets the four
 * fetch tests, driven by the derived dispatch. Deleting the fetch call inside
 * the handler must turn the request-count leg red — the claim is behaviour,
 * which is exactly what PLAN-00's amended request-count row tiers T2.
 *
 * Item 4: a client component whose branches key on a PROP predicate asserts
 * the presence/absence mirror pair — each leg renders its own branch's literal
 * and asserts the other's absent. Swapping the branch literals must turn it
 * red: the witnesses are keyed to the predicate's polarity, not to the copy.
 *
 * The named refusals ride along as emission assertions: a branch with no
 * assertable literal on one side, and a predicate not reachable from a prop
 * override, refuse by name — never a silent drop.
 *
 * Mechanics follow tests/hostA11yAttrsExecution.test.ts: the suite is
 * generated ONCE; between green and red only the component source is written,
 * never the spec — the red must come from the emitted assertion reading the
 * mutated markup, not from regeneration.
 */

const CLICK_FETCH = `"use client";

export function ClickFetch() {
  function ask() {
    void fetch("/api/items").catch(() => undefined);
  }
  return (
    <div>
      <button type="button" onClick={ask}>
        Load items
      </button>
    </div>
  );
}
`;

const PROP_PREDICATE = `"use client";

export function PropPredicate({ empty }: { empty?: boolean }) {
  if (empty) {
    return <p>No items yet</p>;
  }
  return <p>3 items in stock</p>;
}
`;

// A branch with no literal on the false side: the pair has nothing falsifiable
// to move, so the inversion refuses by name instead of claiming an absence
// over an <img>.
const ONE_SIDED = `"use client";

export function OneSided({ flag }: { flag?: boolean }) {
  return <div>{flag ? <p>Visible panel text</p> : <img src="/x.png" alt="" />}</div>;
}
`;

// The predicate keys on a destructured field of an object prop — a path the
// spec cannot override with a single prop, so it refuses by name.
const DEEP_PREDICATE = `"use client";

export function DeepPredicate({ config }: { config: { view?: string } }) {
  const { view } = config;
  return <div>{view === "grid" ? <p>Grid layout</p> : <p>List layout</p>}</div>;
}
`;

const OPENAPI = JSON.stringify(
  {
    openapi: "3.0.0",
    info: { title: "d1b-exec", version: "1.0.0" },
    paths: {
      "/api/items": {
        get: {
          summary: "List items",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { example: { greeting: "Hello from the API" } },
              },
            },
          },
        },
      },
    },
  },
  null,
  2,
);

function suitePins(): string[] {
  const pkg = JSON.parse(suitePackageJson("/x/flawless", false, true)) as {
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
    "msw",
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

describe("D1 items 3+4, interaction claims, executed", () => {
  test("click-fetch and prop-predicate claims run green; the named mutations go red, the reverts go green", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-d1b-exec-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify(
        {
          name: "d1b-exec",
          dependencies: { next: "15.0.0", react: "19.1.0", "react-dom": "19.1.0" },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      path.join(app, "next.config.ts"),
      "const nextConfig = { reactStrictMode: true };\nexport default nextConfig;\n",
    );
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(app, "openapi.json"), OPENAPI);
    mkdirSync(path.join(app, "src", "app"), { recursive: true });
    writeFileSync(
      path.join(app, "src", "app", "layout.tsx"),
      `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    );
    writeFileSync(
      path.join(app, "src", "app", "page.tsx"),
      `export default function Home() {
  return <main>home</main>;
}
`,
    );
    const clickPath = path.join(app, "src", "ClickFetch.tsx");
    const propPath = path.join(app, "src", "PropPredicate.tsx");
    writeFileSync(clickPath, CLICK_FETCH);
    writeFileSync(propPath, PROP_PREDICATE);
    writeFileSync(path.join(app, "src", "OneSided.tsx"), ONE_SIDED);
    writeFileSync(path.join(app, "src", "DeepPredicate.tsx"), DEEP_PREDICATE);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "*.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      nextjs: app,
      apiSpec: path.join(app, "openapi.json"),
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    const clickSpec = readFileSync(path.join(outDir, "unit", "ClickFetch.test.tsx"), "utf8");
    const propSpec = readFileSync(path.join(outDir, "unit", "PropPredicate.test.tsx"), "utf8");
    const oneSidedSpec = readFileSync(path.join(outDir, "unit", "OneSided.test.tsx"), "utf8");
    const deepSpec = readFileSync(path.join(outDir, "unit", "DeepPredicate.test.tsx"), "utf8");

    // Emission, item 3: the fetch describe is DRIVEN — an unconditional
    // dispatch, not the conditional mount-hedge trigger — and the test names
    // say click, not mount.
    expect(clickSpec).toContain('describe("ClickFetch GET /api/items", () => {');
    expect(clickSpec).toContain(
      'test("click fetches and renders with a successful response", async () => {',
    );
    expect(clickSpec).toContain(
      '    await userEvent.click(screen.getAllByRole("button", { name: "Load items" })[0] as HTMLElement);',
    );
    expect(clickSpec).not.toContain("if (trigger) await userEvent.click");

    // Emission, item 4: the full mirror pair — each leg asserts its own
    // branch's literal present and the other's absent.
    expect(propSpec).toContain(
      'test("PropPredicate: empty flipped — 1 branch site(s) change side", () => {',
    );
    expect(propSpec).toContain('expect(t0).toContain("3 items in stock");');
    expect(propSpec).toContain('expect(t0).not.toContain("No items yet");');
    expect(propSpec).toContain("const second = renderTarget({ empty: true });");
    expect(propSpec).toContain('expect(t1).toContain("No items yet");');
    expect(propSpec).toContain('expect(t1).not.toContain("3 items in stock");');

    // Named refusals — never silent.
    expect(oneSidedSpec).toContain(
      `test.skip("OneSided: flag inversion refused — a branch it moves carries no assertable literal on one side", () => {});`,
    );
    expect(deepSpec).toContain(
      `test.skip("DeepPredicate: config.view inversion refused — the predicate is not reachable from a prop override this spec can build", () => {});`,
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
        [vitestBin, "run", "unit/ClickFetch.test.tsx", "unit/PropPredicate.test.tsx"],
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

    // GREEN — both claims hold against the correct components.
    const green = await vitest();
    if (green.code !== 0) console.error(green.output);
    expect(green.code).toBe(0);

    // FALSIFIER, item 3 — delete the fetch call inside the handler. The
    // request-count leg must go red: the count is the claim.
    writeFileSync(
      clickPath,
      CLICK_FETCH.replace('    void fetch("/api/items").catch(() => undefined);\n', ""),
    );
    const redFetch = await vitest();
    expect(redFetch.code).not.toBe(0);
    expect(redFetch.output).toContain("click fetches and renders with a successful response");
    expect(redFetch.output).toContain("expected 0 to be greater than 0");
    writeFileSync(clickPath, CLICK_FETCH);
    const greenAgain = await vitest();
    if (greenAgain.code !== 0) console.error(greenAgain.output);
    expect(greenAgain.code).toBe(0);

    // FALSIFIER, item 4 — swap the branch literals. The witnesses are keyed
    // to the predicate's polarity, so the legs go red on copy that moved.
    writeFileSync(
      propPath,
      PROP_PREDICATE.replace("No items yet", "%%SWAP%%")
        .replace("3 items in stock", "No items yet")
        .replace("%%SWAP%%", "3 items in stock"),
    );
    const redBranch = await vitest();
    expect(redBranch.code).not.toBe(0);
    expect(redBranch.output).toContain("empty flipped — 1 branch site(s) change side");
    expect(redBranch.output).toContain("to contain");
    writeFileSync(propPath, PROP_PREDICATE);
    const greenFinal = await vitest();
    if (greenFinal.code !== 0) console.error(greenFinal.output);
    expect(greenFinal.code).toBe(0);
  }, 360_000);
});
