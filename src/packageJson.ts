import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { stringifyLike } from "./scaffold/adoptStyle.ts";

interface Pkg {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  catalogs?: Record<string, Record<string, string>>;
  pnpm?: { catalog?: Record<string, string> };
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

/** The manifest at `<dir>/package.json`, or undefined when it is absent/unparseable. */
function readManifest(dir: string): Pkg | undefined {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Pkg;
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
  key: string,
  dir: string,
  pkg: Pkg,
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
function catalogFromYaml(dir: string, catalog: string | null, key: string): string | undefined {
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
 * The top major a version range can resolve to, read per npm's comparator
 * grammar.
 *
 * A disjunction (`||`) is bounded by its WIDEST part — `^2 || ^5` installs 5,
 * so it answers 5. Within a part the comparators AND: an upper bound caps the
 * answer (`<X` → X−1, `<=X` → X, `^M`/`~M`/an exact `M.x.y` → M), a lower
 * bound alone (`>`, `>=`) leaves the part open, and an open part answers
 * `"unbounded"` — `*`, `latest` and a `>=X` with nothing above it all mean
 * "whatever is newest". What carries no version at all — a dist tag, a
 * `git+`/URL range, a `catalog:`/`workspace:` reference — answers undefined:
 * no major can be read, and a caller deciding between "the host picked a
 * version" and "the host's declaration is unreadable" must be able to tell.
 * References resolve to a concrete version through the manifest context at
 * the call sites that have one (hostViteFamily's legs); passed here raw they
 * are the unreadable answer, never a guess.
 */
export function topMajorOf(range: string): number | "unbounded" | undefined {
  const parts = range
    .split("||")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  let best: number | undefined;
  for (const part of parts) {
    const top = partTopMajor(part);
    if (top === "unbounded") return "unbounded";
    if (top === undefined) continue;
    if (best === undefined || top > best) best = top;
  }
  return best;
}

function partTopMajor(part: string): number | "unbounded" | undefined {
  if (part === "*" || part === "x" || part === "X" || part === "latest") return "unbounded";
  if (/^(git\+|https?:|file:)/.test(part)) return undefined;
  if (part.startsWith("workspace:") || part.startsWith("catalog:")) return undefined;
  let upper: number | undefined;
  for (const comp of part.split(/\s+/)) {
    const m = /^(<=|>=|<|>|~|\^)?(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)?$/.exec(comp);
    if (!m) return undefined;
    const op = m[1] ?? "";
    const ver = m[2];
    if (ver === undefined) continue; // a bare `>`/`>=`: a lower bound only
    const major = Number(ver.split(/[.+~-]/)[0]);
    if (!Number.isFinite(major)) return undefined;
    switch (op) {
      case "<":
        // strictly below: `<6.0.0` tops out at 5.x, `<6` at 5.x too
        upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, major - 1);
        break;
      case "<=":
        upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, major);
        break;
      case ">":
      case ">=":
        break; // no upper contribution
      case "^":
      case "~":
      case "":
        // ^M (M>0) tops at M; ^0.x, ~M.m and an exact M.x.y all top at M too
        upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, major);
        break;
    }
  }
  return upper === undefined ? "unbounded" : Math.max(upper, 0);
}

/**
 * The vite MAJOR a vitest range runs on, from the shipped package.json files
 * (the declared range is the contract a fresh install honours — the installed
 * copy outranks it, and is read separately in installedViteFamilyAt):
 *
 *   vitest 2.1.9  → vite `^5.0.0`
 *   vitest 3.x    → vite `^5.0.0 || ^6.0.0 || ^7.0.0-0`
 *   vitest 4.1.12 → vite `^6.0.0 || ^7.0.0 || ^8.0.0`
 *   vitest 5.1.0  → vite `^6.4.0 || ^7.0.0 || ^8.0.0` (peer)
 *
 * The answer is the TOP of the range: `^6.0.0 || ^7.0.0 || ^8.0.0` CAN
 * install vite 8, and a config written only for the family the range floors
 * at goes red the moment a fresh install picks the top — so it is written
 * for the worst case. Majors nobody has shipped and unbounded ranges answer
 * 8, the newest family, for the same reason. Unreadable answers 8 here too:
 * a direct range→family conversion has no "yield" to fall back on.
 */
export function vitestRangeToViteFamily(range: string): number {
  const top = topMajorOf(range);
  if (top === undefined || top === "unbounded") return 8;
  if (top === 2) return 5;
  if (top === 3) return 7;
  return 8;
}

/**
 * The JSX mechanism the emitted vitest config must declare, for the vite
 * generation the suite runs on (hostViteFamily's answer). Measured, not
 * chosen:
 *
 * vite ≤ 7 — the transformer is esbuild. vite 7.3.7's dist carries NO oxc
 * machinery (no `vite:oxc` plugin, no `convertEsbuildConfigToOxcConfig`, no
 * both-set warning), so an `oxc` key is inert there and `esbuild: { jsx:
 * "automatic" }` is the only spelling that works.
 *
 * vite 8 — the transformer is oxc, and vitest 4/5 ALWAYS inject their own
 * `oxc: { target: … }` default (4.1.12: `target: viteConfig.oxc?.target ||
 * "node18"`; 5.1.0: `target ??= "node22"`). Vite 8's resolveConfig then finds
 * BOTH an `esbuild` and an `oxc` key, discards the esbuild one with a "Both
 * esbuild and oxc options were set" warning on every run, and jsx falls back
 * to the tsconfig — where a host `"jsx": "preserve"` (Next's own) leaves raw
 * JSX that dies when vite re-parses its own transform output: `Parse
 * failure: Unexpected JSX expression`, every spec file.
 * `oxc: { jsx: { runtime: "automatic" } }` is the only variant measured green
 * on every host tsconfig shape (preserve / react-jsx / unset / classic) with
 * no warning — an explicit jsx wins over the tsconfig on both transformers.
 */
export function jsxTransformFor(family: number): "esbuild" | "oxc" {
  return family < 8 ? "esbuild" : "oxc";
}

/**
 * A declared dependency range as a concrete range: `catalog:` references
 * resolve through the declaring manifest's catalogs (or its sibling
 * pnpm-workspace.yaml), `workspace:` references through the nearest workspace
 * root's member packages — anything else passes through untouched. A
 * reference that cannot be resolved answers undefined (unreadable), never a
 * guess: an unreadable preference is not a disagreement.
 */
function resolveDeclaredRange(
  range: string,
  depName: string,
  dir: string,
  pkg: Pkg,
): string | undefined {
  if (range.startsWith("catalog:")) return resolveCatalog(range, depName, dir, pkg);
  if (range.startsWith("workspace:")) return workspacePackageVersion(dir, depName);
  return range;
}

/**
 * The version a `workspace:` range answers, through the NEAREST workspace
 * root — the manifest at `dir` or one hop up that declares `workspaces` —
 * reading the member package named `name` (literal dirs and single-star dir
 * globs only, the same supported subset the workspace map honours;
 * negations and `node_modules` globs skipped, the never-walk invariant
 * intact). Unresolvable answers undefined.
 */
function workspacePackageVersion(fromDir: string, name: string): string | undefined {
  const start = path.resolve(fromDir);
  for (const dir of [start, path.dirname(start)]) {
    const root = readManifest(dir);
    if (!root) continue;
    const globs = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages;
    if (!globs) continue;
    for (const glob of globs) {
      if (typeof glob !== "string" || glob.startsWith("!") || glob.includes("node_modules"))
        continue;
      for (const member of workspaceMemberDirs(dir, glob)) {
        const manifest = readManifest(member);
        if (manifest?.name === name && typeof manifest.version === "string") {
          return manifest.version;
        }
      }
    }
  }
  return undefined;
}

/** The member dirs one glob names, at the supported subset (see workspacePackageVersion). */
function workspaceMemberDirs(rootDir: string, glob: string): string[] {
  if (!glob.includes("*")) return [path.resolve(rootDir, glob)];
  if (glob !== "*" && !glob.endsWith("/*")) return [];
  if (glob !== "*" && glob.lastIndexOf("*") !== glob.length - 1) return [];
  const parent = path.resolve(rootDir, glob === "*" ? "." : glob.slice(0, -2));
  if (path.basename(parent) === "node_modules") return [];
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e !== "node_modules" && !e.startsWith("."))
    .map((e) => path.join(parent, e));
}

/**
 * The vite family ONE store (a dir carrying a node_modules) answers with, in
 * the order the graph actually loads: the store-root vite first (the hoisted
 * copy a fresh bun install lands), then vitest's own nested copy, then the
 * vite range the INSTALLED VITEST's manifest declares (dependencies before
 * peers before optional — the contract a fresh install honours when no copy
 * is present), then the table by the installed vitest's major. A store
 * without a vitest in it answers undefined — it is not a store for this
 * question, and the walk continues above it.
 */
function installedViteFamilyAt(storeDir: string): number | undefined {
  const nm = path.join(storeDir, "node_modules");
  if (!existsSync(nm)) return undefined;
  const rootVite = versionInNodeModules(nm, "vite");
  const rootMajor = rootVite === undefined ? undefined : viteMajorOf(rootVite);
  if (rootMajor !== undefined) return rootMajor;
  const nested = versionInNodeModules(path.join(nm, "vitest", "node_modules"), "vite");
  const nestedMajor = nested === undefined ? undefined : viteMajorOf(nested);
  if (nestedMajor !== undefined) return nestedMajor;
  const vitestPkg = readManifest(path.join(nm, "vitest"));
  if (vitestPkg?.name !== "vitest") return undefined;
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    const range = vitestPkg[field]?.vite;
    if (!range) continue;
    const resolved = resolveDeclaredRange(range, "vite", storeDir, vitestPkg);
    if (resolved !== undefined) return vitestRangeToViteFamily(resolved);
  }
  if (typeof vitestPkg.version === "string") return vitestRangeToViteFamily(vitestPkg.version);
  return undefined;
}

function viteMajorOf(version: string): number | undefined {
  const m = /^(\d+)/.exec(version);
  return m ? Number(m[1]) : undefined;
}

/**
 * A dir carrying a repo root marker: the walk-up boundary for stores.
 * Beyond the repo there is no project for this question to be about — a
 * vitest in some tooling's home directory must not answer for the app.
 */
function isRepoBoundary(dir: string): boolean {
  return (
    existsSync(path.join(dir, ".git")) ||
    existsSync(path.join(dir, "bun.lock")) ||
    existsSync(path.join(dir, "bun.lockb"))
  );
}

/**
 * The vite generation the suite's vitest runs on — the number
 * jsxTransformFor switches on, and the answer the emitted config's JSX
 * mechanism must be honest about. Four legs, in order, each answering only
 * what it can prove:
 *
 * 1. An INSTALLED vitest, walking up from the suite dir. The nearest store
 *    wins: a suite that installed its own manifest runs ITS vitest — that is
 *    the copy its own test:unit script executes — and an app-store install
 *    (the pattern the execution tests use) answers one hop up. The walk
 *    stops after a dir carrying a .git or a bun lockfile, or at the
 *    filesystem root (isRepoBoundary), so nothing above the repo is ever
 *    consulted. Within a store, the installed vite outranks every declared
 *    range (installedViteFamilyAt).
 *
 * 2. The SUITE MANIFEST's own vitest pin — `<suiteDir>/package.json`,
 *    devDependencies before dependencies, references resolved — EXCEPT while
 *    its pin is byte-identical to `fallbackRange`, the tool's own generated
 *    default. A manifest holding the default the tool itself wrote last run
 *    is not a declaration: it is this tool's own output, and letting it
 *    answer would pin every fresh suite's config to the default's family no
 *    matter what the host actually runs (a host on `^5` with a fresh
 *    manifest would emit the esbuild spelling and red on vite 8). A pin the
 *    user chose — anything different from the default — outranks the host:
 *    the manifest is where the suite's install lives, and a boundary-
 *    spanning host range (`^2 || ^5`) defangs the moment the manifest says
 *    one thing.
 *
 * 3. The HOST-declared vitest, the same nearest-wins 8-hop walk
 *    detectAppReact makes (starting at the suite's parent, devDependencies
 *    before dependencies, references resolved). A range answers at its TOP —
 *    `>=2 <6` installs 5, so the config must be written for vite 8. An
 *    unreadable pin (a `workspace:*` no workspace root answers, a git/URL
 *    range) yields to the next hop rather than guessing.
 *
 * 4. `fallbackRange` itself — the tool's own default, the answer when
 *    nothing on the machine declared a version.
 */
export function hostViteFamily(opts: { suiteDir: string; fallbackRange: string }): number {
  const suiteDir = path.resolve(opts.suiteDir);
  let dir = suiteDir;
  for (;;) {
    const store = installedViteFamilyAt(dir);
    if (store !== undefined) return store;
    const up = path.dirname(dir);
    if (up === dir || isRepoBoundary(dir)) break;
    dir = up;
  }
  const manifest = readManifest(suiteDir);
  const declared = manifest?.devDependencies?.vitest ?? manifest?.dependencies?.vitest;
  const resolved =
    declared !== undefined && manifest !== undefined
      ? resolveDeclaredRange(declared, "vitest", suiteDir, manifest)
      : undefined;
  if (resolved !== undefined && resolved !== opts.fallbackRange) {
    return vitestRangeToViteFamily(resolved);
  }
  dir = path.dirname(suiteDir);
  for (let hop = 0; hop < 8; hop++) {
    const host = readManifest(dir);
    if (host) {
      const range = host.devDependencies?.vitest ?? host.dependencies?.vitest;
      if (range !== undefined) {
        const concrete = resolveDeclaredRange(range, "vitest", dir, host);
        if (concrete !== undefined) return vitestRangeToViteFamily(concrete);
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return vitestRangeToViteFamily(opts.fallbackRange);
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
