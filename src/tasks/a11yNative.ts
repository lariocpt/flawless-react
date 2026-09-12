import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  VALID_ACCESSIBILITY_ROLES,
  VALID_ROLES,
  VECTOR_ICON_FAMILIES,
} from "../analyse/nativeProps.ts";
import type {
  ComponentInfo,
  ComponentTree,
  Finding,
  NativeA11yElement,
  RunContext,
  TaskResult,
} from "../types.ts";
import { findingsByComponent, groupFindingsByFile } from "./biomeSweep.ts";

/** The sweep writes ONE aggregate, not one report per component. Declared here
 *  and re-exported from a11yScan.ts (its historical home) so the web and native
 *  engines cannot disagree about the file the sidecar pointer names. */
export const A11Y_REPORT = "a11y.json";

/**
 * The native accessibility analyser — wave 5 of the Expo mode.
 *
 * Biome cannot be the native a11y engine: all 29 of the web task's rules are
 * HTML/ARIA, and over 31 React Native files carrying 82 unlabelled Pressables
 * they returned ZERO findings while finding 3/3 on the DOM offender fixture —
 * a clean report that meant "these rules do not apply", presented as coverage.
 * This module is the replacement: six rules over the a11y census the analysis
 * retains for native-dialect files (NativeA11yElement), judged at task time the
 * way perf-static judges retained ComponentInfo.
 *
 * Two structural properties matter more than any single rule:
 *
 *   - THE DENOMINATOR. The summary and the aggregate always carry how many
 *     press targets / text inputs / icons were examined and how many rules ran,
 *     so "0 findings" can never again be confused with "the rules do not apply".
 *   - ZERO FALSE POSITIVES over completeness. Every rule stands down where the
 *     source is not readable (a dynamic accessibilityLabel, a spread) — a miss
 *     costs coverage, a guess costs a false finding. The declined rules and the
 *     evidence live in docs/reviews/backlog.md's B-16 row.
 */
export const NATIVE_A11Y_RULES = [
  "a11y/unnamed-control",
  "a11y/missing-role",
  "a11y/textinput-unlabelled",
  "a11y/icon-unhidden",
  "a11y/label-text-mismatch",
  "a11y/invalid-role",
] as const;

export interface NativeA11yStats {
  /** Unique files behind native-dialect components — the filesScanned denominator. */
  nativeFiles: string[];
  /** Unique files behind dom-dialect components: counted and NAMED, never silently skipped. */
  domDialectFiles: string[];
  pressTargets: number;
  textInputs: number;
  icons: number;
}

const ICON_FAMILIES: ReadonlySet<string> = new Set(VECTOR_ICON_FAMILIES);

/**
 * Pure rule evaluation over the retained census, exported for the tests: the
 * mutation probes re-analyse a fixture and call this directly, so they stay
 * fast and ungated while still exercising the exact production path.
 */
export function nativeA11yFindings(trees: ComponentTree[]): {
  findings: Finding[];
  stats: NativeA11yStats;
} {
  const infos = collectComponents(trees);

  const nativeFiles = new Set<string>();
  const domFiles = new Set<string>();
  // Every component analysed out of a file carries the file's whole census
  // (the walk covers same-file siblings on purpose), so elements dedupe by
  // their own position before any counting or judging happens.
  const elements = new Map<string, NativeA11yElement>();
  for (const info of infos) {
    if (info.hostDialect === "native") {
      nativeFiles.add(path.resolve(info.filePath));
      for (const e of info.interactions?.a11yElements ?? []) {
        const key = `${e.pos.file}:${e.pos.line}:${e.pos.column}`;
        if (!elements.has(key)) elements.set(key, e);
      }
    } else {
      domFiles.add(path.resolve(info.filePath));
    }
  }

  const stats: NativeA11yStats = {
    nativeFiles: [...nativeFiles].sort(),
    domDialectFiles: [...domFiles].sort(),
    pressTargets: 0,
    textInputs: 0,
    icons: 0,
  };
  const findings: Finding[] = [];
  for (const e of elements.values()) {
    if (e.pressable) stats.pressTargets += 1;
    if (e.element === "TextInput") stats.textInputs += 1;
    if (ICON_FAMILIES.has(e.element)) stats.icons += 1;
    judge(e, findings);
  }
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.rule.localeCompare(b.rule),
  );
  return { findings, stats };
}

function judge(e: NativeA11yElement, out: Finding[]): void {
  const finding = (rule: string, severity: "error" | "warn", message: string): void => {
    out.push({
      rule,
      severity,
      file: e.pos.file,
      line: e.pos.line,
      column: e.pos.column,
      message,
      source: "a11y",
    });
  };

  // Only the PROVABLY nameless case: children that are all textless (the
  // iconOnly proof) or absent. A pressable rendering `{building.name}` DOES
  // announce at runtime, so label-absence there is not a finding — that
  // restraint is what keeps this rule at zero false positives.
  if (e.pressable && e.textless && !e.hints.ariaLabel && !e.dynamicLabel) {
    finding(
      "a11y/unnamed-control",
      "error",
      `<${e.element}> renders no text and carries no accessibilityLabel — it is silent ` +
        `to a screen reader and unaddressable to a spec. One accessibilityLabel retires both.`,
    );
  }

  // RN has no implicit roles: RNTL's getRole() reads the explicit prop, else
  // "text" for Text, else "none" — and the platforms announce accordingly. RN's
  // own <Button> is exempt for free: collectHints injects its one implicit role.
  if (e.pressable && e.hints.role === undefined && !e.dynamicRole) {
    finding(
      "a11y/missing-role",
      "error",
      `<${e.element}> has no accessibilityRole — TalkBack and VoiceOver announce its ` +
        `content without saying it can be activated. Add accessibilityRole="button" ` +
        `(or the role it actually plays).`,
    );
  }

  if (e.element === "TextInput" && !e.hints.ariaLabel && !e.dynamicLabel) {
    finding(
      "a11y/textinput-unlabelled",
      "error",
      e.hints.placeholder === undefined
        ? `<TextInput> has no accessibilityLabel and no placeholder — the field is announced as nothing at all.`
        : `<TextInput placeholder="${e.hints.placeholder}"> has no accessibilityLabel — a ` +
            `placeholder is not a label: it disappears on input and is not the field's accessible name.`,
    );
  }

  if (ICON_FAMILIES.has(e.element) && !e.hiddenFromA11y && !e.exemptAncestor) {
    finding(
      "a11y/icon-unhidden",
      "warn",
      `<${e.element}> is exposed to the accessibility tree with nothing to announce — a ` +
        `vector icon renders a private-use glyph. Add aria-hidden, or move it inside the ` +
        `labelled control it decorates.`,
    );
  }

  // WCAG 2.5.3 Label in Name: voice-control users say what they SEE, and an
  // accessibilityLabel that does not contain the visible text makes the visible
  // words a command that activates nothing.
  if (
    e.hints.ariaLabel !== undefined &&
    (e.label.kind === "text" || e.label.kind === "text-partial") &&
    !e.hints.ariaLabel.toLowerCase().includes(e.label.value.toLowerCase())
  ) {
    finding(
      "a11y/label-text-mismatch",
      "error",
      `accessibilityLabel "${e.hints.ariaLabel}" does not contain the visible text ` +
        `"${e.label.value}" — voice-control users say what they see, and saying it here ` +
        `activates nothing (WCAG 2.5.3).`,
    );
  }

  for (const { attr, value } of e.roleLiterals ?? []) {
    const valid = attr === "role" ? VALID_ROLES : VALID_ACCESSIBILITY_ROLES;
    if (!valid.has(value)) {
      finding(
        "a11y/invalid-role",
        "error",
        `${attr}="${value}" is not a value React Native recognises, so the platform ` +
          `announces no role at all — and the union widens with \`| string\`, so tsc ` +
          `cannot catch it either.`,
      );
    }
  }
}

/** The native engine behind the `a11y` task under --expo. */
export async function runNativeA11y(ctx: RunContext): Promise<TaskResult> {
  const reportsDir = path.join(ctx.outDir, "reports");
  await mkdir(reportsDir, { recursive: true });

  const { findings, stats } = nativeA11yFindings(ctx.trees);
  const byFile = groupFindingsByFile(findings);
  const written: string[] = [];

  const aggregatePath = path.join(reportsDir, A11Y_REPORT);
  const aggregate = {
    task: "a11y",
    engine: "native",
    filesScanned: stats.nativeFiles.length,
    findingCount: findings.length,
    // The denominator that makes 0 findings distinguishable from "the rules do
    // not apply" — the vacuous green this wave exists to kill.
    elementsExamined: {
      pressTargets: stats.pressTargets,
      textInputs: stats.textInputs,
      icons: stats.icons,
    },
    rulesApplied: [...NATIVE_A11Y_RULES],
    ...(stats.domDialectFiles.length > 0 ? { domDialectFilesNotSwept: stats.domDialectFiles } : {}),
    findingsByFile: Object.fromEntries(byFile),
  };
  await Bun.write(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
  written.push(aggregatePath);

  for (const owner of findingsByComponent(ctx.trees, byFile)) {
    const out = path.join(reportsDir, `${owner.tree.entry.componentName}.a11y.json`);
    const report = {
      component: owner.tree.entry.componentName,
      file: owner.tree.entry.filePath,
      findings: owner.findings,
    };
    await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
    written.push(out);
  }

  const denominator =
    `${stats.pressTargets} press target(s), ${stats.textInputs} text input(s), ` +
    `${stats.icons} icon(s) examined, ${NATIVE_A11Y_RULES.length} native rules`;
  const domNote =
    stats.domDialectFiles.length > 0
      ? `; ${stats.domDialectFiles.length} dom-dialect file(s) NOT swept — run without --expo for those`
      : "";
  return {
    id: "a11y",
    ok: true,
    outputs: written,
    findings,
    summary: `a11y: ${findings.length} finding(s) across ${stats.nativeFiles.length} file(s) — ${denominator}${domNote}`,
  };
}

function collectComponents(trees: ComponentTree[]): ComponentInfo[] {
  const infos: ComponentInfo[] = [];
  const visited = new Set<ComponentTree>();
  const seen = new Set<string>();
  const collect = (t: ComponentTree): void => {
    if (visited.has(t)) return;
    visited.add(t);
    const key = `${path.resolve(t.entry.filePath)}::${t.entry.componentName}`;
    if (!seen.has(key)) {
      seen.add(key);
      infos.push(t.entry);
    }
    for (const child of t.children) collect(child);
  };
  for (const tree of trees) collect(tree);
  return infos;
}
