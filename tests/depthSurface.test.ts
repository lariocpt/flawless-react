import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { classifySpec, type Tier } from "../src/reporters/depth.ts";

/**
 * The depth-surface guard (track D, chunk 5).
 *
 * `tests/fixtures/depthapp/` is a committed Next app with one component per
 * pattern the depth census measures: P1–P10 each carry a fact the emitter does
 * — or does not yet — turn into an assertion, and N1/N2 are the refusal
 * controls: shapes the tool must NOT claim. This test generates the fixture
 * in-process (colocated, the way the dogfood baseline generates its app) and
 * pins, per pattern, the exact assertion bytes and the tier the census
 * classifier assigns them.
 *
 * The positive half is the depth claim: if the emitter drops an assertion or a
 * tier moves, the pattern's test reddens by name. The negative half is the
 * EXPECTED-ABSENT table: every behaviour the tool does not emit yet is an
 * explicit row naming the plan item that owns it — never a missing case, never
 * a passing no-op. When an owning item ships, its row reddens: that is the
 * fixture's purpose — the movement metric for track D — and the row plus
 * `docs/plans/baselines/depth-surface.json` must be re-pinned in the same PR
 * as the fix.
 *
 * The pinned bytes were measured on the tree at 5ae6d01 (the item-7 salvage);
 * P3's two host-attribute tests are that salvage's surface rows. Re-pinned at
 * 2c262d9 by D1b: P4 and P5 flipped from EXPECTED-ABSENT to pinned-present
 * (items 3 and 4 shipped), each now a T2 surface row. Tier notes:
 * the classifier reads toBeDisabled as T2 (src/reporters/depth.ts:521) while
 * the D1a receipt calls it T1 — the census records the classifier's reading,
 * so P1 is pinned T2 here.
 */

const FIXTURE = path.resolve(__dirname, "fixtures", "depthapp");
const BASELINE = path.resolve(__dirname, "..", "docs", "plans", "baselines", "depth-surface.json");

/** Pattern id -> the colocated spec the fixture's generation emits for it. */
const SPEC_BY_ID = {
  P1: "src/components/P1AlwaysDisabled.flawless.test.tsx",
  P2: "src/components/P2StateToAttribute.flawless.test.tsx",
  P3: "src/components/P3HostAriaLabel.flawless.test.tsx",
  P4: "src/components/P4ClickFetch.flawless.test.tsx",
  P5: "src/components/P5PropPredicate.flawless.test.tsx",
  P6: "src/app/guarded/page.flawless.test.tsx",
  P7: "src/components/P7CappedVariants.flawless.test.tsx",
  P8: "src/components/P8EffectFetch.flawless.test.tsx",
  P9: "src/components/P9SetterTransition.flawless.test.tsx",
  P10: "src/components/P10ActionForm.flawless.test.tsx",
  N1: "src/components/N1ConditionalDisabled.flawless.test.tsx",
  N2: "src/components/N2ComputedAriaLabel.flawless.test.tsx",
  home: "src/app/page.flawless.test.tsx",
  root: "src/app/layout.flawless.test.tsx",
} as const;

const tmpDirs: string[] = [];
let app: string;

function read(...rel: string[]): string {
  return readFileSync(path.join(app, ...rel), "utf8");
}

/** The strongest tier of a pattern's spec, as the census classifier reads it. */
function specTier(rel: string): Tier | null {
  return classifySpec(read(rel)).tier;
}

/** The tier the classifier assigns to the test whose name contains `namePart`. */
function testTier(rel: string, namePart: string): Tier | null | undefined {
  return classifySpec(read(rel)).perTest.find((t) => t.name.includes(namePart))?.tier;
}

beforeAll(async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "flawless-depth-surface-"));
  tmpDirs.push(root);
  app = path.join(root, "app");
  cpSync(FIXTURE, app, { recursive: true });
  const result = await runCore({
    pattern: path.join(app, "src", "**", "*.tsx"),
    outDir: path.join(app, "flawless"),
    taskIds: ["perf-harness", "unit-browser", "perf-static", "a11y", "react-rules", "e2e", "load"],
    nextjs: app,
    apiSpec: path.join(app, "openapi.json"),
    log: false,
    inlineSummary: false,
    colocate: true,
  });
  expect(result.exitCode).toBe(0);
}, 180_000);

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test("the surface generates: every pattern has a stamped spec", () => {
  // The control for every assertion below: if this reddens, the pattern tests
  // measure a broken run, not the tool.
  expect(existsSync(path.join(app, "flawless", "provider.tsx"))).toBe(true);
  expect(existsSync(path.join(app, "flawless", "vitest.config.mts"))).toBe(true);
  const specs = [...new Bun.Glob("src/**/*.flawless.test.tsx").scanSync({ cwd: app })].sort();
  expect(specs).toEqual(Object.values(SPEC_BY_ID).sort());
  for (const rel of Object.values(SPEC_BY_ID)) {
    expect(read(rel).startsWith("// @flawless-generated sha256:")).toBe(true);
  }
});

test("P1 — an always-disabled control asserts toBeDisabled (D1 item 1, shipped)", () => {
  const spec = read(SPEC_BY_ID.P1);
  expect(spec).toContain(
    `test("P1AlwaysDisabled: 'Pay now' is disabled at these props", async () => {`,
  );
  expect(spec).toContain(
    `expect(screen.getAllByRole("button", { name: "Pay now" })[0] as HTMLElement).toBeDisabled();`,
  );
  expect(spec).toContain(`for (const t of ["Checkout summary", "Pay now"]) {`);
  // The classifier reads toBeDisabled as T2 (depth.ts:521) — the D1a receipt
  // calls it T1; the census records the classifier's reading, so T2 is pinned.
  expect(specTier(SPEC_BY_ID.P1)).toBe("T2");
  expect(testTier(SPEC_BY_ID.P1, "'Pay now' is disabled at these props")).toBe("T2");
});

test("P2 — a string initial flowing to an attribute asserts toHaveAttribute (D1 item 2, shipped)", () => {
  const spec = read(SPEC_BY_ID.P2);
  expect(spec).toContain(
    `test("P2StateToAttribute initial state: placeholder = 'Enter your email' ` +
      `is rendered as placeholder on <input>", () => {`,
  );
  expect(spec).toContain(
    `  expect(container.querySelector("input[placeholder]")).toHaveAttribute(\n` +
      `    "placeholder",\n    "Enter your email",\n  );`,
  );
  expect(spec).toContain(`// Detected state:\n//   placeholder (string) = "Enter your email"`);
  expect(specTier(SPEC_BY_ID.P2)).toBe("T1");
  expect(testTier(SPEC_BY_ID.P2, "initial state: placeholder")).toBe("T1");
});

test("P3 — host static attributes are asserted on rungs that do not read them (D1 item 7, salvaged)", () => {
  const spec = read(SPEC_BY_ID.P3);
  // testid rung: the locator reads neither attribute — both are asserted.
  expect(spec).toContain(
    `test("P3HostAriaLabel: [aria-label='Submit document'] #0 carries its host ` +
      `attributes", () => {`,
  );
  expect(spec).toContain(
    `  expect(screen.getByTestId("p3-submit")).toHaveAttribute("aria-label", "Submit document");`,
  );
  expect(spec).toContain(
    `  expect(screen.getByTestId("p3-submit")).toHaveAttribute("role", "button");`,
  );
  // label rung: the locator matches on the aria-label — asserting it would
  // tautologise the locator, so only the role is asserted.
  expect(spec).toContain(
    `test("P3HostAriaLabel: [aria-label='Open menu'] #1 carries its host attributes", () => {`,
  );
  expect(spec).toContain(
    `expect(screen.getAllByLabelText("Open menu")[0] as HTMLElement)` +
      `.toHaveAttribute("role", "button");`,
  );
  // Anti-tautology: exactly one aria-label assert in the whole spec — button A's.
  expect(spec.match(/toHaveAttribute\("aria-label"/g) ?? []).toHaveLength(1);
  expect(specTier(SPEC_BY_ID.P3)).toBe("T1");
  expect(testTier(SPEC_BY_ID.P3, "#0 carries its host attributes")).toBe("T1");
  expect(testTier(SPEC_BY_ID.P3, "#1 carries its host attributes")).toBe("T1");
});

test("P4 — a click-fired fetch gets the fetch tests, driven by the dispatch (D1 item 3, shipped)", () => {
  const spec = read(SPEC_BY_ID.P4);
  expect(spec).toContain(`screen.getAllByRole("button", { name: "Load items" })[0]`);
  // The fetch describe is entered (msw is imported) and every test is DRIVEN:
  // an unconditional dispatch, never the conditional mount-hedge trigger.
  expect(spec).toContain(`import { delay, HttpResponse, http } from "msw";`);
  expect(spec).toContain(`describe("P4ClickFetch GET /api/items", () => {`);
  expect(spec).toContain(
    `  test("click fetches and renders with a successful response", async () => {`,
  );
  expect(spec).toContain(
    `    await userEvent.click(screen.getAllByRole("button", { name: "Load items" })[0] as HTMLElement);`,
  );
  expect(spec).toContain(
    `    await waitFor(() => expect(calls).toBeGreaterThan(0), { timeout: 3000 });`,
  );
  expect(spec).not.toContain(`if (trigger) await userEvent.click`);
  // The request count after a dispatch is T2 (PLAN-00 amended request-count
  // row); the mount-fetch shape (P8) stays T0.
  expect(specTier(SPEC_BY_ID.P4)).toBe("T2");
  expect(testTier(SPEC_BY_ID.P4, "click fetches and renders with a successful response")).toBe(
    "T2",
  );
});

test("P5 — both prop-keyed branches assert their witness (D1 item 4, shipped)", () => {
  const spec = read(SPEC_BY_ID.P5);
  expect(spec).toContain(`const DEFAULTS: Record<string, unknown> = { empty: false };`);
  expect(spec).toContain(`for (const t of ["3 items in stock"]) {`);
  expect(spec).toContain(`// no interactions detected — render-only smoke is above.`);
  // The presence/absence mirror pair: each leg renders its own branch's
  // literal and asserts the other's absent. The witnesses are branch
  // literals — "No items yet" appears ONLY in the inversion legs, never in
  // the unconditional static-content loop above.
  expect(spec).toContain(
    `test("P5PropPredicate: empty flipped — 1 branch site(s) change side", () => {`,
  );
  expect(spec).toContain(`  expect(t0).toContain("3 items in stock");`);
  expect(spec).toContain(`  expect(t0).not.toContain("No items yet");`);
  expect(spec).toContain(`  const second = renderTarget({ empty: true });`);
  expect(spec).toContain(`  expect(t1).toContain("No items yet");`);
  expect(spec).toContain(`  expect(t1).not.toContain("3 items in stock");`);
  expect(spec.match(/"No items yet"/g) ?? []).toHaveLength(2);
  expect(specTier(SPEC_BY_ID.P5)).toBe("T2");
  expect(testTier(SPEC_BY_ID.P5, "empty flipped")).toBe("T2");
});

test("P6 — a two-dep guard gets the generic RSC contract, no guard fixture (D1 item 5, unshipped)", () => {
  const spec = read(SPEC_BY_ID.P6);
  // Exactly one test declaration: emitGuardTests skipped the page (the guard's
  // two operands name different deps), so only the generic RSC contract runs.
  expect(spec.match(/^test\(/gm) ?? []).toHaveLength(1);
  expect(spec).toContain(
    `test("GuardedPage (RSC): resolves, or takes one of its declared guard paths", async () => {`,
  );
  // The extended regex no longer fits the formatter's line width, so the
  // pinned bytes are the wrapped form the emitter writes out.
  expect(spec).toContain(
    `    if (\n` +
      `      /notFound\\(\\) called|NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_UNAUTHORIZED|NEXT_FORBIDDEN/.test(\n` +
      `        String(err),\n` +
      `      )\n` +
      `    )\n` +
      `      return;`,
  );
  expect(spec).toContain(`  expect(rendered?.container.innerHTML.length ?? 0).toBeGreaterThan(0);`);
  expect(spec).toContain(`  void screen;`);
  expect(specTier(SPEC_BY_ID.P6)).toBe("T0");
});

test("P7 — the variant matrix is the five-option prefix (D1 item 6, unshipped)", () => {
  const spec = read(SPEC_BY_ID.P7);
  expect(spec).toContain(`const DEFAULTS: Record<string, unknown> = { size: "xs" };`);
  expect(spec).toContain(
    `const VARIANTS: Array<Record<string, unknown>> = [\n` +
      `  { size: "xs" },\n  { size: "sm" },\n  { size: "md" },\n  { size: "lg" },\n  { size: "xl" },\n];`,
  );
  expect(spec).toContain(`describe("P7CappedVariants variants", () => {`);
  expect(spec).toContain(
    '      expect(\n        container.querySelector("span"),\n' +
      `        \`\${JSON.stringify(v)} rendered no <span>\`,\n      ).not.toBeNull();`,
  );
  expect(specTier(SPEC_BY_ID.P7)).toBe("T1");
});

test("P8 — the effect fetch gets four state tests; the content witness is absent (D2, unshipped)", () => {
  const spec = read(SPEC_BY_ID.P8);
  expect(spec).toContain(`import { delay, HttpResponse, http } from "msw";`);
  expect(spec).toContain(`import { server } from "../../flawless/mocks/node";`);
  expect(spec).toContain(`describe("P8EffectFetch GET /api/items", () => {`);
  expect(spec).toContain(`  const FIXTURE: unknown = { greeting: "Hello from the API" };`);
  const waitFors = spec.match(
    /await waitFor\(\(\) => expect\(calls\)\.toBeGreaterThan\(0\), \{ timeout: 3000 \}\);/g,
  );
  expect(waitFors ?? []).toHaveLength(4);
  expect(spec.match(/\/\/ TODO\(flawless\):/g) ?? []).toHaveLength(4);
  expect(spec).toContain(`        return new HttpResponse(null, { status: 500 });`);
  expect(spec).toContain(`  for (const t of ["Loading…"]) {`);
  expect(spec).toContain(`// Detected state:\n//   greeting / setGreeting (unknown) = null`);
  // D2's absence: the fixture value is carried into every fetch test but never
  // asserted — every line that names it is a handler line, never an expect
  // line. (The FIXTURE pin above guarantees this loop is not a no-op.)
  for (const line of spec.split("\n")) {
    if (line.includes(`greeting: "Hello from the API"`)) {
      expect(line).not.toContain("expect(");
    }
  }
  expect(specTier(SPEC_BY_ID.P8)).toBe("T1");
});

test("P9 — the setter click is a canary; no text witness for the transition (D3, unshipped)", () => {
  const spec = read(SPEC_BY_ID.P9);
  expect(spec).toContain(`screen.getAllByRole("button", { name: "Record visit" })[0]`);
  expect(spec).toContain(`for (const t of ["Record visit"]) {`);
  expect(spec).toContain(`// Detected state:\n//   count / setCount (number) = 0`);
  expect(specTier(SPEC_BY_ID.P9)).toBe("T1");
});

test("P10 — the form fills and reads back; the action call is unasserted (D4, unshipped)", () => {
  const spec = read(SPEC_BY_ID.P10);
  expect(spec).toContain(`test("P10ActionForm form #0 accepts input and submits", async () => {`);
  expect(spec).toContain(
    `  await userEvent.type(screen.getAllByLabelText("Name")[0] as HTMLElement, "Name");`,
  );
  expect(spec).toContain(
    `  await userEvent.type(screen.getAllByLabelText("Email")[0] as HTMLElement, ` +
      `"user@example.com");`,
  );
  expect(spec).toContain(
    `  expect(screen.getAllByLabelText("Name")[0] as HTMLElement).toHaveValue("Name");`,
  );
  expect(spec).toContain(
    `  expect(screen.getAllByLabelText("Email")[0] as HTMLElement).toHaveValue(` +
      `"user@example.com");`,
  );
  expect(spec).toContain(`  for (const t of ["Name", "Email", "Save profile"]) {`);
  expect(specTier(SPEC_BY_ID.P10)).toBe("T1");
});

test("N1 — a disabled expression that does not reduce is a named skip, never a toBeDisabled claim", () => {
  const spec = read(SPEC_BY_ID.N1);
  expect(spec).toContain(
    `const DEFAULTS: Record<string, unknown> = { flags: {}, pending: false };`,
  );
  expect(spec).toContain(
    `test.skip("N1ConditionalDisabled onClick on 'Confirm order' #0 — its ` +
      `control is disabled at these props", () => {`,
  );
  expect(spec).toContain(`for (const t of ["Confirm order"]) {`);
  // The refusal's meaning: no generated DEFAULTS provably satisfies `disabled`
  // here (flags is a Pick both resolvers refuse, floored to {}), so the emitter
  // must not claim it — the named skip is the refusal, this is its witness.
  expect(spec).not.toContain("toBeDisabled(");
  expect(testTier(SPEC_BY_ID.N1, "its control is disabled at these props")).toBeNull();
  expect(specTier(SPEC_BY_ID.N1)).toBe("T1");
});

test("N2 — a template-literal aria-label is never recorded, so the locator falls to the role rung", () => {
  const spec = read(SPEC_BY_ID.N2);
  expect(spec).toContain(`const DEFAULTS: Record<string, unknown> = { count: 1 };`);
  expect(spec).toContain(`screen.getAllByRole("button", { name: "Save" })[0]`);
  // readStringInitializer is literals-only: the computed aria-label is not a
  // fact the analyser carries, so no assertion may name it.
  expect(spec).not.toContain(`toHaveAttribute("aria-label"`);
  expect(specTier(SPEC_BY_ID.N2)).toBe("T1");
});

test("the home page mounts with no props and no interactions of its own", () => {
  const spec = read(SPEC_BY_ID.home);
  expect(spec).toContain(`const DEFAULTS: Record<string, unknown> = {};`);
  expect(spec).toContain(`test("HomePage renders a <main>", () => {`);
  expect(spec).toContain(`// no interactions detected — render-only smoke is above.`);
  // The page's own JSX is all component references — no literal copy of its
  // own to witness, so no static-content describe.
  expect(spec).not.toContain("static content");
  expect(specTier(SPEC_BY_ID.home)).toBe("T1");
});

test("the root layout is checked as a server document root, not mounted", () => {
  const spec = read(SPEC_BY_ID.root);
  // A document root cannot mount inside a container — the contract is server
  // markup, so exactly one test and no renderTarget.
  expect(spec.match(/^test\(/gm) ?? []).toHaveLength(1);
  expect(spec).not.toContain("renderTarget");
  expect(spec).toContain(
    `test("RootLayout returns a document root containing its children", async () => {`,
  );
  expect(spec).toContain(`import { renderToReadableStream } from "react-dom/server.browser";`);
  expect(spec).toContain(`const SLOT = "flawless-slot";`);
  expect(spec).toContain(`expect(html).toMatch(/^<html/);`);
  expect(spec).toContain(`expect(html).toContain("<body");`);
  expect(spec).toContain(`expect(html).toContain(SLOT);`);
  expect(spec).toContain(`void vi;`);
  expect(specTier(SPEC_BY_ID.root)).toBe("T1");
});

/**
 * EXPECTED-ABSENT — the negative half of the surface: one row per behaviour
 * the tool does not emit yet, each naming the plan item that owns it. These
 * are not missing cases; every row is an explicit assertion in the test below.
 * When the owning item ships, its row reddens and names itself — that is the
 * movement metric working, and the row (and the census baseline) must be
 * re-pinned in the same PR as the fix.
 */
const EXPECTED_ABSENT: Array<{ id: keyof typeof SPEC_BY_ID; absent: string; owner: string }> = [
  {
    id: "P6",
    absent: "lib/data",
    owner:
      "D1 item 5 (PLAN-01) — multi-dep guards: classifyLogical yields a trigger only when " +
      "both operands name the SAME single dep, so emitGuardTests skips the page and its data " +
      "module is never mocked in the spec",
  },
  {
    id: "P7",
    absent: '"2xl"',
    owner:
      "D1 item 6 (PLAN-01) — full variant coverage: the emitter caps the variant matrix at " +
      "five options; the three it never sees appear nowhere",
  },
  { id: "P7", absent: '"3xl"', owner: "D1 item 6 (PLAN-01) — full variant coverage (same cap)" },
  { id: "P7", absent: '"4xl"', owner: "D1 item 6 (PLAN-01) — full variant coverage (same cap)" },
  {
    id: "P7",
    absent: "flawless-cls",
    owner:
      "the className-forwarding test (shipped, templates.ts:1983) — deliberate non-trigger: " +
      "the detector keys on the identifier `className` and the component names its local `cls`, " +
      "so no forwarding test may be emitted",
  },
  {
    id: "P9",
    absent: "No visits",
    owner:
      "D3 (PLAN-03) — state transitions: ternary branch texts are not extracted as static " +
      "text, so the pre-click copy is absent too",
  },
  {
    id: "P9",
    absent: "Visited",
    owner:
      "D3 (PLAN-03) — state transitions: the post-click copy has no witness; the click test " +
      "ends in its TODO tail",
  },
  {
    id: "P10",
    absent: "toHaveBeenCalledWith(",
    owner:
      "D4 (PLAN-04) — payload claims: client mock mode is allowlist-only, so the " +
      "server-action module stays real and there is no mock to assert against",
  },
  { id: "P10", absent: "vi.mocked(", owner: "D4 (PLAN-04) — payload claims (same allowlist rule)" },
];

test("EXPECTED-ABSENT: every unshipped behaviour stays absent from its pattern's spec", () => {
  expect(EXPECTED_ABSENT.length).toBeGreaterThan(0);
  for (const row of EXPECTED_ABSENT) {
    expect(read(SPEC_BY_ID[row.id]), `${row.id}: ${row.owner}`).not.toContain(row.absent);
  }
});

test("the emitted surface passes the fixture's own biome with zero errors", () => {
  // The suite must be committable in a linted repo, so the host's linter runs
  // over EVERY emitted file — flawless/ plus the colocated specs (biome's CLI
  // takes paths, not shell-less globs, so the colocated files are enumerated).
  // Mirrors the dogfood baseline's gate: --write is the tool's own style path
  // (adoptStyle cannot resolve the binary inside a tmp copy, so it runs here);
  // the gate below is what must be clean.
  const biome = path.resolve(__dirname, "../node_modules/.bin/biome");
  const colocated = [...new Bun.Glob("src/**/*.flawless.test.tsx").scanSync({ cwd: app })].sort();
  expect(colocated.length).toBeGreaterThan(0);
  const emitted = ["flawless", ...colocated];
  Bun.spawnSync([biome, "check", "--write", "--no-errors-on-unmatched", ...emitted], {
    cwd: app,
    stdout: "pipe",
    stderr: "pipe",
  });
  const gate = Bun.spawnSync(
    [biome, "check", "--max-diagnostics=200", "--reporter=json", ...emitted],
    { cwd: app, stdout: "pipe", stderr: "pipe" },
  );
  const report = JSON.parse(gate.stdout.toString()) as {
    summary: { errors: number };
    diagnostics: Array<{ severity: string; code?: string; message: string }>;
  };
  const errors = report.diagnostics.filter((d) => d.severity === "error");
  expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  expect(report.summary.errors).toBe(0);
  expect(gate.exitCode).toBe(0);
});

/**
 * The census baseline pins what the NON-colocated D0-mirrored generation
 * emits — the same assertion bytes, different paths. It lands later on this
 * branch (the commit after this test), so until it exists the per-pattern
 * assertions above are the guard; once it exists every row must still describe
 * this run: a found assertion is present in the pattern's spec, and every row
 * names the tier the classifier measures.
 */
test("the depth-surface census baseline matches this run (when present)", () => {
  if (!existsSync(BASELINE)) return;
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as {
    patterns: Record<string, { spec: string; assertion: string; tier: Tier }>;
  };
  expect(Object.keys(baseline.patterns).sort()).toEqual(Object.keys(SPEC_BY_ID).sort());
  for (const [id, rel] of Object.entries(SPEC_BY_ID)) {
    const row = baseline.patterns[id];
    if (row === undefined) throw new Error(`${id}: baseline row missing`);
    expect(specTier(rel), `${id}: tier`).toBe(row.tier);
    if (row.assertion.startsWith("not emitted —")) continue;
    expect(read(rel), `${id}: baseline assertion must still be emitted`).toContain(row.assertion);
  }
});
