import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";

/**
 * The emitted EXPO e2e suite, executed — the wave-6 half of what
 * tests/e2eExecution.test.ts proves for the Next.js flavour.
 *
 * The stand-in server reproduces what was MEASURED against real Metro + the
 * real dogfood app on 2026-09-12 (docs/reviews/2026-09-expo-probes.md), not a
 * guess about a SPA:
 *
 *   - every served route answers 200 with per-route HTML; unknown paths 404
 *   - an unauthenticated "/" CLIENT-redirects to /login (the landing case)
 *   - an unauthenticated protected route renders a wall IN PLACE at the same
 *     URL — and the app's API calls surface as 401 console errors
 *
 * Three assertions have to bite for the suite to be real: the landing
 * assertion (redirect case), the console assertion (wall case), and the copy
 * witness (the claim that cannot be true of a wall). Each is driven to red
 * here, and the whole run back to green, in a real chromium.
 *
 * Gated by FLAWLESS_CI_BROWSER=1 like the Next.js twin; armed in the
 * Jenkinsfile.
 */

const GATED = process.env.FLAWLESS_CI_BROWSER === "1";

let tmpRoot: string | undefined;
afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

interface StandIn {
  port: number;
  stop: () => void;
  /** Mutates the copy served for a route — the witness-mutation probe. */
  setCopy: (route: string, text: string) => void;
}

/** Metro-semantics stand-in: per-route HTML, real 404s, client-side auth walls. */
function serveMetroShaped(copy: Map<string, string>): StandIn {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const authed = (req.headers.get("cookie") ?? "").includes("session=");
      const page = (body: string, status = 200) =>
        new Response(`<!doctype html><html><body>${body}</body></html>`, {
          status,
          // charset matters: the hostile fixture's witness carries an em dash,
          // and without it chromium decodes as windows-1252 and getByText
          // never matches — a red spec about encoding, not about the app.
          headers: { "content-type": "text/html; charset=utf-8" },
        });

      // The app's API, same origin for the stand-in: 401 without the cookie.
      if (url.pathname === "/api/me") {
        return new Response(authed ? "{}" : "unauthorized", { status: authed ? 200 : 401 });
      }
      if (!copy.has(url.pathname)) return page("<h1>Not found</h1>", 404);

      if (url.pathname === "/login") return page(copy.get("/login") as string);
      if (!authed) {
        if (url.pathname === "/") {
          // The redirect face: expo-router's <Redirect> is a client-side nav.
          return page(`<script>location.replace("/login")</script>`);
        }
        // The wall face: same URL, 200, the screen's own copy never renders,
        // and the API call the screen makes lands in the console as a 401.
        return page(`Unauthorized<script>fetch("/api/me");</script>`);
      }
      return page(copy.get(url.pathname) as string);
    },
  });
  const { port } = server;
  if (port === undefined) throw new Error("Bun.serve did not report a port");
  return {
    port,
    stop: () => void server.stop(true),
    setCopy: (route, text) => void copy.set(route, text),
  };
}

describe("the emitted expo e2e suite, in a real chromium", () => {
  test.skipIf(!GATED)(
    "red on both auth-wall faces until global-setup is filled, green after, red again when the copy lies",
    async () => {
      tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-e2e-expo-exec-"));
      const app = path.join(tmpRoot, "app");
      cpSync(path.resolve(__dirname, "fixtures", "expoapp"), app, { recursive: true });

      const result = await runCore({
        pattern: path.join(app, "app", "**", "*.tsx"),
        expo: app,
        taskIds: ["e2e"],
        force: true,
        log: false,
        inlineSummary: false,
      });
      expect(result.exitCode).toBe(0);
      const e2eDir = path.join(app, "flawless", "e2e");

      // The witnesses the specs actually assert, read back from the emitted
      // files so the stand-in cannot drift from the emitter.
      const witnessOf = (stem: string): string => {
        const spec = readFileSync(path.join(e2eDir, `${stem}.spec.ts`), "utf8");
        const m = /await expect\(page\.getByText\("((?:[^"\\]|\\.)*)"\)/.exec(spec);
        if (!m?.[1]) throw new Error(`${stem}.spec.ts emitted no copy witness`);
        return JSON.parse(`"${m[1]}"`) as string;
      };
      const copy = new Map<string, string>([
        ["/", `<h1>${witnessOf("index")}</h1>`],
        ["/login", `<h1>${witnessOf("login")}</h1>`],
        ["/hostile", `<h1>${witnessOf("hostile")}</h1>`],
      ]);

      // Trim the install to the runner. Nothing renders the real app here.
      const pkgPath = path.join(app, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        dependencies?: unknown;
        devDependencies: Record<string, string>;
      };
      const playwright = pkg.devDependencies["@playwright/test"];
      expect(playwright).toBeTruthy();
      pkg.dependencies = {};
      pkg.devDependencies = { "@playwright/test": playwright as string };
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      for (const cmd of [
        ["bun", "install"],
        ["bunx", "playwright", "install", "chromium"],
      ]) {
        const proc = Bun.spawn(cmd as string[], { cwd: app, stdout: "pipe", stderr: "pipe" });
        if ((await proc.exited) !== 0) {
          throw new Error(`${cmd.join(" ")} failed:\n${await new Response(proc.stderr).text()}`);
        }
      }

      const standIn = serveMetroShaped(copy);
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
                FLAWLESS_E2E_BASEURL: `http://localhost:${standIn.port}`,
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
          ? `[{ name: "session", value: "filled", domain: "localhost", path: "/",
               expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }]`
          : "[]"
      },
      origins: [],
    }),
  );
}
`,
          );

        // 1. The REDIRECT face, stub as shipped: "/" client-redirects to the
        //    login screen. The landing assertion must name it.
        const redirected = await play("GET / renders without");
        expect(redirected.code).not.toBe(0);
        expect(redirected.output).toContain("navigation left the route");
        expect(redirected.output).toContain("/login");

        // 2. The WALL face: /hostile keeps its URL and answers 200 — status
        //    and landing are blind, the console assertion is not (the 401),
        //    and the copy witness is not either.
        const walled = await play("GET /hostile renders without");
        expect(walled.code).not.toBe(0);
        expect(walled.output).toMatch(/401|Failed to load resource/);
        const walledCopy = await play("GET /hostile renders its own copy");
        expect(walledCopy.code).not.toBe(0);

        // 3. Fill the auth hook the way its own TODO describes. Everything
        //    above goes green — including interactions, whose guards must not
        //    turn absence into a pass on a wall (assertOnRoute runs first).
        fillSetup(true);
        for (const grep of [
          "GET / renders",
          "GET /login renders",
          "GET /hostile renders",
          "GET /hostile basic interactions",
        ]) {
          const green = await play(grep);
          if (green.code !== 0) console.error(green.output);
          expect(`${grep}: ${green.code}`).toBe(`${grep}: 0`);
        }

        // 4. The witness bites: serve the WRONG copy for /hostile and only the
        //    copy test reddens — the console is clean, the URL is right, and
        //    the screen is still not the one the analysis described.
        standIn.setCopy("/hostile", "<h1>A perfectly pleasant wrong screen</h1>");
        const lied = await play("GET /hostile renders its own copy");
        expect(lied.code).not.toBe(0);
        standIn.setCopy("/hostile", `<h1>${witnessOf("hostile")}</h1>`);

        // 5. The landing override earns its keep for the cold-start shape the
        //    dogfood app actually has: declare that "/" lands on "/login" and
        //    the redirect becomes the EXPECTED destination.
        fillSetup(false);
        const paramsPath = path.join(e2eDir, "params.json");
        const params = JSON.parse(readFileSync(paramsPath, "utf8")) as {
          landing: Record<string, string>;
        };
        expect(params.landing).toEqual({});
        params.landing["/"] = "/login";
        writeFileSync(paramsPath, JSON.stringify(params, null, 2));
        const declared = await play("GET / renders without");
        if (declared.code !== 0) console.error(declared.output);
        expect(declared.code).toBe(0);
        // …and the copy test SKIPS under the override rather than asserting
        // this screen's text on the screen it deliberately redirects to.
        const declaredCopy = await play("GET / renders its own copy");
        if (declaredCopy.code !== 0) console.error(declaredCopy.output);
        expect(declaredCopy.code).toBe(0);
        expect(declaredCopy.output).toMatch(/1 skipped/);
        params.landing = {};
        writeFileSync(paramsPath, JSON.stringify(params, null, 2));

        // 6. Control: with the session gone again, the green run above goes
        //    back to red — the suite did not quietly stop asserting.
        const reverted = await play("GET /hostile renders without");
        expect(reverted.code).not.toBe(0);
      } finally {
        standIn.stop();
      }
    },
    600_000,
  );
});
