import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * A login-walled app, plus the three shapes the landing assertion has to get
 * right. Every path 302s to /login without a session cookie; with one:
 *
 *   /slash  308s to /slash/   — a trailing-slash app, which must still PASS
 *   /dash   302s to /dash/overview — a page that redirects ON PURPOSE
 *   /soft   answers 200 and then redirects from the CLIENT
 *   /clicky answers 200 with a button, for the interaction test
 */
function serveLoginWalled(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const page = (body: string) =>
        new Response(`<!doctype html><html><body>${body}</body></html>`, {
          headers: { "content-type": "text/html" },
        });
      const to = (location: string, status: 302 | 308) =>
        new Response(null, { status, headers: { location } });

      if (url.pathname === "/login") return page("<h1>Sign in</h1>");
      // 302 to the login page — which answers 200. That is the whole bug.
      if (!(req.headers.get("cookie") ?? "").includes("session=")) return to("/login", 302);

      if (url.pathname === "/slash") return to("/slash/", 308);
      if (url.pathname === "/dash") return to("/dash/overview", 302);
      if (url.pathname === "/soft") {
        // 200, clean console, and then it leaves — the client-side half.
        return page(`<h1>Soft</h1><script>location.replace("/login")</script>`);
      }
      if (url.pathname === "/clicky") return page(`<button>Save</button>`);
      return page("<h1>Dashboard</h1>");
    },
  });
  const { port } = server;
  if (port === undefined) throw new Error("Bun.serve did not report a port");
  return { port, stop: () => void server.stop(true) };
}

/** A page component per extra route, so the emitter has something to analyse. */
function writePage(app: string, route: string, body: string): void {
  const dir = path.join(app, "src", "app", route);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "page.tsx"), body);
}

describe("the emitted e2e spec, in a real chromium, against a login redirect", () => {
  test.skipIf(!GATED)(
    "red until global-setup is filled in, green once it is",
    async () => {
      tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-e2e-exec-"));
      const app = path.join(tmpRoot, "app");
      cpSync(path.resolve(__dirname, "fixtures", "nextapp"), app, { recursive: true });

      const plain = (name: string) =>
        `export default function ${name}() {\n  return <main>${name}</main>;\n}\n`;
      writePage(app, "slash", plain("Slash"));
      writePage(app, "dash", plain("Dash"));
      writePage(app, path.join("dash", "overview"), plain("Overview"));
      writePage(app, "soft", plain("Soft"));
      // A click, so the SECOND emitted test (interactions) exists at all — the
      // stock fixture has none, and that half of the template was unexecuted.
      writePage(
        app,
        "clicky",
        `"use client";\n\nexport default function Clicky() {\n  return <button onClick={() => console.log("saved")}>Save</button>;\n}\n`,
      );

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
      expect(readFileSync(path.join(e2eDir, "index.spec.ts"), "utf8")).toContain(
        'const ROUTE = "/"',
      );
      // The interaction test really was emitted, so asserting on it below is
      // not asserting on an absent file.
      expect(readFileSync(path.join(e2eDir, "clicky.spec.ts"), "utf8")).toContain(
        "basic interactions from analysis stay error-free",
      );

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
        const play = async (grep: string): Promise<{ code: number; output: string }> => {
          const proc = Bun.spawn(
            [
              "bunx",
              "playwright",
              "test",
              "--config",
              "flawless/e2e/playwright.config.ts",
              "--grep",
              grep,
            ],
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
        const fillSetup = (cookie: boolean): void =>
          writeFileSync(
            path.join(e2eDir, "global-setup.ts"),
            `import { writeFileSync } from "node:fs";
import path from "node:path";

export default async function globalSetup(config: { rootDir: string }): Promise<void> {
  writeFileSync(
    path.join(config.rootDir, ".auth.json"),
    JSON.stringify({
      cookies: ${
        cookie
          ? `[
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
      ]`
          : "[]"
      },
      origins: [],
    }),
  );
}
`,
          );

        // 1. Unauthenticated, stub as shipped. The suite must FAIL: it asked for
        //    "/" and was handed the login screen.
        const unfilled = await play("GET / renders");
        if (unfilled.code === 0) console.error(unfilled.output);
        expect(unfilled.code).not.toBe(0);
        // …and for the RIGHT reason. The exact sentence the new assertion
        // produces, not any output that happens to mention /login: without this
        // the test would pass on a missing browser or a broken config.
        expect(unfilled.output).toContain("navigation left the route");
        expect(unfilled.output).toContain("/login");

        // 2. The interaction test is just as vacuous unfilled — every harvested
        //    click is visibility-guarded, so on a login page it does nothing and
        //    then reports a clean error list. It must fail too.
        const clicksUnfilled = await play("GET /clicky basic interactions");
        expect(clicksUnfilled.code).not.toBe(0);
        expect(clicksUnfilled.output).toContain("navigation left the route");

        // 3. Fill global-setup the way its own TODO describes — persist a
        //    session. This is the hand-work, performed.
        fillSetup(true);
        const filled = await play("GET / renders");
        if (filled.code !== 0) console.error(filled.output);
        expect(filled.code).toBe(0);
        expect(filled.output).toMatch(/\d+ passed/);

        const clicksFilled = await play("GET /clicky basic interactions");
        expect(clicksFilled.code).toBe(0);

        // 4. normalisePath earns its keep: /slash 308s to /slash/, which is the
        //    SAME route. Gutting the helper to `return p` leaves this red.
        const trailing = await play("GET /slash renders");
        if (trailing.code !== 0) console.error(trailing.output);
        expect(trailing.code).toBe(0);

        // 5. A page that redirects ON PURPOSE fails by default…
        const legit = await play("GET /dash renders");
        expect(legit.code).not.toBe(0);
        expect(legit.output).toContain("/dash/overview");

        // …and the escape the failure message names actually works. params.json,
        // not the spec: --force rewrites specs and leaves this file alone, so an
        // expectation recorded here survives regeneration.
        const paramsPath = path.join(e2eDir, "params.json");
        const params = JSON.parse(readFileSync(paramsPath, "utf8")) as {
          landing: Record<string, string>;
        };
        expect(params.landing).toEqual({});
        params.landing["/dash"] = "/dash/overview";
        writeFileSync(paramsPath, JSON.stringify(params, null, 2));
        const declared = await play("GET /dash renders");
        if (declared.code !== 0) console.error(declared.output);
        expect(declared.code).toBe(0);

        // 6. The client-side half of the claim: /soft answers 200 with a clean
        //    console and then leaves. Status and console cannot see it.
        const soft = await play("GET /soft renders");
        expect(soft.code).not.toBe(0);
        expect(soft.output).toContain("navigation left the route");

        // 7. Control for the whole file: with the session cookie removed again,
        //    the run that just passed goes back to red. Without this, a suite
        //    that had silently stopped asserting would still show green above.
        fillSetup(false);
        const reverted = await play("GET / renders");
        expect(reverted.code).not.toBe(0);
      } finally {
        stop();
      }
    },
    600_000,
  );
});
