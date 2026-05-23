import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ComponentTree, Finding, RunContext, Task, TaskResult } from "../types.ts";
import { runBiome } from "./biomeRunner.ts";

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
        const findings = await runBiome({
          files,
          source: "react-rules",
          rules: reactRules(),
        });
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

function reactRules(): unknown {
  return {
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
  };
}
