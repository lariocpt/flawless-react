import type { RunContext, Task, TaskResult } from "../types.ts";
import { runBiomeSweep } from "./biomeSweep.ts";

export const eslintReactRules: Task = {
  id: "react-rules",
  label: "Functionally important React rules (Biome)",
  description: "Curated bug-catching React + hooks rules via Biome",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    return runBiomeSweep({
      id: "react-rules",
      ctx,
      rules: reactRules(),
      aggregateFile: "react-rules.json",
      note: "Curated React correctness rules via Biome. Local biome.json is bypassed.",
    });
  },
};

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
