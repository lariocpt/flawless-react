import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Make generated files conform to the HOST project's formatter so flawless
 * output never churns a target repo's lint/format state. Detection walks up
 * from the project root: biome config → run the project's own biome;
 * prettier config → run prettier; eslint config → run eslint --fix; none of
 * the three → leave files untouched. A host carrying several is formatted by
 * the first of the chain it carries, in that order.
 * Failures are warnings, never task failures.
 */

export interface AdoptStyleResult {
  formatter: "biome" | "prettier" | "eslint" | "none";
  formatted: number;
  warning?: string;
}

// eslint.config.* is the flat config; the .eslintrc* family is the legacy
// format. Flat is probed first because a host carrying both is linted by
// eslint's own flat-by-default resolution. The legacy list is shared with
// nextjs/detect.ts' ensureFormatterIgnores, which must decide from the SAME
// names whether a repo's .eslintignore is in force.
export const FLAT_ESLINT_CONFIG_NAMES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
];
export const ESLINTRC_CONFIG_NAMES = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.json5",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

// The extensions eslint can lint when passed explicitly. FORMATTABLE's
// .json/.css/.md have no processor in the default configs, and passing a
// file no config entry matches is a hard eslint error — so the eslint pass
// filters them out rather than letting one bad extension sink the whole run.
const JS_LINTABLE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;

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
    // Syntax the repo's pinned prettier predates - `with { type: "json" }`
    // import attributes need prettier 3.1, and the tool's specs use them.
    // Those files are still valid TS the app's own toolchain accepts; the
    // honest degrade is to skip THOSE and format the rest, not to abandon
    // the whole pass. (Repo CI never sees any of them: the ignore files
    // say so.)
    // Normalize both sides: prettier reports paths relative to its cwd,
    // while the caller's list may be absolute.
    const unparseable = new Set<string>();
    for (const m of stderr.matchAll(/^\[error\] (\S+):/gm)) {
      if (m[1] !== undefined) unparseable.add(path.resolve(cwd, m[1]));
    }
    if (/SyntaxError/.test(stderr) && unparseable.size > 0 && unparseable.size < files.length) {
      const rest = files.filter((f) => !unparseable.has(path.resolve(cwd, f)));
      if (rest.length > 0) {
        const retry = Bun.spawn(
          [...cmd, "--write", "--ignore-unknown", "--ignore-path", ignoreOverride, ...rest],
          { cwd, stdout: "pipe", stderr: "pipe" },
        );
        if ((await retry.exited) === 0) {
          return {
            formatter: "prettier",
            formatted: rest.length,
            warning: `prettier could not parse ${unparseable.size} generated file(s) - its version predates their syntax; the remaining ${rest.length} were formatted`,
          };
        }
      }
    }
    if (/SyntaxError/.test(stderr)) {
      return {
        formatter: "prettier",
        formatted: 0,
        warning: `prettier could not parse the generated files (its version predates their syntax) - style pass skipped: ${stderr.slice(0, 160)}`,
      };
    }
    return {
      formatter: "prettier",
      formatted: 0,
      warning: `prettier --write exited ${code}: ${stderr.slice(0, 300)}`,
    };
  }

  // eslint is last in the chain: a host that also carries biome or prettier is
  // formatted by the first of the chain it carries — the documented contract,
  // not a config preference.
  const eslintDir =
    findUp(projectRoot, FLAT_ESLINT_CONFIG_NAMES) ?? findUp(projectRoot, ESLINTRC_CONFIG_NAMES);
  const hasEslintConfig = eslintDir !== undefined || packageJsonHasEslint(projectRoot);
  if (hasEslintConfig) {
    const cwd = eslintDir?.dir ?? projectRoot;
    // eslint hard-errors on a file no config entry matches, and the default
    // configs carry no processor for FORMATTABLE's .json/.css/.md — so the
    // pass hands it only the JS family instead of letting one bad extension
    // sink the whole run.
    const jsFiles = files.filter((f) => JS_LINTABLE.test(f));
    if (jsFiles.length === 0) return { formatter: "none", formatted: 0 };
    // No `bunx` fallback (unlike prettier): a host eslint config is
    // version-sensitive — flat vs legacy resolution depends on the installed
    // major — and a floating registry install would lint with a different
    // parser than the repo's own CI. A missing binary degrades to a warning,
    // like the biome branch.
    const bin = resolveLocalBin(cwd, "eslint") ?? Bun.which("eslint");
    if (!bin) {
      return {
        formatter: "eslint",
        formatted: 0,
        warning: "eslint config found but no eslint binary",
      };
    }
    // --fix only, never --fix-suggestions: the pass must not apply
    // semantics-changing fixes. --no-ignore keeps the files the tool just
    // wrote out of the repo's own ignore lists — flat `ignores`, or a
    // .eslintignore that ensureFormatterIgnores appends the out dir to — so a
    // run's own suite is not silently skipped on the next pass.
    const proc = Bun.spawn([bin, "--fix", "--no-ignore", ...jsFiles], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code === 0 || code === 1) {
      // eslint exits 1 when unfixable errors remain — the pass still ran.
      return { formatter: "eslint", formatted: jsFiles.length };
    }
    const stderr = await new Response(proc.stderr).text();
    return {
      formatter: "eslint",
      formatted: 0,
      warning: `eslint --fix exited ${code}: ${stderr.slice(0, 300)}`,
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

function packageJsonHasEslint(projectRoot: string): boolean {
  const found = findUp(projectRoot, ["package.json"]);
  if (!found) return false;
  try {
    const pkg = JSON.parse(readFileSync(found.file, "utf8")) as Record<string, unknown>;
    return pkg.eslintConfig !== undefined;
  } catch {
    return false;
  }
}
