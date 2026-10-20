import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, TaskId } from "../types.ts";

interface BiomeDiagnostic {
  severity?: string;
  message?: string;
  category?: string;
  location?: { path?: string; start?: { line?: number; column?: number } };
}

interface BiomeResult {
  diagnostics?: BiomeDiagnostic[];
}

export interface RunBiomeOptions {
  files: string[];
  source: TaskId;
  /** Biome flat rule config under linter.rules. */
  rules: unknown;
  /** Optional rule-category prefix filter, e.g. "lint/a11y". When set, findings
   *  outside this prefix are dropped (so an a11y task doesn't surface
   *  correctness rules its config didn't enable). */
  categoryPrefix?: string;
}

/** Where the biome executable might be, in order of preference.
 *
 * This used to check exactly one path — `findProjectRoot()/node_modules/.bin/biome` — which
 * is correct for a source install (biome is a dependency, so it sits in our own
 * node_modules) and wrong everywhere else.
 *
 * It matters because flawless-react is also shipped as a `bun build --compile` binary. In a
 * compiled binary `import.meta.url` points into Bun's virtual filesystem, so findProjectRoot()
 * walks six levels of a path that does not exist on disk and falls back to `process.cwd()` —
 * the user's project, which almost never has biome. The result was that the two biome-backed
 * tasks (a11y, react-rules) hard-failed in the binary while the other three worked.
 *
 * Checking a few plausible locations makes the binary useful whenever biome is reachable at
 * all, and keeps the source install behaving exactly as before.
 *
 * The walk UP from the analysed project is not decoration. A monorepo hoists its dev
 * dependencies to the workspace root, so `apps/web/node_modules/.bin/biome` does not exist
 * while `<root>/node_modules/.bin/biome` does — and a monorepo app is the shape this tool is
 * most often pointed at. Checking only the scanned package left a11y and react-rules dead in
 * the compiled binary on exactly that layout, including on this project's own dogfood app,
 * where every previous run had been made with the SOURCE install and therefore resolved
 * biome from flawless-react's own node_modules instead. Two of seven tasks were failing in
 * the shipped artifact and passing in the one used to test it. */
export function biomeCandidates(from: string = process.cwd()): string[] {
  return [
    // 1. Our own node_modules. This is the source-install case and stays first, so a
    //    source install always uses the biome version pinned in our package.json.
    path.join(findProjectRoot(), "node_modules", ".bin", "biome"),
    // 2. The project being analysed, then every ancestor — node's own resolution order,
    //    which is what makes a hoisted workspace root reachable.
    ...nodeModulesBinCandidates(from, "biome"),
  ];
}

/** The biome major whose linter config `runBiome` writes and whose JSON reporter
 *  it parses. Not a preference — the config below is spelled for it. */
const CONFIG_BIOME_MAJOR = "2";

/** The resolver's answer: a usable biome, or the one it refused, or nothing. */
export type BiomeBin = { bin: string } | { tooOld: { bin: string; version: string } };

/**
 * The first biome that can read the config these sweeps write.
 *
 * The ladder walks up from the ANALYSED project, and a compiled binary resolves
 * there (its own pinned biome lives inside the artifact, not on disk), so what
 * it finds is whatever the user's repo happens to depend on. On
 * code-forge-io/react-router-devtools that is a hoisted biome 1.9.4 — and the
 * sweep died there on `The "paths[0]" property must be of type string, got
 * object`: biome 1.x reports `location.path` as an object (`{ file: <relative> }`)
 * and `message` as an array of console-markup runs, while the parser reads both
 * as strings. a11y and react-rules reported `files:0 findings:0` on that shape —
 * not clean, dead, and only in the shipped artifact, because a source install
 * answers with our own pinned 2.x first and never sees the repo's biome.
 *
 * So ask each candidate its version and keep walking. A version that cannot be
 * read (a stub, a wrapper, a build whose `--version` output we do not
 * recognise) is accepted as before: only a biome PROVEN to be another major is
 * refused, and the refusal names it. Walking past the refusal is what lets a
 * 2.x further up the tree win over a 1.x nearer the scanned package.
 */
export function pickBiome(candidates: string[]): BiomeBin | null {
  let tooOld: { bin: string; version: string } | undefined;
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    const version = biomeVersion(bin);
    if (version && version.split(".")[0] !== CONFIG_BIOME_MAJOR) {
      tooOld ??= { bin, version };
      continue;
    }
    return { bin };
  }
  return tooOld ? { tooOld } : null;
}

/** Every place a biome might be, resolution order: ours, the project's, its
 *  ancestors, then PATH. */
export function biomeLadder(from: string = process.cwd()): string[] {
  const list = biomeCandidates(from);
  try {
    const onPath = Bun.which("biome");
    if (onPath && !list.includes(onPath)) list.push(onPath);
  } catch {
    // Bun.which is unavailable under plain Node; the candidates above are the answer there.
  }
  return list;
}

/** What a refused biome means to the person running the sweep. Exported so the
 *  wording — the version, the path, and the fix — is pinned by a test. */
export function biomeUnusableMessage(found: { bin: string; version: string }): string {
  return (
    `biome ${found.version} at ${found.bin} is not the biome major these sweeps are written ` +
    `for: they write a biome ${CONFIG_BIOME_MAJOR}.x linter config and parse its JSON ` +
    `reporter, and biome ${found.version} spells both differently — its output cannot be ` +
    "read as this task's findings. This is a hard failure, not a clean bill of health.\n" +
    `  Fix: bun add -d @biomejs/biome@^${CONFIG_BIOME_MAJOR} in the project being scanned, ` +
    `or put a matching biome on PATH. A source or npm install of flawless-react uses its ` +
    `own pinned biome ${CONFIG_BIOME_MAJOR}.x and is unaffected.`
  );
}

/** `Version: 2.5.1` → "2.5.1"; null when the binary will not say, or says
 *  something we cannot read as a version. */
function biomeVersion(bin: string): string | null {
  try {
    const out = Bun.spawnSync({ cmd: [bin, "--version"], stdout: "pipe", stderr: "pipe" });
    return /(\d+\.\d+\.\d+)/.exec(out.stdout?.toString() ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

function resolveBiomeBin(): BiomeBin | null {
  return pickBiome(biomeLadder());
}

/** `<dir>/node_modules/.bin/<bin>` for dir and every ancestor, nearest first. */
export function nodeModulesBinCandidates(from: string, bin: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(from);
  for (;;) {
    out.push(path.join(dir, "node_modules", ".bin", bin));
    const parent = path.dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

export async function runBiome(opts: RunBiomeOptions): Promise<Finding[]> {
  if (opts.files.length === 0) return [];
  const found = resolveBiomeBin();
  if (!found) {
    throw new Error(
      "biome executable not found. Looked in this package's node_modules, in " +
        `${path.join(process.cwd(), "node_modules", ".bin", "biome")} and every ancestor ` +
        "(so a hoisted workspace root counts), and on PATH.\n" +
        "  Source install:   bun install\n" +
        "  Compiled binary:  install biome in the project you are scanning " +
        "(bun add -d @biomejs/biome) or put it on PATH.",
    );
  }
  if ("tooOld" in found) throw new Error(biomeUnusableMessage(found.tooOld));
  const biomeBin = found.bin;

  const tmp = await mkdtemp(path.join(tmpdir(), "fhr-biome-"));
  const configPath = path.join(tmp, "biome.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        $schema: "https://biomejs.dev/schemas/2.3.13/schema.json",
        linter: { enabled: true, rules: opts.rules },
      },
      null,
      2,
    ),
  );

  const proc = Bun.spawn(
    [biomeBin, "lint", "--config-path", tmp, "--reporter=json", ...opts.files],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    throw new Error(`biome produced no JSON output. stderr:\n${stderr.slice(0, 2000)}`);
  }
  const jsonEnd = findMatchingBraceEnd(stdout, jsonStart);
  if (jsonEnd < 0) throw new Error("biome JSON output appears truncated");
  const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd)) as BiomeResult;

  const wantedFiles = new Set(opts.files.map((f) => path.resolve(f)));
  const findings: Finding[] = [];
  for (const d of parsed.diagnostics ?? []) {
    const p = d.location?.path;
    if (!p) continue;
    if (!wantedFiles.has(path.resolve(p))) continue;
    // A file biome could not PARSE produces `parse` diagnostics, which a
    // category filter ("lint/a11y") dropped on the floor — so an unreadable
    // file was reported as clean by every sweep. A file the analyser could
    // not read is never a pass; the diagnostic rides through the filter.
    const isParseFailure = d.category === "parse" || d.category?.startsWith("parse/");
    if (!isParseFailure && opts.categoryPrefix && !d.category?.startsWith(opts.categoryPrefix)) {
      continue;
    }
    // The sweep runs against a scratch config with only its own rules, so a
    // suppression aimed at the project's full config looks "unused" here.
    // Reporting that would punish the user for answering another task's
    // finding — suppression hygiene belongs to the project's own biome run.
    if (d.category?.startsWith("suppressions/")) continue;
    findings.push({
      rule: d.category ?? "biome",
      severity: d.severity === "error" ? "error" : "warn",
      file: path.resolve(p),
      line: d.location?.start?.line ?? 1,
      column: d.location?.start?.column ?? 1,
      message: d.message ?? "",
      source: opts.source,
    });
  }
  return findings;
}

function findMatchingBraceEnd(s: string, openIdx: number): number {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function findProjectRoot(): string {
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
