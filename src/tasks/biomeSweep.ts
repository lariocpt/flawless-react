import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ComponentTree, Finding, RunContext, TaskId, TaskResult } from "../types.ts";
import { runBiome } from "./biomeRunner.ts";

export interface BiomeSweepOptions {
  id: TaskId;
  ctx: RunContext;
  /** Biome flat rule config under linter.rules. */
  rules: unknown;
  /** Forwarded to runBiome; a11y filters to "lint/a11y", react-rules does not filter. */
  categoryPrefix?: string;
  /** Basename of the single aggregate report, e.g. "a11y.json". */
  aggregateFile: string;
  /** Free-text note copied into every report this task writes. */
  note?: string;
}

/** Every source file reachable from a single tree, absolute and deduped, entry first. */
export function treeFilePaths(tree: ComponentTree): string[] {
  const out: string[] = [];
  collectInto(tree, out, new Set<string>(), new Set<ComponentTree>());
  return out;
}

/** Every source file reachable from *all* trees, absolute and deduped.
 *
 * Deduping across trees (rather than per tree) is the whole point: in a whole-app sweep
 * the same leaf component is imported by dozens of roots, so a per-tree file list lints
 * shared files once per importer. Paths are resolved before comparison so two trees that
 * reached the same file by different spellings collapse to one entry. */
export function dedupeTreeFiles(trees: ComponentTree[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<ComponentTree>();
  for (const tree of trees) collectInto(tree, out, seen, visited);
  return out;
}

/** Findings keyed by absolute file path, in first-seen order. */
export function groupFindingsByFile(findings: Finding[]): Map<string, Finding[]> {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = path.resolve(f.file);
    const list = byFile.get(key);
    if (list) list.push(f);
    else byFile.set(key, [f]);
  }
  return byFile;
}

export interface ComponentFindings {
  tree: ComponentTree;
  findings: Finding[];
}

/** Trees that own at least one finding, with the findings from their whole subtree.
 *
 * Attribution is by file, not by component, because a file's diagnostics belong to every
 * component analysed out of it — two roots declared in one file both want to see them.
 * Trees with nothing to report are dropped here rather than at the write site, so the
 * "no findings, no report" rule is testable without running biome. */
export function findingsByComponent(
  trees: ComponentTree[],
  byFile: Map<string, Finding[]>,
): ComponentFindings[] {
  const out: ComponentFindings[] = [];
  for (const tree of trees) {
    const findings: Finding[] = [];
    for (const file of treeFilePaths(tree)) {
      const list = byFile.get(file);
      if (list) findings.push(...list);
    }
    if (findings.length > 0) out.push({ tree, findings });
  }
  return out;
}

/** Lint every file behind every tree in one biome process, then fan the findings back out
 *  to the components that own each file. */
export async function runBiomeSweep(opts: BiomeSweepOptions): Promise<TaskResult> {
  const { ctx, id } = opts;
  const reportsDir = path.join(ctx.outDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const files = dedupeTreeFiles(ctx.trees);

  let findings: Finding[];
  try {
    // One process for the entire sweep. This used to be a per-tree loop, which on a
    // whole-app run (~175 trees) spawned ~175 biome processes per task. Passing the file
    // set as argv is safe at that size: ~100 absolute paths is a few KB, three orders of
    // magnitude under ARG_MAX, so do not "optimise" this back into batches.
    findings = await runBiome({
      files,
      source: id,
      rules: opts.rules,
      categoryPrefix: opts.categoryPrefix,
    });
  } catch (err) {
    return {
      id,
      ok: false,
      outputs: [],
      findings: [],
      summary: `${id} scan failed`,
      error: (err as Error).message,
    };
  }

  const byFile = groupFindingsByFile(findings);
  const written: string[] = [];

  const aggregatePath = path.join(reportsDir, opts.aggregateFile);
  const aggregate = {
    task: id,
    ...(opts.note ? { note: opts.note } : {}),
    filesScanned: files.length,
    findingCount: findings.length,
    findingsByFile: Object.fromEntries(byFile),
  };
  await Bun.write(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
  written.push(aggregatePath);

  // Per-component reports only for components that actually have something to report.
  // A whole-app sweep covers ~175 components; a near-empty JSON for each of them buries
  // the handful that matter, and the aggregate above already answers "was it scanned?".
  for (const owner of findingsByComponent(ctx.trees, byFile)) {
    const out = path.join(reportsDir, `${owner.tree.entry.componentName}.${id}.json`);
    const report = {
      component: owner.tree.entry.componentName,
      file: owner.tree.entry.filePath,
      ...(opts.note ? { note: opts.note } : {}),
      findings: owner.findings,
    };
    await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
    written.push(out);
  }

  return {
    id,
    ok: true,
    outputs: written,
    findings,
    summary: `${id}: ${findings.length} finding(s) across ${files.length} file(s)`,
  };
}

function collectInto(
  tree: ComponentTree,
  out: string[],
  seen: Set<string>,
  visited: Set<ComponentTree>,
): void {
  // Two guards, because they answer different questions. `visited` stops runaway recursion
  // if a caller ever hands us a tree whose children loop back; `seen` dedupes paths without
  // pruning the walk, since a file already reached through one root can still be the only
  // route to children another root has not seen yet.
  if (visited.has(tree)) return;
  visited.add(tree);
  const file = path.resolve(tree.entry.filePath);
  if (!seen.has(file)) {
    seen.add(file);
    out.push(file);
  }
  for (const child of tree.children) collectInto(child, out, seen, visited);
}
