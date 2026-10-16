import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { analyseFile, createAnalyseSharedContext } from "./analyse/index.ts";
import { deriveContextProviderWraps, libraryProviderShimsFor } from "./analyse/providerWraps.ts";
import { affectedSpecs, changedFiles, findRepoRoot } from "./changed.ts";
import { outDirRel, underOutDir } from "./emitPaths.ts";
import { detectExpo } from "./expo/detect.ts";
import {
  detectComponentsGlob,
  detectNextjs,
  ensureFormatterIgnores,
  ignoreEntries,
  ignoreRootFor,
  mergeIntoNextPackageJson,
  updateGitignore,
} from "./nextjs/detect.ts";
import { emitNextjsMocks } from "./nextjs/emit.ts";
import { fetchLiveSwagger, loadLocalSpec } from "./nextjs/liveSpec.ts";
import {
  dropReasonLabel,
  ensureClientProviderWrapper,
  isUsableUnitProvider,
} from "./nextjs/providerWrapper.ts";
import { appReactMajor } from "./packageJson.ts";
import { printFindings, writeInlineSummaries, writeSummaryJson } from "./reporters/findings.ts";
import { type UnparseableFile, writeReportMarkdown } from "./reporters/report.ts";
import { runAffectedTests, runGeneratedTests } from "./runner/runTests.ts";
import { adoptProjectStyle } from "./scaffold/adoptStyle.ts";
import { restampGenerated } from "./scaffold-tests/stamp.ts";
import { EXPO_SCRIPT, JEST_CONFIG, NEXT_SCRIPT, VITEST_CONFIG } from "./suiteScripts.ts";
import { findTask, TASKS } from "./tasks/index.ts";
import type {
  ComponentTree,
  ExpoContext,
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
  /** Expo project root; enables Expo mode. Mutually exclusive with `nextjs`. */
  expo?: string;
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
  /**
   * Everything this run writes to STDOUT — the progress narration AND the
   * per-file findings listing (`printFindings`). Default on. False is what
   * --json/--ci and the programmatic API pass: stdout then belongs to the
   * caller — a JSON blob that must parse whole — so nothing may go there.
   *
   * It is NOT a vow of silence. Diagnostics go to stderr and are gated by
   * `quiet`, which is a separate decision: see below.
   */
  log?: boolean;
  /**
   * Suppress `runCore`'s OWN diagnostics — the `warn()` lines: a skipped file,
   * an unparseable spec, a script collision, a failed Next.js emit. Default
   * off, so they always speak, including under --ci.
   *
   * Sharing one flag with `log` is how `--ci`, the mode built for machines,
   * became the mode that lost "warning: skipping <file>" and "could not parse
   * <path> as OpenAPI JSON — ignoring". Whether stdout is the caller's and
   * whether the run may report a problem at all are different questions.
   *
   * Deliberately narrow, and NOT "silence stderr": the suite runner's own
   * output (`› bun run flawless:unit`, `failed suites: …`, and every child
   * suite's streams) is routed by a different flag, and task-level warnings
   * like perfHarness's migration notice go through `console.warn` with no gate
   * at all. If you need a fully silent process, redirect fd 2 yourself.
   */
  quiet?: boolean;
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
   * What the test-run phase did.
   *
   *  - "affected" | "generated": suites actually RAN — that is the promise
   *    these two arms make, and `green` is what folded into exitCode. A phase
   *    that spawned nothing never wears them (FR-042/FR-043).
   *  - "none": zero suites ran; `reason` says why — no selected task generates
   *    one --run-tests executes, nothing was affected, or the selected tasks
   *    plan no run for the work that was.
   *  - absent: the run never REACHED the test-run phase. FR-046: that is not
   *    the same as "nothing was requested". It also covers a request blocked by
   *    a failed task, which exits 1 and is explained by `results`. Read absent
   *    as "look elsewhere", never as "no run was asked for".
   *
   * The invariant a consumer can rely on: `mode: "none"` if and only if zero
   * suites executed, and a `green` field only ever appears on a phase that ran
   * something.
   *
   * The whole point is that exit 0 has two meanings — "the suites passed" and
   * "no suite ran" — and a caller reading only the exit code cannot tell them
   * apart. That is the pair FR-017 hid between, and B-14 found `--run-tests`
   * over a selection of non-runnable tasks reproducing it one flag over.
   *
   * Deliberately NOT set when a task failed: that run exits 1, so it is already
   * telling the truth, and the failing TaskResult says which task.
   */
  testRun?: { mode: "affected" | "generated"; green: boolean } | { mode: "none"; reason: string };
  /**
   * Failures that belong to no task and so appear nowhere in `results`
   * (FR-041). Today's only producer is a Next.js emit that threw: it sets the
   * exit code to 1 while every TaskResult still says ok:true, so without this
   * a --ci consumer saw a red run whose blob contained no account of it.
   * Empty on a clean run; with `testRun`, every red run is now explicable from
   * the blob alone.
   */
  errors: string[];
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
  // Deliberately NOT `opts.log`: stdout purity and permission to report a
  // problem are separate decisions (B-13). Gating both on one flag made --ci
  // silent about work it skipped.
  const warn = (line: string): void => {
    if (opts.quiet !== true) process.stderr.write(`${line}\n`);
  };

  let pattern: string | undefined = opts.pattern;
  let outDir = opts.outDir;
  const taskIds: TaskId[] =
    opts.taskIds === undefined || opts.taskIds.length === 0 ? ["perf-harness"] : opts.taskIds;

  let expoCtx: ExpoContext | undefined;
  let nextCtx: NextjsContext | undefined;
  let liveSpec: unknown;
  const providerExplicit = opts.provider !== undefined;
  let providerOverride = opts.provider;

  // Belt and braces: the CLI already refuses both flags, but runCore is a public
  // API (src/index.ts) and a programmatic caller reaches here without parseArgs.
  if (opts.nextjs !== undefined && opts.expo !== undefined) {
    throw new UsageError(
      "nextjs and expo are mutually exclusive: a project is a Next.js app or an Expo app, not both.",
    );
  }

  if (opts.expo !== undefined) {
    expoCtx = await detectExpo(opts.expo); // throws UsageError on bad input
    if (outDir === undefined) outDir = path.join(expoCtx.root, "flawless");
    else assertOutDirInsideProject(outDir, expoCtx.root, "--expo");
    if (pattern === undefined && expoCtx.routerRoot !== undefined) {
      pattern = path.join(expoCtx.routerRoot, "**/*.tsx");
      log(`expo: no entry passed — defaulting to ${path.relative(expoCtx.root, pattern)}`);
    }
    log(
      `expo: ${expoCtx.root} (sdk=${expoCtx.sdkMajor ?? "unknown"}` +
        `, expo-router=${expoCtx.routerMajor ?? "none"}` +
        `, react-compiler=${expoCtx.reactCompiler}` +
        `, nativewind=${expoCtx.nativewind}` +
        `, web-port=${expoCtx.webPort})`,
    );
  }

  if (opts.nextjs !== undefined) {
    nextCtx = await detectNextjs(opts.nextjs); // throws UsageError on bad input
    if (outDir === undefined) outDir = path.join(nextCtx.root, "flawless");
    else assertOutDirInsideProject(outDir, nextCtx.root, "--nextjs");
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
          const droppedText =
            wrapped.dropped.length === 0
              ? ""
              : ` — dropped ${wrapped.dropped
                  .map((d) => `${d.name} (${dropReasonLabel(d.reason)})`)
                  .join(", ")}`;
          log(
            wrapped.created
              ? `nextjs: app resolver is a server layout — derived ${path.relative(nextCtx.root, wrapped.path)} (providers: ${wrapped.included.join(", ") || "none mounted"}${droppedText})`
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

  // Derived before any task runs: the context providers a mount needs are
  // frequently imported by NO analysed component (the route layout imports
  // SidebarProvider, and route files are not component entries), so the host
  // cannot find them in the trees — it needs this map instead.
  const providerWraps = await deriveContextProviderWraps(trees, analyseShared.cache, (c) =>
    libraryProviderShimsFor([c.info.filePath]),
  );

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
    ...(expoCtx ? { expo: expoCtx } : {}),
    colocate: opts.colocate ?? false,
    selectedTasks: taskIds,
    // Changed-mode reaches the tasks so perf-harness can keep an existing
    // suite instead of churning it — the affected-run gate below stays on
    // !anyFailed, and a kept harness is not a failure.
    ...(opts.changed === undefined ? {} : { changed: opts.changed }),
    ...(providerWraps.size > 0 ? { providerWraps } : {}),
  };

  const results: TaskResult[] = [];
  let anyFailed = false;
  // FR-041: failures that belong to no task, and so appear nowhere in
  // `results`. A caller reading the blob saw exitCode 1 with every task ok:true
  // and no account of why; the stderr line was the only record, and before B-13
  // even that was suppressed under --ci.
  const runErrors: string[] = [];
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
      // React 17 apps get @testing-library/react 12 — 13+ peer-require
      // react ^18 and hard-require the react-dom 18 client entry at load.
      // Mirrors suitePackageJson's branch.
      const appMajor = appReactMajor(path.join(nextCtx.root, "package.json"));
      const legacyRtl = appMajor !== undefined && appMajor <= 17;
      const scriptMerge = await mergeIntoNextPackageJson(
        nextCtx.root,
        {},
        {
          msw: "^2.6.0",
          vitest: "^2.1.0",
          jsdom: "^25.0.0",
          "@testing-library/react": legacyRtl ? "^12.1.5" : "^16.0.0",
          ...(legacyRtl ? { "@testing-library/dom": "^8.20.1" } : {}),
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
          // --project=chromium is a no-op against the emitted config's single
          // project — kept because it says what this script IS (the headless
          // perf plane) and keeps working on configs where the user added
          // projects of their own. The config once shipped a headed second
          // project, which turned every bare \`playwright test\` into a
          // double pass with real windows; that project is gone.
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
      const added = updateGitignore(nextCtx.root, ignoreEntries(outRel));
      if (added.length > 0) {
        log(`nextjs: added ${added.length} entry(ies) to .gitignore (${added.join(", ")})`);
      }
      for (const t of ensureFormatterIgnores(nextCtx.root, outRel)) {
        log(
          `nextjs: added ${t.entry} to ${t.file} — the suite is tool-owned, not project lint input`,
        );
      }
    } catch (err) {
      anyFailed = true;
      const message = `nextjs emit failed: ${(err as Error).message}`;
      runErrors.push(message);
      warn(message);
    }
  }

  // Expo mode merges the native test stack into the app, the way Next.js mode
  // merges the DOM one. The version pairing is the whole point and it is not
  // cosmetic: a bare `jest` resolves to 30 while jest-expo 54's tooling is all
  // ^29.2.1, and the mismatch surfaces as
  // "TypeError: this._moduleMocker.clearMocksOnScope is not a function"
  // from inside jest-runtime — which names nothing a user could act on. Found by
  // running the emitted suite, not by reading the manifest.
  if (expoCtx) {
    try {
      const outRel = outDirRel(outDir, expoCtx.root);
      const merge = await mergeIntoNextPackageJson(
        expoCtx.root,
        {},
        {
          // Pinned to the project's OWN SDK major. jest-expo@54 pairs with Expo
          // SDK 54; a fixed range breaks every other adopter, and a guessed one
          // fails deep inside expo-modules-core.
          ...(expoCtx.sdkMajor === undefined ? {} : { "jest-expo": `~${expoCtx.sdkMajor}.0.0` }),
          // ^29, matching jest-expo's own babel-jest/@jest/globals/jest-snapshot.
          jest: "^29.7.0",
          // 13, not 14: expo-router 6's testing-library is built against
          // react-test-renderer, which RNTL 14 replaced with `test-renderer`.
          "@testing-library/react-native": "^13.3.3",
          "react-test-renderer": "19.1.0",
          // The suite does not type-check without it. jest ships no types of its
          // own, so an adopting app running `tsc --noEmit` over the emitted
          // specs reports TS2593 on every describe/test and TS2304 on every
          // expect — 2366 errors across the 32 specs of the dogfood app, none of
          // them the adopter's fault. Majored to the jest pin above: @types/jest
          // 30 against jest 29 is a mismatch nobody asked for.
          "@types/jest": "^29.5.14",
          // The e2e specs' runner. Same pin as the Next.js merge — an Expo app
          // has no Playwright of its own (the dogfood app's lived in a sibling
          // workspace the mobile package cannot resolve from).
          ...(taskIds.includes("e2e") ? { "@playwright/test": "^1.49.0" } : {}),
        },
        {
          ...(taskIds.includes("unit-browser")
            ? { [EXPO_SCRIPT.unit]: `jest --config ${underOutDir(outRel, JEST_CONFIG)}` }
            : {}),
          ...(taskIds.includes("e2e")
            ? {
                [EXPO_SCRIPT.e2e]: `playwright test --config ${underOutDir(outRel, "e2e/playwright.config.ts")}`,
              }
            : {}),
          // crust is a CLI, not an npm dep — same as the Next.js load script,
          // which is why no @-dep rides alongside this one.
          ...(taskIds.includes("load")
            ? {
                [EXPO_SCRIPT.load]: `crust -c 'test-pipes --target ${underOutDir(outRel, "load/routes.pipes")} --timeout 60000'`,
              }
            : {}),
        },
      );
      keptScripts = merge.keptScripts;
      log(`expo: merged the native test stack into ${path.join(expoCtx.root, "package.json")}`);
      if (keptScripts.length > 0) {
        log(
          `expo: kept ${keptScripts.length} script(s) with commands this tool does not ` +
            `recognize: ${keptScripts.join(", ")} — delete a key from package.json to take ` +
            `the tool's current command`,
        );
      }
      for (const collision of detectTestScriptCollisions(expoCtx.root, true)) {
        warn(`warning: ${collision}`);
      }
      const added = updateGitignore(expoCtx.root, ignoreEntries(outRel));
      if (added.length > 0) {
        log(`expo: added ${added.length} entry(ies) to .gitignore (${added.join(", ")})`);
      }
      for (const t of ensureFormatterIgnores(expoCtx.root, outRel)) {
        log(
          `expo: added ${t.entry} to ${t.file} — the suite is tool-owned, not project lint input`,
        );
      }
    } catch (err) {
      anyFailed = true;
      const message = `expo emit failed: ${(err as Error).message}`;
      runErrors.push(message);
      warn(message);
    }
  }

  // Outside Next.js mode this used to run at all: updateGitignore was reached
  // only from the branch above, so a plain `flawless-react "src/**/*.tsx"` run
  // ignored NOTHING it generated — not reports/, not heaps/, not
  // playwright-report/, and not e2e/.auth.json, which the emitted global-setup
  // itself describes as session cookies staged for commit. One run in a fresh
  // repo left 28 generated files untracked and unignored.
  //
  // The design call this needed: WHERE does a non-Next .gitignore belong? At the
  // git root — that is where git reads a repo-wide ignore and where the user's
  // existing one already is. Writing beside the out dir instead would create a
  // second, easily-missed ignore file inside generated output. Failing that (a
  // package that is not a repo) the nearest package.json, and failing that the
  // out dir's parent, so something is always ignored rather than nothing.
  if (!nextCtx && !expoCtx) {
    const ignoreRoot = ignoreRootFor(outDir);
    const added = updateGitignore(ignoreRoot, ignoreEntries(outDirRel(outDir, ignoreRoot)));
    if (added.length > 0) {
      log(
        `added ${added.length} entry(ies) to ${path.join(ignoreRoot, ".gitignore")} ` +
          `(${added.join(", ")})`,
      );
    }
    for (const t of ensureFormatterIgnores(ignoreRoot, outDirRel(outDir, ignoreRoot))) {
      log(`added ${t.entry} to ${path.join(ignoreRoot, t.file)} — tool-owned suite`);
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

  // The tasks that generate a suite something can run. Named once, so the
  // message below cannot drift from the predicate that produced it.
  const RUNNABLE_TASK_IDS: readonly TaskId[] = ["perf-harness", "unit-browser", "e2e"];
  const runnableSelected = selected.some((t) => RUNNABLE_TASK_IDS.includes(t.id));

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
  // FR-044. --changed is checked first, so passing both flags silently runs the
  // NARROW set and drops the full suite the caller also asked for. Say so: the
  // outcome is defensible, choosing it in silence is not.
  if (opts.changed !== undefined && opts.runTests === true) {
    warn(
      "--changed and --run-tests were both given: running only the affected specs. " +
        "Drop --changed to run the full generated suites.",
    );
  }
  if (!anyFailed && opts.changed !== undefined && runnableSelected) {
    const projectRoot = nextCtx?.root ?? expoCtx?.root;
    const repoRoot = (await findRepoRoot(projectRoot ?? outDir)) ?? projectRoot ?? outDir;
    const files = await changedFiles(repoRoot, opts.changed === true ? "HEAD" : opts.changed);
    const affected = affectedSpecs(
      trees,
      files,
      nextCtx ? { router: nextCtx.router, root: nextCtx.root } : undefined,
      expoCtx?.routerRoot !== undefined ? { routerRoot: expoCtx.routerRoot } : undefined,
    );
    log(
      `changed: ${affected.changedFiles.length} source file(s) → ${affected.components.length} component spec(s), ${affected.routes.length} route(s)` +
        (affected.withoutSpecs.length > 0
          ? ` (${affected.withoutSpecs.length} unexported component(s) covered through their parent)`
          : ""),
    );
    const outcome = await runAffectedTests(
      outDir,
      selected.map((t) => t.id),
      affected,
      // The project whose package.json carries the flawless:* scripts — the
      // Expo root serves the same role the Next root does.
      nextCtx?.root ?? expoCtx?.root,
      // log:false means stdout belongs to the caller (--json's blob, or a
      // programmatic consumer) — the runner and its children use stderr.
      //
      // This argument is NOT opts.quiet, and must never become it. The runner's
      // `quiet` has the OPPOSITE polarity to CoreOptions.quiet: there it means
      // "route everything to stderr", here it would mean "say nothing at all".
      // Wiring opts.quiet into this slot inverts the --json stdout-purity
      // guarantee (a quiet:false caller would get suite output on stdout, in
      // front of the blob), and tests/runTests.test.ts drives the runner
      // directly, so nothing would catch it. Same word, one file apart.
      opts.log !== true,
    );
    suitesGreen = outcome.green;
    // ran === 0 FIRST, always. A run arm of this union is a promise that suites
    // executed, so "green because nothing ran" must never wear one (FR-042).
    testRun =
      outcome.ran === 0
        ? { mode: "none", reason: outcome.reason ?? "changed: no specs to run" }
        : { mode: "affected", green: outcome.green };
  } else if (!anyFailed && opts.runTests === true && runnableSelected) {
    const outcome = await runGeneratedTests(
      outDir,
      selected.map((t) => t.id),
      // Same role either way: the project whose package.json holds flawless:*.
      nextCtx?.root ?? expoCtx?.root,
      opts.log !== true,
    );
    suitesGreen = outcome.green;
    testRun =
      outcome.ran === 0
        ? { mode: "none", reason: outcome.reason ?? "no generated suite matched the selection" }
        : { mode: "generated", green: outcome.green };
  } else if (!anyFailed && (opts.runTests === true || opts.changed !== undefined)) {
    // B-14: a run WAS asked for and cannot happen, because nothing selected
    // generates a suite. Previously this fell off the end of the chain with no
    // else — exit 0, empty stderr, and a blob indistinguishable from a green
    // suite run. The reason names the ids that would have run something: told
    // only that nothing ran, a caller has to go and read the source to learn
    // what to select instead.
    //
    // The !anyFailed guard is deliberate and load-bearing. A run where a task
    // failed exits 1 and its TaskResult says which — that run is already
    // telling the truth, and marking it "none" would relabel a real failure as
    // a no-op.
    const asked = opts.runTests === true ? "--run-tests" : "--changed";
    const selectedIds = selected.map((t) => t.id).join(", ");
    // FR-045. "generates no suite" was false for `load`, which generates pipes
    // AND declares the flawless:load script to run them in the same breath —
    // --run-tests simply does not execute them. Saying a generated artefact is
    // not one is exactly the kind of claim this repo's rules forbid.
    const loadNote = selected.some((t) => t.id === "load")
      ? " load pipes are a suite, but not one --run-tests executes — run them with `bun run flawless:load`."
      : "";
    const reason =
      `${asked} ran no suite: none of the selected task(s) (${selectedIds}) generates one ` +
      `that ${asked} executes.${loadNote} Select at least one of ${RUNNABLE_TASK_IDS.join(", ")}.`;
    warn(reason);
    testRun = { mode: "none", reason };
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
    errors: runErrors,
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
    if (selectsAllTests(trimmed)) {
      out.push(
        `"${name}": "${trimmed}" names no path, so it will also collect the ` +
          `*.flawless.test.tsx specs this run emits and execute them under the wrong ` +
          `runner — which fails on a defect that is not theirs. Scope it ` +
          `(e.g. "bun test tests"), or point it at a config whose testMatch already does.`,
      );
    }
  }
  return out;
}

/**
 * Flags whose argument is NOT a test-selection filter.
 *
 * A runner invoked with only these still globs the whole project, so it will
 * collect the specs this tool emits and run them under the wrong runner.
 */
const VALUE_FLAGS = new Set([
  "--preload",
  "--config",
  "-c",
  "--root",
  "--reporter",
  "--timeout",
  "--env-file",
  "--setup-files",
  "--coverage-reporter",
  "--max-workers",
  "-w",
  // vitest's workspace selector: it chooses WHICH project runs, not which
  // tests — `vitest --project unit` still globs that project's whole suite,
  // so its argument must not be mistaken for a path filter.
  "--project",
]);

/**
 * Flags that take NO argument.
 *
 * Kept separate from VALUE_FLAGS because conflating them was wrong in the
 * expensive direction: treating `--coverage` as value-taking made
 * `jest --coverage tests/` consume "tests/" as the flag's argument, so a
 * correctly-scoped script was reported as a collision.
 */
const BOOLEAN_FLAGS = new Set([
  "--coverage",
  "--bail",
  "--silent",
  "--watch",
  "--watchAll",
  "--ci",
  "--verbose",
  "--run",
]);

/**
 * Whether a test command selects EVERYTHING, rather than a scoped path.
 *
 * The old test was a four-spelling regex — `bun test`, `jest`, `vitest run`,
 * `vitest` — which the dogfood app walked straight past: its script is
 * `bun test --preload ./tests/setup.ts`, a bare runner with a flag, no path, and
 * no match. Bun's default discovery then sweeps every emitted spec into the
 * project suite, where it fails on a runner it was not written for.
 *
 * `--config` is the interesting exception: a runner given an explicit config is
 * scoped BY that config's own testMatch, so `jest --config flawless/jest.config.cjs`
 * is not a collision even though it names no path.
 */
export function selectsAllTests(cmd: string): boolean {
  const tokens = cmd.trim().split(/\s+/);
  const head = tokens[0] ?? "";
  if (!/^(bun|jest|vitest|bunx|npx)$/.test(head)) return false;

  // Where the runner's ARGUMENTS begin.
  //
  // This was `bun test ? 2 : 1`, which counted the runner's own name as a
  // positional path filter for every `npx`/`bunx` form — so `npx jest` and
  // `bunx vitest` were reported as scoped when they glob the whole project,
  // which is precisely the collision this function exists to catch. `npx` and
  // `bunx` are in the accepted-runner regex above, so covering them was always
  // the intent.
  let i: number;
  if (head === "bun") {
    if (tokens[1] !== "test") return false;
    i = 2;
  } else if (head === "npx" || head === "bunx") {
    // `npx jest`, `bunx vitest run`, and `bunx bun test` — skip the launcher and
    // whatever runner it names.
    if (!/^(jest|vitest|bun)$/.test(tokens[1] ?? "")) return false;
    i = tokens[1] === "bun" ? (tokens[2] === "test" ? 3 : -1) : 2;
    if (i === -1) return false;
  } else {
    i = 1;
  }
  let positionals = 0;
  let configScoped = false;
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (t === "run" && positionals === 0) {
      i++;
      continue;
    }
    if (t.startsWith("-")) {
      const [flag, inline] = t.includes("=") ? t.split("=", 2) : [t, undefined];
      if (flag === "--config" || flag === "-c") configScoped = true;
      // A flag that takes a SEPARATE argument consumes it, so the argument is not
      // mistaken for a path filter. Boolean flags must not, or the path after one
      // disappears and a scoped script reads as a collision.
      if (
        inline === undefined &&
        VALUE_FLAGS.has(flag as string) &&
        !BOOLEAN_FLAGS.has(flag as string)
      ) {
        i++;
      }
      i++;
      continue;
    }
    positionals++;
    i++;
  }
  return positionals === 0 && !configScoped;
}

/**
 * Refuse an out dir outside the project root, in a mode that writes INTO that project.
 *
 * `--nextjs`/`--expo` do more than choose a directory: they merge scripts into the
 * project's package.json and add entries to its .gitignore, both computed relative
 * to the project. With the out dir outside it, those come out as
 * `../../../../tmp/…` — a gitignore pattern git ignores, and a `flawless:unit`
 * script naming a path that exists on one machine. Both were observed: a run with
 * `--out` in a tmpdir left
 *
 *   "flawless:unit": "jest --config ../../../../../../../tmp/mockfix2/out/jest.config.cjs"
 *
 * in the app's package.json, and ten `../../../../tmp/…` lines in its .gitignore.
 *
 * A UsageError rather than a warning: the run would otherwise write those into a
 * repo the user then commits, and every emitted path in the suite has the same
 * problem. The escape is to leave --out off, which defaults to <root>/flawless.
 */
function assertOutDirInsideProject(outDir: string, root: string, flag: string): void {
  if (isInside(root, outDir) || path.resolve(outDir) === path.resolve(root)) return;
  throw new UsageError(
    `--out ${outDir} is outside the ${flag} project at ${root}. ` +
      `In ${flag} mode the run writes into that project — package.json scripts and ` +
      `.gitignore entries are both relative to it — so an out dir outside it produces ` +
      `paths that escape the repository and name this machine. ` +
      `Drop --out to use ${path.join(root, "flawless")}, or point it inside the project.`,
  );
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
