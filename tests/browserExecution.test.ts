import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";

/**
 * FR-022: hosts were booted and curled and configs --list'ed, but no emitted
 * playwright spec ever met a REAL browser in this repo — a spec-body runtime
 * error against the host's __FLAWLESS__ driver API was invisible. This is
 * the one Jenkins-gated case: chromium installed, the smallest browser spec
 * run against the booted host (the emitted config's webServer boots it),
 * one green, one mutated-red.
 *
 * Gated by FLAWLESS_CI_BROWSER=1 — deliberately, per the finding: a real
 * browser is a CI-scoped cost. The Jenkinsfile sets it; run locally with
 * FLAWLESS_CI_BROWSER=1 bun test tests/browserExecution.test.ts
 */

const GATED = process.env.FLAWLESS_CI_BROWSER === "1";

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("the smallest emitted browser spec, in a real chromium", () => {
  test.skipIf(!GATED)(
    "green against the booted host; a mutated spec goes red",
    async () => {
      tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-browser-exec-"));
      const app = path.join(tmpRoot, "app");
      mkdirSync(path.join(app, "src"), { recursive: true });
      copyFileSync(
        path.resolve(__dirname, "fixtures", "Hello.tsx"),
        path.join(app, "src", "Hello.tsx"),
      );
      const outDir = path.join(app, "flawless");

      const result = await runCore({
        pattern: path.join(app, "src", "Hello.tsx"),
        outDir,
        taskIds: ["perf-harness", "unit-browser"],
        force: true,
        log: false,
        inlineSummary: false,
      });
      expect(result.exitCode).toBe(0);

      const install = Bun.spawn(["bun", "install"], {
        cwd: outDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await install.exited) !== 0) {
        throw new Error(`bun install failed:\n${await new Response(install.stderr).text()}`);
      }
      const chromium = Bun.spawn(["bunx", "playwright", "install", "chromium"], {
        cwd: outDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await chromium.exited) !== 0) {
        throw new Error(
          `playwright install chromium failed:\n${await new Response(chromium.stderr).text()}`,
        );
      }

      const play = async (): Promise<{ code: number; output: string }> => {
        const proc = Bun.spawn(
          ["bunx", "playwright", "test", "--config", "browser/playwright.config.ts"],
          {
            cwd: outDir,
            env: { ...process.env, CI: "1" },
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
      };

      const green = await play();
      if (green.code !== 0) console.error(green.output);
      expect(green.code).toBe(0);
      expect(green.output).toMatch(/\d+ passed/);

      // Mutated-red: point the spec at a component the host never
      // registered. If the run stayed green, the spec never really drove
      // the __FLAWLESS__ driver — the vacuity this test exists to close.
      const spec = path.join(outDir, "browser", "Hello.spec.ts");
      writeFileSync(spec, readFileSync(spec, "utf8").replaceAll('"Hello"', '"NotARealComponent"'));
      const red = await play();
      expect(red.code).not.toBe(0);
    },
    600_000,
  );
});
