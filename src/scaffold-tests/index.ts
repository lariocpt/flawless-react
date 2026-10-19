import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectAppReact, mergePackageJson, repairReactPin } from "../packageJson.ts";
import { PNPM_SUITE_SETTINGS, tsConfig } from "../scaffold/templates.ts";
import { SUITE_COMMAND, SUITE_SCRIPT, VITEST_CONFIG } from "../suiteScripts.ts";
import type { ComponentTree, NextjsApiRoute, ProviderRef } from "../types.ts";
import { classifyStamped, stamp } from "./stamp.ts";
import { type AliasEntry, type ReactExportShim, renderUnitBrowser } from "./templates.ts";

export interface ScaffoldUnitBrowserOptions {
  trees: ComponentTree[];
  outDir: string;
  variants: number;
  skipInnerPackageJson?: boolean;
  mswSetup?: boolean;
  /**
   * The run is a Next.js suite living under the app. The manifest is emitted
   * there too (a self-contained install needs it), but WITHOUT its "type"
   * field: the playwright configs around it are written assuming the app's
   * CJS transpile default (the nextjs e2e config anchors on __dirname), and
   * a package.json placed above them decides how Playwright loads them.
   */
  nextjs?: boolean;
  provider?: string;
  resolveAliases?: AliasEntry[];
  /** Emitted alongside the config when set; see ReactExportShim in templates.ts. */
  reactShim?: ReactExportShim;
  colocate?: boolean;
  /** Overwrite existing colocated specs (in-outDir files are always rewritten). */
  force?: boolean;
  apiRoutes?: NextjsApiRoute[];
  /** Emit Playwright browser specs (they need the perf-harness host). */
  browserSpecs?: boolean;
  /** Derived context providers to mount around each unit render; see UnitBrowserRenderOptions. */
  providerWraps?: Map<string, ProviderRef[]>;
}

export interface ScaffoldUnitBrowserResult {
  written: string[];
  /** Colocated spec targets left untouched because they already exist (no --force). */
  skipped: string[];
  /** Colocated specs --force kept because their stamp no longer matches the body. */
  keptEdited: string[];
  /** Colocated specs --force kept because they carry no stamp at all (pre-stamp). */
  keptLegacy: string[];
  /** Browser specs removed: their component left the mountable set and the file was untouched tool output. */
  staleRemoved: string[];
  /** Browser specs whose component left the mountable set, kept because a human may have worked in them. */
  staleKept: StaleBrowserSpec[];
}

export async function scaffoldUnitBrowser(
  opts: ScaffoldUnitBrowserOptions,
): Promise<ScaffoldUnitBrowserResult> {
  const outDir = path.resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });

  const files = renderUnitBrowser(opts);
  const written: string[] = [];
  const skipped: string[] = [];
  const keptEdited: string[] = [];
  const keptLegacy: string[] = [];
  for (const f of files) {
    const abs = f.absPath ?? path.join(outDir, f.relPath);
    if (f.skipIfExists && existsSync(abs)) {
      if (!opts.force) {
        skipped.push(abs);
        continue;
      }
      // --force refreshes what is still exactly ours and keeps everything a
      // human may have worked on. "Ours" is what the stamp proves; a file
      // from before stamping existed can't prove it either way, so it is
      // kept too and reported separately (delete it to regenerate).
      const verdict = classifyStamped(await readFile(abs, "utf8"));
      if (verdict === "edited") {
        keptEdited.push(abs);
        continue;
      }
      if (verdict === "stampless") {
        keptLegacy.push(abs);
        continue;
      }
    }
    await mkdir(path.dirname(abs), { recursive: true });
    // Only colocated specs (the skipIfExists set) are stamped: the in-outDir
    // files are identified by being rewritten every run, not by provenance.
    // This stamp hashes the raw render; core.ts restamps after the host
    // project's formatter has had its turn.
    await Bun.write(abs, f.skipIfExists ? stamp(f.content) : f.content);
    written.push(abs);
  }

  // The config used to be emitted as vitest.config.ts and is now .mts, so a
  // suite generated before this leaves the old one sitting beside the new one.
  // Two configs in one directory is worse than either: vitest picks by its own
  // precedence, so the file a reader edits and the file that runs can differ
  // silently. This name has only ever been ours, and it has never been
  // writeOnce, so removing the stale one is safe.
  // Compared as paths rather than against the literal, so that if VITEST_CONFIG
  // ever goes back to ".ts" this deletes nothing instead of deleting the file
  // the loop above just wrote.
  const stale = path.join(outDir, "vitest.config.ts");
  if (stale !== path.join(outDir, VITEST_CONFIG) && existsSync(stale)) {
    await rm(stale);
    written.push(stale);
  }

  // Browser specs are rewritten every run ONLY while their component stays
  // host-mountable. When it leaves the mountable set (a new guard, a render
  // mode change, a deleted file) the spec is simply no longer rendered — and
  // without this sweep it sits in browser/ forever, failing at mount with
  // "unknown component": a suite red by the tool's own doing. Provenance
  // decides, exactly as for the colocated specs: an untouched stamp is pure
  // tool output (removed and reported); a mismatched stamp is hand work
  // (kept, reported); no stamp at all is unprovable (kept, reported).
  const staleRemoved: string[] = [];
  const staleKept: StaleBrowserSpec[] = [];
  if (opts.browserSpecs !== false) {
    const rendered = new Set(
      files
        .filter((f) => f.relPath.startsWith("browser/") && f.relPath.endsWith(".spec.ts"))
        .map((f) => f.relPath),
    );
    const browserDir = path.join(outDir, "browser");
    if (existsSync(browserDir)) {
      for (const entry of (await readdir(browserDir)).sort()) {
        if (!entry.endsWith(".spec.ts")) continue;
        if (rendered.has(`browser/${entry}`)) continue;
        const abs = path.join(browserDir, entry);
        const verdict = classifyStamped(await readFile(abs, "utf8"));
        if (verdict === "untouched") {
          await rm(abs);
          staleRemoved.push(abs);
        } else {
          staleKept.push({ abs, verdict });
        }
      }
    }
  }

  if (!opts.skipInnerPackageJson) {
    await writeSuitePackageJson(
      outDir,
      opts.browserSpecs !== false,
      Boolean(opts.mswSetup),
      Boolean(opts.nextjs),
    );
    written.push(path.join(outDir, "package.json"));
    if (await ensurePnpmSuiteSettings(path.join(outDir, "pnpm-workspace.yaml"))) {
      written.push(path.join(outDir, "pnpm-workspace.yaml"));
    }
    // The suite type-checks in isolation (docs promise); emitted once, then
    // the user's — the same write-once promise as the yaml above.
    const tsPath = path.join(outDir, "tsconfig.json");
    if (!existsSync(tsPath)) {
      await writeFile(tsPath, tsConfig());
      written.push(tsPath);
    }
  }
  return { written, skipped, keptEdited, keptLegacy, staleRemoved, staleKept };
}

/** A stale browser spec the writer refused to remove, and why. */
export interface StaleBrowserSpec {
  abs: string;
  /** "edited" = stamp present, body differs (hand work); "stampless" = no provenance at all. */
  verdict: "edited" | "stampless";
}

/**
 * What unit-browser contributes to the suite's package.json.
 *
 * Exported so tests/core.test.ts can compare it against perf-harness's without
 * going through disk — the only place two emitters' declarations can be seen
 * side by side, and so the only place a disagreement between them is visible.
 *
 * `test:perf` is deliberately absent. It names perf-harness's config and
 * directory, and `browserSpecs` is set from exactly `selectedTasks.includes
 * ("perf-harness")` (unitAndBrowser.ts), so this emitter could only ever declare
 * it in the runs where perf-harness declares it too. A second, differently
 * spelled copy of a key that is never needed alone is how the two files came to
 * disagree in the first place.
 */
export function suitePackageJson(
  outDir: string,
  withBrowser: boolean,
  msw = false,
  nextjs = false,
): string {
  // The suite's react IS the copy every plane renders with (aliases + host
  // resolution point at the suite's node_modules), so it must be the
  // version the app's component code was written against. See detectAppReact.
  const pin = detectAppReact(outDir);
  const typesPin = pin ? `^${pin.react.split(".")[0]}.0.0` : "^18.3.0";
  // RTL majors split at React 18: 13+ peer-require react ^18 and their
  // dist/pure.js hard-requires the react-dom 18 client entry (a canary
  // proved 14.3.1 fails at collection under React 17). 12.1.5 is the last
  // major whose peers carry <18; its bundled dom-v8 covers every API the
  // spec templates emit.
  const legacyRtl = pin && Number(pin.react.split(".")[0]) <= 17;
  const rtlPin = legacyRtl ? "^12.1.5" : "^16.0.0";
  return `${JSON.stringify(
    {
      name: `${path.basename(outDir).replace(/[^a-zA-Z0-9_-]+/g, "-")}-suite`,
      version: "0.0.0",
      private: true,
      // A standalone suite owns its loader: "module", with configs and
      // sources written for ESM. A nextjs suite's manifest must NOT say it:
      // the file sits above playwright configs emitted against the app's
      // CJS transpile default (the nextjs e2e config anchors on __dirname),
      // and the nearest package.json picks Playwright's loader — inheriting
      // "module" here crashed those configs at import with "__dirname is not
      // defined in ES module scope".
      ...(nextjs ? {} : { type: "module" }),
      scripts: {
        [SUITE_SCRIPT.unit]: SUITE_COMMAND.unit,
        // browser/ is only rendered when browserSpecs is on. Declared
        // unconditionally, `--tasks unit-browser` wrote a script pointing at a
        // config that run never created, and --run-tests then invoked it and
        // reported a correct suite as failing.
        ...(withBrowser ? { [SUITE_SCRIPT.browser]: SUITE_COMMAND.browser } : {}),
      },
      dependencies: {
        react: pin?.react ?? "^18.3.0",
        "react-dom": pin?.reactDom ?? "^18.3.0",
        // The perf host's main.tsx imports react-scan; withBrowser IS
        // "perf-harness ran", so the host is in this suite. Same pin as
        // perf-harness's own emitter — divergent pins meant the file's
        // bytes depended on which task ran last.
        ...(withBrowser ? { "react-scan": "^0.4.3" } : {}),
        // mswSetup IS "setup.ts wires the MSW server", and every nextjs
        // suite fetches through it — a self-contained install cannot
        // assume the APP ships msw (chanhdai happened to; that is luck,
        // not a contract).
        ...(msw ? { msw: "^2.7.0" } : {}),
      },
      devDependencies: {
        "@playwright/test": "^1.49.0",
        // next's trace tracer require()s this OPTIONAL peer at module load.
        // webpack tolerates the miss; the perf host's bun transpiler hard-
        // errors on it. Ship the real package — without a registered
        // provider it is a faithful no-op, identical to production behavior.
        "@opentelemetry/api": "^1.9.0",
        "@types/node": "^22.0.0",
        "@types/react": typesPin,
        "@types/react-dom": typesPin,
        typescript: "^5.6.0",
        vitest: "^2.1.0",
        "@vitest/ui": "^2.1.0",
        jsdom: "^25.0.0",
        "@testing-library/react": rtlPin,
        // user-event 14 peers @testing-library/dom >=7.21.4. Modern RTL
        // ships dom 10 as a dependency; RTL 12's dom 8 is only reachable
        // transitively, and pnpm's strict linking does not expose it to a
        // sibling — declare it so the peer resolves deterministically.
        ...(legacyRtl ? { "@testing-library/dom": "^8.20.1" } : {}),
        "@testing-library/user-event": "^14.5.0",
        "@testing-library/jest-dom": "^6.5.0",
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Through the shared merge, like perf-harness — the version pins above are
 * defaults an existing file overrides, not values that overwrite it.
 */
async function writeSuitePackageJson(
  outDir: string,
  withBrowser: boolean,
  msw: boolean,
  nextjs = false,
): Promise<void> {
  const pkgPath = path.join(outDir, "package.json");
  const generated = suitePackageJson(outDir, withBrowser, msw, nextjs);
  if (!existsSync(pkgPath)) {
    await writeFile(pkgPath, generated);
    return;
  }
  const pin = detectAppReact(outDir);
  const merged = repairRtlPin(
    repairReactPin(mergePackageJson(await readFile(pkgPath, "utf8"), generated), pin),
    pin,
  );
  // The merge lets an existing file win on every key — except in nextjs
  // mode, where the loader switch is the TOOL's key (see suitePackageJson):
  // a manifest that already says "module" would pin ESM onto the playwright
  // configs around it and kill their __dirname at import. Everything else
  // in the file stays the user's.
  if (nextjs && /"type":/.test(merged)) {
    const parsed = JSON.parse(merged) as Record<string, unknown>;
    delete parsed.type;
    await writeFile(pkgPath, `${JSON.stringify(parsed, null, 2)}\n`);
    return;
  }
  await writeFile(pkgPath, merged);
}

/**
 * The merge lets an existing manifest out-vote every pin — but a pin that
 * peer-requires react ^18 (RTL 13+) inside a React-17 suite cannot even be
 * collected: dist/pure.js requires the react-dom 18 client entry that 17
 * does not ship. When the surviving range is one this tool itself emitted
 * before that was known (a canary proved ^14.0.0 fails at collection), the
 * merge yields that one key back. Ranges the tool never offered, or that
 * merely degrade rather than fail outright (RTL 12 on react 18 renders in
 * legacy mode with a warning), are left alone.
 */
export function repairRtlPin(
  merged: string,
  pin: { react: string; reactDom: string } | undefined,
): string {
  const appMajor = pin ? Number(pin.react.split(".")[0]) : undefined;
  if (appMajor === undefined || !(appMajor <= 17)) return merged;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(merged) as Record<string, unknown>;
  } catch {
    return merged;
  }
  const dev = parsed.devDependencies as Record<string, string> | undefined;
  const range = dev?.["@testing-library/react"];
  const rtlMajor = range ? /^\D*(\d+)/.exec(range)?.[1] : undefined;
  if (!dev || rtlMajor === undefined || Number(rtlMajor) < 13) return merged;
  dev["@testing-library/react"] = "^12.1.5";
  if (!dev["@testing-library/dom"]) dev["@testing-library/dom"] = "^8.20.1";
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * Build scripts a suite install must run (pnpm 10+ refuses them by default
 * and EXITS 1 doing so). esbuild's postinstall IS its binary — without it
 * vitest dies at startup; msw's copies its service worker.
 */
const SUITE_BUILD_ALLOWLIST = ["esbuild", "msw"];

/**
 * The suite's pnpm-workspace.yaml: write-once in spirit, self-healing in
 * fact. Every dogfood suite install died on ERR_PNPM_IGNORED_BUILDS because
 * the allowlist had not grown with the suite's dependencies; a file that is
 * merely re-written-when-absent repeats that on existing suites. A missing
 * file is written whole; an existing one gains only the entries it lacks —
 * user keys are untouched, nothing is ever duplicated, and a key the user
 * rewrote inline (flow style, not a block) is theirs to keep, so the pass
 * hands off entirely.
 */
export async function ensurePnpmSuiteSettings(wsPath: string): Promise<boolean> {
  if (!existsSync(wsPath)) {
    await writeFile(wsPath, PNPM_SUITE_SETTINGS);
    return true;
  }
  const body = await readFile(wsPath, "utf8");
  const inList = (name: string) => new RegExp(`^[ \\t]*-[ \\t]+${name}[ \\t]*$`, "m").test(body);
  const flagged = (name: string) =>
    new RegExp(`^[ \\t]*${name}:[ \\t]*true[ \\t]*$`, "m").test(body);
  const items = SUITE_BUILD_ALLOWLIST.filter((n) => !inList(n)).map((n) => `  - ${n}`);
  const flags = SUITE_BUILD_ALLOWLIST.filter((n) => !flagged(n)).map((n) => `  ${n}: true`);
  if (items.length === 0 && flags.length === 0) return false;
  let changed = false;
  let next = body;
  if (items.length > 0) {
    const merged = appendToYamlBlock(next, "onlyBuiltDependencies:", items);
    if (merged !== null) {
      next = merged;
      changed = true;
    }
  }
  if (flags.length > 0) {
    const merged = appendToYamlBlock(next, "allowBuilds:", flags);
    if (merged !== null) {
      next = merged;
      changed = true;
    }
  }
  if (!changed) return false;
  await writeFile(wsPath, next);
  return true;
}

/**
 * Insert lines at the end of a top-level YAML block (creating it at EOF when
 * absent). Null means hands off: the key carries an inline value the user
 * wrote — duplicating the key would make the file invalid YAML.
 */
function appendToYamlBlock(body: string, header: string, lines: string[]): string | null {
  const all = body.split("\n");
  const at = all.findIndex((l) => l.trimStart().startsWith(header));
  if (at === -1) {
    const base = body.endsWith("\n") ? body : `${body}\n`;
    return `${base}${header}\n${lines.join("\n")}\n`;
  }
  const atLine = all[at] ?? "";
  if (atLine.slice(atLine.indexOf(header) + header.length).trim() !== "") return null;
  let end = at + 1;
  while (end < all.length && /^[ \t]+\S/.test(all[end] ?? "")) end++;
  all.splice(end, 0, ...lines);
  return all.join("\n");
}
