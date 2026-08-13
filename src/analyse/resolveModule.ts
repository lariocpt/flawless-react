import { existsSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Project-local module resolution for the analyser: relative specifiers plus
 * tsconfig `paths` aliases (with `extends` chains) and `baseUrl` fallback.
 * Bare package specifiers (react, next/link, …) intentionally resolve to
 * undefined — node_modules is never walked into.
 */

interface PathPattern {
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

export class ModuleResolver {
  /** dir → nearest resolved tsconfig (null = no tsconfig above this dir). */
  private dirCache = new Map<string, ResolvedTsconfig | null>();
  /** configPath → parsed chain result. */
  private configCache = new Map<string, ResolvedTsconfig>();

  /** Resolve `spec` as imported from `importerAbsPath`. Undefined for bare/unresolvable. */
  resolve(spec: string, importerAbsPath: string): string | undefined {
    if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) {
      return probeModuleFile(path.resolve(path.dirname(importerAbsPath), spec));
    }
    const config = this.nearestConfig(path.dirname(importerAbsPath));
    if (!config) return undefined;

    const match = this.matchPattern(config, spec);
    if (match) return match;

    if (config.baseUrlDir) {
      return probeModuleFile(path.resolve(config.baseUrlDir, spec));
    }
    return undefined;
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
    let pathsEntry: { dir: string; paths: Record<string, unknown>; baseUrlDir?: string } | undefined;
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
