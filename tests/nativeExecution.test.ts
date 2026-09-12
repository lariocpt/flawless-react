// The emitted native suite, EXECUTED.
//
// Gated on FLAWLESS_CI_NATIVE=1 and ARMED in the Jenkinsfile — gated-and-armed,
// never gated-and-skipped, for the reason tests/emittedExecution.test.ts states:
// "a skipped zsh case in CI is how the env.sh bug survived the first time".
//
// This file exists because parsing proves nothing here. Every defect wave 3
// actually had was invisible to a syntax check and fatal at run time:
//
//   * `jest` resolved to 30 while jest-expo 54's tooling is ^29.2.1, and the
//     mismatch surfaced as "this._moduleMocker.clearMocksOnScope is not a
//     function" from inside jest-runtime.
//   * `render(<TabsLayout/>)` threw "No filename found" — <Tabs> needs a route
//     context, so a layout is not mountable on its own.
//   * The emitted specs made LIVE HTTP CALLS and crashed a worker with
//     "api_error 405" from a real server.
//   * A jest.mock() specifier written relative to the COMPONENT resolved to
//     nothing from the spec's directory.
//
// None of those is visible in a parse. All four are one `jest` run away.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const GATED = process.env.FLAWLESS_CI_NATIVE === "1";
const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "expoapp");

let app = "";
let tmpRoot = "";

async function sh(cmd: string[], cwd: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, out: out + err };
}

beforeAll(async () => {
  if (!GATED) return;
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "flawless-native-exec-"));
  app = path.join(tmpRoot, "app");
  cpSync(FIXTURE, app, { recursive: true });

  const gen = await sh(
    [
      "bun",
      path.join(REPO_ROOT, "src", "bin.ts"),
      "--expo",
      app,
      "--tasks",
      "unit-browser",
      "--roots",
      "exported",
      "--ci",
      "--no-inline-summary",
    ],
    REPO_ROOT,
  );
  // A dead harness is not a result: without this, every check below would report
  // a vacuous pass over an empty directory.
  if (gen.code !== 0) throw new Error(`generation exited ${gen.code}: ${gen.out}`);

  // The versions come from the emitted package.json, not from a table here — so
  // the install proves the PINS, not a second opinion about them.
  const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const dev = pkg.devDependencies ?? {};
  const want = [
    "jest",
    "jest-expo",
    "@testing-library/react-native",
    "react-test-renderer",
    // The specs do not type-check without it, and the type gate below is the
    // only place in the suite where real types exist to prove that.
    "@types/jest",
  ];
  const missing = want.filter((d) => dev[d] === undefined);
  if (missing.length > 0) {
    throw new Error(`the run did not declare ${missing.join(", ")} — nothing to install`);
  }
  const install = await sh(["bun", "install"], app);
  if (install.code !== 0) throw new Error(`bun install exited ${install.code}: ${install.out}`);
}, 600_000);

afterAll(() => {
  // The 63G-tmpfs lesson from emittedSelection.test.ts: an install this size has
  // to be cleaned up even when the suite fails.
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

const jest = (args: string[] = []) =>
  sh(["bunx", "jest", "--config", "flawless/jest.config.cjs", ...args], app);

describe.skipIf(!GATED)("the emitted native suite runs under real jest-expo", () => {
  test("every emitted spec passes, and some tests actually ran", async () => {
    const r = await jest();
    expect(r.out).toMatch(/Test Suites:\s+\d+ passed/);
    expect(r.out).not.toMatch(/failed/);
    // ">0 passed" is the anti-vacuous half: a config that selected nothing would
    // also exit 0.
    const m = /Tests:.*?(\d+) passed/.exec(r.out);
    expect(Number(m?.[1] ?? 0)).toBeGreaterThan(5);
    expect(r.code).toBe(0);
  }, 600_000);

  test("it goes RED when the component's copy changes", async () => {
    // The mutation probe. A suite that cannot fail is not a suite, and this is
    // the cheapest proof that the static-text assertions are real.
    const screen = path.join(app, "app", "login.tsx");
    const original = readFileSync(screen, "utf8");
    try {
      writeFileSync(screen, original.replace("Welcome back", "Welcome BACK"));
      const r = await jest(["flawless/unit/LoginScreen"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/renders its static copy/);
    } finally {
      writeFileSync(screen, original);
    }
    expect((await jest(["flawless/unit/LoginScreen"])).code).toBe(0);
  }, 600_000);

  test("an unaddressable target is a SKIP that names the fix, never a pass", async () => {
    const r = await jest();
    expect(r.out).toMatch(/Tests:.*\d+ skipped/);
    // The skip has to be actionable. "renders only an icon" plus the remedy is
    // the difference between a gap a reader can close and one they cannot.
    const spec = readFileSync(
      path.join(app, "flawless", "unit", "ItemDetail.flawless.test.tsx"),
      "utf8",
    );
    expect(spec).toMatch(/test\.skip/);
    expect(spec).toMatch(/accessibilityLabel/);
  }, 600_000);

  test("no emitted spec makes a live network call", async () => {
    // The fixture's api module performs fetch(). Before the mocks were emitted
    // this crashed a jest worker against a real server on localhost.
    const spec = readFileSync(
      path.join(app, "flawless", "unit", "LoginScreen.flawless.test.tsx"),
      "utf8",
    );
    expect(spec).toMatch(/jest\.mock\(/);
    const r = await jest();
    expect(r.out).not.toMatch(/api_error|ECONNREFUSED|fetch failed/);
  }, 600_000);

  test("the emitted suite type-checks against the REAL installed types", async () => {
    // emittedTypes.test.ts cannot see this class. It has no types to install, so
    // it stubs `declare const expect: any` — which makes EVERY matcher call in
    // every spec type-check trivially. `expect(screen).toHavePathname(x)` passed
    // that gate and then failed in the adopting app with TS2339 on all 30 of its
    // route specs, because expo-router 6 ships toHavePathname at RUNTIME while
    // its expect.d.ts is `export {}`. A matcher that exists but is untyped is
    // invisible to a program where the matcher's receiver is `any`.
    //
    // So this is not a duplicate of that gate — it is the half of it that needs
    // node_modules, and it lives here because this is the only test that pays
    // for a real install.
    // @types/react is the APP's dependency, not the test stack's — every real
    // Expo project has it, and the tool does not emit it. The minimal fixture
    // does not, so without this the gate reports TS7016 on react/jsx-runtime
    // and never reaches the emitted code it exists to check.
    const ts = await sh(["bun", "add", "-d", "typescript", "@types/react"], app);
    expect(ts.code).toBe(0);
    writeFileSync(
      path.join(app, "tsconfig.spec.json"),
      JSON.stringify(
        {
          compilerOptions: {
            // jest, NOT bun: both declare describe/test/expect globally, and a
            // program carrying both reports TS2403 on every one of them.
            types: ["jest", "node"],
            jsx: "react-jsx",
            strict: true,
            noEmit: true,
            moduleResolution: "bundler",
            module: "esnext",
            target: "esnext",
            skipLibCheck: true,
            paths: { "@/*": ["./*"] },
          },
          include: ["flawless/**/*.ts", "flawless/**/*.tsx"],
        },
        null,
        2,
      ),
    );
    const r = await sh(["bunx", "tsc", "-p", "tsconfig.spec.json", "--noEmit"], app);
    // Scoped to the EMITTED tree on purpose. The specs import the components, so
    // the app's own source is pulled into the program, and this fixture's source
    // does not type-check on its own: it writes NativeWind `className` on
    // <Pressable> without the `nativewind-env.d.ts` augmentation a real project
    // has. Those are the FIXTURE's errors, not the tool's, and the tool's
    // contract is that what it WRITES type-checks — the adopting app's own type
    // health is its business. (mybodycorpai/apps/mobile is clean at 0 errors, so
    // the real adoption gets the strict version of this for free.)
    //
    // The scoping is not a way to pass: the guard below plants its error inside
    // an emitted spec, which is squarely in scope.
    const emitted = r.out
      .split("\n")
      .filter((l) => l.startsWith("flawless/"))
      .join("\n");
    expect(emitted).toBe("");
  }, 300_000);

  test("the icon-unhidden premise holds in the real accessibility tree", async () => {
    // a11y/icon-unhidden (wave 5) claims three things about @expo/vector-icons
    // under the real renderer: a bare icon IS exposed to the accessibility
    // tree, each hiding spelling the rule accepts actually removes it, and an
    // icon inside a labelled pressable is announced via the label. All three
    // are claims about RN + RNTL behaviour rather than this repo's own code —
    // exactly the premise class wave 3 got wrong four times — so they are
    // executed here, where a real install exists to execute against.
    const probe = path.join(app, "flawless", "unit", "A11yIconPremise.flawless.test.tsx");
    writeFileSync(
      probe,
      `import { Ionicons } from "@expo/vector-icons";
import { isHiddenFromAccessibility, render, screen } from "@testing-library/react-native";
import { Pressable } from "react-native";

describe("the native a11y task's icon premise", () => {
  test("a bare vector icon is exposed to the accessibility tree", () => {
    render(<Ionicons name="star" size={16} testID="bare" />);
    expect(isHiddenFromAccessibility(screen.getByTestId("bare"))).toBe(false);
  });

  test("aria-hidden removes it", () => {
    render(<Ionicons aria-hidden name="star" size={16} testID="aria" />);
    expect(
      isHiddenFromAccessibility(screen.getByTestId("aria", { includeHiddenElements: true })),
    ).toBe(true);
  });

  test("the pre-0.71 spellings remove it too", () => {
    render(
      <Ionicons
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        name="star"
        size={16}
        testID="legacy"
      />,
    );
    expect(
      isHiddenFromAccessibility(screen.getByTestId("legacy", { includeHiddenElements: true })),
    ).toBe(true);
  });

  test("inside a labelled pressable, the label is what announces", () => {
    render(
      <Pressable accessibilityLabel="Go back" accessibilityRole="button" onPress={() => {}}>
        <Ionicons name="arrow-back" size={24} />
      </Pressable>,
    );
    expect(screen.getByRole("button", { name: "Go back" })).toBeTruthy();
  });
});
`,
    );
    try {
      const r = await jest(["flawless/unit/A11yIconPremise"]);
      expect(r.out).toMatch(/Tests:\s+4 passed/);
      expect(r.code).toBe(0);
    } finally {
      // Removed even on failure: the full-suite runs and the type gate in this
      // file must keep seeing exactly what the tool emitted.
      rmSync(probe, { force: true });
    }
  }, 600_000);

  test("guard the guard: a type error in an emitted spec IS caught here", async () => {
    // Without this, the test above passes just as well when tsc silently checks
    // an empty file set — which is exactly how the `any` stub next door went
    // unnoticed. Planting a real error proves the program reaches the specs.
    const victim = path.join(app, "flawless", "unit", "LoginScreen.flawless.test.tsx");
    const original = readFileSync(victim, "utf8");
    try {
      writeFileSync(victim, `${original}\nconst _probe: number = "not a number";\n`);
      const r = await sh(["bunx", "tsc", "-p", "tsconfig.spec.json", "--noEmit"], app);
      // Scoped the same way, and to the VICTIM file — the fixture's own errors
      // would satisfy a bare /TS2322/ match without the planted one existing.
      const emitted = r.out.split("\n").filter((l) => l.startsWith("flawless/"));
      expect(emitted.join("\n")).toMatch(/LoginScreen\.flawless\.test\.tsx.*TS2322/);
    } finally {
      writeFileSync(victim, original);
    }
  }, 300_000);
});
