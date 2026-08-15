import { stringifyLike } from "./scaffold/adoptStyle.ts";

interface Pkg {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Fold a generated `package.json` into the one already on disk.
 *
 * `<outDir>/package.json` is the only file two tasks both write. unit-browser
 * merged into whatever it found; perf-harness overwrote it. Task order is the
 * order you type — the CLI documents that — so `--tasks unit-browser,perf-harness`
 * ran the overwrite second and dropped `test:unit` and `test:browser` without a
 * word, after which --run-tests invoked `test:unit`, found nothing, and reported
 * a correct suite as failing.
 *
 * Both emitters now come through here, because two merges into one file that
 * disagree about who owns a field are worse than either: the copy in
 * scaffold-tests kept an existing `name`, the one in scaffold did not, and a
 * renamed suite would have been renamed back depending on which task ran last —
 * the same bug one level up from the one being fixed.
 *
 * The policy, matching mergeIntoNextPackageJson for the target app:
 *
 *  - Generated scripts win their own keys, so an existing suite picks up a
 *    corrected command. The command that runs the generated suite is ours.
 *  - Existing dependency pins win: a version range is the project's decision and
 *    ours is only a default.
 *  - Everything else the file already carries wins — `name`, `version`, a script
 *    you added, a `packageManager` field — and is left exactly as it was.
 *
 * Indentation and the trailing newline are preserved, so a tabs-indented file
 * does not come back reindented, and a second run over a merged file produces
 * identical bytes.
 */
export function mergePackageJson(existingSource: string, generated: string): string {
  const fresh = JSON.parse(generated) as Pkg;
  let existing: Pkg;
  try {
    existing = JSON.parse(existingSource) as Pkg;
  } catch {
    // An unparseable package.json is not a reason to abandon the suite, and the
    // generated one is at least valid JSON.
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

/**
 * Script keys two emitters declare with different commands.
 *
 * Not checkable at merge time: a value on disk that differs from the generated
 * one is indistinguishable from an older version being upgraded, which is
 * exactly the case the merge exists to allow. Divergence is only visible
 * between two emitters' FRESH output in one run, which is where
 * tests/core.test.ts checks it.
 */
export function divergentScripts(a: Record<string, string>, b: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, command] of Object.entries(a)) {
    const other = b[key];
    if (other !== undefined && other !== command) out.push(`${key}: "${command}" vs "${other}"`);
  }
  return out.sort();
}
