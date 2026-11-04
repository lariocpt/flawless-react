// A biome-host regen must land 0-warning under the project's own biome check
// on EVERY host — including the ones with no biome on PATH.
//
// Dogfood-031 chunks #16 and #21. Two facts shape this test:
//
//  1. The style pass is a mask. On a host that happens to carry a biome on
//     PATH, adoptStyle runs it over every emitted file, so the emitter's own
//     import layout never has to be canonical. The control build measured
//     that directly: with the style pass alive the tool-written files were
//     0-error, with it off the same bytes carried 24 organizeImports errors
//     and 3 useImportType warnings. A test that only ever runs on a
//     biome-carrying host proves the PATH biome works, not the emitter.
//
//  2. The mask cannot be removed from inside the process. adoptStyle resolves
//     its binary with `Bun.which("biome")`, and Bun.which reads the PATH the
//     process STARTED with, not the live process.env.PATH. The previous
//     version of this test swapped process.env.PATH around runCore and still
//     formatted — green on bigcachy, red on every host without a PATH biome
//     (l-dev-ai since PR #159), which is exactly backwards.
//
// So the regen runs as a SUBPROCESS whose PATH carries no biome executable:
// every PATH directory that contains one is dropped, and a private bin holds
// a `bun` symlink so the child can still be launched. node stays on PATH on
// purpose: a11y and react-rules resolve the repo-pinned biome through
// biomeRunner's own ladder (findProjectRoot's node_modules/.bin first), and
// that shim is `#!/usr/bin/env node`. Removing node would break the scanner
// tasks; removing biome directories only starves the style pass, which is the
// whole point.
//
// Proof that the style pass did nothing: adoptStyle returns
// `{ formatter: "biome", formatted: 0, warning: "biome config found but no
// biome binary" }` on exactly that path (adoptStyle.ts), and core.ts prints
// the warning. The line's presence means the fixture's biome.json WAS found
// and NO binary was invoked — formatted 0 is the same return value.
//
// Measured on this tree, fresh colocated full-task regen of this fixture
// with the copy's own `bun install` first (a real host always has
// node_modules, and the emitter's setup.ts variant depends on what is
// installed), repo-pinned biome 2.5.1
// (`check . --formatter-enabled=false --reporter=json` from the copy root):
//
//   tool-written files  0 errors / 0 warnings / 18 infos
//   full tree           2 errors / 0 warnings / 21 infos
//
// The two errors are pre-existing fixture debt in files the tool never
// writes (src/components/InboxList.tsx and
// src/components/providers/store-provider.tsx, both organizeImports under the
// fixture's own biome.json). They are pinned present: if they ever disappear
// the fixture changed and this test's accounting must be re-read, not
// silently widened.
//
// The surviving infos are the tolerated residue this test does NOT fail on:
// useTemplate ×19 on tool files (the 3 browser specs ×1 each, host/main.tsx
// ×4, host/server.ts ×7, setup.ts ×3, vitest.config.mts ×1) +
// noUselessFragments ×1 (provider.tsx), plus the fixture's own two
// (useTemplate in src/lib/labels.ts, a deserialize notice on its
// biome.json). Info severity only, zero behavioral effect; named in the PR as
// follow-up candidates.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
const TASKS = ["perf-harness", "unit-browser", "perf-static", "a11y", "react-rules", "e2e", "load"];

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

/**
 * A PATH with no biome executable in it, and a `bun` the child can be
 * launched with. Everything else (node above all) survives: this is a host
 * without a biome, not a host without a shell.
 */
function pathWithoutBiome(): string {
  const privBin = mkdtempSync(join(tmpdir(), "flawless-nobiome-"));
  symlinkSync(process.execPath, join(privBin, "bun"));
  const kept = (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => dir !== "" && !existsSync(join(dir, "biome")));
  return [privBin, ...kept].join(":");
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

interface CiResult {
  id: string;
  ok: boolean;
  summary?: string;
  error?: string;
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

test("biome-free host regen: no style pass runs, tree lands 0-warning, no errors on tool files", async () => {
  const root = copyFixture();
  try {
    bunInstall(root);

    // --ci, not the human log: stdout is one JSON blob whose per-task `ok`
    // flags make the exit code explainable, and the run's own narration
    // (including the style: lines) lands on stderr.
    const proc = spawnSync(
      process.execPath,
      [
        join(REPO, "src", "bin.ts"),
        "src/**/*.tsx",
        "--out",
        join(root, "flawless"),
        "--tasks",
        TASKS.join(","),
        "--nextjs",
        root,
        "--colocate",
        "--ci",
      ],
      {
        cwd: root,
        encoding: "utf-8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: 300_000,
        env: { ...process.env, PATH: pathWithoutBiome() },
      },
    );
    let blob: { exitCode?: number; results?: CiResult[] };
    try {
      blob = JSON.parse(proc.stdout) as { exitCode?: number; results?: CiResult[] };
    } catch {
      throw new Error(
        `regen produced no --ci JSON (${proc.status}): ${(proc.stderr || proc.stdout || "").slice(-600)}`,
      );
    }
    const results = blob.results ?? [];
    const failed = results.filter((r) => !r.ok);
    expect(
      failed.map((r) => `${r.id}: ${r.error ?? r.summary ?? "?"}`),
      "every task must succeed on a host with no biome on PATH",
    ).toEqual([]);
    expect(blob.exitCode).toBe(0);

    // The style pass found the config and formatted nothing: that warning is
    // adoptStyle's `formatted: 0, no biome binary` return, so it is proof of
    // both halves at once. A host that DID format would print
    // `style: formatted N …` with N > 0 instead — impossible here, and the
    // negative check keeps a future log-routing change from hiding it.
    const logs = `${proc.stdout}\n${proc.stderr}`;
    expect(logs).toContain("style: biome config found but no biome binary");
    expect(logs).not.toMatch(/style: formatted [1-9]/);

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
