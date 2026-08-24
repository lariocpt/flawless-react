import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Project-local module resolution for the analyser: relative specifiers,
 * tsconfig `paths` aliases (with `extends` chains) and `baseUrl` fallback,
 * then the monorepo's own workspace packages (`@scope/shared`) resolved to
 * their SOURCE trees. Bare THIRD-PARTY specifiers (react, next/link, …)
 * still intentionally resolve to undefined — node_modules is never walked
 * into; only directories the workspace map enumerates are entered, and all
 * of those live inside the repo.
 */

export interface PathPattern {
  /** Key split on its single `*`; exact keys have no star. */
  prefix: string;
  suffix: string;
  exact: boolean;
  /** Raw target strings with `*` preserved, in declared order. */
  targets: string[];
  /** Directory targets resolve against. */
  baseDir: string;
}

interface ResolvedTsconfig {
  configPath: string;
  baseUrlDir: string | undefined;
  patterns: PathPattern[];
}

const MODULE_SUFFIXES = [".tsx", ".ts", "/index.tsx", "/index.ts"];

/** Try `base` as a module file: as-is, extension-swapped, then index files. */
export function probeModuleFile(base: string): string | undefined {
  if (existsSync(base) && !isDirectory(base)) return base;
  const stripped = base.replace(/\.(jsx?|tsx?)$/, "");
  for (const ext of MODULE_SUFFIXES) {
    const candidate = `${stripped}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

interface WorkspaceMap {
  rootDir: string;
  /** package.json `name` → absolute package dir. */
  packages: Map<string, string>;
}

/**
 * The workspace glob list declared at `dir`, or undefined when `dir` is not
 * a workspace root. package.json `workspaces` (array or `{ packages: [] }`)
 * and pnpm-workspace.yaml are unioned when both exist — resolving a true
 * member is never wrong whichever manager owns the repo.
 */
function workspaceGlobs(dir: string): string[] | undefined {
  const globs: string[] = [];
  const pkgPath = path.join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (ws) globs.push(...ws.filter((g): g is string => typeof g === "string"));
    } catch {
      // Unparseable package.json: not a workspace root we can trust.
    }
  }
  const pnpmPath = path.join(dir, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) globs.push(...pnpmWorkspacePackages(pnpmPath));
  return globs.length > 0 ? globs : undefined;
}

/**
 * The top-level `packages:` list of a pnpm-workspace.yaml, without a YAML
 * dependency: consume `- entry` lines until the first non-list line. Fancy
 * YAML (anchors, flow lists) yields nothing — the bail-safe direction.
 */
function pnpmWorkspacePackages(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  let inList = false;
  for (const line of text.split("\n")) {
    if (/^packages\s*:\s*(#.*)?$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const m = /^\s+-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
    if (m?.[1]) out.push(m[1]);
    else if (line.trim() !== "" && !line.startsWith(" ")) break;
  }
  return out;
}

/**
 * Enumerate the packages the globs name. The supported subset is literal
 * dirs and single-star dir globs (`packages/*`) — anything fancier (`**`,
 * negations, mid-pattern stars) is silently skipped, because resolution
 * returning undefined is the bail-safe direction. node_modules is refused
 * even when a glob names it: the never-walk invariant outranks the map.
 */
function buildWorkspaceMap(rootDir: string, globs: string[]): WorkspaceMap {
  const packages = new Map<string, string>();
  const addPackage = (pkgDir: string): void => {
    const pkgJson = path.join(pkgDir, "package.json");
    if (!existsSync(pkgJson)) return;
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: string };
      if (typeof pkg.name === "string" && pkg.name.length > 0 && !packages.has(pkg.name)) {
        packages.set(pkg.name, pkgDir);
      }
    } catch {
      // Unreadable member manifest: skip the package, keep the map.
    }
  };
  for (const glob of globs) {
    if (glob.includes("node_modules")) continue;
    if (glob.startsWith("!")) continue;
    const star = glob.indexOf("*");
    if (star === -1) {
      addPackage(path.resolve(rootDir, glob));
      continue;
    }
    // Single trailing dir star only: `packages/*` or bare `*`.
    if (glob !== "*" && !glob.endsWith("/*")) continue;
    if (glob.indexOf("*") !== glob.lastIndexOf("*")) continue;
    const parent = glob === "*" ? rootDir : path.resolve(rootDir, glob.slice(0, -2));
    if (path.basename(parent) === "node_modules" || !isDirectory(parent)) continue;
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const pkgDir = path.join(parent, entry);
      if (isDirectory(pkgDir)) addPackage(pkgDir);
    }
  }
  return { rootDir, packages };
}

export class ModuleResolver {
  /** dir → nearest resolved tsconfig (null = no tsconfig above this dir). */
  private dirCache = new Map<string, ResolvedTsconfig | null>();
  /** configPath → parsed chain result. */
  private configCache = new Map<string, ResolvedTsconfig>();
  /** dir → nearest workspace map (null = no workspace root above this dir). */
  private workspaceDirCache = new Map<string, WorkspaceMap | null>();
  /** workspace root dir → built map. */
  private workspaceCache = new Map<string, WorkspaceMap>();

  /** The tsconfig path patterns in effect for files under `dir` (for alias re-emission). */
  aliasPatternsFor(dir: string): PathPattern[] {
    return this.nearestConfig(dir)?.patterns ?? [];
  }

  /** Resolve `spec` as imported from `importerAbsPath`. Undefined for bare/unresolvable. */
  resolve(spec: string, importerAbsPath: string): string | undefined {
    if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
      return probeModuleFile(path.resolve(path.dirname(importerAbsPath), spec));
    }
    const importerDir = path.dirname(importerAbsPath);
    const config = this.nearestConfig(importerDir);
    if (config) {
      const match = this.matchPattern(config, spec);
      if (match) return match;

      if (config.baseUrlDir) {
        const hit = probeModuleFile(path.resolve(config.baseUrlDir, spec));
        if (hit) return hit;
      }
    }
    // Both non-workspace exits (no tsconfig at all, and a paths/baseUrl
    // miss) fall through here: a workspace app often has no tsconfig of its
    // own, and gating the branch on one would silently keep it failing.
    return this.resolveWorkspace(spec, importerDir);
  }

  /**
   * A bare specifier as one of the monorepo's own workspace packages,
   * resolved to its SOURCE tree — never `exports`/`main`/`types`: dist is
   * routinely stale or absent, and `.d.ts` files have no function bodies for
   * the fetch-wrapper path to read. probeModuleFile only knows .ts/.tsx, so
   * a .js-source or .d.ts-only package misses here exactly like a package
   * that does not exist — bail-safe, and deliberate.
   */
  private resolveWorkspace(spec: string, importerDir: string): string | undefined {
    const ws = this.nearestWorkspace(importerDir);
    if (!ws) return undefined;
    let best: { name: string; dir: string } | undefined;
    for (const [name, dir] of ws.packages) {
      if (spec !== name && !spec.startsWith(`${name}/`)) continue;
      if (!best || name.length > best.name.length) best = { name, dir };
    }
    if (!best) return undefined;
    const subpath = spec === best.name ? undefined : spec.slice(best.name.length + 1);
    const bases =
      subpath === undefined
        ? [path.join(best.dir, "src", "index"), path.join(best.dir, "index")]
        : [path.join(best.dir, "src", subpath), path.join(best.dir, subpath)];
    for (const base of bases) {
      const hit = probeModuleFile(base);
      if (hit) return hit;
    }
    return undefined;
  }

  private nearestWorkspace(fromDir: string): WorkspaceMap | null {
    const visited: string[] = [];
    let dir = path.resolve(fromDir);
    for (;;) {
      const cached = this.workspaceDirCache.get(dir);
      if (cached !== undefined) {
        for (const v of visited) this.workspaceDirCache.set(v, cached);
        return cached;
      }
      visited.push(dir);
      const globs = workspaceGlobs(dir);
      if (globs) {
        const built = this.workspaceCache.get(dir) ?? buildWorkspaceMap(dir, globs);
        this.workspaceCache.set(dir, built);
        for (const v of visited) this.workspaceDirCache.set(v, built);
        return built;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        for (const v of visited) this.workspaceDirCache.set(v, null);
        return null;
      }
      dir = parent;
    }
  }

  private matchPattern(config: ResolvedTsconfig, spec: string): string | undefined {
    for (const p of config.patterns) {
      if (p.exact) {
        if (spec !== p.prefix) continue;
        for (const target of p.targets) {
          const hit = probeModuleFile(path.resolve(p.baseDir, target));
          if (hit) return hit;
        }
        continue;
      }
      if (
        spec.startsWith(p.prefix) &&
        spec.endsWith(p.suffix) &&
        spec.length >= p.prefix.length + p.suffix.length
      ) {
        const captured = spec.slice(p.prefix.length, spec.length - p.suffix.length);
        for (const target of p.targets) {
          const substituted = target.replace("*", captured);
          const hit = probeModuleFile(path.resolve(p.baseDir, substituted));
          if (hit) return hit;
        }
      }
    }
    return undefined;
  }

  private nearestConfig(fromDir: string): ResolvedTsconfig | null {
    const visited: string[] = [];
    let dir = path.resolve(fromDir);
    for (;;) {
      const cached = this.dirCache.get(dir);
      if (cached !== undefined) {
        for (const v of visited) this.dirCache.set(v, cached);
        return cached;
      }
      visited.push(dir);
      const candidate = path.join(dir, "tsconfig.json");
      if (existsSync(candidate)) {
        const resolved = this.parseConfigChain(candidate);
        for (const v of visited) this.dirCache.set(v, resolved);
        return resolved;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        for (const v of visited) this.dirCache.set(v, null);
        return null;
      }
      dir = parent;
    }
  }

  private parseConfigChain(configPath: string): ResolvedTsconfig {
    const cached = this.configCache.get(configPath);
    if (cached) return cached;

    // Walk the extends chain collecting raw configs root-first (child last),
    // so later entries override earlier ones with TS semantics: `paths` and
    // `baseUrl` are replaced wholesale by whichever config declares them last.
    const chain: Array<{ dir: string; options: Record<string, unknown> }> = [];
    const seen = new Set<string>();
    const load = (p: string): void => {
      const abs = path.resolve(p);
      if (seen.has(abs)) return;
      seen.add(abs);
      const read = ts.readConfigFile(abs, ts.sys.readFile);
      const config = (read.config ?? {}) as {
        extends?: string | string[];
        compilerOptions?: Record<string, unknown>;
      };
      const dir = path.dirname(abs);
      const bases = config.extends
        ? Array.isArray(config.extends)
          ? config.extends
          : [config.extends]
        : [];
      for (const base of bases) {
        const resolved = this.resolveExtends(base, dir);
        if (resolved) load(resolved);
      }
      chain.push({ dir, options: config.compilerOptions ?? {} });
    };
    load(configPath);

    let baseUrlDir: string | undefined;
    let pathsEntry:
      | { dir: string; paths: Record<string, unknown>; baseUrlDir?: string }
      | undefined;
    for (const { dir, options } of chain) {
      const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : undefined;
      if (baseUrl !== undefined) baseUrlDir = path.resolve(dir, baseUrl);
      const paths = options.paths;
      if (paths && typeof paths === "object") {
        pathsEntry = { dir, paths: paths as Record<string, unknown>, baseUrlDir };
      }
    }

    const patterns: PathPattern[] = [];
    if (pathsEntry) {
      // Without baseUrl (TS >= 4.1), paths resolve against the declaring config's dir.
      const baseDir = pathsEntry.baseUrlDir ?? pathsEntry.dir;
      for (const [key, rawTargets] of Object.entries(pathsEntry.paths)) {
        if (!Array.isArray(rawTargets)) continue;
        const targets = rawTargets.filter((t): t is string => typeof t === "string");
        if (targets.length === 0) continue;
        const star = key.indexOf("*");
        if (star === -1) {
          patterns.push({ prefix: key, suffix: "", exact: true, targets, baseDir });
        } else {
          patterns.push({
            prefix: key.slice(0, star),
            suffix: key.slice(star + 1),
            exact: false,
            targets,
            baseDir,
          });
        }
      }
      // Longest prefix wins.
      patterns.sort((a, b) => b.prefix.length - a.prefix.length);
    }

    const result: ResolvedTsconfig = { configPath, baseUrlDir, patterns };
    this.configCache.set(configPath, result);
    return result;
  }

  private resolveExtends(spec: string, fromDir: string): string | undefined {
    if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
      const base = path.resolve(fromDir, spec);
      if (existsSync(base) && !isDirectory(base)) return base;
      if (existsSync(`${base}.json`)) return `${base}.json`;
      if (existsSync(path.join(base, "tsconfig.json"))) return path.join(base, "tsconfig.json");
      return undefined;
    }
    // Bare specifier (@tsconfig/foo): probe node_modules upward from the config dir.
    let dir = fromDir;
    for (;;) {
      const root = path.join(dir, "node_modules", spec);
      for (const candidate of [root, `${root}.json`, path.join(root, "tsconfig.json")]) {
        if (existsSync(candidate) && !isDirectory(candidate)) return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}
