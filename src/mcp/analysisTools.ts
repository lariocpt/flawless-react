// The read plane's analysis tools: the analyser and the static rules, run
// in-process over files they only OPEN.
//
// Why in-process: these are pure over the filesystem — no suite execution, no
// browser, no child — so an agent asking "what is this component, and what does
// the static engine say about it" gets an answer without paying for a process,
// and, more importantly, without any possibility of writing into the project.
// The same `analyseFile()` the generation tasks consume is what these call, so
// an answer here is the analyser's real answer, not a summary of it.
//
// Why `root` changes the working directory for the duration of a call (see
// withRoot): the glob engine and the default excludes match BOTH absolute and
// project-relative paths, and the analyser resolves tsconfig-based specifiers
// from the working directory. Running the call with `root` as cwd is what makes
// a tool answer match what the same command typed in that project would produce
// — the alternative, rewriting every pattern into an absolute one, silently
// weakens the excludes and would scan a target project's node_modules.

import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { analyseFile, createAnalyseSharedContext } from "../analyse/index.ts";
import { expandGlob } from "../core.ts";
import { detectExpo } from "../expo/detect.ts";
import { detectNextjs } from "../nextjs/detect.ts";
import { hasFlawlessSkills } from "../skills/data.ts";
import { EXPO_SCRIPT, NEXT_SCRIPT, SUITE_SCRIPT } from "../suiteScripts.ts";
import { analyseTree } from "../tasks/staticPerfAnalysis.ts";
import type { ComponentTree, RootMode } from "../types.ts";
import type { JsonObject, JsonValue } from "./protocol.ts";
import {
  DEFAULT_MAX_ENTRIES,
  MAX_ENTRIES_LIMIT,
  okJson,
  optBool,
  optEnum,
  optEnumArray,
  optInt,
  optStr,
  relativeTo,
  reqStr,
  requireKeys,
  resolveIn,
  rootArg,
  type ToolDef,
  ToolError,
} from "./support.ts";

const ROOT_MODES: readonly RootMode[] = ["primary", "exported"];
const SEVERITIES = ["error", "warn"] as const;

/** Run `fn` with the process working directory set to `root`.
 *
 *  Safe because the server serialises tool calls (one in flight, see server.ts)
 *  and restored in `finally` because a throw inside the call must not leave the
 *  next call — or the next project — reading a stranger's files. */
async function withRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new ToolError(`invalid "root": not a directory: ${root}`);
  }
  const prev = process.cwd();
  if (prev === root) return fn();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

/** One entry pattern → the files it selects, capped, with the cut ANNOUNCED. */
async function entryFiles(
  root: string,
  entry: string,
  max: number,
): Promise<{ files: string[]; matched: number; skipped: number }> {
  const abs = resolveIn(root, entry);
  // Prefer the project-relative spelling: that is the form the default excludes
  // are written against, and the form the CLI sees when a user runs the same glob.
  const rel = relativeTo(root, abs);
  const all = await expandGlob(rel === "" ? abs : rel);
  return { files: all.slice(0, max), matched: all.length, skipped: Math.max(0, all.length - max) };
}

/**
 * One component, described.
 *
 * Field-for-field the analyser's own vocabulary, with the bulky derivation
 * (variant tables, module import graphs, positions) left out and paths made
 * project-relative. Positions are kept where they are the actionable part — a
 * prop used at line 41 is a different fix from one used at line 8.
 */
function describeComponent(t: ComponentTree, root: string, nested = false): JsonObject {
  const e = t.entry;
  const out: JsonObject = {
    component: e.componentName,
    file: relativeTo(root, e.filePath),
    export_kind: e.exportKind ?? null,
    exported_as: e.exportedAs ?? null,
    host_element: e.hostElement ?? null,
    host_dialect: e.hostDialect ?? "dom",
    root_tag: e.rootTag ?? null,
    render_mode: e.renderMode ?? null,
    render_notes: e.renderNotes ?? [],
    render_guarded: e.renderGuarded ?? false,
    render_undecidable: e.renderUndecidable ?? false,
    error_boundary: e.errorBoundary ? { fallback_text: e.errorBoundary.fallbackText } : null,
    is_async: e.isAsync ?? false,
    is_client_component: e.isClientComponent ?? false,
    wrappers: e.wrappers ?? [],
    accepts_children: e.acceptsChildren ?? false,
    children_flow: e.childrenFlow ?? false,
    class_name_flow: e.classNameFlow ?? false,
    children_slotted: e.childrenSlotted ?? false,
    logs_errors: e.logsErrors ?? null,
    prop_names: Object.keys(e.propsShape ?? {}),
    prop_usage:
      e.propUsage?.map((u) => ({
        name: u.propName,
        kind: u.kind,
        line: u.pos.line,
        ...(u.tag ? { tag: u.tag } : {}),
        ...(u.attr ? { attr: u.attr } : {}),
        ...(u.hook ? { hook: u.hook } : {}),
        ...(u.member ? { member: u.member } : {}),
      })) ?? [],
    hooks: e.hooks,
    state:
      e.state?.map((s) => ({
        name: s.varName,
        kind: s.kind,
        type: s.typeKind,
        ...(s.setterName ? { setter: s.setterName } : {}),
        line: s.pos.line,
      })) ?? [],
    fetches: [...(e.fetchCalls ?? []), ...(e.apiCalls ?? [])].map((f) => ({
      method: f.method,
      url: f.urlTemplate,
      in_effect: f.inEffect,
      line: f.pos.line,
    })),
    guards:
      e.guards?.map((g) => ({
        effect: g.effect,
        callee: g.callee,
        condition: g.conditionRaw,
        condition_kind: g.conditionKind,
        line: g.pos.line,
      })) ?? [],
    unresolved_props: e.unresolvedProps,
    unresolved_types: e.unresolvedTypes ?? [],
    promise_props: e.promiseProps ?? [],
    static_text: (e.staticText ?? []).slice(0, 25),
    compound_family: e.compoundFamily ?? null,
    children: t.children.map((c) => ({
      component: c.entry.componentName,
      file: relativeTo(root, c.entry.filePath),
      render_mode: c.entry.renderMode ?? null,
      props: c.entry.unresolvedProps.length + Object.keys(c.entry.propsShape ?? {}).length,
    })),
    descendants: countDescendants(t),
  };
  if (nested) {
    out.children_trees = t.children.map((c) => describeComponent(c, root, false));
  }
  return out;
}

function countDescendants(t: ComponentTree): number {
  return t.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

/** Shared args of the two analysis tools, minus their own extras. */
const ANALYSIS_ARGS = [
  "entry",
  "root",
  "depth",
  "include_children",
  "roots",
  "max_entries",
] as const;

function analysisOptions(args: JsonObject, extra: readonly string[]) {
  requireKeys(args, [...ANALYSIS_ARGS, ...extra]);
  return {
    entry: reqStr(args, "entry"),
    root: rootArg(args),
    depth: optInt(args, "depth", 1, 20) ?? 3,
    includeChildren: optBool(args, "include_children") ?? true,
    roots: optEnum(args, "roots", ROOT_MODES),
    maxEntries: optInt(args, "max_entries", 1, MAX_ENTRIES_LIMIT) ?? DEFAULT_MAX_ENTRIES,
  };
}

function entrySchema(): JsonObject {
  return {
    type: "string",
    description:
      "Component file or glob, relative to `root` (absolute accepted). The default excludes apply, " +
      "so generated specs, stories and fixtures are skipped as they are on the command line.",
  };
}

const ROOT_SCHEMA: JsonObject = {
  type: "string",
  description:
    "Project directory this call reads. Every path argument resolves against it. Default: the " +
    "server's working directory.",
};

// ---------------------------------------------------------- flawless_analyse ----

const flawlessAnalyse: ToolDef = {
  name: "flawless_analyse",
  description:
    "What the analyser knows about a component: declared props and where each one is used, hooks, " +
    "state, fetch calls, render guards, the render path it could not decide, unresolved prop and " +
    "type names, the child tree, and the literal text it renders. This is the same analysis the " +
    "generator consumes, so it answers 'why did the generated spec look thin here' — an unresolved " +
    "prop type is exactly what --props fixes. Parses TypeScript; writes nothing and spawns nothing. " +
    "A glob is capped by max_entries and the cut is reported as entries_skipped.",
  inputSchema: {
    type: "object",
    properties: {
      entry: entrySchema(),
      root: ROOT_SCHEMA,
      depth: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Component-tree depth to follow. Default 3.",
      },
      include_children: {
        type: "boolean",
        description: "Follow JSX children to leaf content. Default true.",
      },
      roots: {
        type: "string",
        enum: [...ROOT_MODES],
        description:
          "exported describes every exported component in each file, not just the primary one.",
      },
      max_entries: {
        type: "integer",
        minimum: 1,
        maximum: MAX_ENTRIES_LIMIT,
        description: `Files to analyse in one call. Default ${DEFAULT_MAX_ENTRIES}, ceiling ${MAX_ENTRIES_LIMIT}.`,
      },
      full: {
        type: "boolean",
        description:
          "Include each child's own description, not just its name and file. Bigger output.",
      },
    },
    required: ["entry"],
    additionalProperties: false,
  },
  async run(args) {
    const o = analysisOptions(args, ["full"]);
    const full = optBool(args, "full") ?? false;
    return withRoot(o.root, async () => {
      const { files, skipped } = await entryFiles(o.root, o.entry, o.maxEntries);
      if (files.length === 0) {
        throw new ToolError(
          `no .tsx files matched "${o.entry}" under ${o.root} — a directory is not an entry; ` +
            `try a glob like "src/**/*.tsx"`,
        );
      }
      const shared = createAnalyseSharedContext();
      const components: JsonValue[] = [];
      const errors: JsonValue[] = [];
      for (const file of files) {
        try {
          const trees = await analyseFile(
            {
              entry: file,
              depth: o.depth,
              includeChildren: o.includeChildren,
              ...(o.roots ? { roots: o.roots } : {}),
            },
            shared,
          );
          for (const t of trees) components.push(describeComponent(t, o.root, full));
        } catch (err) {
          // Per file, and reported: one unreadable file in a 50-file glob must
          // not erase the other 49 answers, and must not be silent either.
          errors.push({ file: relativeTo(o.root, file), error: (err as Error).message });
        }
      }
      const out: JsonObject = {
        root: o.root,
        files_read: files.length,
        components,
        errors,
      };
      if (skipped > 0) {
        out.entries_skipped = skipped;
        out.note = `${skipped} file(s) beyond max_entries were not analysed — narrow the glob or raise max_entries`;
      }
      return okJson(out);
    });
  },
};

// --------------------------------------------------------- flawless_findings ----

const FINDINGS_ARGS = ["severities", "max_findings"] as const;
const DEFAULT_MAX_FINDINGS = 300;

const flawlessFindings: ToolDef = {
  name: "flawless_findings",
  description:
    "Run the static analysis engine (the perf-static task) over a file or glob and return its " +
    "findings as file:line records — missing memoisation, unstable child props, state that could " +
    "be derived, effects that could be handlers — plus the spec-quality count of props no fixture " +
    "could synthesise. Writes nothing: this is the report the task would file, without generating " +
    "a suite. NOT the whole picture: the a11y and react-rules tasks are separate engines (axe and " +
    "Biome) that run only in a real run, so zero findings here is not an accessible, lint-clean " +
    "component. Counts are per call and bounded by max_entries and max_findings, both announced.",
  inputSchema: {
    type: "object",
    properties: {
      entry: entrySchema(),
      root: ROOT_SCHEMA,
      depth: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "Component-tree depth to follow. Default 3.",
      },
      include_children: {
        type: "boolean",
        description: "Follow JSX children to leaf content. Default true.",
      },
      roots: {
        type: "string",
        enum: [...ROOT_MODES],
        description: "exported covers every export per file.",
      },
      max_entries: {
        type: "integer",
        minimum: 1,
        maximum: MAX_ENTRIES_LIMIT,
        description: `Files to analyse in one call. Default ${DEFAULT_MAX_ENTRIES}.`,
      },
      severities: {
        type: "array",
        items: { type: "string", enum: [...SEVERITIES] },
        description: "Only these severities. Default both.",
      },
      max_findings: {
        type: "integer",
        minimum: 1,
        maximum: 5000,
        description: `Findings to return before truncating. Default ${DEFAULT_MAX_FINDINGS}. Counts above it are still reported in full.`,
      },
    },
    required: ["entry"],
    additionalProperties: false,
  },
  async run(args) {
    const o = analysisOptions(args, FINDINGS_ARGS);
    const severities = optEnumArray(args, "severities", SEVERITIES);
    const maxFindings = optInt(args, "max_findings", 1, 5000) ?? DEFAULT_MAX_FINDINGS;
    return withRoot(o.root, async () => {
      const { files, skipped } = await entryFiles(o.root, o.entry, o.maxEntries);
      if (files.length === 0) {
        throw new ToolError(`no .tsx files matched "${o.entry}" under ${o.root}`);
      }
      const shared = createAnalyseSharedContext();
      const all: JsonValue[] = [];
      const specQuality: JsonValue[] = [];
      const errors: JsonValue[] = [];
      let total = 0;
      for (const file of files) {
        try {
          const trees = await analyseFile(
            {
              entry: file,
              depth: o.depth,
              includeChildren: o.includeChildren,
              ...(o.roots ? { roots: o.roots } : {}),
            },
            shared,
          );
          for (const t of trees) {
            const report = analyseTree(t);
            for (const f of report.findings) {
              total++;
              if (severities && !severities.includes(f.severity)) continue;
              all.push({
                rule: f.rule,
                severity: f.severity,
                file: relativeTo(o.root, f.file),
                line: f.line,
                column: f.column,
                message: f.message,
                component: report.component,
              });
            }
            if (report.specQuality.length > 0) {
              specQuality.push({
                component: report.component,
                file: relativeTo(o.root, report.file),
                // Emitted as the engine produced it. SpecQualityBucket is an
                // internal shape; re-deriving it here would be a second copy of
                // a contract that is allowed to change.
                gaps: report.specQuality as unknown as JsonValue,
              });
            }
          }
        } catch (err) {
          errors.push({ file: relativeTo(o.root, file), error: (err as Error).message });
        }
      }
      const byRule: Record<string, number> = {};
      const bySeverity: Record<string, number> = {};
      for (const f of all) {
        const o2 = f as { rule: string; severity: string };
        byRule[o2.rule] = (byRule[o2.rule] ?? 0) + 1;
        bySeverity[o2.severity] = (bySeverity[o2.severity] ?? 0) + 1;
      }
      const truncated = all.length > maxFindings;
      const out: JsonObject = {
        root: o.root,
        engine:
          "perf-static — static analysis of the component tree. The a11y (axe) and react-rules " +
          "(Biome) engines are separate and run only in a real run.",
        files_read: files.length,
        findings_total: total,
        findings_returned: truncated ? maxFindings : all.length,
        by_severity: bySeverity,
        by_rule: byRule,
        findings: truncated ? all.slice(0, maxFindings) : all,
        spec_quality: specQuality,
        errors,
      };
      if (truncated) {
        out.note = `${all.length - maxFindings} finding(s) beyond max_findings omitted from the list; findings_total counts them`;
      }
      if (skipped > 0) {
        out.entries_skipped = skipped;
      }
      return okJson(out);
    });
  },
};

// --------------------------------------------------- flawless_project_status ----

const STATUS_ARGS = ["root", "suite_dir", "max_files"] as const;

/** Directories no inventory should walk. Not a policy about projects — these are
 *  build and dependency trees, where the answer is always "thousands". */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  "out",
]);

interface Inventory {
  colocated_specs: number;
  todo_markers: number;
  todo_files: number;
  scanned_files: number;
  hit_limit: boolean;
}

/**
 * Walk the project counting generated specs and `TODO(flawless)` markers.
 *
 * This is the question an agent actually has after a run — "how much of this
 * suite is still hand-work" — and it is a bounded walk because a repo is not an
 * invitation to read every byte: `max_files` stops it and `hit_limit` says it did.
 */
function inventory(root: string, maxFiles: number): Inventory {
  const inv: Inventory = {
    colocated_specs: 0,
    todo_markers: 0,
    todo_files: 0,
    scanned_files: 0,
    hit_limit: false,
  };
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skipped, and the scan is still honest
    }
    for (const ent of entries) {
      if (inv.scanned_files >= maxFiles) {
        inv.hit_limit = true;
        return inv;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name === "flawless" || ent.name === ".flawless")
          continue;
        stack.push(full);
        continue;
      }
      if (!/\.(tsx|ts|jsx|js)$/.test(ent.name)) continue;
      inv.scanned_files++;
      const isSpec = /\.flawless\.test\.[tj]sx?$/.test(ent.name);
      if (isSpec) inv.colocated_specs++;
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const markers = text.split("TODO(flawless)").length - 1;
      if (markers > 0) {
        inv.todo_markers += markers;
        inv.todo_files++;
      }
    }
  }
  return inv;
}

/** What the suite directory holds, or that it does not exist. */
function suiteInventory(root: string, rel: string): JsonObject {
  const dir = resolveIn(root, rel);
  if (!existsSync(dir)) return { dir: rel, exists: false };
  const reportsDir = path.join(dir, "reports");
  let reports: string[] = [];
  if (existsSync(reportsDir)) {
    try {
      reports = readdirSync(reportsDir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      reports = [];
    }
  }
  const summaryFile = path.join(reportsDir, "summary.json");
  let lastRun: JsonValue = null;
  if (existsSync(summaryFile)) {
    try {
      // The last recorded run per task, which is the status an agent can act on.
      lastRun = JSON.parse(readFileSync(summaryFile, "utf8")) as JsonValue;
    } catch {
      lastRun = "reports/summary.json exists but is not valid JSON";
    }
  }
  let files = 0;
  try {
    files = readdirSync(dir).length;
  } catch {
    files = 0;
  }
  return {
    dir: rel,
    exists: true,
    entries: files,
    report_md: existsSync(path.join(dir, "REPORT.md")),
    reports,
    last_run: lastRun,
  };
}

function readPackage(root: string): JsonObject | null {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return {
      ...(pkg.name ? { name: pkg.name } : {}),
      scripts: Object.keys(pkg.scripts ?? {}).sort(),
      relevant_deps: Object.entries(deps)
        .filter(([k]) =>
          [
            "react",
            "react-dom",
            "next",
            "expo",
            "react-native",
            "expo-router",
            "playwright",
            "@playwright/test",
            "vitest",
            "jest-expo",
            "axe-core",
          ].includes(k),
        )
        .reduce<Record<string, string>>((acc, [k, v]) => {
          acc[k] = v;
          return acc;
        }, {}),
    };
  } catch {
    return { error: "package.json is not valid JSON" };
  }
}

const flawlessProjectStatus: ToolDef = {
  name: "flawless_project_status",
  description:
    "What is already true about a project before generating anything: framework detection (Next.js " +
    "router and API-route count, Expo SDK/router majors, React Compiler, NativeWind, the web port), " +
    "which suite directory exists and whether it has a REPORT.md and reports/*.json, the scripts a " +
    "suite of that mode is expected to have declared and which are missing, how many colocated " +
    "*.flawless.test.* specs there are and how many TODO(flawless) markers are still open, and " +
    "whether the agent skills are installed. Reads only, spawns nothing. Run it first: a run " +
    "without --force leaves an existing suite alone, and --force regenerates it wholesale.",
  inputSchema: {
    type: "object",
    properties: {
      root: {
        ...ROOT_SCHEMA,
        description: "Project directory to inspect. Default: the server's working directory.",
      },
      suite_dir: {
        type: "string",
        description:
          "Check this suite directory in addition to the mode defaults (flawless/, .flawless).",
      },
      max_files: {
        type: "integer",
        minimum: 1,
        maximum: 50000,
        description:
          "Stop the spec/TODO inventory after this many source files. Default 8000, and hit_limit is reported.",
      },
    },
    additionalProperties: false,
  },
  async run(args) {
    requireKeys(args, STATUS_ARGS);
    const root = rootArg(args);
    const maxFiles = optInt(args, "max_files", 1, 50000) ?? 8000;
    const extraSuite = optStr(args, "suite_dir");
    return withRoot(root, async () => {
      // Both detections are attempted and a refusal is data, not a failure: a
      // plain component library is neither, and the agent needs the same shape
      // either way. detectNextjs/detectExpo throw UsageError when the project is
      // not that framework — which is a normal answer here, not an error result.
      type Detected = { ok: true; facts: JsonObject } | { ok: false; reason: string };
      const detection = async (fn: () => Promise<JsonObject>): Promise<Detected> => {
        try {
          return { ok: true, facts: await fn() };
        } catch (err) {
          return { ok: false, reason: (err as Error).message };
        }
      };
      const nextRes = await detection(async () => {
        const ctx = await detectNextjs(root);
        return {
          router: ctx.router,
          app_resolver: ctx.appResolver ?? null,
          api_routes: ctx.apiRoutes.length,
        };
      });
      const expoRes = await detection(async () => {
        const ctx = await detectExpo(root);
        return {
          router_root: ctx.routerRoot ? relativeTo(root, ctx.routerRoot) : null,
          sdk_major: ctx.sdkMajor ?? null,
          router_major: ctx.routerMajor ?? null,
          react_compiler: ctx.reactCompiler,
          nativewind: ctx.nativewind,
          web_port: ctx.webPort,
        };
      });
      const next: JsonValue = nextRes.ok
        ? { ok: true, ...nextRes.facts }
        : { ok: false, reason: nextRes.reason };
      const expo: JsonValue = expoRes.ok
        ? { ok: true, ...expoRes.facts }
        : { ok: false, reason: expoRes.reason };
      const mode = expoRes.ok ? "expo" : nextRes.ok ? "nextjs" : "standalone";
      const scripts = expoRes.ok ? EXPO_SCRIPT : nextRes.ok ? NEXT_SCRIPT : SUITE_SCRIPT;
      const expected = Object.values(scripts);
      const pkg = readPackage(root);
      // In framework mode the TARGET's package.json carries the scripts, so they
      // are checkable here. A standalone suite keeps its own package.json inside
      // the suite directory, which `suites[].last_run` covers instead — claiming
      // "missing" from the project's scripts there would be a false finding.
      const scriptsHome = mode === "standalone" ? ".flawless/package.json" : "package.json";
      const pkgScripts = (pkg as { scripts?: Record<string, string> } | null)?.scripts ?? {};
      const declared = new Set<string>(Object.keys(pkgScripts));
      const suiteDirs = ["flawless", ".flawless", ...(extraSuite ? [extraSuite] : [])];
      return okJson({
        root,
        mode,
        package: pkg ?? null,
        nextjs: next,
        expo,
        expected_scripts: expected,
        scripts_declared_in: scriptsHome,
        scripts_missing: mode === "standalone" ? [] : expected.filter((s) => !declared.has(s)),
        suites: suiteDirs
          // Dedupe: `--suite flawless` names a directory the default list already has.
          .filter((d, i) => suiteDirs.indexOf(d) === i)
          .map((d) => suiteInventory(root, d)),
        // Spread, not the value itself: `Inventory` is an interface, so it has no
        // implicit index signature and is not a JsonValue. The literal is.
        inventory: { ...inventory(root, maxFiles) },
        skills_installed: hasFlawlessSkills(false, root) || hasFlawlessSkills(true, root),
      });
    });
  },
};

export const ANALYSIS_TOOLS: ToolDef[] = [flawlessAnalyse, flawlessFindings, flawlessProjectStatus];
