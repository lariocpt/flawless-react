import path from "node:path";
import { allocateSpecNames, flattenTrees } from "./scaffold-tests/registry.ts";
import type { ComponentTree } from "./types.ts";

/**
 * Which specs a set of edited files actually affects.
 *
 * Running 470 profile tests to check a change to three components is the wrong
 * unit of work, and the whole-app analysis that answers "which specs" costs
 * half a second — so narrowing the RUN is both possible and where the time is.
 * Generation is not narrowed: the profiling host is a single bundle of every
 * component, so a partial regeneration would produce a host that no longer
 * matches its specs.
 *
 * The part a path filter gets wrong is e2e. Editing a leaf `<StatusPill>`
 * changes every page that renders it, and those pages' files did not change.
 * The child walk already knows that relationship; this reads it back.
 */

export interface AffectedSpecs {
  /** Absolute paths of the changed source files that map to a component. */
  changedFiles: string[];
  /** Spec names (registry keys) for components declared in those files. */
  components: string[];
  /** Route stems whose page tree renders one of those components. */
  routes: string[];
  /** Components that changed but have no spec of their own. */
  withoutSpecs: string[];
}

/**
 * Files changed since `ref`, as absolute paths.
 *
 * Covers three states, because all three are "work you have not verified":
 * committed since the ref, modified in the worktree, and untracked-but-not-
 * ignored. A new component file is the case a plain `git diff` misses.
 */
export async function changedFiles(repoRoot: string, ref = "HEAD"): Promise<string[]> {
  const out = new Set<string>();
  const runs: string[][] = [
    ["diff", "--name-only", ref],
    ["diff", "--name-only", "--cached", ref],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  for (const args of runs) {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await proc.exited) !== 0) continue;
    const text = await new Response(proc.stdout).text();
    for (const line of text.split("\n")) {
      const rel = line.trim();
      if (rel) out.add(path.resolve(repoRoot, rel));
    }
  }
  return [...out].sort();
}

/** The repository root containing `from`, or undefined when it is not a git checkout. */
export async function findRepoRoot(from: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd: from,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) return undefined;
  const text = (await new Response(proc.stdout).text()).trim();
  return text || undefined;
}

/**
 * Map changed files onto the specs that cover them.
 *
 * `trees` must be the FULL analysis, not just the changed entries — the reverse
 * index below is the whole point, and it needs every page's children.
 */
export function affectedSpecs(trees: ComponentTree[], changed: readonly string[]): AffectedSpecs {
  const changedSet = new Set(changed.map((f) => path.resolve(f)));
  const flat = flattenTrees(trees);
  const specNames = allocateSpecNames(flat);

  const components: string[] = [];
  const withoutSpecs: string[] = [];
  const touchedFiles = new Set<string>();
  for (const c of flat) {
    if (!changedSet.has(path.resolve(c.info.filePath))) continue;
    touchedFiles.add(path.resolve(c.info.filePath));
    // Not exported means no spec imports it; it is covered through its parent.
    if (c.info.exportKind === "none") {
      withoutSpecs.push(c.info.componentName);
      continue;
    }
    components.push(specNames.get(c) as string);
  }

  // A page is affected when its tree renders a changed component anywhere,
  // which is not the same as the page's own file having changed.
  const routes: string[] = [];
  for (const tree of trees) {
    if (rendersAnyOf(tree, changedSet)) routes.push(tree.entry.filePath);
  }

  return {
    changedFiles: [...touchedFiles].sort(),
    components: [...new Set(components)].sort(),
    routes: [...new Set(routes)].sort(),
    withoutSpecs: [...new Set(withoutSpecs)].sort(),
  };
}

function rendersAnyOf(tree: ComponentTree, changed: ReadonlySet<string>): boolean {
  if (changed.has(path.resolve(tree.entry.filePath))) return true;
  for (const child of tree.children) {
    if (rendersAnyOf(child, changed)) return true;
  }
  return false;
}

/**
 * A Playwright `--grep` that matches exactly these components' tests.
 *
 * Every emitted title begins with the component's registry name and ": ", but
 * Playwright greps the whole title chain — `browser/Card.spec.ts › Card: mounts…`
 * — so `^` anchors against the file path and matches nothing. A word boundary
 * is what actually wants saying: `\bCard: ` selects "Card: mounts" and rejects
 * both "CardHeader: mounts" (no ": " after Card) and "MyCard: mounts" (no
 * boundary before it).
 */
export function grepFor(components: readonly string[]): string {
  // `(?!)` is the pattern that matches nothing at all. The obvious `$^` does
  // not: at position 0 of an empty string both anchors hold, so an untitled
  // test would slip through — and a grep that accidentally matches is how
  // "run nothing" becomes "run everything".
  if (components.length === 0) return "(?!)";
  const alt = components.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return `\\b(${alt}): `;
}
