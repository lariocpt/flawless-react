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
  // Nothing on the walk declared BOTH halves, so the answer has to be read off
  // what is there. Three one-sided readings qualify, and each is remembered
  // with the hop it was seen at:
  //   0. a full installed pair — the versions the graph actually shares;
  //   1. one installed half alone — the copy the app's own imports land on;
  //   2. a manifest declaring react alone — an app with no DOM renderer at all
  //      (ospfranco/sol: `"react": "19.1.4"`, no react-dom in the file, and no
  //      react-dom installed anywhere either — a Tauri app rendering elsewhere).
  //      Nothing in its tree renders to DOM, so the SUITE is what supplies a
  //      renderer, and the only version that cannot drift is the react it does
  //      pin. Missing this left sol's suite on the React-18 default under a
  //      React-19.1.4 app — the exact mismatch this whole file exists to stop.
  // A library whose react is a peer dependency declares a disjunction —
  // `"react": "^18.0.0 || ^19.0.0"`, lightswind-ui-library's whole declaration —
  // and no single version answers it: only reading 0 or 1 can speak for it.
  // Nearest wins, then the fullest reading at that hop, because an ancestor
  // that carries react for its own tooling must not out-vote the app.
  const partial: { react: string; reactDom: string; hop: number; rank: number }[] = [];
  for (let hop = 0; hop < 8; hop++) {
    const pkgPath = path.join(dir, "package.json");
    const reactInstalled = installedVersionAt(dir, "react");
    const reactDomInstalled = installedVersionAt(dir, "react-dom");
    const installed =
      reactInstalled && reactDomInstalled
        ? { react: reactInstalled, reactDom: reactDomInstalled }
        : undefined;
    if (installed) partial.push({ ...installed, hop, rank: 0 });
    else if (reactInstalled)
      partial.push({ react: reactInstalled, reactDom: reactInstalled, hop, rank: 1 });
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
        // The versions the graph will ACTUALLY share are the installed ones. A
        // declared range is a floor: `^19.2.0` installs whatever is newest, so
        // a suite pinned from the declaration and an app tree holding the copy
        // it installed last month are two versions — and react-dom refuses to
        // load when the pair it sees disagrees ("Incompatible React versions",
        // every spec file dead at collect: 91 of 93 on bradgarropy.com, whose
        // app declares ^19.2.0 and has 19.2.8 installed). Prefer the installed
        // pair, both or neither, so the two never drift from each other.
        if (v && dv) return installed ?? { react: v, reactDom: dv };
        if (v && !dv) partial.push({ react: v, reactDom: v, hop, rank: 2 });
      } catch {
        /* unparseable: keep walking */
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  partial.sort((a, b) => a.hop - b.hop || a.rank - b.rank);
  const answer = partial[0];
  return answer ? { react: answer.react, reactDom: answer.reactDom } : undefined;
}

/**
 * The exact version physically installed under a package root, reading through
 * a pnpm symlink and returning undefined when that tree carries no copy.
 */
function installedVersionAt(dir: string, name: string): string | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8"),
    ) as { name?: string; version?: string };
    // Not the package the path points at (a stray link): treat it as absent.
    return raw.name === name && typeof raw.version === "string" ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

/** A package's version as installed directly in `nmDir` (a node_modules dir). */
function versionInNodeModules(nmDir: string, name: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(path.join(nmDir, name, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    return raw.name === name && typeof raw.version === "string" ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The React the suite's own install has to match.
 *
 * Two derivations had to be made one. `detectAppReact` walks UP from the suite
 * and reads the pair the app declares and installs; the emitted vitest config
 * anchors its `react` aliases on the copy the SOURCES resolve —
 * `nearestReactNodeModules` over the source roots, which walks DOWN. In a
 * workspace the two can answer different questions:
 * code-forge-io/react-router-devtools has no react at its root at all, so the
 * pin fell through to the `^18.3.0` default while the alias pointed at the
 * `docs` package's linked React 19.2.7. Whatever the manifest names, the app's
 * copy wins at runtime, and React 18's `react-dom/test-utils` reading React
 * 19's renamed internals kills every spec at collect — `Cannot read properties
 * of undefined (reading 'ReactCurrentOwner')`, 180 files contributing zero
 * tests. The suite's install, meanwhile, is the copy RTL and the harness load.
 *
 * So take the pin from the copy the aliases anchor on. The guard is what keeps
 * this surgical: an app with no react anywhere in its tree anchors on the
 * SUITE's own node_modules, and there the anchor is only the install about to
 * happen — `detectAppReact` stays the answer, so an app that never had an
 * app-tree React behaves exactly as it did before.
 */
export function appReactPin(
  fromDir: string,
  anchorNmDir?: string,
): { react: string; reactDom: string } | undefined {
  if (anchorNmDir) {
    const nm = path.resolve(anchorNmDir);
    const suite = path.resolve(fromDir);
    // The anchor is the APP's copy only while it sits outside the suite. When
    // it is the suite's own node_modules (or below it) there is no second
    // copy to agree with — that tree is this install, about to be written —
    // so detectAppReact stays the answer.
    if (nm !== suite && !nm.startsWith(`${suite}${path.sep}`)) {
      const react = versionInNodeModules(nm, "react");
      // A copy carrying react alone still answers the question the alias asks:
      // it is the copy every leg of the graph will load, so it is the pair.
      if (react) return { react, reactDom: versionInNodeModules(nm, "react-dom") ?? react };
    }
  }
  return detectAppReact(fromDir);
}

/**
 * The app's React MAJOR (17, 18, 19 …) — the switch that picks the test
 * stack. React 17 has no `react-dom/client`, no `createRoot`, and no
 * streaming server renderer, and @testing-library/react 15+ dropped it from
 * its peers; the emitters that touch those APIs branch on this number.
 * Undefined when no app pin was detected — callers treat that as the
 * default major their manifests carry.
 */
export function appReactMajor(fromDir: string): number | undefined {
  // Per-component spec dispatch consults this; cache the scan so generation
  // does not re-walk package.jsons per component.
  const key = path.resolve(fromDir);
  if (MAJOR_MEMO.has(key)) return MAJOR_MEMO.get(key);
  const pin = detectAppReact(fromDir);
  const major = pin ? Number(pin.react.split(".")[0]) : undefined;
  const out = pin && Number.isFinite(major) ? major : undefined;
  MAJOR_MEMO.set(key, out);
  return out;
}
const MAJOR_MEMO = new Map<string, number | undefined>();

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
      const value = m?.[1];
      if (value) return value;
    } else if (section === "catalogs") {
      const nm = line.match(/^(\s{2})(\S[^:]*):\s*$/);
      const namedHeader = nm?.[2];
      // Group 2 is only missing when the line did not match at all, so the
      // else-if still means "a line inside the catalogs block".
      if (namedHeader !== undefined) named = namedHeader;
      else if (catalog && named === catalog) {
        const m = line.match(new RegExp(`^\\s{4}${escaped}:\\s*['"]?([^'"\\s#]+)`));
        const value = m?.[1];
        if (value) return value;
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
 * Bring a suite manifest's React back to the app's React, exactly.
 *
 * The merge lets an existing pin win, which is right for a range the project
 * chose and wrong for this key: the suite's react IS the copy the app's
 * component code runs against, and the pair must be the SAME VERSION as the one
 * the app tree carries. A caret is a floor, not a version — `^19.2.0` installs
 * the newest 19.x — so a stale suite manifest pairs its own fresh install with
 * the app's older one and react-dom's load-time guard kills the whole plane:
 * `Cannot read properties of undefined (reading 'ReactCurrentOwner')` for a
 * stale major (90 of 93 files on bradgarropy.com), `Incompatible React
 * versions: react 19.2.8, react-dom 19.3.1` for one that merely drifted patch
 * (91 of 93 there too; the same suite reads 44 passed once the pair matches).
 *
 * So any react/react-dom value that does not name the app's version exactly is
 * rewritten to it, and only when the app actually declares a React. Ranges
 * whose major cannot be read (`catalog:`, `latest`, `workspace:`) are left
 * alone: an unreadable preference is not a disagreement, and guessing at one is
 * how a repair becomes a break. `@types/*` follow the major of the runtime they
 * describe, since a types release need not track a patch.
 */
export function repairReactPin(
  merged: string,
  pin: { react: string; reactDom: string } | undefined,
): string {
  if (!pin) return merged;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(merged) as Record<string, unknown>;
  } catch {
    return merged;
  }
  const majorOf = (range: string): string | undefined => /^\D*(\d+)/.exec(range)?.[1];
  let changed = false;
  for (const field of ["dependencies", "devDependencies"] as const) {
    const block = parsed[field] as Record<string, string> | undefined;
    if (!block) continue;
    for (const [dep, want] of [
      ["react", pin.react],
      ["react-dom", pin.reactDom],
      ["@types/react", pin.react],
      ["@types/react-dom", pin.reactDom],
    ] as const) {
      const have = block[dep];
      if (!have) continue;
      // An unreadable major (`catalog:`, `latest`, `workspace:*`) is not a
      // disagreement, it is an unreadable preference — leave it.
      if (majorOf(have) === undefined) continue;
      const types = dep.startsWith("@types/");
      // The runtime must be the SAME version; types only need the same major.
      if (types ? majorOf(have) === majorOf(want) : have === want) continue;
      block[dep] = types ? `^${majorOf(want)}.0.0` : want;
      changed = true;
    }
  }
  return changed ? stringifyLike(merged, parsed) : merged;
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
