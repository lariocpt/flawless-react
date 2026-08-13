import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  ChildAttrInfo,
  ComponentInfo,
  ComponentTree,
  EffectFeatures,
  Finding,
  RunContext,
  SourcePosition,
  Task,
  TaskResult,
} from "../types.ts";

const MEMO_HOOKS = new Set(["useMemo", "useCallback", "memo", "useRef"]);
const CHILD_RERENDER_THRESHOLD = 3;
const MEMO_HOOK_NAMES = new Set(["useMemo", "useCallback"]);
const EFFECT_HOOK_NAMES = new Set(["useEffect", "useLayoutEffect"]);
const PLAIN_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MEMO_WRAPPED_NOTE = " — child is React.memo-wrapped; this prop defeats memoisation.";

/** Attr value kinds recreated on every render (new reference each time). */
const UNSTABLE_ATTR_KINDS = new Set<ChildAttrInfo["valueKind"]>([
  "object-literal",
  "array-literal",
  "arrow",
  "function",
]);
/** Attrs that are not regular props (memoisation-irrelevant or unanalysable). */
const NON_PROP_ATTRS = new Set(["key", "ref", "children", "...spread"]);
/** Attr value kinds that are referentially stable across parent rerenders. */
const STABLE_ATTR_KINDS = new Set<ChildAttrInfo["valueKind"]>([
  "string",
  "number",
  "boolean-true",
  "null",
  "member",
  "identifier",
]);

const ATTR_KIND_LABEL: Partial<Record<ChildAttrInfo["valueKind"], string>> = {
  "object-literal": "an inline object literal",
  "array-literal": "an inline array literal",
  arrow: "an inline arrow function",
  function: "an inline function expression",
};

interface PerfReport {
  component: string;
  file: string;
  findings: Finding[];
}

export const staticPerfAnalysis: Task = {
  id: "perf-static",
  label: "Static React perf analysis",
  description: "Surface rerender / memoisation / unresolved-prop risks from the parsed tree",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    const reportsDir = path.join(ctx.outDir, "reports");
    await mkdir(reportsDir, { recursive: true });
    const allFindings: Finding[] = [];
    const written: string[] = [];

    for (const tree of ctx.trees) {
      const report = analyseTree(tree);
      for (const finding of report.findings) allFindings.push(finding);
      const out = path.join(reportsDir, `${report.component}.perf-static.json`);
      await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
      written.push(out);
    }

    return {
      id: "perf-static",
      ok: true,
      outputs: written,
      findings: allFindings,
      summary: `static perf analysis: ${allFindings.length} finding(s) across ${ctx.trees.length} root(s)`,
    };
  },
};

export function analyseTree(tree: ComponentTree): PerfReport {
  const findings: Finding[] = [];
  walk(tree, findings);
  return {
    component: tree.entry.componentName,
    file: tree.entry.filePath,
    findings,
  };
}

function walk(node: ComponentTree, findings: Finding[]): void {
  inspect(node, findings);
  for (const c of node.children) walk(c, findings);
}

function inspect(node: ComponentTree, findings: Finding[]): void {
  const info = node.entry;
  const names = knownNamesOf(info);
  inspectMemoisation(info, node.children.length, findings);
  inspectUnresolvedProps(info, findings);
  inspectHookDeps(info, names, findings);
  inspectChildAttrs(node, names, findings);
  inspectRenderSetters(info, findings);
}

/** Names recoverable from a ComponentInfo alone — no AST scope is available here. */
interface KnownNames {
  propNames: Set<string>;
  stateVars: Set<string>;
  setterNames: Set<string>;
  refNames: Set<string>;
  memoResultNames: Set<string>;
}

function knownNamesOf(info: ComponentInfo): KnownNames {
  const propNames = new Set([...Object.keys(info.propsShape), ...info.unresolvedProps]);
  const stateVars = new Set<string>();
  const setterNames = new Set<string>();
  const refNames = new Set<string>();
  for (const s of info.state ?? []) {
    if (s.kind === "useRef") refNames.add(s.varName);
    else stateVars.add(s.varName);
    if (s.setterName) setterNames.add(s.setterName);
  }
  const memoResultNames = new Set<string>();
  for (const d of info.hookDetails ?? []) {
    if (d.resultName) memoResultNames.add(d.resultName);
  }
  return { propNames, stateVars, setterNames, refNames, memoResultNames };
}

function at(
  pos: SourcePosition | undefined,
  fallbackFile: string,
): Pick<Finding, "file" | "line" | "column"> {
  return pos
    ? { file: pos.file, line: pos.line, column: pos.column }
    : { file: fallbackFile, line: 1, column: 1 };
}

function inspectMemoisation(info: ComponentInfo, childCount: number, findings: Finding[]): void {
  const memoised =
    info.hooks.some((h) => MEMO_HOOKS.has(h)) || (info.wrappers ?? []).includes("memo");
  if (childCount < CHILD_RERENDER_THRESHOLD || memoised) return;
  findings.push({
    rule: "perf/no-memoisation-with-children",
    severity: "warn",
    ...at(info.pos, info.filePath),
    message:
      `${info.componentName} renders ${childCount} child component(s) but uses none of ` +
      `useMemo/useCallback/memo/useRef — every parent rerender will rerender all children.`,
    source: "perf-static",
  });
}

function inspectUnresolvedProps(info: ComponentInfo, findings: Finding[]): void {
  for (const u of info.unresolvedProps) {
    findings.push({
      rule: "perf/unresolved-prop",
      severity: "warn",
      ...at(info.propPositions?.[u] ?? info.pos, info.filePath),
      message: `${info.componentName}: could not synthesise a default for prop "${u}" — generated tests will pass undefined.`,
      source: "perf-static",
    });
  }
}

function inspectHookDeps(info: ComponentInfo, names: KnownNames, findings: Finding[]): void {
  const details = info.hookDetails;
  if (!details || details.length === 0) return;
  const exempt = new Set([...names.setterNames, ...names.refNames]);
  // Identifiers we can attribute confidently without a scope; derived locals
  // are deliberately excluded (too noisy from ComponentInfo alone).
  const trackable = new Set([...names.propNames, ...names.stateVars, ...names.memoResultNames]);

  for (const d of details) {
    // Bail: the extractor flagged this hook as unreliable to reason about.
    if (d.depsHasComplex || !d.callbackIsInline || d.readsBareParamsObject) continue;
    const where = at(d.pos, info.filePath);

    if (MEMO_HOOK_NAMES.has(d.name) && d.missingDepsArray) {
      findings.push({
        rule: "perf/hook-missing-deps-array",
        severity: "warn",
        ...where,
        message:
          `${info.componentName}: ${d.name} has no dependency array — it recomputes on ` +
          `every render, so the hook buys nothing.`,
        source: "perf-static",
      });
    }

    if (EFFECT_HOOK_NAMES.has(d.name) && d.missingDepsArray && d.effectFeatures) {
      const f = d.effectFeatures;
      if (f.fetch || f.setInterval || f.setTimeout || f.addEventListener) {
        findings.push({
          rule: "perf/effect-every-render",
          severity: "warn",
          ...where,
          message:
            `${info.componentName}: ${d.name} has no dependency array yet starts ` +
            `${effectFeatureList(f)} — it re-runs on every single render.`,
          source: "perf-static",
        });
      }
    }

    if (d.deps === undefined) continue;
    const plainDeps = new Set(d.deps.filter((x) => PLAIN_IDENTIFIER.test(x)));

    const missing = d.callbackReads.filter(
      (r) => !plainDeps.has(r) && !exempt.has(r) && trackable.has(r),
    );
    if (missing.length > 0) {
      const list = missing.map((m) => `"${m}"`).join(", ");
      findings.push({
        rule: "perf/hook-missing-dependency",
        severity: "warn",
        ...where,
        message:
          `${info.componentName}: ${d.name} reads ${list} but omits ` +
          `${missing.length === 1 ? "it" : "them"} from its deps — the callback closes over ` +
          `stale values (stale-closure risk).`,
        source: "perf-static",
      });
    }

    for (const dep of d.deps) {
      if (!PLAIN_IDENTIFIER.test(dep)) continue;
      if (!trackable.has(dep) || exempt.has(dep)) continue;
      if (d.callbackReads.includes(dep)) continue;
      findings.push({
        rule: "perf/hook-extraneous-dependency",
        severity: "warn",
        ...where,
        message:
          `${info.componentName}: ${d.name} lists "${dep}" in its deps but never reads it — ` +
          `the hook re-fires whenever "${dep}" changes, for no benefit.`,
        source: "perf-static",
      });
    }
  }
}

function effectFeatureList(f: EffectFeatures): string {
  const parts: string[] = [];
  if (f.fetch) parts.push("a fetch");
  if (f.setInterval) parts.push("setInterval");
  if (f.setTimeout) parts.push("setTimeout");
  if (f.addEventListener) parts.push("addEventListener");
  return parts.join(" + ");
}

function inspectChildAttrs(node: ComponentTree, names: KnownNames, findings: Finding[]): void {
  const info = node.entry;
  const attrs = info.childAttrs;
  if (!attrs) return;

  const childByTag = new Map<string, ComponentTree>();
  for (const c of node.children) {
    childByTag.set(c.entry.localTag ?? c.entry.componentName, c);
  }

  for (const a of attrs) {
    if (!UNSTABLE_ATTR_KINDS.has(a.valueKind)) continue;
    if (NON_PROP_ATTRS.has(a.attr)) continue;
    const childIsMemo = (childByTag.get(a.tag)?.entry.wrappers ?? []).includes("memo");
    const kind = ATTR_KIND_LABEL[a.valueKind] ?? "an unstable value";
    findings.push({
      rule: "perf/unstable-child-prop",
      severity: "warn",
      ...at(a.pos, info.filePath),
      message:
        `${info.componentName} passes ${kind} as "${a.attr}" to <${a.tag}> — a new reference ` +
        `on every render${childIsMemo ? MEMO_WRAPPED_NOTE : "."}`,
      source: "perf-static",
    });
  }

  if ((info.state?.length ?? 0) === 0) return;
  const stableIds = new Set([
    ...names.propNames,
    ...names.stateVars,
    ...names.setterNames,
    ...names.memoResultNames,
  ]);
  for (const c of node.children) {
    if (c.children.length !== 0) continue;
    if ((c.entry.wrappers ?? []).includes("memo")) continue;
    const tag = c.entry.localTag ?? c.entry.componentName;
    const childAttrs = attrs.filter((a) => a.tag === tag);
    // Only flag when every prop is provably stable; spreads, unstable kinds and
    // identifiers we cannot attribute all bail (zero-attr children qualify).
    const allStable = childAttrs.every(
      (a) =>
        a.valueKind !== "spread" &&
        STABLE_ATTR_KINDS.has(a.valueKind) &&
        (a.valueKind !== "identifier" ||
          (a.identifier !== undefined && stableIds.has(a.identifier))),
    );
    if (!allStable) continue;
    findings.push({
      rule: "perf/missing-memo-leaf",
      severity: "warn",
      ...at(childAttrs[0]?.pos ?? c.entry.pos, info.filePath),
      message:
        `<${tag}> is a leaf receiving only stable props from stateful ${info.componentName} ` +
        `but is not React.memo-wrapped — every state change rerenders it for nothing.`,
      source: "perf-static",
    });
  }
}

function inspectRenderSetters(info: ComponentInfo, findings: Finding[]): void {
  for (const s of info.state ?? []) {
    for (const call of s.setterCalls) {
      if (call.context !== "render" || call.guarded) continue;
      findings.push({
        rule: "perf/set-state-in-render",
        severity: "error",
        ...at(call.pos, info.filePath),
        message:
          `${info.componentName} calls ${s.setterName ?? `the "${s.varName}" setter`}() ` +
          `unguarded during render — this triggers an infinite re-render loop.`,
        source: "perf-static",
      });
    }
  }
}
