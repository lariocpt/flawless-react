import path from "node:path";
import { findRouterRoot, pageFileToRoute } from "./nextjs/routes.ts";
import { allocateSpecNames, flattenTrees } from "./scaffold-tests/registry.ts";
import { type ComponentTree, UsageError } from "./types.ts";

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
  /**
   * URL templates ("/things/[id]") of the pages whose tree renders one of
   * those components — the exact text the emitted e2e titles embed, so an e2e
   * --grep can be built from them (grepForRoutes).
   */
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
  // A ref git cannot resolve — a typo, or a ref absent from a shallow CI
  // clone — used to make every `git diff` exit nonzero, each skipped with a
  // bare `continue`. The run then reported "nothing affected" and exited 0:
  // a green result for a comparison that never happened.
  const inRepo = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await inRepo.exited) !== 0) {
    throw new UsageError(
      `--changed needs a git checkout: ${repoRoot} is not one. Run it inside the repository, or drop --changed to run the full suite.`,
    );
  }
  const check = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await check.exited) !== 0) {
    throw new UsageError(
      `git cannot resolve the ref "${ref}" in ${repoRoot}. Pass a ref that exists here (a shallow CI clone may not have it).`,
    );
  }
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
export function affectedSpecs(
  trees: ComponentTree[],
  changed: readonly string[],
  /**
   * Router context, so "route" means an actual page.
   *
   * Without it every affected tree was counted as a route — a leaf button in
   * src/components counted the same as app/dashboard/page.tsx — and the number
   * printed in the `changed:` line was simply wrong. Absent outside --nextjs,
   * where there are no e2e routes to narrow to.
   */
  nextjs?: { router: "app" | "pages"; root: string },
): AffectedSpecs {
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
  if (nextjs) {
    const routerRoot = findRouterRoot(nextjs.root);
    for (const tree of trees) {
      const route = pageFileToRoute(tree.entry.filePath, nextjs.router, routerRoot);
      if (!route) continue;
      if (rendersAnyOf(tree, changedSet)) routes.push(route.urlPath);
    }
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
  const alt = components.map(escapeRegex).join("|");
  return `\\b(${alt}): `;
}

/** Escape `s` so it matches only itself inside a RegExp alternation. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A Playwright `--grep` that matches exactly these routes' e2e specs.
 *
 * Every emitted e2e title embeds its route template — `GET /things/[id]
 * renders without console or page errors` — greppable only with the same
 * discipline as grepFor: no `^` (Playwright greps the whole title chain, so it
 * would anchor against the file path), the literal "GET " on the left, and the
 * title's following space on the right so `/a` does not also select `/ab`.
 * The brackets in a dynamic segment MUST be escaped: unescaped, `[id]` is a
 * character class matching single letters, not the literal text in the title.
 */
export function grepForRoutes(routes: readonly string[]): string {
  // `(?!)` matches nothing at all; an empty pattern would match everything.
  if (routes.length === 0) return "(?!)";
  const alt = routes.map(escapeRegex).join("|");
  return `\\bGET (${alt}) `;
}
