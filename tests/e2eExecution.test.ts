import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";

/**
 * B-12: the emitted e2e suite was GREEN BEFORE IT WAS REAL.
 *
 * `global-setup.ts` ships as a hand-fill stub that writes an empty storage
 * state, so an unauthenticated run hits a protected route, the app 302s it to
 * /login, and `page.goto` follows the redirect to a page that answers 200. The
 * spec's only claims were "a response came back", "status < 500" and "no
 * console errors" — all true of a login screen. Thirty route specs could pass
 * having tested one form nobody asked them to test.
 *
 * Reading the emitted spec is exactly what let this survive: every assertion in
 * it looks reasonable. So this test EXECUTES it, in a real chromium, against a
 * server that redirects the way a real app does — red before the setup is
 * filled, green after, which is the whole contract.
 *
 * No Next.js build and no dev server: the emitted config skips its own
 * `webServer` when FLAWLESS_E2E_BASEURL is set (that hook exists for putting a
 * crust validation proxy in front), so a throwaway Bun.serve stands in for the
 * app and the run is seconds rather than minutes.
 *
 * Gated by FLAWLESS_CI_BROWSER=1 like tests/browserExecution.test.ts — a real
 * browser is a CI-scoped cost. Jenkinsfile sets it and installs chromium.
 *   FLAWLESS_CI_BROWSER=1 bun test tests/e2eExecution.test.ts
 */

const GATED = process.env.FLAWLESS_CI_BROWSER === "1";

let tmpRoot: string | undefined;
afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/** A login-walled app in nine lines: every route 302s unless a session cookie rides along. */
function serveLoginWalled(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const page = (body: string) =>
        new Response(`<!doctype html><html><body>${body}</body></html>`, {
          headers: { "content-type": "text/html" },
        });
      if (url.pathname === "/login") return page("<h1>Sign in</h1>");
      const hasSession = (req.headers.get("cookie") ?? "").includes("session=");
      // 302 to the login page — which answers 200. That is the whole bug.
      if (!hasSession) return new Response(null, { status: 302, headers: { location: "/login" } });
      return page("<h1>Dashboard</h1>");
    },
  });
  const { port } = server;
  if (port === undefined) throw new Error("Bun.serve did not report a port");
  return { port, stop: () => void server.stop(true) };
}

describe("the emitted e2e spec, in a real chromium, against a login redirect", () => {
  test.skipIf(!GATED)(
    "red until global-setup is filled in, green once it is",
    async () => {
      tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-e2e-exec-"));
      const app = path.join(tmpRoot, "app");
      cpSync(path.resolve(__dirname, "fixtures", "nextapp"), app, { recursive: true });

      const result = await runCore({
        // The pages explicitly: Next.js mode's auto-detected entry glob does not
        // include app/**/page.tsx, and without them e2e emits a config and no specs.
        pattern: path.join(app, "src/app/**/page.tsx"),
        nextjs: app,
        taskIds: ["e2e"],
        force: true,
        log: false,
        inlineSummary: false,
      });
      expect(result.exitCode).toBe(0);

      const e2eDir = path.join(app, "flawless", "e2e");
      // The static route: a dynamic one would test.skip for a missing id
      // fixture and the whole proof would be vacuous.
      const spec = path.join(e2eDir, "index.spec.ts");
      expect(readFileSync(spec, "utf8")).toContain('const ROUTE = "/"');

      // Trim the install to what the suite actually needs. next/react are in the
      // fixture's deps and are irrelevant here — nothing renders the real app.
      const pkgPath = path.join(app, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies?: unknown;
        devDependencies: Record<string, string>;
        scripts: Record<string, string>;
      };
      const playwright = pkg.devDependencies["@playwright/test"];
      expect(playwright).toBeTruthy();
      pkg.dependencies = {};
      pkg.devDependencies = { "@playwright/test": playwright as string };
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

      const install = Bun.spawn(["bun", "install"], { cwd: app, stdout: "pipe", stderr: "pipe" });
      if ((await install.exited) !== 0) {
        throw new Error(`bun install failed:\n${await new Response(install.stderr).text()}`);
      }
      const chromium = Bun.spawn(["bunx", "playwright", "install", "chromium"], {
        cwd: app,
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await chromium.exited) !== 0) {
        throw new Error(
          `playwright install chromium failed:\n${await new Response(chromium.stderr).text()}`,
        );
      }

      const { port, stop } = serveLoginWalled();
      try {
        const play = async (): Promise<{ code: number; output: string }> => {
          const proc = Bun.spawn(
            ["bunx", "playwright", "test", "--config", "flawless/e2e/playwright.config.ts"],
            {
              cwd: app,
              env: {
                ...process.env,
                CI: "1",
                FLAWLESS_E2E_BASEURL: `http://localhost:${port}`,
              },
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

        // 1. Unauthenticated, with the stub setup exactly as shipped. The suite
        //    must FAIL: it asked for "/" and was handed the login screen.
        const unfilled = await play();
        if (unfilled.code === 0) {
          console.error(unfilled.output);
        }
        expect(unfilled.code).not.toBe(0);
        // …and it must fail for the RIGHT reason. Without this the test would
        // pass on any breakage at all — a missing browser, a bad config.
        expect(unfilled.output).toMatch(/redirected|\/login/i);

        // 2. Fill in global-setup the way its own TODO describes: persist a
        //    session so the storageState the config already points at is real.
        //    This is the hand-work, performed.
        writeFileSync(
          path.join(e2eDir, "global-setup.ts"),
          `import { writeFileSync } from "node:fs";
import path from "node:path";

export default async function globalSetup(config: { rootDir: string }): Promise<void> {
  const authState = path.join(config.rootDir, ".auth.json");
  writeFileSync(
    authState,
    JSON.stringify({
      cookies: [
        {
          name: "session",
          value: "filled-in-by-hand",
          domain: "localhost",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    }),
  );
}
`,
        );

        const filled = await play();
        if (filled.code !== 0) console.error(filled.output);
        expect(filled.code).toBe(0);
        expect(filled.output).toMatch(/\d+ passed/);
      } finally {
        stop();
      }
    },
    600_000,
  );
});
