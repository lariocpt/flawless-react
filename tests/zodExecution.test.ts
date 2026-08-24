import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * B-9 end to end, by EXECUTING the emitted spec: a dep whose annotation
 * type carries a z.infer enum member gains a concrete fixture read from the
 * schema's own AST — with zod NEVER installed. The emitted vi.mock factory
 * replaces the shared module wholesale, so the schema file's `import { z }
 * from "zod"` never evaluates; an explicit node_modules/zod absence
 * assertion keeps that reasoning enforced, not believed.
 *
 * The proof triangle:
 *  - the enriched spec runs green with nothing skipped;
 *  - the fixture hand-corrupted to {} goes RED (the spec really executes);
 *  - the enum's first literal renamed at its SOURCE + a regeneration
 *    re-derives the fixture — and the stale component goes red against it,
 *    which is what live resolution means.
 */

const ROOT_PKG = JSON.stringify({
  name: "zod-exec-monorepo",
  private: true,
  workspaces: ["apps/*", "packages/*"],
});

const SHARED_PKG = JSON.stringify({
  // main points at src so the RUNTIME (vitest transform) can resolve the
  // workspace symlink; the analyser never reads it (B-8 probes src).
  name: "@zex/shared",
  main: "./src/index.ts",
});

const SHARED_BARREL = `export * from "./schemas";
export * from "./types";
export * from "./data";
`;

const SHARED_SCHEMAS = `import { z } from "zod";

export const RoleSchema = z.enum(["host", "cohost", "guest"]);
export type Role = z.infer<typeof RoleSchema>;
`;

const SHARED_TYPES = `import type { Role } from "./schemas";

export interface Participant {
  name: string;
  role: Role;
}
`;

const SHARED_DATA = `import type { Participant } from "./types";

export async function getParticipant(): Promise<Participant> {
  throw new Error("the real data layer must never run under jsdom");
}
`;

const PANEL = `import { getParticipant } from "@zex/shared";

const LABEL: Record<string, string> = { host: "Host", cohost: "Co-host", guest: "Guest" };

function caption(p: { name: string; role: string }): string {
  return \`\${p.name}: \${LABEL[p.role]!.toUpperCase()}\`;
}

export default async function RolePanel() {
  const p = await getParticipant();
  return <h1>{caption(p)}</h1>;
}
`;

function suitePins(): Record<string, string> {
  const pkg = JSON.parse(suitePackageJson("/x/flawless", false)) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  const pins: Record<string, string> = {};
  for (const name of [
    "react",
    "react-dom",
    "vitest",
    "jsdom",
    "@testing-library/react",
    "@testing-library/user-event",
    "@testing-library/jest-dom",
  ]) {
    const range = all[name];
    if (range === undefined) throw new Error(`the emitted suite no longer pins ${name}`);
    pins[name] = range;
  }
  return pins;
}

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("zod-derived dep fixtures, executed", () => {
  test("enum fixture runs green with zod absent; renaming the literal re-derives it", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-zod-exec-"));
    const root = tmpRoot;
    const app = path.join(root, "apps", "web");
    const shared = path.join(root, "packages", "shared");
    mkdirSync(path.join(app, "src"), { recursive: true });
    mkdirSync(path.join(shared, "src"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), ROOT_PKG);
    writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({
        name: "zex-web",
        private: true,
        dependencies: { "@zex/shared": "workspace:*" },
        devDependencies: suitePins(),
      }),
    );
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(shared, "package.json"), SHARED_PKG);
    writeFileSync(path.join(shared, "src", "index.ts"), SHARED_BARREL);
    const schemasPath = path.join(shared, "src", "schemas.ts");
    writeFileSync(schemasPath, SHARED_SCHEMAS);
    writeFileSync(path.join(shared, "src", "types.ts"), SHARED_TYPES);
    writeFileSync(path.join(shared, "src", "data.ts"), SHARED_DATA);
    writeFileSync(path.join(app, "src", "RolePanel.tsx"), PANEL);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "RolePanel.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // Emission first: the fixture came through workspace map + barrel +
    // z.infer alias + schema AST, and left no gap markers behind.
    const specPath = path.join(outDir, "unit", "RolePanel.test.tsx");
    const spec = readFileSync(specPath, "utf8");
    expect(spec).toContain(
      'getParticipant: vi.fn(async () => ({"name":"flawless-name","role":"host"}))',
    );
    expect(spec).toContain("return annotation");
    expect(spec).not.toContain("data fixture missing");
    expect(spec).not.toContain("TODO(flawless): some return shapes");

    const install = Bun.spawn(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [installErr, installCode] = await Promise.all([
      new Response(install.stderr).text(),
      install.exited,
    ]);
    if (installCode !== 0) {
      throw new Error(
        `could not install the suite's runners (needs registry access):\n${installErr}`,
      );
    }
    // The wall this test leans on: zod is NOT installed anywhere, so a green
    // run PROVES the vi.mock factory kept schemas.ts from ever evaluating.
    expect(existsSync(path.join(root, "node_modules", "zod"))).toBe(false);
    expect(existsSync(path.join(app, "node_modules", "zod"))).toBe(false);
    const vitestBin = path.join(app, "node_modules", ".bin", "vitest");
    if (!existsSync(vitestBin)) throw new Error(`vitest did not install at ${vitestBin}`);
    const vitest = async (): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn([vitestBin, "run", "unit/RolePanel.test.tsx"], {
        cwd: outDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      return { code, output: out + err };
    };

    const enriched = await vitest();
    if (enriched.code !== 0) console.error(enriched.output);
    expect(enriched.code).toBe(0);
    expect(enriched.output).not.toContain("skipped");
    expect(enriched.output).not.toContain("data fixture missing");

    // Guard-the-guard on the ARTEFACT: the old {} must crash the component.
    writeFileSync(specPath, spec.replace('({"name":"flawless-name","role":"host"})', "({})"));
    const corrupted = await vitest();
    expect(corrupted.code).not.toBe(0);
    expect(corrupted.output).toContain("toUpperCase");
    // Restore exact bytes so the stamp matches and --force refreshes it (B-4).
    writeFileSync(specPath, spec);

    // Liveness: rename the enum's FIRST literal at its source → regenerate →
    // the fixture must be re-derived, and the stale label table goes red.
    writeFileSync(schemasPath, SHARED_SCHEMAS.replace('"host", ', '"owner", '));
    const regen = await runCore({
      pattern: path.join(app, "src", "RolePanel.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(regen.exitCode).toBe(0);
    const respec = readFileSync(specPath, "utf8");
    expect(respec).toContain('({"name":"flawless-name","role":"owner"})');
    const stale = await vitest();
    expect(stale.code).not.toBe(0);
    expect(stale.output).toContain("toUpperCase");
  }, 120_000);
});
