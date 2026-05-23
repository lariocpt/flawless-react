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

export async function runBiome(opts: RunBiomeOptions): Promise<Finding[]> {
  if (opts.files.length === 0) return [];
  const projectRoot = findProjectRoot();
  const biomeBin = path.join(projectRoot, "node_modules", ".bin", "biome");
  if (!existsSync(biomeBin)) {
    throw new Error(`biome binary not found at ${biomeBin}. Run \`bun install\`.`);
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
    if (opts.categoryPrefix && !d.category?.startsWith(opts.categoryPrefix)) continue;
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
