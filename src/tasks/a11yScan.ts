import type { RunContext, Task, TaskResult } from "../types.ts";
import { runBiomeSweep } from "./biomeSweep.ts";

export const a11yScan: Task = {
  id: "a11y",
  label: "Accessibility / web-standards scan",
  description: "Biome a11y rules over the targeted tree (file:line)",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    return runBiomeSweep({
      id: "a11y",
      ctx,
      rules: biomeA11yRules(),
      categoryPrefix: "lint/a11y",
      aggregateFile: "a11y.json",
    });
  },
};

function biomeA11yRules(): unknown {
  return {
    recommended: false,
    a11y: {
      noAccessKey: "error",
      noAriaUnsupportedElements: "error",
      noAutofocus: "warn",
      noDistractingElements: "error",
      noHeaderScope: "error",
      noInteractiveElementToNoninteractiveRole: "error",
      noLabelWithoutControl: "warn",
      noNoninteractiveElementToInteractiveRole: "error",
      noNoninteractiveTabindex: "warn",
      noPositiveTabindex: "warn",
      noRedundantAlt: "warn",
      noRedundantRoles: "error",
      useAltText: "error",
      useAnchorContent: "error",
      useAriaActivedescendantWithTabindex: "error",
      useAriaPropsForRole: "error",
      useButtonType: "error",
      useFocusableInteractive: "warn",
      useHeadingContent: "error",
      useHtmlLang: "error",
      useIframeTitle: "error",
      useKeyWithClickEvents: "warn",
      useKeyWithMouseEvents: "warn",
      useMediaCaption: "warn",
      useValidAnchor: "warn",
      useValidAriaProps: "error",
      useValidAriaRole: "error",
      useValidAriaValues: "error",
      useValidLang: "error",
    },
  };
}
