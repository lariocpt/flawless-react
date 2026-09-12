import type { RunContext, Task, TaskResult } from "../types.ts";
import { A11Y_REPORT, runNativeA11y } from "./a11yNative.ts";
import { runBiomeSweep } from "./biomeSweep.ts";

/** The sweep writes ONE aggregate, not one report per component. Exported so
 *  that anything pointing a reader at it cannot name a file that is never
 *  written — which is exactly what the inline sidecar used to do. Declared in
 *  a11yNative.ts (both engines write it); re-exported here, its historical
 *  import path. */
export { A11Y_REPORT } from "./a11yNative.ts";

export const a11yScan: Task = {
  id: "a11y",
  label: "Accessibility / web-standards scan",
  description: "Biome a11y rules over the targeted tree (file:line); native analyser under --expo",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    // The wave-3 shape: one TaskId, a sibling engine per platform. Biome cannot
    // be the native engine — all 29 rules below are HTML/ARIA, and over a React
    // Native tree they return zero while the offender fixture scores 3/3.
    if (ctx.expo) return runNativeA11y(ctx);
    return runBiomeSweep({
      id: "a11y",
      ctx,
      rules: biomeA11yRules(),
      categoryPrefix: "lint/a11y",
      aggregateFile: A11Y_REPORT,
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
