import { existsSync } from "node:fs";
import path from "node:path";
import { ModuleResolver } from "../analyse/resolveModule.ts";
import { scaffoldUnitBrowser } from "../scaffold-tests/index.ts";
import { flattenTrees } from "../scaffold-tests/registry.ts";
import type { AliasEntry } from "../scaffold-tests/templates.ts";
import type { RunContext, Task, TaskResult } from "../types.ts";
import { TodoCounter } from "../types.ts";

export const unitAndBrowser: Task = {
  id: "unit-browser",
  label: "Generate React unit + browser tests",
  description: "Vitest + @testing-library/react units, Playwright functional browser specs",
  needsTree: true,
  async run(ctx: RunContext): Promise<TaskResult> {
    if (ctx.trees.length === 0) {
      return {
        id: "unit-browser",
        ok: false,
        outputs: [],
        findings: [],
        summary: "no components to scaffold",
        error: "no components",
      };
    }
    const projectRoot = ctx.nextjs?.root;
    // Browser specs drive the perf-harness host; emitting them without it
    // would hand the user a suite that cannot start.
    const browserSpecs =
      ctx.selectedTasks === undefined || ctx.selectedTasks.includes("perf-harness");
    // Tallies the TODO(flawless) markers the templates plant, counted at each
    // emission site — never by grepping the emitted text (see TodoCounter).
    // The collector travels inside the options object: scaffoldUnitBrowser
    // hands that object to renderUnitBrowser verbatim, whose options type
    // declares `todos`. Built as a variable, not an inline literal, so the
    // extra property passes the excess-property check; todoCounts.test.ts pins
    // the passthrough end to end, because a rebuild of the object anywhere on
    // the path would silently drop the counter and report zero debt.
    const todos = new TodoCounter();
    const scaffoldOptions = {
      browserSpecs,
      trees: ctx.trees,
      outDir: ctx.outDir,
      variants: ctx.variants,
      skipInnerPackageJson: ctx.nextjs !== undefined,
      mswSetup: ctx.nextjs !== undefined,
      provider: ctx.provider,
      resolveAliases: projectRoot ? computeResolveAliases(projectRoot) : undefined,
      colocate: ctx.colocate,
      force: ctx.force,
      apiRoutes: ctx.nextjs?.apiRoutes,
      todos,
    };
    const { written, skipped } = await scaffoldUnitBrowser(scaffoldOptions);
    // Tallying happened while rendering, but a skipped colocated spec's render
    // was discarded — its markers were never written this run, and may name
    // TODOs the user already resolved in the file the writer kept.
    for (const kept of skipped) todos.drop(kept);
    // flattenTrees, not a raw walk: the same component appears in as many trees
    // as there are pages rendering it, and counting the walk reported "unit
    // tests for 606 component(s)" against an app the report itself says has 181.
    const names = flattenTrees(ctx.trees).map((c) => c.info.componentName);
    const skippedNote =
      skipped.length > 0
        ? ` (${skipped.length} colocated spec(s) kept — rerun with --force to regenerate)`
        : "";
    const browserNote = browserSpecs
      ? ""
      : " (browser specs skipped — add perf-harness to the task list for the host they need)";
    return {
      id: "unit-browser",
      ok: true,
      outputs: written,
      findings: [],
      summary: `unit tests for ${names.length} component(s): ${names.join(", ")}${skippedNote}${browserNote}`,
      handWork: todos.toTallies(),
    };
  },
};

/**
 * vitest resolve.alias entries for a Next.js project: the tsconfig path
 * aliases, plus exact react/react-dom pins so a monorepo with several React
 * copies never pairs mismatched react + react-dom under jsdom.
 */
function computeResolveAliases(projectRoot: string): AliasEntry[] {
  const entries: AliasEntry[] = [];
  const resolver = new ModuleResolver();
  for (const p of resolver.aliasPatternsFor(projectRoot)) {
    if (p.exact || p.suffix !== "") continue;
    const target = p.targets[0];
    if (!target) continue;
    const dir = path.resolve(p.baseDir, target.replace(/\*.*$/, "")).replace(/\/+$/, "");
    entries.push({ find: p.prefix, replacement: dir, prefix: true });
  }

  const nmDir = nearestReactNodeModules(projectRoot);
  if (nmDir) {
    const pin = (spec: string, rel: string): void => {
      const abs = path.join(nmDir, rel);
      if (existsSync(abs)) entries.push({ find: spec, replacement: abs, prefix: false });
    };
    pin("react/jsx-runtime", "react/jsx-runtime.js");
    pin("react/jsx-dev-runtime", "react/jsx-dev-runtime.js");
    pin("react-dom/client", "react-dom/client.js");
    pin("react-dom/test-utils", "react-dom/test-utils.js");
    // The document-root specs render through react-dom/server. Pinning every
    // other react-dom subpath but not this one is worse than pinning none: the
    // spec's React is the aliased copy while its renderer is a second one, so
    // the SSR hook dispatcher is set on an instance the component cannot see and
    // every hook call fails with "Cannot read properties of null".
    pin("react-dom/server", "react-dom/server.js");
    pin("react-dom/server.browser", "react-dom/server.browser.js");
    pin("react-dom", "react-dom");
    pin("react", "react");
  }
  return entries;
}

/**
 * The node_modules whose react pair the whole suite should share. Prefer the
 * dir that ALSO carries @testing-library/react: hoisted monorepos put the
 * test stack at the workspace root, and its CJS require() will always find
 * that root pair — so aliasing sources to any other copy guarantees the
 * dual-React invalid-hook-call crash.
 */
function nearestReactNodeModules(fromDir: string): string | undefined {
  let fallback: string | undefined;
  let dir = path.resolve(fromDir);
  for (;;) {
    const nm = path.join(dir, "node_modules");
    if (existsSync(path.join(nm, "react")) && existsSync(path.join(nm, "react-dom"))) {
      if (existsSync(path.join(nm, "@testing-library", "react"))) return nm;
      fallback ??= nm;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}
