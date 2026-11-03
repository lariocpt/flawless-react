import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * Defect #13, by execution — the factory side and the never-forcing guard.
 * The textual twin lives in tests/dogfood-baseline.test.ts (defect 13).
 *
 * The mock factory was built from the analysed importers alone, but a
 * vi.mock factory REPLACES the module for every importer. When the render
 * graph reached @/lib/data through src/lib/labels.ts — a .ts lib the *.tsx
 * entry pattern never opens — the real labels' own `import { signOff } from
 * "./data"` died at collection: the 2 Nov triage's measured receipt on this
 * fixture's regenerated suite was 2 failed, with `Error: [vitest] No
 * "signOff" export is defined on the "@/lib/data" mock`.
 *
 * The fix is on the ANALYSIS side: a one-hop graph extension reads each
 * non-analysed target's own import lines through the shared SourceFileCache
 * and folds them into the per-module view as a synthetic whose runtime
 * names are all mergedNames — covered by any factory the module earns,
 * never a vote for earning one. The mocks-side candidate lost:
 * emitModuleMocks has no resolver or cache in scope to read a target's
 * imports with.
 *
 * Test 1 runs the aliased-next-app fixture end to end: the app's own
 * pinned react 19.1.0 installs first (defect #3), then ONLY the five
 * runners the emitted specs import, at the suite manifest's ranges (never
 * react or react-dom), then the tool on its standing invocation, then a
 * probe spec that renders the real page with the page spec's own mock
 * block — asserting the stubbed signOff's String({}) reaches the DOM
 * through the real labels lib — and that the whole unit plane runs green.
 *
 * Test 2 is the never-forcing guard, through real analysis: a plain app
 * whose page imports the pure ./utils (cn) and whose child Card imports a
 * non-analysed ./builder that binds a second name (themeClass) from the
 * same utils. The extension must leave utils' exemption (every binding
 * pure or graph-only) intact — the emitted page spec carries no vi.mock
 * for utils while the evidenced ./data still earns its factory — and the
 * probe asserts the builder's true rendered output ("themed card"), which
 * no stub combination can produce: a forced utils factory would stub
 * themeClass as a function (never called, never annotated, and the
 * synthetic carries no purity of its own) that the working pure cn stub
 * stringifies to source text. The page div's className is a secondary
 * anchor only — the pure cn stub satisfies it either way. The builder's
 * own mock is pinned neither way: the Card's type-first import wiring
 * keeps its merged view type-only, but that is the fixture's property, not
 * the guard's.
 *
 * Gates: per the operator's request nothing is executed on the authoring
 * machine, so these are the assertions the verification host must make
 * green — no tally is claimed here.
 */

const FIXTURE = path.resolve(__dirname, "fixtures", "aliased-next-app");

/**
 * The five dev runners the emitted specs import — the only packages added
 * on top of an app that already carries its own react (test 1). Ranges
 * come from the suite manifest, never hand-picked.
 */
const RUNNERS = [
  "vitest",
  "jsdom",
  "@testing-library/react",
  "@testing-library/user-event",
  "@testing-library/jest-dom",
];

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

type SuiteManifest = {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/**
 * name@range pins for `bun add -d`, straight from the emitted suite
 * manifest — the same source a real user installs. With reactPinDir the
 * pin reads the app's own installed react (the fixture's 19.1.0 keeps RTL
 * at 16); without it the manifest's own fallbacks apply (the guard app
 * carries no react of its own).
 */
function suitePins(outDir: string, names: string[], reactPinDir?: string): string[] {
  const manifest = suitePackageJson(outDir, false, false, false, reactPinDir);
  const pkg = JSON.parse(manifest) as SuiteManifest;
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return names.map((name) => {
    const range = all[name];
    if (range === undefined) throw new Error(`the emitted suite no longer pins ${name}`);
    return `${name}@${range}`;
  });
}

async function bunRun(args: string[], cwd: string, label: string): Promise<void> {
  const proc = Bun.spawn(["bun", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${label} failed (needs registry access):\n${err}`);
}

/**
 * Run vitest from cwd; return stdout and the exit code. console.error on a
 * non-zero exit mirrors the execution tests' pattern, so a red run leaves
 * its output in the gate log.
 */
async function vitestRun(vitestBin: string, args: string[], cwd: string) {
  const proc = Bun.spawn([vitestBin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) console.error(out);
  return { out, code };
}

/**
 * The emitted spec's mock block: from the first vi.mock(/vi.hoisted( line
 * to the line before the next import. The rscSpec/unitSpec headers place
 * the mock statements (a TODO note plus a one-line vi.mock, consecutive)
 * between the runner imports and the provider/component imports, so the
 * span is the whole mock surface. The probe embeds it verbatim above its
 * own component import: probe and spec then hit the exact same factories.
 */
function mockBlockOf(spec: string): string {
  const lines = spec.split("\n");
  const start = lines.findIndex((l) => l.includes("vi.mock(") || l.includes("vi.hoisted("));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^import[ \t]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * The fixture's execution probe (written into the copied app by test 1).
 * Renders the REAL InboxPage with the page spec's own mock block. The real
 * labels lib is the witness: its module-scope `import { signOff } from
 * "./data"` binds the mocked data's factory entry, and signatureLine
 * renders String(signOff()) + " Inbox" into the .sig span.
 */
function signoffProbe(pageSpec: string): string {
  const mocks = mockBlockOf(pageSpec);
  if (!mocks) throw new Error("the emitted page spec carries no mock block to probe");
  return `// @ts-nocheck — defect #13 execution probe; written by tests/mockFactoryExtension.test.ts.
// Rendered with the page spec's OWN mock block (extracted verbatim below
// the imports), so probe and spec run against the exact same factories.
import { act, render } from "@testing-library/react";
import { Suspense } from "react";
import type * as React from "react";
import { expect, test, vi } from "vitest";
${mocks}
import InboxPage from "./page";

test("the stubbed signOff's output reaches the DOM through the real labels lib", async () => {
  const page = await InboxPage();
  let container: HTMLDivElement;
  await act(async () => {
    container = render(<Suspense fallback={null}>{page}</Suspense>).container;
  });
  const sig = container.querySelector(".sig");
  expect(sig).not.toBeNull();
  // signatureLine = String(signOff()) + " " + "Inbox"; the factory stubs
  // signOff as vi.fn(() => ({})), so String({}) is the exact render.
  expect(sig?.textContent).toBe("[object Object] Inbox");
});
`;
}

const GUARD_PAGE = `// @ts-nocheck — the guard mini-app's entry: its OWN import of cn is the
// unit's evidence for ./utils, and getThing is the evidenced data module.
import { Card } from "./Card";
import { cn } from "./utils";
import { getThing } from "./data";

export default async function GuardPage() {
  const thing = await getThing();
  return (
    <main>
      <div data-testid="page" className={cn("page")}>
        {thing}
      </div>
      <Card />
    </main>
  );
}
`;

const GUARD_CARD = `// @ts-nocheck — the type import deliberately PRECEDES the value import
// from the same module: statement order is the merge order, and only a
// type-only merge base keeps the ./builder view type-only (the mock loop
// skips it) — the same wiring the fixture uses for @/lib/labels.
"use client";
import type { Thing } from "./builder";
import { buildThing } from "./builder";

export function Card() {
  const label: Thing = { name: "card" };
  const thing = buildThing(label.name);
  return <div data-testid="card">{thing}</div>;
}
`;

const GUARD_UTILS = `// @ts-nocheck — the guard's target: a pure lib (no await, no live import,
// no top-level call) the analysis never opens.
export function cn(...classes: (string | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

export const themeClass = "themed";
`;

const GUARD_BUILDER = `// @ts-nocheck — never analysed: a .ts lib no entry pattern or rendered tag
// opens. It binds a SECOND name from the unit's own utils import — the
// shape the graph extension must cover without letting it vote.
import { cn, themeClass } from "./utils";

export interface Thing {
  name: string;
}

export function buildThing(name: string): string {
  return cn(themeClass, name);
}
`;

const GUARD_DATA = `// @ts-nocheck — the evidenced data module: the page awaits getThing. The
// async signature keeps it OUT of the pure-module exemption, so its call
// site earns a factory the never-forcing guard must not displace.
export async function getThing(): Promise<string> {
  return "thing";
}
`;

/**
 * The guard's execution probe (written into the mini-app by test 2). The
 * card's text is the witness: "themed card" is produced ONLY by the real
 * builder running the real utils — cn("themed", "card"). A regression that
 * let the extension's themeClass vote would force the utils factory, where
 * themeClass (never called, never annotated, and the synthetic carries no
 * purity of its own) becomes vi.fn(async () => ({})) — a function the
 * working pure cn stub stringifies to source text. No stub combination
 * yields "themed card".
 */
function guardProbe(pageSpec: string): string {
  const mocks = mockBlockOf(pageSpec);
  if (!mocks.includes('vi.mock("./data"'))
    throw new Error("the guard's page spec carries no data mock block to probe");
  return `// @ts-nocheck — defect #13 never-forcing guard probe; written by tests/mockFactoryExtension.test.ts.
// Rendered with the page spec's OWN mock block (the evidenced ./data
// factory only), so probe and spec run against the exact same factories.
import { act, render } from "@testing-library/react";
import { Suspense } from "react";
import type * as React from "react";
import { expect, test, vi } from "vitest";
${mocks}
import GuardPage from "./page";

test("the extension's names never forced the utils factory: the builder's output is the true join", async () => {
  const page = await GuardPage();
  let container: HTMLDivElement;
  await act(async () => {
    container = render(<Suspense fallback={null}>{page}</Suspense>).container;
  });
  // The witness. Real builder -> real utils -> cn("themed", "card").
  const card = container.querySelector('[data-testid="card"]');
  expect(card).not.toBeNull();
  expect(card?.textContent).toBe("themed card");
  // Secondary anchor only: the page's OWN cn import. Vacuous on its own —
  // the pure cn stub joins "page" to "page" either way — kept so a
  // regression that broke the page's own div would show up beside it.
  const pageDiv = container.querySelector('[data-testid="page"]');
  expect(pageDiv?.getAttribute("class")).toBe("page");
});
`;
}

describe("defect #13: the factory covers the non-analysed importer's names", () => {
  test("the page spec's data factory carries signOff; the real labels renders it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flawless-mockext-"));
    tmpDirs.push(root);
    const app = path.join(root, "aliased-next-app");
    cpSync(FIXTURE, app, { recursive: true });

    // The app's manifest pins react 19.1.0 (defect #3): install it FIRST,
    // so the runner pins the suite manifest computes read the app's react
    // (RTL 16) instead of the manifest's 18 fallback.
    await bunRun(["install"], app, "bun install");
    const outDir = path.join(app, "flawless");
    // RUNNERS ONLY — never react or react-dom: the app's pinned react must
    // stay the single copy every plane renders with.
    await bunRun(["add", "-d", ...suitePins(outDir, RUNNERS, app)], app, "bun add -d");
    const vitestBin = path.join(app, "node_modules", ".bin", "vitest");
    if (!existsSync(vitestBin)) throw new Error(`vitest did not install at ${vitestBin}`);

    // The fixture's standing run: the dogfood baseline's own invocation, so
    // the probe written below lands in the tree the tool sees.
    const result = await runCore({
      pattern: path.join(app, "src", "**", "*.tsx"),
      outDir,
      taskIds: [
        "perf-harness",
        "unit-browser",
        "perf-static",
        "a11y",
        "react-rules",
        "e2e",
        "load",
      ],
      nextjs: app,
      log: false,
      inlineSummary: false,
      colocate: true,
    });
    expect(result.exitCode).toBe(0);

    // The emitted page spec: the @/lib/data factory carries signOff — the
    // name only the non-analysed labels.ts binds — as the factory's
    // graph-only guess: covered, never a vote.
    const specPath = path.join(app, "src", "app", "page.flawless.test.tsx");
    expect(existsSync(specPath)).toBe(true);
    const spec = readFileSync(specPath, "utf8");
    expect(spec).toContain('vi.mock("@/lib/data"');
    expect(spec).toContain("signOff: vi.fn(() => ({}))");
    expect(spec).toContain("signOff guessed {}");
    expect(spec).toContain("graph-only name, no call site in this render");
    // labels itself is never mocked: its type-first merge view is
    // type-only, so the mock loop passes it by. The REAL labels running
    // against the mocked data is the only wiring in which the defect
    // manifests — a value-first order would mock labels and hide it.
    expect(spec).not.toContain('vi.mock("@/lib/labels"');

    // The probe renders the real page with the page spec's own mock block.
    const probePath = path.join(app, "src", "app", "signoff-probe.flawless.test.tsx");
    writeFileSync(probePath, signoffProbe(spec));

    // The probe by path: the .sig span renders String({}) + " Inbox" —
    // the real labels ran, and the mocked signOff answered it.
    const probe = await vitestRun(
      vitestBin,
      ["run", "src/app/signoff-probe.flawless.test.tsx", "--config", "flawless/vitest.config.mts"],
      app,
    );
    expect(probe.code).toBe(0);
    expect(probe.out).toMatch(/1 passed/);

    // The page spec itself — one of the specs behind the 2 Nov triage's 2
    // failed receipt: `No "signOff" export is defined on the
    // "@/lib/data" mock`.
    const page = await vitestRun(
      vitestBin,
      ["run", "src/app/page.flawless.test.tsx", "--config", "flawless/vitest.config.mts"],
      app,
    );
    expect(page.code).toBe(0);
    expect(page.out).not.toMatch(/\d+ failed/);
    expect(page.out).toContain("page.flawless.test.tsx");

    // The full unit plane: the probe is picked up by the config's include
    // (**/*.flawless.test.{ts,tsx}), so the whole tree runs — no failed,
    // one named skip (the store-provider interaction guard). The pass
    // count is deliberately not pinned: the tree's size is not this
    // defect's property.
    const full = await vitestRun(vitestBin, ["run", "--config", "flawless/vitest.config.mts"], app);
    expect(full.code).toBe(0);
    expect(full.out).not.toMatch(/\d+ failed/);
    expect(full.out).toMatch(/1 skipped/);
    expect(full.out).toMatch(/\d+ passed/);
  }, 600_000);
});

describe("defect #13: the extension's names never force a factory", () => {
  test("the extension's names never force a pure utils module's factory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "flawless-mockext-guard-"));
    tmpDirs.push(root);
    const app = path.join(root, "guard");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    const files: [string, string][] = [
      ["page.tsx", GUARD_PAGE],
      ["Card.tsx", GUARD_CARD],
      ["utils.ts", GUARD_UTILS],
      ["builder.ts", GUARD_BUILDER],
      ["data.ts", GUARD_DATA],
    ];
    for (const [name, text] of files) {
      writeFileSync(path.join(app, "src", name), text);
    }
    const outDir = path.join(app, "flawless");

    // The plain-app execution shape (tests/suiteDirExecution.test.ts):
    // tsconfig + colocated specs, the unit-browser task, no nextjs.
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

    // The evidenced data module still earns its factory: "never force" is
    // not "never mock" — getThing's call site is the page's own.
    const specPath = path.join(app, "src", "page.flawless.test.tsx");
    expect(existsSync(specPath)).toBe(true);
    const spec = readFileSync(specPath, "utf8");
    expect(spec).toContain('vi.mock("./data"');
    // The guard's property: the extension added themeClass to utils' view
    // as a covered, non-voting name, so the exemption (every binding pure
    // or graph-only) held and utils stayed real. A regression that let the
    // synthetic's names vote would emit a utils factory here.
    expect(spec).not.toContain('vi.mock("./utils"');
    // The builder's own mock is deliberately pinned neither way: the
    // type-first wiring keeps its merged view type-only (real), but that
    // is the fixture's property, not the guard's — the witness is utils.

    // A plain app carries no react of its own: the suite manifest's own
    // fallbacks (react 18, RTL 16) plus the five runners the emitted
    // specs import.
    const guardPins = suitePins(outDir, ["react", "react-dom", ...RUNNERS]);
    await bunRun(["add", "-d", ...guardPins], app, "bun add -d");
    const vitestBin = path.join(app, "node_modules", ".bin", "vitest");
    if (!existsSync(vitestBin)) throw new Error(`vitest did not install at ${vitestBin}`);

    // The probe renders the real page; the card's text is the witness.
    const probePath = path.join(app, "src", "guard-probe.flawless.test.tsx");
    writeFileSync(probePath, guardProbe(spec));

    const probe = await vitestRun(
      vitestBin,
      ["run", "src/guard-probe.flawless.test.tsx", "--config", "flawless/vitest.config.mts"],
      app,
    );
    expect(probe.code).toBe(0);
    expect(probe.out).toMatch(/1 passed/);

    // The whole plane: page spec + Card spec + probe, no failed — and at
    // least one test actually passed (a run in which every test skipped
    // would otherwise read as green).
    const full = await vitestRun(vitestBin, ["run", "--config", "flawless/vitest.config.mts"], app);
    expect(full.code).toBe(0);
    expect(full.out).not.toMatch(/\d+ failed/);
    expect(full.out).toMatch(/\d+ passed/);
  }, 600_000);
});
