import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { analyseFile, createAnalyseSharedContext } from "./analyse/index.ts";
import { affectedSpecs, changedFiles, findRepoRoot } from "./changed.ts";
import { outDirRel, underOutDir } from "./emitPaths.ts";
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
import { type UnparseableFile, writeReportMarkdown } from "./reporters/report.ts";
import { runAffectedTests, runGeneratedTests } from "./runner/runTests.ts";
import { adoptProjectStyle } from "./scaffold/adoptStyle.ts";
import { restampGenerated } from "./scaffold-tests/stamp.ts";
import { NEXT_SCRIPT, VITEST_CONFIG } from "./suiteScripts.ts";
import { findTask, TASKS } from "./tasks/index.ts";
import type {
  ComponentTree,
  HeapMode,
  NextjsApiRoute,
  NextjsContext,
  PropsShape,
  RootMode,
  RunContext,
  Task,
  TaskId,
  TaskResult,
} from "./types.ts";

import { UsageError } from "./types.ts";

// Re-exported so `import { UsageError } from "…/core.ts"` keeps working — the
// class moved to types.ts so leaf modules can throw it without a cycle.
export { UsageError };

export interface CoreOptions {
  /** Entry file path or glob. */
  pattern: string;
  outDir?: string;
  taskIds?: TaskId[];
  depth?: number;
  variants?: number;
  heaps?: HeapMode;
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
  /** Run only the specs affected by files changed since this ref (true = HEAD). */
  changed?: string | true;
  /** "exported" emits a tree per exported component in each entry file. */
  roots?: RootMode;
  /** Extra globs to skip, appended to DEFAULT_EXCLUDES. */
  exclude?: readonly string[];
  useDefaultExcludes?: boolean;
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
  /**
   * Present when a test run happened (--run-tests, or --changed's affected
   * run); absent when none did. Distinguishes "exit 0 because the suites
   * passed" from "exit 0 because nothing ran" — the two states FR-017 hid
   * between. `green` is what folded into exitCode.
   */
  testRun?: { mode: "affected" | "generated"; green: boolean };
  /**
   * flawless:* scripts whose existing package.json value the merge did not
   * recognize as the tool's own and therefore KEPT (FR-034). Durable on
   * purpose: the log line is suppressed under --ci/--json and programmatic
   * runs, exactly the modes an agent refreshes in.
   */
  keptScripts: string[];
}

/**
 * A command that reproduces this run, for REPORT.md's header.
 *
 * Rebuilt from the options rather than captured from argv. argv carries the
 * interpreter and the absolute path of the script — `bun /home/…/src/bin.ts` —
 * and REPORT.md is committed, timestamp-free, and checked out under a different
 * root on every machine. An absolute path in it would churn `git status`
 * everywhere except the machine that generated it, which is the same failure the
 * no-timestamp rule exists to prevent, arriving through a different door.
 *
 * So: the published bin name, never the interpreter; every path relative, never
 * absolute; and only the options that differ from their defaults, so two runs
 * that did the same thing produce the same line.
 */
export function reproCommand(opts: CoreOptions, root: string, taskIds: TaskId[]): string {
  // Only absolutes are rewritten. A pattern the caller wrote as `src/**/*.tsx`
  // is already relative to where they ran it, and resolving it against `root`
  // just to relativise it again would turn a correct string into a guess.
  const rel = (p: string): string => {
    const r = path.isAbsolute(p) ? path.relative(root, p) : p;
    const posix = r.split(path.sep).join("/");
    return posix === "" ? "." : posix;
  };
  // Globs and spaces need quoting or the invoking shell expands them before
  // flawless sees them — which is a different run.
  const quote = (s: string): string => (/[\s*?[\]{}()|$]/.test(s) ? `"${s}"` : s);

  // Defensive: a caller that reaches here without a pattern gets a line that
  // is honest about what it does not know, never a TypeError from path.relative.
  const parts = [
    "flawless-react",
    opts.pattern === undefined ? "<entry>" : quote(rel(opts.pattern)),
  ];
  const flag = (name: string, value?: string): void => {
    parts.push(name);
    if (value !== undefined) parts.push(value);
  };

  if (opts.nextjs !== undefined) flag("--nextjs", quote(rel(opts.nextjs)));
  if (opts.outDir !== undefined) flag("--out", quote(rel(opts.outDir)));
  // The CLI's no-flag default is perf-harness alone, so anything else has to be
  // spelled out or the line reproduces a different run.
  if (!(taskIds.length === 1 && taskIds[0] === "perf-harness")) {
    flag("--tasks", taskIds.join(","));
  }
  if (opts.roots !== undefined && opts.roots !== "primary") flag("--roots", opts.roots);
  if (opts.apiSpec !== undefined) flag("--api", quote(rel(opts.apiSpec)));
  if (opts.provider !== undefined) flag("--provider", quote(rel(opts.provider)));
  if (opts.swaggerUrl !== undefined) flag("--swagger-url", quote(opts.swaggerUrl));
  if (opts.depth !== undefined && opts.depth !== 3) flag("--depth", String(opts.depth));
  if (opts.variants !== undefined && opts.variants !== 5) {
    flag("--variants", String(opts.variants));
  }
  if (opts.heaps !== undefined && opts.heaps !== "stress") flag("--heaps", opts.heaps);
  if (opts.includeChildren === false) flag("--include-children=false");
  // Relativised like any other path: an exclude is usually already relative
  // (`**/*.stories.tsx`), but nothing stops a caller passing an absolute one.
  for (const g of opts.exclude ?? []) flag("--exclude", quote(rel(g)));
  if (opts.useDefaultExcludes === false) flag("--no-default-excludes");
  if (opts.propsOverride !== undefined) {
    flag("--props", `'${JSON.stringify(opts.propsOverride)}'`);
  }
  if (opts.colocate === true) flag("--colocate");
  if (opts.force === true) flag("--force");
  if (opts.report === true) flag("--report");
  if (opts.inlineSummary === false) flag("--no-inline-summary");
  if (opts.changed !== undefined) {
    flag("--changed", opts.changed === true ? undefined : quote(opts.changed));
  }
  if (opts.runTests === true) flag("--run-tests");
  return parts.join(" ");
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
    nextCtx = await detectNextjs(opts.nextjs); // throws UsageError on bad input
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
        const wrapped = ensureClientProviderWrapper(
          nextCtx,
          outDir as string,
          providerOverride,
          opts.force === true,
        );
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

  const files = await expandGlob(pattern, {
    ...(opts.exclude ? { exclude: opts.exclude } : {}),
    ...(opts.useDefaultExcludes === undefined
      ? {}
      : { useDefaultExcludes: opts.useDefaultExcludes }),
  });
  if (files.length === 0) {
    throw new UsageError(`no files matched: ${pattern}`);
  }

  const trees: ComponentTree[] = [];
  const unparseable: UnparseableFile[] = [];
  // One parse cache + resolver for the whole sweep: a leaf shared by many
  // entries (ui/card.tsx under a dogfood sweep) parses once, not once per
  // entry. Per-entry state (visited sets) stays inside analyseFile.
  const analyseShared = createAnalyseSharedContext();
  for (const file of files) {
    try {
      trees.push(
        ...(await analyseFile(
          {
            entry: file,
            depth: opts.depth ?? 3,
            includeChildren: opts.includeChildren ?? true,
            roots: opts.roots ?? "primary",
          },
          analyseShared,
        )),
      );
    } catch (err) {
      // Also recorded so REPORT.md can account for it. A stderr line is lost in
      // a hundred-file sweep, and a component that vanished silently is exactly
      // what makes a coverage number meaningless.
      unparseable.push({ file, reason: (err as Error).message });
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

  // An unknown id used to be filtered away, so a typo ran ZERO tasks and
  // still exited 0 with an empty results array — a green run that tested
  // nothing, which is the one outcome this tool must never produce.
  const unknownTaskIds = taskIds.filter((id) => findTask(id) === undefined);
  if (unknownTaskIds.length > 0) {
    throw new UsageError(
      `unknown task id(s): ${unknownTaskIds.join(", ")}. Valid ids: ${TASKS.map((t) => t.id).join(", ")}.`,
    );
  }
  const selected = taskIds.map((id) => findTask(id)).filter((t): t is Task => Boolean(t));

  const ctx: RunContext = {
    trees,
    outDir,
    variants: opts.variants ?? 5,
    heaps: opts.heaps ?? "stress",
    force: opts.force ?? false,
    report: opts.report ?? false,
    provider: providerOverride,
    apiSpec: opts.apiSpec,
    inlineSummary: opts.inlineSummary ?? true,
    nextjs: nextCtx,
    colocate: opts.colocate ?? false,
    selectedTasks: taskIds,
    // Changed-mode reaches the tasks so perf-harness can keep an existing
    // suite instead of churning it — the affected-run gate below stays on
    // !anyFailed, and a kept harness is not a failure.
    ...(opts.changed === undefined ? {} : { changed: opts.changed }),
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

  const nextjsWritten: string[] = [];
  // Kept flawless:* scripts must outlive the log line: --ci/--json and
  // programmatic runs suppress logging, and those are exactly the modes an
  // agent refreshes in (the FR-034 dogfood bite happened under one).
  let keptScripts: string[] = [];
  if (nextCtx) {
    try {
      const nm = await emitNextjsMocks(nextCtx, outDir, { liveSpec, force: opts.force });
      nextjsWritten.push(...nm.written, nm.swaggerPath);
      log(
        `nextjs: wrote ${nm.written.length} mock file(s) under ${path.relative(process.cwd(), outDir)}/mocks/`,
      );
      // POSIX separators, like every other emitted path (loadPipes.ts,
      // scaffold/templates.ts, scaffold-tests/mocks.ts). These land in a file;
      // the rest of path.relative's uses in this file are log lines.
      const outRel = outDirRel(outDir, nextCtx.root);
      const scriptMerge = await mergeIntoNextPackageJson(
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
          // Every one of these is gated on the task that emits what it points
          // at. This block runs on EVERY --nextjs invocation, so declaring them
          // unconditionally wrote `flawless:perf` — and unit, and browser — into
          // the app's package.json after a `--tasks load` run that never emitted
          // a playwright.config.ts or a profile/ for them to find. `bun run
          // flawless:perf` then failed on a config the user never asked for and
          // cannot produce without regenerating. Same defect as the standalone
          // suite's missing `test:perf`, from the other direction: there the
          // script was absent, here its target is.
          ...(taskIds.includes("unit-browser")
            ? {
                "flawless:unit": opts.colocate
                  ? `vitest run --config ${outRel}/${VITEST_CONFIG}`
                  : `vitest run --root ${outRel}`,
              }
            : {}),
          // browser/ is rendered only when perf-harness is also in the run —
          // the browser specs drive its host (unitAndBrowser.ts sets
          // browserSpecs from exactly this condition). Gated on unit-browser
          // alone, `--nextjs --tasks unit-browser` declared this script for a
          // config that was never written, and --run-tests then invoked it and
          // reported `failed suites: browser` for a correct run.
          ...(taskIds.includes("unit-browser") && taskIds.includes("perf-harness")
            ? {
                "flawless:browser": `playwright test --config ${outRel}/browser/playwright.config.ts`,
              }
            : {}),
          // --project=chromium, not both: the config also defines a headed
          // "interactive" project for manual debugging, and without this every
          // spec runs twice — once invisibly in a window nobody is watching.
          ...(taskIds.includes("perf-harness")
            ? {
                "flawless:perf": `playwright test --config ${outRel}/playwright.config.ts --project=chromium ${outRel}/profile`,
              }
            : {}),
          ...(taskIds.includes("e2e")
            ? {
                "flawless:e2e": `playwright test --config ${outRel}/e2e/playwright.config.ts`,
              }
            : {}),
          ...(taskIds.includes("load")
            ? {
                "flawless:load": `crust -c 'test-pipes --target ${outRel}/load/routes.pipes --timeout 60000'`,
              }
            : {}),
          // --report emits scripts/report.mjs into the suite, but in Next.js
          // mode there is no suite package.json to declare a `report` script,
          // so the file sat there with nothing anywhere able to invoke it while
          // its own banner said "Re-run with bun run report". Same gate as
          // pkgJson's standalone `report` key, and same pairing with the task
          // that writes the file.
          ...(taskIds.includes("perf-harness") && opts.report === true
            ? { [NEXT_SCRIPT.report]: `node ${outRel}/scripts/report.mjs` }
            : {}),
        },
        {
          // Both spellings are the tool's own — which one a project holds
          // depends only on whether --colocate was passed LAST run, and the
          // stale one silently skips colocated specs under --run-tests.
          "flawless:unit": [
            `vitest run --config ${outRel}/${VITEST_CONFIG}`,
            `vitest run --root ${outRel}`,
          ],
        },
      );
      log(
        `nextjs: merged dev deps + flawless:* scripts into ${path.join(nextCtx.root, "package.json")}`,
      );
      keptScripts = scriptMerge.keptScripts;
      if (keptScripts.length > 0) {
        log(
          `nextjs: kept ${keptScripts.length} script(s) with commands this tool does not ` +
            `recognize: ${keptScripts.join(", ")} — delete a key from package.json to take ` +
            `the tool's current command`,
        );
      }
      // Colocated specs sit in src/ next to their components, where an
      // unscoped test runner will collect them and run them under the wrong
      // runner. Silently creating that collision is not acceptable — it turns
      // a green project suite red for a reason that looks nothing like the
      // cause.
      for (const collision of detectTestScriptCollisions(nextCtx.root, ctx.colocate ?? false)) {
        warn(`warning: ${collision}`);
      }
      // outRel, not a literal "flawless": every script twelve lines above is
      // already written relative to the real out dir, and these were not. Under
      // `--out qa` the run wrote qa/ and ignored flawless/, so the heaps (566MB
      // of them), the Playwright output and — worst — qa/e2e/.auth.json were
      // left untracked and unignored. That file is where global-setup.ts tells
      // you to persist a logged-in storageState, i.e. session cookies staged
      // for commit. `*.flawless.json` stays literal: it is the inline-summary
      // sidecar pattern, written beside the analysed sources, not under outDir.
      const added = updateGitignore(nextCtx.root, [
        underOutDir(outRel, "reports/"),
        underOutDir(outRel, "heaps/"),
        underOutDir(outRel, "playwright-report/"),
        underOutDir(outRel, "node_modules/"),
        underOutDir(outRel, "test-results/"),
        underOutDir(outRel, "browser/test-results/"),
        underOutDir(outRel, "e2e/test-results/"),
        underOutDir(outRel, "e2e/.auth.json"),
        underOutDir(outRel, "load/last-*.json"),
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
  const reportPath = await writeReportMarkdown({
    trees,
    results,
    outDir,
    projectRoot: nextCtx?.root,
    unparseable,
    keptScripts,
    allTaskIds: TASKS.map((t) => t.id),
    // Only in Next.js mode, where there is a project root that both the command
    // and the report's file paths are relative to, and which is where the user
    // ran the command from. Standalone, the report lands in outDir while the
    // pattern is relative to the caller's cwd — two different directories, so a
    // line claiming to be runnable "from the project root" would not be.
    // The RESOLVED pattern, not opts.pattern: Next.js mode auto-detects the
    // entry glob, leaving opts.pattern undefined despite its type — which
    // crashed the report line AFTER every task had already run.
    command: nextCtx ? reproCommand({ ...opts, pattern }, nextCtx.root, taskIds) : undefined,
  });

  // Format everything we wrote with the host project's own formatter so
  // generation never churns the target repo's lint/format state.
  const styleRoot = nextCtx?.root ?? outDir;
  const writtenFiles = [
    reportPath,
    ...results.flatMap((r) => r.outputs),
    // swagger.json + mocks are rewritten on every run; if they are not written
    // in the project's own style, its formatter (or a pre-commit hook) will
    // reformat them and the next run will churn the diff straight back.
    ...nextjsWritten,
    ...(providerOverride && isInside(outDir, providerOverride) ? [providerOverride] : []),
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
  // Second phase of the colocated-spec stamps: the writer stamped the raw
  // render, and the style pass above may just have reformatted those bytes —
  // leaving stamps that would classify every untouched spec as hand-edited on
  // the next --force. Restamp AFTER (and regardless of) style adoption; when
  // the formatter didn't run or didn't change a file this is a no-op, and
  // restampGenerated ignores everything that doesn't open with a stamp line.
  try {
    await restampGenerated(writtenFiles);
  } catch (err) {
    warn(`stamp refresh failed (non-fatal): ${(err as Error).message}`);
  }

  const runnableSelected = selected.some(
    (t) => t.id === "perf-harness" || t.id === "unit-browser" || t.id === "e2e",
  );

  // --changed narrows the RUN, never the generation. The profiling host is a
  // single bundle of every component, so regenerating only part of it would
  // leave a host that no longer matches its specs — and generation is not where
  // the time goes anyway: analysing 99 files takes half a second, while running
  // every spec they produce took seventeen minutes.
  // A suite failure must reach the exit code: --ci --run-tests previously
  // discarded both runners' outcomes and exited 0 on red suites.
  let suitesGreen = true;
  // Recorded on CoreResult so a caller (or a test) can tell the affected run
  // actually FIRED — exit 0 alone is equally consistent with the branch never
  // executing, which is exactly how FR-017 hid.
  let testRun: CoreResult["testRun"];
  if (!anyFailed && opts.changed !== undefined && runnableSelected) {
    const repoRoot = (await findRepoRoot(nextCtx?.root ?? outDir)) ?? nextCtx?.root ?? outDir;
    const files = await changedFiles(repoRoot, opts.changed === true ? "HEAD" : opts.changed);
    const affected = affectedSpecs(
      trees,
      files,
      nextCtx ? { router: nextCtx.router, root: nextCtx.root } : undefined,
    );
    log(
      `changed: ${affected.changedFiles.length} source file(s) → ${affected.components.length} component spec(s), ${affected.routes.length} route(s)` +
        (affected.withoutSpecs.length > 0
          ? ` (${affected.withoutSpecs.length} unexported component(s) covered through their parent)`
          : ""),
    );
    suitesGreen = await runAffectedTests(
      outDir,
      selected.map((t) => t.id),
      affected,
      nextCtx?.root,
      // log:false means stdout belongs to the caller (--json's blob, or a
      // programmatic consumer) — the runner and its children use stderr.
      opts.log !== true,
    );
    testRun = { mode: "affected", green: suitesGreen };
  } else if (!anyFailed && opts.runTests === true && runnableSelected) {
    suitesGreen = await runGeneratedTests(
      outDir,
      selected.map((t) => t.id),
      nextCtx?.root,
      opts.log !== true,
    );
    testRun = { mode: "generated", green: suitesGreen };
  }

  return {
    keptScripts,
    exitCode: anyFailed || !suitesGreen ? 1 : 0,
    outDir,
    results,
    trees,
    nextjs: nextCtx,
    provider: providerOverride,
    testRun,
  };
}

/**
 * Test scripts that would collect colocated `*.flawless.test.tsx` files and run
 * them under a runner they were not written for. Bun's and Jest's default globs
 * both match `*.test.tsx` anywhere, so an unscoped script silently absorbs
 * every generated spec.
 */
export function detectTestScriptCollisions(nextRoot: string, colocate: boolean): string[] {
  if (!colocate) return [];
  const pkgPath = path.join(nextRoot, "package.json");
  if (!existsSync(pkgPath)) return [];
  let scripts: Record<string, string> = {};
  try {
    scripts =
      (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> }).scripts ??
      {};
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (name.startsWith("flawless:")) continue;
    const trimmed = cmd.trim();
    // A bare runner with no path/pattern argument globs the whole project.
    if (/^(bun test|jest|vitest run|vitest)$/.test(trimmed)) {
      out.push(
        `"${name}": "${trimmed}" has no path filter, so it will also collect the colocated ` +
          `*.flawless.test.tsx specs and run them under the wrong runner. Scope it ` +
          `(e.g. "bun test tests") or run flawless without --colocate.`,
      );
    }
  }
  return out;
}

/** True when `file` lives under `dir` (not merely shares its path prefix). */
function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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

/**
 * Never analysed by a glob. The first entry is the important one: without it a
 * second `src/**\/*.tsx` run analyses the specs the first run generated, and
 * writes specs for its own specs.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  "**/*.flawless.test.*",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.stories.*",
  "**/*.d.ts",
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/flawless/**",
];

export interface ExpandGlobOptions {
  /** Appended to the defaults unless `useDefaultExcludes` is false. */
  exclude?: readonly string[];
  useDefaultExcludes?: boolean;
}

export async function expandGlob(pattern: string, opts: ExpandGlobOptions = {}): Promise<string[]> {
  const abs = path.resolve(pattern);
  // An explicit path wins over every exclusion — otherwise you could never
  // deliberately point the tool at a file the defaults would skip. A directory
  // is a usage mistake, not an entry: without this check it fell through to
  // "Directories cannot be read like files" + "no analysable components found",
  // neither of which names the fix. "" resolves to cwd, so the interactive
  // prompt's empty submit landed here too.
  if (existsSync(abs)) {
    if (statSync(abs).isDirectory()) {
      // Shell tab-completion appends a trailing slash ("src/"); keep it out of
      // the suggested glob or the fix reads "src//**/*.tsx".
      const shown = pattern.replace(/[\\/]+$/, "");
      throw new UsageError(
        `${shown === "" ? abs : shown} is a directory — pass a .tsx file or a glob like "${shown === "" ? "src" : shown}/**/*.tsx"`,
      );
    }
    return [abs];
  }
  const hasGlobChar = /[*?[\]{}]/.test(pattern);
  if (!hasGlobChar) {
    return [];
  }

  const excludes = [
    ...(opts.useDefaultExcludes === false ? [] : DEFAULT_EXCLUDES),
    ...(opts.exclude ?? []),
  ].map((p) => new Bun.Glob(p));
  const cwd = process.cwd();
  const isExcluded = (file: string): boolean => {
    const rel = path.relative(cwd, file);
    // Match both forms: users write "**/*.test.*" and "src/**/*.test.tsx".
    return excludes.some((g) => g.match(file) || g.match(rel));
  };

  const glob = new Bun.Glob(pattern);
  const out: string[] = [];
  try {
    for await (const f of glob.scan({ cwd, absolute: true })) {
      if (!isExcluded(f)) out.push(f);
    }
  } catch {
    // A glob rooted at a directory that doesn't exist throws ENOENT rather
    // than yielding nothing; "no files matched" is the useful message.
    return [];
  }
  return out.sort();
}
