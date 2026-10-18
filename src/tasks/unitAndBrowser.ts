import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ModuleResolver } from "../analyse/resolveModule.ts";
import { appPackageRoot } from "../packageJson.ts";
import { scaffoldUnitBrowser } from "../scaffold-tests/index.ts";
import { scaffoldNativeUnit } from "../scaffold-tests/nativeIndex.ts";
import { flattenTrees } from "../scaffold-tests/registry.ts";
import type { AliasEntry, MultiRootAlias, ReactExportShim } from "../scaffold-tests/templates.ts";
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
    // Expo runs the native plane instead of the DOM one. Not "as well as": the
    // DOM suite pointed at React Native emits specs that run, pass and touch
    // nothing, which is the one outcome this tool must never produce.
    if (ctx.expo) {
      const todos = new TodoCounter();
      const res = await scaffoldNativeUnit({
        trees: ctx.trees,
        outDir: ctx.outDir,
        expo: ctx.expo,
        force: ctx.force,
        todos,
      });
      for (const kept of res.kept) todos.drop(kept);
      const names = flattenTrees(ctx.trees).map((c) => c.info.componentName);
      const keptNote =
        res.kept.length > 0
          ? ` (${res.kept.length} write-once file(s) kept — delete one to regenerate it)`
          : "";
      return {
        id: "unit-browser",
        ok: true,
        outputs: res.written,
        findings: [],
        summary: `native unit specs for ${names.length} component(s)${keptNote}`,
        handWork: todos.toTallies(),
      };
    }

    const projectRoot = ctx.nextjs?.root;
    // Alias / react-pin anchor. A Next app is anchored at the app root; a
    // plain vite project has no such marker, but its tsconfig sits right next
    // to the analysed sources — anchor at each source directory and let
    // nearestConfig() walk up from there. Without this, non-Next specs lost
    // every tsconfig `paths` alias AND the shared-react pin, so `@/...`
    // imports failed to resolve and the suite crashed on dual React.
    const aliasRoots = ctx.nextjs
      ? [ctx.nextjs.root]
      : [...new Set(flattenTrees(ctx.trees).map((c) => path.dirname(c.info.filePath)))];
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
    // The shared-react anchor follows the SOURCES, not the suite directory.
    // Externalized deps (next-themes & co.) resolve "react" from the APP's
    // tree — node's require, no alias involved — so the alias must anchor at
    // that same physical copy or the app's libraries render with one React
    // while the suite renders with another ("Cannot read properties of null
    // (reading 'useContext')"). The suite's own copy would win this lookup
    // the moment it is installed, splitting the graph exactly there; the
    // harness closure (@testing-library, react, react-dom) is INLINED in the
    // vitest config instead, so its bare specifiers ride the alias too. An
    // app with no installed react falls through to the suite's copy, which
    // now carries the app's version pin.
    const pinFrom = ctx.nextjs ? ctx.nextjs.root : (aliasRoots[0] ?? ctx.outDir);
    const pinFallback = ctx.nextjs ? undefined : ctx.outDir;
    const aliasRes =
      aliasRoots.length > 0
        ? computeResolveAliases(aliasRoots, pinFrom, pinFallback)
        : { aliases: [] as AliasEntry[], multiRoot: [] as MultiRootAlias[] };
    // The react named-export shim (ReactExportShim): the app's own imports
    // scanned against its installed react's exports, filled only with what
    // Next's bundled copy proves to exist. Undefined for every app whose
    // imports the core already answers.
    const reactShim = detectCanaryReactExports(
      flattenTrees(ctx.trees).map((c) => c.info.filePath),
      nearestReactNodeModules(pinFrom) ??
        (pinFallback ? nearestReactNodeModules(pinFallback) : undefined),
    );
    const scaffoldOptions = {
      browserSpecs,
      trees: ctx.trees,
      outDir: ctx.outDir,
      variants: ctx.variants,
      mswSetup: ctx.nextjs !== undefined,
      nextjs: ctx.nextjs !== undefined,
      provider: ctx.provider,
      resolveAliases: aliasRes.aliases.length > 0 ? aliasRes.aliases : undefined,
      multiRootAliases: aliasRes.multiRoot.length > 0 ? aliasRes.multiRoot : undefined,
      // The single-React anchor: vitest aliases only reach code VITE loads,
      // so setup.ts redirects every NATIVE react/react-dom load (an
      // externalised @testing-library/react requires its peer-linked suite
      // copy otherwise — physically a second React, null dispatcher on every
      // mount) to this same pair.
      reactPinDir: aliasRes.pinDir,
      reactShim,
      // The app package's .env files for the emitted vitest config (server
      // modules read DATABASE_URL & co. at import time; unset env crashes
      // every importing spec at collection).
      appEnvRoot: ctx.nextjs
        ? ctx.nextjs.root
        : aliasRoots[0]
          ? appPackageRoot(aliasRoots[0])
          : undefined,
      colocate: ctx.colocate,
      force: ctx.force,
      apiRoutes: ctx.nextjs?.apiRoutes,
      providerWraps: ctx.providerWraps,
      todos,
    };
    const { written, skipped, keptEdited, keptLegacy, staleRemoved, staleKept } =
      await scaffoldUnitBrowser(scaffoldOptions);
    // Tallying happened while rendering, but a kept colocated spec's render
    // was discarded — its markers were never written this run, and may name
    // TODOs the user already resolved in the file the writer kept. All three
    // kept buckets discard their render, so all three retract their tallies.
    for (const kept of [...skipped, ...keptEdited, ...keptLegacy]) todos.drop(kept);
    // flattenTrees, not a raw walk: the same component appears in as many trees
    // as there are pages rendering it, and counting the walk reported "unit
    // tests for 606 component(s)" against an app the report itself says has 181.
    const names = flattenTrees(ctx.trees).map((c) => c.info.componentName);
    const skippedNote =
      skipped.length > 0
        ? ` (${skipped.length} colocated spec(s) kept — rerun with --force to regenerate)`
        : "";
    // Paths relative to where the user reads the summary from, capped so one
    // big app can't turn the summary line into a wall of text.
    const rel = (p: string): string => path.relative(projectRoot ?? process.cwd(), p) || p;
    const listKept = (paths: string[]): string => {
      const shown = paths.slice(0, 10).map(rel).join(", ");
      return paths.length > 10 ? `${shown}, +${paths.length - 10} more` : shown;
    };
    const editedNote =
      keptEdited.length > 0
        ? ` (${keptEdited.length} hand-edited or reformatted colocated spec(s) kept — delete to regenerate: ${listKept(keptEdited)})`
        : "";
    const legacyNote =
      keptLegacy.length > 0
        ? ` (${keptLegacy.length} pre-stamp colocated spec(s) kept — delete to regenerate: ${listKept(keptLegacy)})`
        : "";
    const staleRemovedNote =
      staleRemoved.length > 0
        ? ` (${staleRemoved.length} stale browser spec(s) removed — the component is no longer in the host: ${listKept(staleRemoved)})`
        : "";
    const staleKeptNote =
      staleKept.length > 0
        ? ` (${staleKept.length} stale browser spec(s) kept — the component is no longer in the host and the file is hand-edited or unprovable; delete to remove: ${listKept(staleKept.map((k) => k.abs))})`
        : "";
    const browserNote = browserSpecs
      ? ""
      : " (browser specs skipped — add perf-harness to the task list for the host they need)";
    const shimNote = reactShim
      ? ` (react shim: ${[...reactShim.components, ...reactShim.functions].join(", ")} from Next's bundled react@${reactShim.canaryVersion})`
      : "";
    // Notes before the name list: REPORT.md truncates each task summary at
    // 120 chars and the component list runs to thousands — a note appended
    // after it would exist only in summary.json and stdout, and the kept
    // listing is the one part of this line a user must act on.
    return {
      id: "unit-browser",
      ok: true,
      outputs: written,
      findings: [],
      summary: `unit tests for ${names.length} component(s)${skippedNote}${editedNote}${legacyNote}${staleRemovedNote}${staleKeptNote}${shimNote}${browserNote}: ${names.join(", ")}`,
      handWork: todos.toTallies(),
    };
  },
};

/**
 * vitest resolve.alias entries for a Next.js project: the tsconfig path
 * aliases, plus exact react/react-dom pins so a monorepo with several React
 * copies never pairs mismatched react + react-dom under jsdom.
 */
function computeResolveAliases(
  roots: string[],
  pinFrom?: string,
  pinFallback?: string,
): {
  aliases: AliasEntry[];
  multiRoot: MultiRootAlias[];
  pinDir?: string;
} {
  const entries: AliasEntry[] = [];
  const multiRoot: MultiRootAlias[] = [];
  const targets = new Map<string, string[]>();
  const resolver = new ModuleResolver();
  // A multi-package run may put sources under several tsconfigs; collect every
  // prefix's candidate targets first. One root → plain alias. Several roots
  // claiming the same prefix with DIFFERENT targets cannot collapse into the
  // one alias map vite offers — those become importer-aware plugin entries.
  for (const projectRoot of roots) {
    for (const p of resolver.aliasPatternsFor(projectRoot)) {
      if (p.exact || p.suffix !== "") continue;
      const target = p.targets[0];
      if (!target) continue;
      const dir = path.resolve(p.baseDir, target.replace(/\*.*$/, "")).replace(/\/+$/, "");
      const arr = targets.get(p.prefix);
      if (arr) {
        if (!arr.includes(dir)) arr.push(dir);
      } else targets.set(p.prefix, [dir]);
    }
  }
  for (const [prefix, dirs] of targets) {
    const only = dirs[0];
    if (dirs.length === 1 && only !== undefined)
      entries.push({ find: prefix, replacement: only, prefix: true });
    else multiRoot.push({ prefix, dirs });
  }

  // The shared-react pin. A Next suite runs on the repo's own vitest/RTL
  // stack, so it anchors at the app root. A non-Next standalone suite
  // anchors at the SOURCES' copy first (see the call site): externalized
  // deps resolve react from the app tree through plain node require, so
  // that copy is the one the whole graph must share. Only when the app
  // tree carries no react at all does pinFallback join — the suite's own
  // installed test stack, which is version-matched to the app by
  // detectAppReact. nearestReactNodeModules's preference (the dir that
  // carries @testing-library/react wins) keeps each leg honest.
  const nmDir =
    (pinFrom ? nearestReactNodeModules(pinFrom) : undefined) ??
    (pinFallback ? nearestReactNodeModules(pinFallback) : undefined);
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
    // pnpm's realpath layout escapes every request-level pin above. When
    // vitest INTERNALIZES a package (react-dom, testing-library — see the
    // deps.inline note in the vitest config), the package's own
    // require("react") runs from its realpath under
    // <nm>/.pnpm/<name>@<ver>/node_modules/<name>/ and resolves by plain
    // node rules — a second physical react beside the aliased one, same
    // version, separate dispatcher ("Cannot read properties of null
    // (reading 'useSyncExternalStore')"). A pattern against the RESOLVED
    // path is the only hook that sees those loads.
    const pnpmPin = (name: string): void => {
      const abs = path.join(nmDir, name);
      if (existsSync(abs))
        entries.push({
          find: `\\.pnpm/${name}@[^/]*/node_modules/${name}$`,
          replacement: abs,
          prefix: false,
          raw: true,
        });
    };
    pnpmPin("react");
    pnpmPin("react-dom");
  }
  // The anchor travels with the aliases: setup.ts needs the SAME directory to
  // pin the loads the aliases cannot reach (see ReactPinDir).
  return { aliases: entries, multiRoot, pinDir: nmDir };
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

/**
 * Detect React named exports the analysed sources import that the app's
 * installed react does not carry but the copy Next bundles does, and
 * describe the additive shim for them (ReactExportShim in
 * scaffold-tests/templates.ts explains why this is not a core swap).
 * Returns undefined when the core answers every import — the common case,
 * and the cheap exit. The scan is a regex over the import statements, not a
 * type-aware pass: only the set of names taken from the bare "react"
 * specifier matters. A name NEITHER react exports stays unfilled — that is
 * a genuine app bug and should fail the suite as loudly as it fails the
 * app.
 */
function detectCanaryReactExports(
  sourceFiles: string[],
  nmDir: string | undefined,
): ReactExportShim | undefined {
  if (!nmDir) return undefined;
  const imported = new Set<string>();
  // Default clause optional, `type` markers optional; braces capture every
  // name including multiline ones ([^}]* spans newlines).
  const importRe = /import\s+(?:type\s+)?[\w$]*\s*,?\s*\{([^}]*)\}\s*from\s*["']react["']/g;
  for (const file of sourceFiles) {
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(importRe)) {
      const clause = m[1] ?? "";
      for (const raw of clause.split(",")) {
        const first = raw
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0];
        const name = first?.trim() ?? "";
        if (/^[A-Za-z_$][\w$]*$/.test(name)) imported.add(name);
      }
    }
  }
  if (imported.size === 0) return undefined;
  const coreDir = path.join(nmDir, "react");
  const core = reactRuntimeExports(coreDir);
  if (!core || core.size === 0) return undefined;
  const missing = [...imported].filter((n) => !core.has(n));
  if (missing.length === 0) return undefined;
  // Evidence gate: fill only what the bundled copy actually exports, which
  // is what the app was compiled and ships against.
  const bundled = reactRuntimeExports(path.join(nmDir, "next", "dist", "compiled", "react"));
  if (!bundled) return undefined;
  const fills = missing.filter((n) => bundled.has(n));
  if (fills.length === 0) return undefined;
  const versionOf = (dir: string): string => {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        version?: string;
      };
      return pkg.version ?? "unknown";
    } catch {
      return "unknown";
    }
  };
  return {
    coreIndex: path.join(coreDir, "index.js"),
    coreVersion: versionOf(coreDir),
    canaryVersion: versionOf(path.join(nmDir, "next")),
    components: fills.filter((n) => /^[A-Z]/.test(n)),
    functions: fills.filter((n) => !/^[A-Z]/.test(n)),
  };
}

/** Runtime export names of a CommonJS react build, loaded from its directory. */
function reactRuntimeExports(reactDir: string): Set<string> | undefined {
  try {
    const req = createRequire(path.join(reactDir, "resolver.cjs"));
    const mod = req(path.join(reactDir, "index.js")) as Record<string, unknown>;
    return new Set(Object.keys(mod));
  } catch {
    return undefined;
  }
}
