import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * D2a (PLAN-02 items 1-2), by EXECUTING the emitted specs — the content
 * witness on the DOM plane: generate a fixture app whose components render
 * fetched data through a child, show the witness assertion present and
 * green, apply the named mutations, show the success test red exactly as
 * T3 promises — falsified by a data-flow change — then revert to green.
 *
 * The two components are the two shapes a witness can witness:
 *
 *   TextFetch — the parent fetches into state and hands the response to a
 *   child that renders ONE field as plain text.
 *   ListFetch — the parent fetches rows into state; a child maps them and a
 *   grandchild row component renders one field of each row. The witness
 *   reaches the grandchild through the subtree walk, which is the whole
 *   point of attributing renderedFields to the entry file.
 *
 * The mutation set is PLAN-02 acceptance 1's, operationalised as source-
 * only edits — the spec is NOT regenerated between green and red, so the
 * inlined FIXTURE is a constant and only the component's source moves:
 *
 *   1. rename the rendered field in the component: the child now displays a
 *      DIFFERENT sentinel (the fixture carries both), so the red is
 *      "another fixture value is on screen", not "nothing is";
 *   2. change the fixture field the witness reads: the feed now puts a
 *      different fixture field into the rendered slot, so the value the
 *      witness is pinned to no longer appears under the field name that
 *      still renders.
 *
 * Both mutations revert to green, which is what makes the red a
 * measurement instead of a coincidence.
 */

const LAYOUT = `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

const PAGE = `import { ListFetch } from "../components/ListFetch";
import { TextFetch } from "../components/TextFetch";

export default function HomePage() {
  return (
    <main>
      <TextFetch />
      <ListFetch />
    </main>
  );
}
`;

// Both fixture fields carry sentinels: the green render shows one, and each
// mutation makes the OTHER the visible value — a red that proves the witness
// is pinned to a field, not to "some fixture string happened to render".
const TEXT_FETCH = `// Text-rendering fetch (D2a execution fixture): the parent fetches into
// state and hands the response to a child that renders one field as text.
"use client";
import { useEffect, useState } from "react";

type GreetingData = { greeting: string; other: string };

function Greeting({ data }: { data: GreetingData | null }) {
  if (data === null) {
    return <p>Loading…</p>;
  }
  return <p>{data.greeting}</p>;
}

export function TextFetch() {
  const [data, setData] = useState<GreetingData | null>(null);
  useEffect(() => {
    void fetch("/api/items")
      .then((r) => r.json())
      .then((j: GreetingData) => setData({ greeting: j.greeting, other: j.other }))
      .catch(() => setData(null));
  }, []);
  return <Greeting data={data} />;
}
`;

const LIST_FETCH = `// List-rendering fetch (D2a execution fixture): the parent fetches rows
// into state; a child maps them and a grandchild row renders one field.
"use client";
import { useEffect, useState } from "react";

type RowData = { id: number; label: string; other: string };

function Row({ row }: { row: RowData }) {
  return <li>{row.label}</li>;
}

function RowList({ rows }: { rows: RowData[] | null }) {
  if (rows === null) {
    return <p>Loading…</p>;
  }
  return <ul>{rows.map((row) => <Row key={row.id} row={row} />)}</ul>;
}

export function ListFetch() {
  const [rows, setRows] = useState<RowData[] | null>(null);
  useEffect(() => {
    void fetch("/api/rows")
      .then((r) => r.json())
      .then((j: { rows: RowData[] }) =>
        setRows(j.rows.map((r) => ({ id: r.id, label: r.label, other: r.other }))),
      )
      .catch(() => setRows(null));
  }, []);
  return <RowList rows={rows} />;
}
`;

const OPENAPI = `${
  JSON.stringify(
    {
      openapi: "3.0.0",
      info: { title: "witnessapp", version: "1.0.0" },
      paths: {
        "/api/items": {
          get: {
            responses: {
              200: {
                description: "OK",
                content: {
                  "application/json": {
                    example: {
                      greeting: "flawless-w1-greeting",
                      other: "flawless-w1-other",
                    },
                  },
                },
              },
            },
          },
        },
        "/api/rows": {
          get: {
            responses: {
              200: {
                description: "OK",
                content: {
                  "application/json": {
                    example: {
                      rows: [
                        {
                          id: 1,
                          label: "flawless-w2-label",
                          other: "flawless-w2-other",
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    null,
    2,
  ) + "\n"
}`;

/** The emitted suite's own pins — the install cannot drift from the manifest. */
function suitePins(): string[] {
  const pkg = JSON.parse(suitePackageJson("/x/flawless", false, true, true)) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return [
    "react",
    "react-dom",
    "msw",
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

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("D2a: the content witness, executed", () => {
  test("witness present and green; both named mutations red; revert green", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-d2a-exec-"));
    const app = path.join(tmpRoot, "witnessapp");
    mkdirSync(path.join(app, "src/components"), { recursive: true });
    mkdirSync(path.join(app, "src/app"), { recursive: true });
    writeFileSync(path.join(app, "next.config.ts"), `export default {};\n`);
    writeFileSync(
      path.join(app, "package.json"),
      `${JSON.stringify({ name: "witnessapp" }, null, 2)}\n`,
    );
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(app, "openapi.json"), OPENAPI);
    writeFileSync(path.join(app, "src/app/layout.tsx"), LAYOUT);
    writeFileSync(path.join(app, "src/app/page.tsx"), PAGE);
    const textPath = path.join(app, "src/components/TextFetch.tsx");
    const listPath = path.join(app, "src/components/ListFetch.tsx");
    writeFileSync(textPath, TEXT_FETCH);
    writeFileSync(listPath, LIST_FETCH);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "**", "*.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      nextjs: app,
      apiSpec: path.join(app, "openapi.json"),
      log: false,
      inlineSummary: false,
      colocate: true,
    });
    expect(result.exitCode).toBe(0);

    // Emission: the witness is present in both specs and the success TODO is
    // gone — while the delayed/500/empty TODOs (D3's subject) are untouched.
    const textSpecPath = path.join(app, "src/components/TextFetch.flawless.test.tsx");
    const listSpecPath = path.join(app, "src/components/ListFetch.flawless.test.tsx");
    const textSpec = readFileSync(textSpecPath, "utf8");
    const listSpec = readFileSync(listSpecPath, "utf8");
    expect(textSpec).toContain('getAllByText("flawless-w1-greeting", { exact: false })');
    expect(textSpec).toContain("subtree renders `greeting` as text");
    expect(textSpec).not.toContain("assert rendered content derived from FIXTURE");
    expect(listSpec).toContain('getAllByText("flawless-w2-label", { exact: false })');
    expect(listSpec).toContain("the fixture's value at `rows.0.label`");
    expect(listSpec).not.toContain("assert rendered content derived from FIXTURE");
    for (const spec of [textSpec, listSpec]) {
      for (const todo of [
        "assert the loading indicator while the response is pending.",
        "assert the error-state UI.",
        "assert the empty-state copy.",
      ]) {
        expect(spec, `the untouched TODO must stay: ${todo}`).toContain(`TODO(flawless): ${todo}`);
      }
    }

    const vitestBin = await installRunners(app);
    const config = path.join(outDir, "vitest.config.mts");
    const vitest = async (): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn(
        [vitestBin, "run", "--config", config, textSpecPath, listSpecPath, "--reporter=verbose"],
        { cwd: app, stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      return { code, output: out + err };
    };
    // Vitest's verbose reporter marks each failed test in the list with ×
    // (U+00D7); the "Failed Tests" section repeats it as " FAIL " lines, which
    // we deliberately do NOT count. A single character class like [×✗FAIL]
    // would match any line starting with F/A/I/L — including "Ignored nodes:"
    // — and break the one-failure-per-mutation count.
    const failureLines = (output: string): string[] =>
      output.split("\n").filter((l) => /^\s*[\u00d7\u2717]/.test(l));
    const greenCheck = (label: string, run: { code: number; output: string }): void => {
      if (run.code !== 0) console.error(run.output);
      expect(run.code, `${label}: the suite must be green`).toBe(0);
      expect(failureLines(run.output).length, `${label}: no test may fail`).toBe(0);
      // Non-vacuity: the SUCCESS test of both specs actually ran.
      expect(run.output).toContain("mount fetches and renders with a successful response");
      expect(run.output.match(/✓/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    };

    const green = await vitest();
    greenCheck("baseline", green);

    // --- TextFetch -------------------------------------------------------

    // Mutation 1: rename the rendered field in the child — {data.greeting}
    // becomes {data.other}. The feed still carries both sentinels, so the
    // visible value is the fixture's OTHER sentinel and the witness's own
    // value is gone from the screen.
    const textOrig = readFileSync(textPath, "utf8");
    const textMut1 = textOrig.replace("{data.greeting}", "{data.other}");
    expect(textMut1).not.toBe(textOrig);
    writeFileSync(textPath, textMut1);
    let red = await vitest();
    expect(red.code).not.toBe(0);
    expect(failureLines(red.output).length).toBe(1);
    expect(failureLines(red.output)[0]).toContain("successful response");
    expect(red.output).toContain("flawless-w1-greeting"); // the missing witness
    expect(red.output).not.toMatch(/×.*ListFetch/); // the other spec stays green
    writeFileSync(textPath, textOrig);

    // Mutation 2: change the fixture field the witness reads — the feed now
    // puts the fixture's `other` value into the `greeting` slot. The field
    // name that renders is unchanged; the value under it is not the one the
    // witness is pinned to.
    const textMut2 = textOrig.replace("greeting: j.greeting", "greeting: j.other");
    expect(textMut2).not.toBe(textOrig);
    writeFileSync(textPath, textMut2);
    red = await vitest();
    expect(red.code).not.toBe(0);
    expect(failureLines(red.output).length).toBe(1);
    expect(failureLines(red.output)[0]).toContain("successful response");
    expect(red.output).toContain("flawless-w1-greeting");
    expect(red.output).not.toMatch(/×.*ListFetch/);
    writeFileSync(textPath, textOrig);

    greenCheck("text revert", await vitest());

    // --- ListFetch -------------------------------------------------------

    // Mutation 1: the grandchild row now renders {row.other} — a different
    // sentinel than the witness's pinned value.
    const listOrig = readFileSync(listPath, "utf8");
    const listMut1 = listOrig.replace("{row.label}", "{row.other}");
    expect(listMut1).not.toBe(listOrig);
    writeFileSync(listPath, listMut1);
    red = await vitest();
    expect(red.code).not.toBe(0);
    expect(failureLines(red.output).length).toBe(1);
    expect(failureLines(red.output)[0]).toContain("successful response");
    expect(red.output).toContain("flawless-w2-label");
    expect(red.output).not.toMatch(/×.*TextFetch/); // the other spec stays green
    writeFileSync(listPath, listOrig);

    // Mutation 2: the feed map now puts the fixture's `other` value into the
    // `label` slot — the rendered field name is unchanged, its value is not.
    const listMut2 = listOrig.replace("label: r.label", "label: r.other");
    expect(listMut2).not.toBe(listOrig);
    writeFileSync(listPath, listMut2);
    red = await vitest();
    expect(red.code).not.toBe(0);
    expect(failureLines(red.output).length).toBe(1);
    expect(failureLines(red.output)[0]).toContain("successful response");
    expect(red.output).toContain("flawless-w2-label");
    expect(red.output).not.toMatch(/×.*TextFetch/);
    writeFileSync(listPath, listOrig);

    greenCheck("list revert", await vitest());
  }, 300_000);
});
