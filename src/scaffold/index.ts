import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ComponentTree, ScaffoldOptions } from "../types.ts";
import { stringifyLike } from "./adoptStyle.ts";
import { extractRoutes, loadApiSpec } from "./openapi.ts";
import { renderSuite, toHostRelImport } from "./templates.ts";

interface Pkg {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * package.json is the one file two tasks both write, so this one merges.
 *
 * `unit-browser` merges into whatever it finds; `perf-harness` overwrote it. Task
 * order is the order you type — the CLI documents that, and findings print as
 * each task completes — so `--tasks unit-browser,perf-harness` is legal and ran
 * the overwrite second, dropping `test:unit` and `test:browser` from the file
 * without a word. `--run-tests` then invoked `test:unit`, which no longer
 * existed, and reported a correct suite as failing. Sorting the task list into
 * registry order would have hidden this by taking away the documented ordering,
 * and only until a third emitter touched the file.
 *
 * Policy matches the repo's other two merges (scaffold-tests/index.ts,
 * mergeIntoNextPackageJson), field for field, because two merges into one file
 * that disagree are worse than either:
 *
 *  - Generated scripts win their own keys, so an existing suite picks up a
 *    corrected command. The command that runs the generated suite is ours.
 *  - Existing dependency pins win: a version range is the project's decision and
 *    ours is only a default.
 *  - Everything else the file already has wins, including `name` and `version` —
 *    scaffoldUnitBrowser keeps a renamed suite renamed, and this must too — and
 *    anything the generator never emits, such as a script you added or a
 *    `packageManager` field, is left exactly as it was.
 */
export function mergePackageJson(existingSource: string, generated: string): string {
  const fresh = JSON.parse(generated) as Pkg;
  let existing: Pkg;
  try {
    existing = JSON.parse(existingSource) as Pkg;
  } catch {
    // An unparseable package.json is not a reason to abandon the suite; the
    // generated one is at least valid. Same call scaffold-tests/index.ts makes.
    return generated;
  }

  // fresh first, so a field the file already carries keeps its own value and
  // only the ones it lacks are contributed.
  const merged: Pkg = { ...fresh, ...existing };
  merged.scripts = { ...(existing.scripts ?? {}), ...(fresh.scripts ?? {}) };
  for (const field of ["dependencies", "devDependencies"] as const) {
    const before = existing[field];
    const add = fresh[field];
    if (!before && !add) {
      delete merged[field];
      continue;
    }
    merged[field] = { ...(add ?? {}), ...(before ?? {}) };
  }
  return stringifyLike(existingSource, merged);
}

export async function scaffold(tree: ComponentTree, opts: ScaffoldOptions): Promise<string[]> {
  const outDir = path.resolve(opts.outDir);
  // Keyed on a suite already being here, not on the directory existing. The
  // directory is not a usable proxy: ensureClientProviderWrapper mkdirs outDir
  // at core.ts:215, before the task loop at :298, so on any --nextjs run outDir
  // exists by the time this is reached and a bare existsSync would refuse every
  // FIRST run. That is why this guard was bypassed with a hardcoded force:true,
  // which cost it the re-run it was actually written to catch.
  const marker = path.join(outDir, "playwright.config.ts");
  if (existsSync(marker) && !opts.force) {
    throw new Error(
      `scaffold: a generated suite already exists at ${outDir}. Pass --force to regenerate (budgets.json and host/main.tsx are kept either way).`,
    );
  }
  await mkdir(outDir, { recursive: true });

  const providerImportPath = opts.provider ? toHostRelImport(outDir, opts.provider) : undefined;
  const mockRoutes = opts.apiSpec ? extractRoutes(await loadApiSpec(opts.apiSpec)) : undefined;

  const files = renderSuite({
    tree,
    extraTrees: opts.extraTrees,
    suiteName: opts.suiteName,
    outDir,
    variants: opts.variants,
    ...(opts.heaps ? { heaps: opts.heaps } : {}),
    report: opts.report,
    providerImportPath,
    mockRoutes,
    nextjsHost: opts.nextjsHost,
    mswSetup: opts.mswSetup,
  });

  const written: string[] = [];
  for (const f of files) {
    const abs = path.join(outDir, f.relPath);
    // Not gated on --force, unlike the colocated specs: the point of these two
    // is that no flag rebuilds a tuned budget or hand-wired provider. Delete the
    // file to get a fresh one, same as provider.fixtures.ts.
    if (f.writeOnce && existsSync(abs)) continue;
    await mkdir(path.dirname(abs), { recursive: true });
    if (f.relPath === "package.json" && existsSync(abs)) {
      await Bun.write(abs, mergePackageJson(await Bun.file(abs).text(), f.content));
      written.push(abs);
      continue;
    }
    await Bun.write(abs, f.content);
    if (f.executable) await chmod(abs, 0o755);
    written.push(abs);
  }
  return written;
}

export { renderSuite } from "./templates.ts";
