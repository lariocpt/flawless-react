import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { mergePackageJson } from "../packageJson.ts";
import { SUITE_COMMAND, SUITE_SCRIPT, VITEST_CONFIG } from "../suiteScripts.ts";
import type { ComponentTree, NextjsApiRoute } from "../types.ts";
import { classifyStamped, stamp } from "./stamp.ts";
import { type AliasEntry, renderUnitBrowser } from "./templates.ts";

export interface ScaffoldUnitBrowserOptions {
  trees: ComponentTree[];
  outDir: string;
  variants: number;
  skipInnerPackageJson?: boolean;
  mswSetup?: boolean;
  provider?: string;
  resolveAliases?: AliasEntry[];
  colocate?: boolean;
  /** Overwrite existing colocated specs (in-outDir files are always rewritten). */
  force?: boolean;
  apiRoutes?: NextjsApiRoute[];
  /** Emit Playwright browser specs (they need the perf-harness host). */
  browserSpecs?: boolean;
}

export interface ScaffoldUnitBrowserResult {
  written: string[];
  /** Colocated spec targets left untouched because they already exist (no --force). */
  skipped: string[];
  /** Colocated specs --force kept because their stamp no longer matches the body. */
  keptEdited: string[];
  /** Colocated specs --force kept because they carry no stamp at all (pre-stamp). */
  keptLegacy: string[];
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

  if (!opts.skipInnerPackageJson) {
    await writeSuitePackageJson(outDir, opts.browserSpecs !== false);
    written.push(path.join(outDir, "package.json"));
  }
  return { written, skipped, keptEdited, keptLegacy };
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
export function suitePackageJson(outDir: string, withBrowser: boolean): string {
  return `${JSON.stringify(
    {
      name: `${path.basename(outDir).replace(/[^a-zA-Z0-9_-]+/g, "-")}-suite`,
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        [SUITE_SCRIPT.unit]: SUITE_COMMAND.unit,
        // browser/ is only rendered when browserSpecs is on. Declared
        // unconditionally, `--tasks unit-browser` wrote a script pointing at a
        // config that run never created, and --run-tests then invoked it and
        // reported a correct suite as failing.
        ...(withBrowser ? { [SUITE_SCRIPT.browser]: SUITE_COMMAND.browser } : {}),
      },
      dependencies: {
        react: "^18.3.0",
        "react-dom": "^18.3.0",
      },
      devDependencies: {
        "@playwright/test": "^1.49.0",
        "@types/node": "^22.0.0",
        "@types/react": "^18.3.0",
        "@types/react-dom": "^18.3.0",
        typescript: "^5.6.0",
        vitest: "^2.1.0",
        "@vitest/ui": "^2.1.0",
        jsdom: "^25.0.0",
        "@testing-library/react": "^16.0.0",
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
async function writeSuitePackageJson(outDir: string, withBrowser: boolean): Promise<void> {
  const pkgPath = path.join(outDir, "package.json");
  const generated = suitePackageJson(outDir, withBrowser);
  if (!existsSync(pkgPath)) {
    await writeFile(pkgPath, generated);
    return;
  }
  await writeFile(pkgPath, mergePackageJson(await readFile(pkgPath, "utf8"), generated));
}
