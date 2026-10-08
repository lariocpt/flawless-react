import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Make generated files conform to the HOST project's formatter so flawless
 * output never churns a target repo's lint/format state. Detection walks up
 * from the project root: biome config → run the project's own biome;
 * prettier config → run prettier; neither → leave files untouched.
 * Failures are warnings, never task failures.
 */

export interface AdoptStyleResult {
  formatter: "biome" | "prettier" | "none";
  formatted: number;
  warning?: string;
}

// .html is deliberately excluded: biome's HTML formatting is not stable enough
// to churn the emitted host/index.html.
const FORMATTABLE = /\.(tsx?|jsx?|mts|cts|mjs|cjs|jsonc?|css|md)$/;

export async function adoptProjectStyle(
  projectRoot: string,
  writtenFiles: string[],
): Promise<AdoptStyleResult> {
  const files = writtenFiles.filter((f) => FORMATTABLE.test(f) && existsSync(f));
  if (files.length === 0) return { formatter: "none", formatted: 0 };

  const biomeDir = findUp(projectRoot, ["biome.json", "biome.jsonc"]);
  if (biomeDir) {
    const bin = resolveLocalBin(biomeDir.dir, "biome") ?? Bun.which("biome");
    if (bin) {
      const proc = Bun.spawn([bin, "check", "--write", "--no-errors-on-unmatched", ...files], {
        cwd: biomeDir.dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code === 0 || code === 1) {
        // biome exits 1 when unfixable diagnostics remain — files are still formatted.
        return { formatter: "biome", formatted: files.length };
      }
      const stderr = await new Response(proc.stderr).text();
      return {
        formatter: "biome",
        formatted: 0,
        warning: `biome check --write exited ${code}: ${stderr.slice(0, 300)}`,
      };
    }
    return { formatter: "biome", formatted: 0, warning: "biome config found but no biome binary" };
  }

  const prettierDir = findUp(projectRoot, [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.js",
    ".prettierrc.cjs",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    "prettier.config.js",
    "prettier.config.cjs",
  ]);
  const hasPrettierConfig = prettierDir !== undefined || packageJsonHasPrettier(projectRoot);
  if (hasPrettierConfig) {
    const cwd = prettierDir?.dir ?? projectRoot;
    const bin = resolveLocalBin(cwd, "prettier") ?? Bun.which("prettier");
    const cmd = bin ? [bin] : ["bunx", "prettier"];
    // Ignore files govern the repo's sweeps, not the tool's own conformance pass.
    // prettier skips ignored files even when they are passed explicitly (proven on
    // 3.0.3), so once a run appends `flawless/` to the repo's .prettierignore the
    // format pass would silently stop formatting the suite it just wrote — and
    // any pre-existing repo ignore covering an output directory already had that
    // effect. An empty ignore path keeps the pass alive for exactly the files the
    // tool passed; the repo's own ignore still owns the repo's own sweeps.
    const ignoreOverride = path.join(os.tmpdir(), "flawless-empty.prettierignore");
    writeFileSync(ignoreOverride, "");
    const proc = Bun.spawn(
      [...cmd, "--write", "--ignore-unknown", "--ignore-path", ignoreOverride, ...files],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const code = await proc.exited;
    if (code === 0) return { formatter: "prettier", formatted: files.length };
    const stderr = await new Response(proc.stderr).text();
    return {
      formatter: "prettier",
      formatted: 0,
      warning: `prettier --write exited ${code}: ${stderr.slice(0, 300)}`,
    };
  }

  return { formatter: "none", formatted: 0 };
}

/** Detect a JSON file's indentation so merges preserve it (tabs beat spaces). */
export function detectJsonIndent(source: string): string {
  const m = source.match(/^(\t+|[ ]+)"/m);
  if (!m?.[1]) return "  ";
  return m[1].startsWith("\t") ? "\t" : " ".repeat(m[1].length);
}

/** Stringify preserving the original file's indentation and final newline. */
export function stringifyLike(original: string, value: unknown): string {
  const indent = detectJsonIndent(original);
  const trailingNewline = original.endsWith("\n") ? "\n" : "";
  return `${JSON.stringify(value, null, indent)}${trailingNewline}`;
}

function findUp(fromDir: string, names: string[]): { dir: string; file: string } | undefined {
  let dir = path.resolve(fromDir);
  for (;;) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return { dir, file: candidate };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveLocalBin(fromDir: string, name: string): string | undefined {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", ".bin", name);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function packageJsonHasPrettier(projectRoot: string): boolean {
  const found = findUp(projectRoot, ["package.json"]);
  if (!found) return false;
  try {
    const pkg = JSON.parse(readFileSync(found.file, "utf8")) as Record<string, unknown>;
    return pkg.prettier !== undefined;
  } catch {
    return false;
  }
}
