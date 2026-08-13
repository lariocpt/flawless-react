import { existsSync } from "node:fs";
import path from "node:path";
import { analyse } from "./analyse/index.ts";
import {
  detectComponentsGlob,
  detectNextjs,
  mergeIntoNextPackageJson,
  updateGitignore,
} from "./nextjs/detect.ts";
import { emitNextjsMocks } from "./nextjs/emit.ts";
import { fetchLiveSwagger, loadLocalSpec } from "./nextjs/liveSpec.ts";
import { ensureClientProviderWrapper, isUsableUnitProvider } from "./nextjs/providerWrapper.ts";
import { printFindings, writeInlineSummaries, writeSummaryJson } from "./reporters/findings.ts";
import { runGeneratedTests } from "./runner/runTests.ts";
import { adoptProjectStyle } from "./scaffold/adoptStyle.ts";
import { findTask } from "./tasks/index.ts";
import type {
  ComponentTree,
  NextjsApiRoute,
  NextjsContext,
  PropsShape,
  RunContext,
  Task,
  TaskId,
  TaskResult,
} from "./types.ts";

/** Recoverable input/configuration error — the CLI maps it to exit code 2. */
export class UsageError extends Error {}

export interface CoreOptions {
  /** Entry file path or glob. */
  pattern: string;
  outDir?: string;
  taskIds?: TaskId[];
  depth?: number;
  variants?: number;
  includeChildren?: boolean;
  force?: boolean;
  report?: boolean;
  propsOverride?: PropsShape;
  /** Explicit provider wrapper (.tsx default export). Used verbatim. */
  provider?: string;
  apiSpec?: string;
  inlineSummary?: boolean;
  /** Next.js project root; enables Next.js mode. */
  nextjs?: string;
  swaggerUrl?: string;
  colocate?: boolean;
  runTests?: boolean;
  /** Interactive confirm already happened (CLI); when false, runTests decides alone. */
  log?: boolean;
}

export interface CoreResult {
  exitCode: 0 | 1;
  outDir: string;
  results: TaskResult[];
  trees: ComponentTree[];
  nextjs: NextjsContext | undefined;
  /** Path of the provider wrapper actually used for unit specs, if any. */
  provider: string | undefined;
}

export async function runCore(opts: CoreOptions): Promise<CoreResult> {
  const log = (line: string): void => {
    if (opts.log !== false) process.stdout.write(`${line}\n`);
  };
  const warn = (line: string): void => {
    if (opts.log !== false) process.stderr.write(`${line}\n`);
  };

  let pattern: string | undefined = opts.pattern;
  let outDir = opts.outDir;
  const taskIds: TaskId[] =
    opts.taskIds === undefined || opts.taskIds.length === 0 ? ["perf-harness"] : opts.taskIds;

  let nextCtx: NextjsContext | undefined;
  let liveSpec: unknown;
  const providerExplicit = opts.provider !== undefined;
  let providerOverride = opts.provider;

  if (opts.nextjs !== undefined) {
    nextCtx = await detectNextjs(opts.nextjs); // throws UsageError-worthy Errors
    if (outDir === undefined) outDir = path.join(nextCtx.root, "flawless");
    if (providerOverride === undefined) providerOverride = nextCtx.appResolver;
    if (pattern === undefined) {
      const detected = detectComponentsGlob(nextCtx.root);
      if (detected) {
        pattern = detected;
        log(`nextjs: no entry passed — defaulting to ${path.relative(nextCtx.root, detected)}`);
      }
    }
    log(
      `nextjs: ${nextCtx.root} (router=${nextCtx.router}, api-routes=${nextCtx.apiRoutes.length}, app-resolver=${nextCtx.appResolver ?? "<none>"})`,
    );

    if (opts.swaggerUrl !== "off") {
      const live = await fetchLiveSwagger(opts.swaggerUrl);
      if (live.ok && live.routes) {
        mergeRoutes(nextCtx, live.routes);
        liveSpec = live.rawSpec;
        log(
          `nextjs: enriched routes from live OpenAPI at ${live.url} (paths=${live.routes.length})`,
        );
      } else if (opts.swaggerUrl !== undefined) {
        warn(
          `nextjs: live spec at ${live.url} unavailable (${live.error}); using static AST output`,
        );
      }
    }

    // A local OpenAPI file beats both the AST walk and the live spec — it is
    // the only reliable source when the API is a catch-all (Hono, tRPC, ...).
    if (opts.apiSpec !== undefined) {
      const local = await loadLocalSpec(opts.apiSpec);
      if (local) {
        mergeRoutes(nextCtx, local.routes);
        liveSpec = local.rawSpec;
        log(`nextjs: enriched routes from ${opts.apiSpec} (paths=${local.routes.length})`);
      } else {
        warn(`nextjs: could not parse ${opts.apiSpec} as OpenAPI JSON — ignoring`);
      }
    }

    // The auto-detected app resolver is usually an async server layout that
    // cannot run under jsdom — derive a client-safe wrapper instead. An
    // explicit --provider is respected verbatim (warn when it looks unusable).
    if (providerOverride !== undefined && !isUsableUnitProvider(providerOverride)) {
      if (providerExplicit) {
        warn(
          `provider: ${providerOverride} looks like a server component (async or server-only imports) — unit specs may fail under jsdom`,
        );
      } else {
        const wrapped = ensureClientProviderWrapper(nextCtx, outDir as string, providerOverride);
        if (wrapped) {
          providerOverride = wrapped.path;
          log(
            wrapped.created
              ? `nextjs: app resolver is a server layout — derived ${path.relative(nextCtx.root, wrapped.path)} (providers: ${wrapped.included.join(", ") || "none detected"})`
              : `nextjs: using existing ${path.relative(nextCtx.root, wrapped.path)}`,
          );
        }
      }
    }
  }

  if (pattern === undefined) {
    throw new UsageError(
      "missing entry path or glob. Pass a .tsx path, a glob, or run in a TTY for the interactive menu. See --help.",
    );
  }

  outDir = path.resolve(outDir ?? path.join(process.cwd(), ".flawless"));

  const files = await expandGlob(pattern);
  if (files.length === 0) {
    throw new UsageError(`no files matched: ${pattern}`);
  }

  const trees: ComponentTree[] = [];
  for (const file of files) {
    try {
      const tree = await analyse({
        entry: file,
        depth: opts.depth ?? 3,
        includeChildren: opts.includeChildren ?? true,
      });
      trees.push(tree);
    } catch (err) {
      warn(`warning: skipping ${file}: ${(err as Error).message}`);
    }
  }
  if (trees.length === 0) {
    throw new UsageError("no analysable components found");
  }

  const firstTree = trees[0];
  if (firstTree && opts.propsOverride) {
    firstTree.entry.propsShape = { ...firstTree.entry.propsShape, ...opts.propsOverride };
  }

  const selected = taskIds.map((id) => findTask(id)).filter((t): t is Task => Boolean(t));

  const ctx: RunContext = {
    trees,
    outDir,
    variants: opts.variants ?? 5,
    force: opts.force ?? false,
    report: opts.report ?? false,
    provider: providerOverride,
    apiSpec: opts.apiSpec,
    inlineSummary: opts.inlineSummary ?? true,
    json: false,
    nextjs: nextCtx,
    colocate: opts.colocate ?? false,
  };

  const results: TaskResult[] = [];
  let anyFailed = false;
  for (const task of selected) {
    try {
      const r = await task.run(ctx);
      results.push(r);
      if (!r.ok) anyFailed = true;
      if (opts.log !== false) printFindings(r.findings);
    } catch (err) {
      anyFailed = true;
      results.push({
        id: task.id,
        ok: false,
        outputs: [],
        findings: [],
        summary: "task threw",
        error: (err as Error).message,
      });
    }
  }

  if (nextCtx) {
    try {
      const nm = await emitNextjsMocks(nextCtx, outDir, { liveSpec });
      log(
        `nextjs: wrote ${nm.written.length} mock file(s) under ${path.relative(process.cwd(), outDir)}/mocks/`,
      );
      await mergeIntoNextPackageJson(
        nextCtx.root,
        {},
        {
          msw: "^2.6.0",
          vitest: "^2.1.0",
          jsdom: "^25.0.0",
          "@testing-library/react": "^16.0.0",
          "@testing-library/user-event": "^14.5.0",
          "@testing-library/jest-dom": "^6.5.0",
          "@playwright/test": "^1.49.0",
          "react-scan": "^0.4.3",
        },
        {
          "flawless:unit": opts.colocate
            ? `vitest run --config ${path.relative(nextCtx.root, outDir)}/vitest.config.ts`
            : `vitest run --root ${path.relative(nextCtx.root, outDir)}`,
          "flawless:perf": `playwright test --config ${path.relative(nextCtx.root, outDir)}/playwright.config.ts ${path.relative(nextCtx.root, outDir)}/tests`,
          "flawless:browser": `playwright test --config ${path.relative(nextCtx.root, outDir)}/browser/playwright.config.ts`,
          ...(taskIds.includes("e2e")
            ? {
                "flawless:e2e": `playwright test --config ${path.relative(nextCtx.root, outDir)}/e2e/playwright.config.ts`,
              }
            : {}),
          ...(taskIds.includes("load")
            ? {
                "flawless:load": `crust -c 'test-pipes --target ${path.relative(nextCtx.root, outDir)}/load/routes.pipes --timeout 60000'`,
              }
            : {}),
        },
      );
      log(
        `nextjs: merged dev deps + flawless:* scripts into ${path.join(nextCtx.root, "package.json")}`,
      );
      const added = updateGitignore(nextCtx.root, [
        "flawless/reports/",
        "flawless/heaps/",
        "flawless/playwright-report/",
        "flawless/node_modules/",
        "flawless/test-results/",
        "flawless/e2e/.auth.json",
        "*.flawless.json",
      ]);
      if (added.length > 0) {
        log(`nextjs: added ${added.length} entry(ies) to .gitignore (${added.join(", ")})`);
      }
    } catch (err) {
      anyFailed = true;
      warn(`nextjs emit failed: ${(err as Error).message}`);
    }
  }

  if (ctx.inlineSummary) {
    await writeInlineSummaries(trees, results, outDir);
  }
  await writeSummaryJson(outDir, results);

  // Format everything we wrote with the host project's own formatter so
  // generation never churns the target repo's lint/format state.
  const styleRoot = nextCtx?.root ?? outDir;
  const writtenFiles = [
    ...results.flatMap((r) => r.outputs),
    ...(providerOverride && providerOverride.startsWith(outDir) ? [providerOverride] : []),
  ];
  try {
    const adopted = await adoptProjectStyle(styleRoot, writtenFiles);
    if (adopted.formatter !== "none") {
      log(
        `style: formatted ${adopted.formatted} generated file(s) with the project's ${adopted.formatter}`,
      );
    }
    if (adopted.warning) warn(`style: ${adopted.warning}`);
  } catch (err) {
    warn(`style adoption failed (non-fatal): ${(err as Error).message}`);
  }

  if (
    !anyFailed &&
    opts.runTests === true &&
    selected.some((t) => t.id === "perf-harness" || t.id === "unit-browser" || t.id === "e2e")
  ) {
    await runGeneratedTests(
      outDir,
      selected.map((t) => t.id),
      nextCtx?.root,
    );
  }

  return {
    exitCode: anyFailed ? 1 : 0,
    outDir,
    results,
    trees,
    nextjs: nextCtx,
    provider: providerOverride,
  };
}

function mergeRoutes(nextCtx: NextjsContext, routes: NextjsApiRoute[]): void {
  const byPath = new Map(routes.map((r) => [r.path, r] as const));
  for (const ar of nextCtx.apiRoutes) {
    const match = byPath.get(ar.path);
    if (match) {
      ar.responseBodies = match.responseBodies;
      for (const m of match.methods) {
        if (!ar.methods.includes(m)) ar.methods.push(m);
      }
    }
  }
  for (const r of routes) {
    if (!nextCtx.apiRoutes.some((ar) => ar.path === r.path)) nextCtx.apiRoutes.push(r);
  }
}

export async function expandGlob(pattern: string): Promise<string[]> {
  const abs = path.resolve(pattern);
  if (existsSync(abs)) return [abs];
  const hasGlobChar = /[*?[\]{}]/.test(pattern);
  if (!hasGlobChar) {
    return [];
  }
  const glob = new Bun.Glob(pattern);
  const out: string[] = [];
  for await (const f of glob.scan({ cwd: process.cwd(), absolute: true })) {
    out.push(f);
  }
  return out.sort();
}
