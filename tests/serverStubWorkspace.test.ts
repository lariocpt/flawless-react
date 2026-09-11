import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";

/**
 * B-11, by BOOTING the emitted host: a "use server" module that lives in a
 * dist-built workspace package bypasses the browser host's stub filter.
 * The analyser resolves `@fix/actions` to the package's SOURCE tree (B-8,
 * deliberately — annotations live there), so the stub is keyed on the src
 * path; the host's bundler resolves the same bare specifier through
 * package.json `main`/`exports` to `dist/index.js` — a different path the
 * onLoad filter (\.tsx?$) does not even inspect. The built server module
 * lands in the browser bundle and the build fails on its Node imports —
 * taking every profile spec with it, since the host is one bundle.
 *
 * The unit plane is the control: vi.mock by bare specifier, sound today.
 */

const PANEL = `import { useState } from "react";
import { notify } from "@fix/actions";

export function Panel() {
  const [sent, setSent] = useState(false);
  return (
    <div>
      <span>{sent ? "sent" : "idle"}</span>
      <button
        type="button"
        onClick={() => {
          void notify("hi").then(() => setSent(true));
        }}
      >
        notify
      </button>
    </div>
  );
}
`;

const ACTIONS_SRC = `"use server";

import { appendFileSync } from "node:fs";

export async function notify(msg: string): Promise<{ b11Stubbed: boolean }> {
  appendFileSync("/tmp/never", msg);
  return { b11Stubbed: true };
}
`;

// What a real build step ships: same Node dependency, compiled to JS.
const ACTIONS_DIST = `import { appendFileSync } from "node:fs";

export async function notify(msg) {
  appendFileSync("/tmp/never", "b11-real-server-module " + msg);
  return { ok: true };
}
`;

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("a dist-built workspace 'use server' package in the browser host", () => {
  test("the host stubs it by bare specifier and boots", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-b11-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    mkdirSync(path.join(app, "packages", "actions", "src"), { recursive: true });
    mkdirSync(path.join(app, "packages", "actions", "dist"), { recursive: true });
    writeFileSync(
      path.join(app, "package.json"),
      `${JSON.stringify(
        {
          name: "fix-root",
          private: true,
          workspaces: ["packages/*"],
          // The app depends on its workspace package the way any adopter's
          // does — that is what links it into node_modules for the bundler.
          dependencies: { "@fix/actions": "workspace:*" },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(app, "src", "Panel.tsx"), PANEL);
    writeFileSync(
      path.join(app, "packages", "actions", "package.json"),
      `${JSON.stringify(
        {
          name: "@fix/actions",
          version: "0.0.1",
          type: "module",
          main: "./dist/index.js",
          exports: { ".": { default: "./dist/index.js" } },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(path.join(app, "packages", "actions", "src", "index.ts"), ACTIONS_SRC);
    writeFileSync(path.join(app, "packages", "actions", "dist", "index.js"), ACTIONS_DIST);

    // Link the workspace package the way any adopter's install would, so the
    // host's Bun.resolveSync finds @fix/actions through node_modules.
    const link = Bun.spawn(["bun", "install"], { cwd: app, stdout: "pipe", stderr: "pipe" });
    if ((await link.exited) !== 0) {
      throw new Error(`workspace bun install failed:\n${await new Response(link.stderr).text()}`);
    }

    const outDir = path.join(app, "flawless");
    const result = await runCore({
      pattern: path.join(app, "src", "Panel.tsx"),
      outDir,
      taskIds: ["perf-harness", "unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // Detection worked (B-8): the unit spec mocks the bare specifier, and the
    // host carries a stub for the module. Interception is what B-11 is about.
    const unitSpec = readFileSync(path.join(outDir, "unit", "Panel.test.tsx"), "utf8");
    expect(unitSpec).toContain('vi.mock("@fix/actions"');
    const server = readFileSync(path.join(outDir, "host", "server.ts"), "utf8");
    expect(server).toContain("notify");

    const install = Bun.spawn(["bun", "install"], { cwd: outDir, stdout: "pipe", stderr: "pipe" });
    if ((await install.exited) !== 0) {
      throw new Error(`suite bun install failed:\n${await new Response(install.stderr).text()}`);
    }

    // Boot the host: the bundle happens at startup, so a stub miss fails
    // RIGHT HERE with the dist module's node:fs import in the browser build.
    const port = 40000 + Math.floor(Math.random() * 10000);
    const host = Bun.spawn(["bun", path.join(outDir, "host", "server.ts")], {
      cwd: outDir,
      env: { ...process.env, PORT: String(port) },
      stdout: "pipe",
      stderr: "pipe",
    });
    let exited = false;
    void host.exited.then(() => {
      exited = true;
    });
    try {
      const deadline = Date.now() + 30_000;
      let up = false;
      let lastErr = "";
      while (Date.now() < deadline) {
        // The bundle failure exits the process — stop polling and read why.
        if (exited) break;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          if (res.ok) {
            up = true;
            break;
          }
        } catch (e) {
          lastErr = String(e);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!up) {
        const [out, err] = await Promise.all([
          new Response(host.stdout).text(),
          new Response(host.stderr).text(),
        ]);
        throw new Error(`host did not come up (${lastErr}):\nstdout:\n${out}\nstderr:\n${err}`);
      }

      // The sharp probe: WHAT got bundled. Bun shims tame Node imports for a
      // browser target, so the bypass does not always fail the build — it
      // silently ships the real server module instead. The bundle must carry
      // the STUB (whose return the analyser read off the src object literal),
      // and none of the dist module's body.
      const bundle = await (await fetch(`http://127.0.0.1:${port}/bundle.js`)).text();
      expect(bundle).toContain("b11Stubbed");
      expect(bundle).not.toContain("b11-real-server-module");
    } finally {
      host.kill();
      await host.exited;
    }
  }, 180_000);
});
