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
  const want = ["jest", "jest-expo", "@testing-library/react-native", "react-test-renderer"];
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
});
