import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Finding, TaskId } from "../types.ts";

interface LintMessageLike {
  ruleId: string | null;
  severity: number;
  line: number;
  column: number;
  message: string;
  fatal?: boolean;
}

interface LintResultLike {
  filePath: string;
  messages: LintMessageLike[];
}

export interface RunEslintOptions {
  files: string[];
  source: TaskId;
  plugins: string[];
  rules: Record<string, "error" | "warn">;
}

export async function runEslint(opts: RunEslintOptions): Promise<Finding[]> {
  if (opts.files.length === 0) return [];
  const projectRoot = findProjectRoot();
  const eslintBin = path.join(projectRoot, "node_modules", ".bin", "eslint");
  if (!existsSync(eslintBin)) {
    throw new Error(`eslint binary not found at ${eslintBin}. Run \`bun install\`.`);
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "fhr-eslint-"));
  const configPath = path.join(tmp, "eslint.config.mjs");
  await writeFile(configPath, renderConfig(opts, projectRoot));

  const args = [
    "--config",
    configPath,
    "--no-config-lookup",
    "--no-warn-ignored",
    "--no-error-on-unmatched-pattern",
    "--format",
    "json",
    ...opts.files,
  ];

  const proc = Bun.spawn(["node", eslintBin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (!stdout.trim().startsWith("[")) {
    throw new Error(
      `eslint produced no JSON output. stderr:\n${stderr.slice(0, 2000)}\nstdout:\n${stdout.slice(0, 500)}`,
    );
  }

  const results = JSON.parse(stdout) as LintResultLike[];
  const findings: Finding[] = [];
  for (const r of results) {
    for (const m of r.messages) {
      if (m.fatal) {
        findings.push({
          rule: "parse-error",
          severity: "error",
          file: r.filePath,
          line: m.line ?? 1,
          column: m.column ?? 1,
          message: `parse failed: ${m.message}`,
          source: opts.source,
        });
        continue;
      }
      if (m.ruleId === null) continue;
      findings.push({
        rule: m.ruleId,
        severity: m.severity === 2 ? "error" : "warn",
        file: r.filePath,
        line: m.line,
        column: m.column,
        message: m.message,
        source: opts.source,
      });
    }
  }
  return findings;
}

function renderConfig(opts: RunEslintOptions, projectRoot: string): string {
  const nm = path.join(projectRoot, "node_modules");
  const parserUrl = pathToFileURL(resolvePackageEntry(path.join(nm, "@typescript-eslint", "parser"))).href;
  const pluginImports: string[] = [];
  const pluginEntries: string[] = [];
  for (const name of opts.plugins) {
    const pkg = pluginPackageName(name);
    const ident = name.replace(/[^a-zA-Z0-9_]/g, "_");
    const pkgPath = path.join(nm, pkg);
    const url = pathToFileURL(resolvePackageEntry(pkgPath)).href;
    pluginImports.push(`import ${ident} from ${JSON.stringify(url)};`);
    pluginEntries.push(`  ${JSON.stringify(name)}: ${ident},`);
  }
  const rulesJson = JSON.stringify(opts.rules);
  return `import tsParser from ${JSON.stringify(parserUrl)};
${pluginImports.join("\n")}

export default [
  {
    files: ["**/*.{ts,tsx,jsx,js,mjs,cjs}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
        ecmaVersion: "latest",
      },
    },
    plugins: {
${pluginEntries.join("\n")}
    },
    rules: ${rulesJson},
    settings: { react: { version: "detect" } },
  },
];
`;
}

function pluginPackageName(short: string): string {
  if (short === "jsx-a11y") return "eslint-plugin-jsx-a11y";
  if (short === "react") return "eslint-plugin-react";
  if (short === "react-hooks") return "eslint-plugin-react-hooks";
  return `eslint-plugin-${short}`;
}

function resolvePackageEntry(pkgDir: string): string {
  type Pkg = { main?: string; module?: string; exports?: unknown };
  let pkg: Pkg = {};
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as Pkg;
  } catch {
    pkg = {};
  }
  const exp = pkg.exports;
  if (exp && typeof exp === "object" && exp !== null) {
    const root = (exp as Record<string, unknown>)["."] ?? exp;
    const entry =
      typeof root === "string"
        ? root
        : typeof (root as Record<string, unknown>)?.import === "string"
          ? ((root as Record<string, unknown>).import as string)
          : typeof (root as Record<string, unknown>)?.default === "string"
            ? ((root as Record<string, unknown>).default as string)
            : typeof (root as Record<string, unknown>)?.require === "string"
              ? ((root as Record<string, unknown>).require as string)
              : undefined;
    if (entry) return path.resolve(pkgDir, entry);
  }
  if (pkg.module) return path.resolve(pkgDir, pkg.module);
  if (pkg.main) return path.resolve(pkgDir, pkg.main);
  return path.resolve(pkgDir, "index.js");
}

function findProjectRoot(): string {
  // Walk up from this file to find package.json with our name; fall back to cwd.
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
