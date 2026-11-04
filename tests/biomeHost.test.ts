// A biome-host regen must land 0-warning under the project's own biome check.
//
// Dogfood-031 chunk #16. The control build (edd0b62) measured, on a fresh
// colocated full-task regen of this fixture with the repo-pinned biome
// 2.5.1 (`check . --formatter-enabled=false --reporter=json`):
//
//   - bigcachy arm (a biome on PATH, 2.5.14, ran the style pass):
//       tool-written files 0 errors / 12 warnings / 16 infos
//       full tree          2 errors / 12 warnings / 18 infos
//     the 12: 7 suppressions/unused + 3 useArrowFunction +
//     1 noUnusedVariables + 1 noUnusedFunctionParameters.
//   - no-style arm (no biome on PATH — what every other host sees):
//       the emitted files carried 24 organizeImports errors and 3
//       useImportType warnings the style pass had been masking. The
//       emitter's import layout was never canonical on its own; the
//       PATH biome was silently fixing it after the fact.
//
// The treatment (importCanon + the C1–C3 emitter fixes) must reach
// 0 warnings tree-wide and 0 errors on tool-written files with NO style
// pass at all, on every host. So this test neutralizes any PATH biome
// during runCore — the style line still prints (the config is found),
// but no formatting happens, and the check below runs the repo-pinned
// biome 2.5.1 binary, never a PATH one.
//
// The two remaining tree errors are pre-existing fixture debt in files
// the tool never writes (src/components/InboxList.tsx and
// src/components/providers/store-provider.tsx, both organizeImports
// under the fixture's own biome.json). They are pinned present: if they
// ever disappear the fixture changed and this test's accounting must be
// re-read, not silently widened.
//
// The surviving infos are the tolerated residue this test does NOT fail
// on: useTemplate ×15 on tool files (the 3 browser specs ×1 each,
// host/main.tsx ×3, host/server.ts ×5, setup.ts ×3, vitest.config.mts
// ×1) + noUselessFragments ×1 (provider.tsx), plus the fixture's own
// two (useTemplate in src/lib/labels.ts, a deserialize notice on its
// biome.json). Info severity only, zero behavioral effect; named in the
// PR as follow-up candidates.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCore } from "../src/core";

const REPO = resolve(import.meta.dir, "..");
const FIXTURE = join(REPO, "tests/fixtures/aliased-next-app");
const BIOME = join(REPO, "node_modules/.bin/biome");
// The tool never writes these; their organizeImports errors are fixture
// debt this chunk deliberately leaves in place.
const FIXTURE_OWN_FILES = new Set([
  "src/components/InboxList.tsx",
  "src/components/providers/store-provider.tsx",
]);
// Non-vacuity, eslintHost's LINTED_REQUIRED pattern: every site the
// closed-state receipt says carries a diagnostic. A suite-layout change
// is a conscious edit of this list, never a widened assertion.
const DIAG_REQUIRED = [
  "flawless/browser/InboxList.spec.ts",
  "flawless/browser/ReportTitle.spec.ts",
  "flawless/browser/StoreProvider.spec.ts",
  "flawless/host/main.tsx",
  "flawless/host/server.ts",
  "flawless/provider.tsx",
  "flawless/setup.ts",
  "flawless/vitest.config.mts",
  "src/lib/labels.ts",
  "biome.json",
  "src/components/InboxList.tsx",
  "src/components/providers/store-provider.tsx",
];

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "flawless-biomehost-"));
  cpSync(FIXTURE, root, {
    recursive: true,
    filter: (src) =>
      !/(^|\/)(node_modules|\.next|\.git|flawless|test-results|playwright-report)($|\/)/.test(src),
  });
  return root;
}

function bunInstall(cwd: string): void {
  const r = spawnSync("bun", ["install"], {
    cwd,
    encoding: "utf-8",
    timeout: 300_000,
  });
  if (r.status !== 0) {
    throw new Error(`bun install failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
  }
}

interface Diag {
  severity?: string;
  category?: string;
  location?: { path?: string };
}

interface Summary {
  changed?: number;
  unchanged?: number;
}

function checkTree(root: string): { diags: Diag[]; summary: Summary } {
  // The repo-pinned 2.5.1, run from the copy root exactly as the gate
  // defines it (the fixture's biome.json sits at that root). Exit code
  // is 1 for any diagnostic; never assert it.
  const r = spawnSync(BIOME, ["check", ".", "--formatter-enabled=false", "--reporter=json"], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
  try {
    const parsed = JSON.parse(r.stdout) as { diagnostics?: Diag[]; summary?: Summary };
    if (Array.isArray(parsed.diagnostics))
      return { diags: parsed.diagnostics, summary: parsed.summary ?? {} };
  } catch {
    /* fall through */
  }
  throw new Error(
    `biome check produced no JSON (${r.status}): ${(r.stderr || r.stdout || "").slice(0, 400)}`,
  );
}

function relPath(d: Diag): string {
  return (d.location?.path ?? "").replace(/^\.\//, "");
}

function label(d: Diag): string {
  return `${relPath(d)} ${d.category ?? "?"}`;
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  }
  return n;
}

function countSpecs(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countSpecs(join(dir, e.name));
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) n += 1;
  }
  return n;
}

test("biome-host regen: style line prints, tree lands 0-warning, no errors on tool files", async () => {
  const root = copyFixture();
  try {
    bunInstall(root);

    // Neutralize any PATH biome for the duration of runCore so the style
    // pass cannot mask emitter layout on hosts that happen to have one
    // (bigcachy carries 2.5.14 on PATH). A private bin holding only
    // `bun`: adoptStyle's Bun.which("biome") finds nothing, the copy's
    // node_modules/.bin has no biome, and the style line still prints
    // because the fixture's biome.json was found.
    const savedPath = process.env.PATH;
    const privBin = mkdtempSync(join(tmpdir(), "flawless-nobiome-"));
    symlinkSync(process.execPath, join(privBin, "bun"));
    process.env.PATH = privBin;

    // runCore's narration goes to process.stdout; capture it the way
    // eslintHost.test.ts does — the style: line leaves no filesystem trace.
    const out: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      out.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
    let exitCode: number;
    let runErrors: string[];
    try {
      const res = await runCore({
        pattern: join(root, "src", "**", "*.tsx"),
        outDir: join(root, "flawless"),
        taskIds: [
          "perf-harness",
          "unit-browser",
          "perf-static",
          "a11y",
          "react-rules",
          "e2e",
          "load",
        ],
        nextjs: root,
        colocate: true,
        log: true,
        inlineSummary: false,
      });
      exitCode = res.exitCode;
      runErrors = res.errors;
    } finally {
      process.stdout.write = original;
      process.env.PATH = savedPath;
      rmSync(privBin, { recursive: true, force: true });
    }
    expect(runErrors).toEqual([]);
    expect(exitCode).toBe(0);

    const styleLine = out
      .join("")
      .split("\n")
      .find((l) => l.startsWith("style:"));
    if (styleLine === undefined) {
      throw new Error("the run's stdout carries no style: line — the biome branch never ran");
    }
    expect(styleLine).toContain("the project's biome");

    // Non-vacuity: the regen actually wrote a full suite — 56 files in
    // flawless/ and 10 colocated specs in src/ on this fixture.
    expect(countFiles(join(root, "flawless"))).toBeGreaterThan(50);
    expect(countSpecs(join(root, "src"))).toBeGreaterThan(8);

    // The tool updated the app's own manifest like it does for a real
    // user's app; the post-regen install is part of the host's flow.
    bunInstall(root);

    const { diags, summary } = checkTree(root);
    const warnings = diags.filter((d) => d.severity === "warning");
    const errors = diags.filter((d) => d.severity === "error");

    // The whole point of the chunk: a plain check reports nothing to fix
    // on anything the tool wrote, and nothing at warning level anywhere.
    expect(warnings.map(label)).toEqual([]);
    expect(errors.filter((d) => !FIXTURE_OWN_FILES.has(relPath(d))).map(label)).toEqual([]);

    // The two fixture-own errors stay present (pinned, not assumed):
    // this chunk does not touch files the tool doesn't write.
    for (const f of FIXTURE_OWN_FILES) {
      expect(errors.some((d) => relPath(d) === f)).toBe(true);
    }

    // No suppression was emitted without being used, and the
    // useImportType class the emitter now fixes itself is gone.
    const cat = (d: Diag): string => d.category ?? "";
    expect(diags.filter((d) => cat(d).includes("suppressions/unused"))).toHaveLength(0);
    expect(diags.filter((d) => cat(d).includes("useImportType"))).toHaveLength(0);

    // Non-vacuity, twice over: the check actually scanned the tree, and
    // every required diagnostic site is present — the sweep reached the
    // suite, not an empty directory.
    expect((summary.changed ?? 0) + (summary.unchanged ?? 0)).toBeGreaterThan(0);
    const seen = new Set(diags.map(relPath));
    expect(DIAG_REQUIRED.filter((f) => !seen.has(f))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 600_000);
