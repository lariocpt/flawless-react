import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stringifyLike } from "./scaffold/adoptStyle.ts";

interface Pkg {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * The app's own React pin, as a bare exact version.
 *
 * The suite installs its OWN react/react-dom (its harness deps live in the
 * suite's tree), and every plane resolves react through that one copy: the
 * vitest aliases point at the suite's node_modules, and the perf host's
 * resolveFromSuite resolves from the suite directory. So the suite's copy IS
 * the copy the app's component code runs against — and a suite pinned to 18
 * under a React-19 app fails every component that touches a 19-only hook
 * (`useOptimistic is not a function` across 100+ specs). Pin what the app
 * declares instead; absent a detectable app pin, fall back to the default.
 *
 * Walks up from the suite dir past package.jsons that merely exist until one
 * DEFINES react (monorepo roots often carry no react at all), resolving pnpm
 * `catalog:` references through the package.json catalogs map or a sibling
 * pnpm-workspace.yaml.
 */
export function detectAppReact(fromDir: string): { react: string; reactDom: string } | undefined {
  let dir = path.dirname(path.resolve(fromDir));
  for (let hop = 0; hop < 8; hop++) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          catalogs?: Record<string, Record<string, string>>;
          pnpm?: { catalog?: Record<string, string> };
        };
        const all = { ...pkg.devDependencies, ...pkg.dependencies };
        const react = resolveCatalog(all.react, "react", dir, pkg);
        const reactDom = resolveCatalog(all["react-dom"], "react-dom", dir, pkg);
        const v = bareVersion(react);
        const dv = bareVersion(reactDom);
        if (v && dv) return { react: v, reactDom: dv };
      } catch {
        /* unparseable: keep walking */
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/**
 * The nearest ancestor of `fromDir` that holds a package.json — the package
 * an analysed source belongs to, and therefore where the app's .env files
 * live (the app reads them from its own package directory).
 */
export function appPackageRoot(fromDir: string): string | undefined {
  let dir = path.dirname(path.resolve(fromDir));
  for (let hop = 0; hop < 8; hop++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function resolveCatalog(
  range: string | undefined,
  key: "react" | "react-dom",
  dir: string,
  pkg: {
    catalogs?: Record<string, Record<string, string>>;
    pnpm?: { catalog?: Record<string, string> };
  },
): string | undefined {
  if (!range) return undefined;
  if (!range.startsWith("catalog:")) return range;
  const named = range.slice("catalog:".length) || "default";
  if (named === "default") {
    return (
      pkg.catalogs?.default?.[key] ?? pkg.pnpm?.catalog?.[key] ?? catalogFromYaml(dir, null, key)
    );
  }
  return pkg.catalogs?.[named]?.[key] ?? catalogFromYaml(dir, named, key);
}

// `catalog:` / `catalogs:` maps in a pnpm-workspace.yaml, without a YAML
// parser: `  react: x` under a top-level catalog:, or one more indent under
// catalogs:<name>: . A file with only the default catalog is unambiguous.
function catalogFromYaml(
  dir: string,
  catalog: string | null,
  key: "react" | "react-dom",
): string | undefined {
  let yaml: string;
  try {
    yaml = readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return undefined;
  }
  const escaped = key.replace("-", "\\-");
  let section: "root" | "catalog" | "catalogs" | "other" = "other";
  let named = "";
  for (const line of yaml.split("\n")) {
    if (/^[^\s#]/.test(line)) {
      if (/^catalog:\s*$/.test(line)) section = "catalog";
      else if (/^catalogs:\s*$/.test(line)) section = "catalogs";
      else section = "other";
      continue;
    }
    if (section === "catalog") {
      const m = line.match(new RegExp(`^\\s{2}${escaped}:\\s*['"]?([^'"\\s#]+)`));
      if (m) return m[1];
    } else if (section === "catalogs") {
      const nm = line.match(/^(\s{2})(\S[^:]*):\s*$/);
      if (nm) named = nm[2];
      else if (catalog && named === catalog) {
        const m = line.match(new RegExp(`^\\s{4}${escaped}:\\s*['"]?([^'"\\s#]+)`));
        if (m) return m[1];
      }
    }
  }
  return undefined;
}

function bareVersion(range: string | undefined): string | undefined {
  const m = range?.match(/(\d+\.\d+\.\d+)/);
  return m?.[1];
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
  // pnpm >=12 stopped reading package.json's `pnpm` settings block entirely
  // and warns on every install (the allow-list lives in pnpm-workspace.yaml,
  // which the suite emits). An older generation of this tool wrote
  // pnpm.onlyBuiltDependencies into the suite's own package.json; the file is
  // ours, so the dead key is stripped instead of warned about forever.
  const pnpmBlock = (merged as { pnpm?: Record<string, unknown> }).pnpm;
  if (pnpmBlock && "onlyBuiltDependencies" in pnpmBlock) {
    delete pnpmBlock.onlyBuiltDependencies;
    if (Object.keys(pnpmBlock).length === 0) delete merged.pnpm;
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
