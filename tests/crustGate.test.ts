import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LoadTarget, renderPipes } from "../src/tasks/loadPipes.ts";

/**
 * FR-021: the crust half of the baseline gate was a one-off manual run
 * preserved as a comment — if crust renamed `summary.p95`, the gate compared
 * against undefined forever and nobody would see. This automates that exact
 * documented run against REAL crust and a throwaway server: no baseline
 * passes, at-baseline passes, a forced baseline fails. Fail-don't-skip: a
 * missing crust is a broken environment, not a reason to hand the blind spot
 * back (install it from the public release:
 * curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash,
 * or point FLAWLESS_CRUST at a binary).
 */

function requireCrust(): string {
  const fromEnv = process.env.FLAWLESS_CRUST;
  if (fromEnv) return fromEnv;
  const found = Bun.which("crust");
  if (found) return found;
  throw new Error(
    "crust is not on PATH and FLAWLESS_CRUST is unset. This test executes the emitted " +
      "load pipes through real crust — skipping it restores exactly the vacuity FR-021 " +
      "names. Install it (public release, no VPN needed):\n" +
      "  curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash\n" +
      "or point FLAWLESS_CRUST at an existing binary.",
  );
}

const DASHBOARD: LoadTarget = { name: "dashboard", urlPath: "/dashboard", params: [] };

let root: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

afterAll(() => {
  server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

async function runPipes(env: Record<string, string>): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(
    [requireCrust(), "-c", "test-pipes --target flawless/load/routes.pipes --timeout 30000"],
    {
      cwd: root as string,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: out + err };
}

describe("the emitted baseline gate, through real crust", () => {
  test("no baseline passes; a copied baseline passes; a forced one fails", async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "flawless-crust-gate-"));
    const loadDir = path.join(root, "flawless", "load");
    mkdirSync(loadDir, { recursive: true });

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok", { status: 200 }),
    });
    const env = {
      LOAD_BASE: `http://127.0.0.1:${server.port}`,
      LOAD_AUTH: "accept: */*",
    };

    // The REAL emitted pipe, with only the load tunables shortened — the
    // header itself tells users to tune rate/duration, and a 10s soak per
    // case is load engineering, not gate semantics.
    const pipes = renderPipes([DASHBOARD], path.join(root, "flawless"), root, new Set()).replace(
      "load 10s 50/s",
      "load 1s 10/s",
    );
    expect(pipes).toContain("load 1s 10/s");
    writeFileSync(path.join(loadDir, "routes.pipes"), pipes);

    // Case 1: first run, no baseline — the gate must not fail a fresh suite.
    const first = await runPipes(env);
    if (first.code !== 0) console.error(first.output);
    expect(first.code).toBe(0);

    // The shape contract the comment could only assert by reading source:
    // crust's `stats --out` really writes summary.p95 as a number. If crust
    // ever renames it, THIS goes red instead of the gate going blind.
    const last = (await Bun.file(path.join(loadDir, "last-dashboard.json")).json()) as {
      summary?: { p95?: unknown };
    };
    expect(typeof last.summary?.p95).toBe("number");
    expect(last.summary?.p95 as number).toBeGreaterThan(0);

    // Case 2: the documented flow — copy a good last-*.json to baseline —
    // and a healthy run stays under 2x it.
    //
    // FR-047. Copying `last` VERBATIM made this flaky: the gate is
    // `p95 < 2 * baseline.p95`, and this test shortens the emitted load to
    // `1s 10/s` against a trivial in-process server, so p95 lands in the
    // sub-millisecond noise floor where run-to-run jitter doubles it easily.
    // Observed failing roughly 1 run in 3 while the rest of the suite (a real
    // chromium included) competed for the machine.
    //
    // The emitted gate is NOT the problem — at its real `10s 50/s` the p95 it
    // compares is a meaningful number. The problem is a test asserting a ratio
    // between two measurements too small to have a stable ratio. So the
    // baseline gets a floor: still derived from the observed run (this is
    // still the documented copy-last-to-baseline flow), just not asked to
    // resolve differences below a millisecond.
    //
    // Case 3 below is what keeps this honest — it forces the baseline far
    // under reality and REQUIRES a failure, so a floor generous enough to stop
    // the flake cannot also stop the gate from gating.
    const observedP95 = last.summary?.p95 as number;
    const baselineP95 = Math.max(observedP95, 5);
    writeFileSync(
      path.join(loadDir, "baseline-dashboard.json"),
      JSON.stringify({ ...last, summary: { ...last.summary, p95: baselineP95 } }),
    );
    const atBaseline = await runPipes(env);
    if (atBaseline.code !== 0) console.error(atBaseline.output);
    expect(atBaseline.code).toBe(0);

    // Case 3: guard-the-guard — a baseline forced far below reality must
    // fail the run, or the gate never gated anything.
    writeFileSync(
      path.join(loadDir, "baseline-dashboard.json"),
      JSON.stringify({ summary: { p95: 0.000001 } }),
    );
    const forced = await runPipes(env);
    expect(forced.code).not.toBe(0);
  }, 60_000);
});
