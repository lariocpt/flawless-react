import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentTree, Finding, RunContext, Task, TaskResult } from "../types.ts";

export const eslintReactRules: Task = {
  id: "react-rules",
  label: "Functionally important React rules (Biome)",
  description: "Curated bug-catching React + hooks rules via Biome",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    const reportsDir = path.join(ctx.outDir, "reports");
    await mkdir(reportsDir, { recursive: true });
    const allFindings: Finding[] = [];
    const written: string[] = [];

    try {
      for (const tree of ctx.trees) {
        const files = collectFiles(tree);
        const findings = await runBiome(files);
        const out = path.join(reportsDir, `${tree.entry.componentName}.react-rules.json`);
        const report = {
          component: tree.entry.componentName,
          file: tree.entry.filePath,
          note: "Curated React correctness rules via Biome. Local biome.json is bypassed.",
          findings,
        };
        await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
        written.push(out);
        for (const f of findings) allFindings.push(f);
      }
    } catch (err) {
      return {
        id: "react-rules",
        ok: false,
        outputs: written,
        findings: allFindings,
        summary: "react-rules scan failed",
        error: (err as Error).message,
      };
    }

    return {
      id: "react-rules",
      ok: true,
      outputs: written,
      findings: allFindings,
      summary: `react-rules: ${allFindings.length} finding(s) across ${ctx.trees.length} component(s)`,
    };
  },
};

function collectFiles(tree: ComponentTree): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (t: ComponentTree): void => {
    if (seen.has(t.entry.filePath)) return;
    seen.add(t.entry.filePath);
    out.push(t.entry.filePath);
    for (const c of t.children) walk(c);
  };
  walk(tree);
  return out;
}

interface BiomeDiagnostic {
  severity?: string;
  message?: string;
  category?: string;
  location?: { path?: string; start?: { line?: number; column?: number } };
}

interface BiomeResult {
  diagnostics?: BiomeDiagnostic[];
}

async function runBiome(files: string[]): Promise<Finding[]> {
  if (files.length === 0) return [];
  const projectRoot = findProjectRoot();
  const biomeBin = path.join(projectRoot, "node_modules", ".bin", "biome");
  if (!existsSync(biomeBin)) {
    throw new Error(`biome binary not found at ${biomeBin}. Run \`bun install\`.`);
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "fhr-biome-"));
  const configPath = path.join(tmp, "biome.json");
  await writeFile(configPath, JSON.stringify(biomeConfig(), null, 2));

  const proc = Bun.spawn(
    [biomeBin, "lint", "--config-path", tmp, "--reporter=json", ...files],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    throw new Error(`biome produced no JSON output. stderr:\n${stderr.slice(0, 2000)}`);
  }
  let braceCount = 0;
  let jsonEnd = -1;
  let inStr = false;
  let escape = false;
  for (let i = jsonStart; i < stdout.length; i++) {
    const ch = stdout[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") braceCount++;
    else if (ch === "}") {
      braceCount--;
      if (braceCount === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }
  if (jsonEnd < 0) {
    throw new Error("biome JSON output appears truncated");
  }
  const parsed = JSON.parse(stdout.slice(jsonStart, jsonEnd)) as BiomeResult;
  const findings: Finding[] = [];
  const wantedFiles = new Set(files.map((f) => path.resolve(f)));
  for (const d of parsed.diagnostics ?? []) {
    const p = d.location?.path;
    if (!p) continue;
    if (!wantedFiles.has(path.resolve(p))) continue;
    findings.push({
      rule: d.category ?? "biome",
      severity: d.severity === "error" ? "error" : "warn",
      file: path.resolve(p),
      line: d.location?.start?.line ?? 1,
      column: d.location?.start?.column ?? 1,
      message: d.message ?? "",
      source: "react-rules",
    });
  }
  return findings;
}

function biomeConfig(): unknown {
  return {
    $schema: "https://biomejs.dev/schemas/2.4.15/schema.json",
    linter: {
      enabled: true,
      rules: {
        recommended: false,
        correctness: {
          noChildrenProp: "error",
          noConstAssign: "error",
          noConstantCondition: "error",
          noEmptyPattern: "error",
          noInvalidUseBeforeDeclaration: "error",
          noPrecisionLoss: "error",
          noRenderReturnValue: "error",
          noVoidElementsWithChildren: "error",
          noVoidTypeReturn: "error",
          useExhaustiveDependencies: "error",
          useHookAtTopLevel: "error",
          useIsNan: "error",
          useJsxKeyInIterable: "error",
          useValidForDirection: "error",
        },
        suspicious: {
          noArrayIndexKey: "warn",
          noAssignInExpressions: "error",
          noAsyncPromiseExecutor: "error",
          noCompareNegZero: "error",
          noConfusingVoidType: "warn",
          noControlCharactersInRegex: "error",
          noDoubleEquals: "warn",
          noDuplicateCase: "error",
          noDuplicateClassMembers: "error",
          noDuplicateJsxProps: "error",
          noDuplicateObjectKeys: "error",
          noDuplicateParameters: "error",
          noEmptyBlockStatements: "warn",
          noExplicitAny: "warn",
          noExtraNonNullAssertion: "warn",
          noFallthroughSwitchClause: "error",
          noGlobalIsFinite: "error",
          noGlobalIsNan: "error",
          noImplicitAnyLet: "warn",
          noLabelVar: "error",
          noMisleadingCharacterClass: "error",
          noMisleadingInstantiator: "error",
        },
      },
    },
  };
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
