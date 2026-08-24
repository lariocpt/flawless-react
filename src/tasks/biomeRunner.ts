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
 * all, and keeps the source install behaving exactly as before. */
function resolveBiomeBin(): string | null {
  const candidates = [
    // 1. Our own node_modules. This is the source-install case and stays first, so a
    //    source install always uses the biome version pinned in our package.json.
    path.join(findProjectRoot(), "node_modules", ".bin", "biome"),
    // 2. The project being analysed. A React codebase that lints with biome already has it.
    path.join(process.cwd(), "node_modules", ".bin", "biome"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // 3. Anything on PATH — a global install, or a distro package.
  try {
    const onPath = Bun.which("biome");
    if (onPath) return onPath;
  } catch {
    // Bun.which is unavailable under plain Node; the candidates above are the answer there.
  }
  return null;
}

export async function runBiome(opts: RunBiomeOptions): Promise<Finding[]> {
  if (opts.files.length === 0) return [];
  const biomeBin = resolveBiomeBin();
  if (!biomeBin) {
    throw new Error(
      "biome executable not found. Looked in this package's node_modules, " +
        `${path.join(process.cwd(), "node_modules", ".bin", "biome")}, and on PATH.\n` +
        "  Source install:   bun install\n" +
        "  Compiled binary:  install biome in the project you are scanning " +
        "(bun add -d @biomejs/biome) or put it on PATH.",
    );
  }

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
