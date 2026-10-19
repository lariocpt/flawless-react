import { readdirSync } from "node:fs";
import path from "node:path";
import { flattenTrees } from "../scaffold-tests/registry.ts";
import type { ComponentTree } from "../types.ts";
import { isAuthLibSpecifier } from "./authShims.ts";
import { providerShimModules } from "./providerWraps.ts";

/**
 * Will this suite boot at all?
 *
 * Vitest resolves a spec's imports when it COLLECTS the file, before a single
 * test runs, and a module it cannot resolve takes the whole file down with the
 * message `Failed to resolve import "x"`. That failure is loud in the run log
 * and absent from REPORT.md, so lightswind-ui-library's first run read as
 * "401 files failed, no tests" with nothing explaining itself — while every one
 * of those files imported `framer-motion`, a package the app declares nowhere
 * and has nowhere on disk, because it expects its CONSUMERS to provide it.
 *
 * This module answers the question at generation time: for every bare package
 * specifier the analysed sources import, is the package installed anywhere the
 * suite will look for it? It is a diagnostic, not a gate — a suite can still be
 * worth generating for the components that DO boot.
 */

/** One module that the analysed sources import and the suite cannot resolve. */
export interface UnresolvableImport {
  /** Specifier as written in the source (`framer-motion`, `@scope/pkg/sub`). */
  specifier: string;
  /** The package whose presence was tested (`framer-motion`, `@scope/pkg`). */
  pkg: string;
  /** How many analysed components import it. */
  count: number;
  /** Up to this many component names, for the report's examples column. */
  examples: string[];
}

/** Vite owns these: loaders, not node resolution, so they are never a miss. */
const ASSET_SUFFIXES = [
  ".css",
  ".module.css",
  ".scss",
  ".sass",
  ".less",
  ".styl",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".bmp",
  ".mp3",
  ".mp4",
  ".webm",
  ".wav",
  ".ogg",
  ".mov",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".md",
  ".mdx",
  ".txt",
  ".csv",
  ".wasm",
  ".graphql",
  ".gql",
];

/**
 * Specifier → package name, or undefined when the specifier is not a bare
 * package reference at all: relative, absolute, a runtime scheme (`node:`,
 * `bun:`, `virtual:`), or an asset vite resolves with a loader. `@scope/pkg/sub`
 * answers `@scope/pkg`.
 */
export function packageNameOf(specifier: string): string | undefined {
  if (!specifier) return undefined;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return undefined;
  // `@/…` is the most common path alias in React, and a scope of nothing is not
  // a package: npm requires a name after the `@`.
  if (specifier.startsWith("@/")) return undefined;
  if (/^[a-z]+:/.test(specifier) && !specifier.startsWith("@")) return undefined;
  const bare = specifier.split(/[?#]/)[0] ?? specifier;
  const lower = bare.toLowerCase();
  if (ASSET_SUFFIXES.some((ext) => lower.endsWith(ext))) return undefined;
  const parts = bare.split("/");
  if (parts[0]?.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0];
}

/**
 * Specifiers the suite already answers without the package being installed:
 * the provider shims (canonical name and alias modules) and the auth stubs.
 * `next/*`, `server-only` and `client-only` join because the specs `vi.mock`
 * the framework's own namespace and every Next app resolves those through
 * Next's bundler, not through a package on disk.
 */
function isStubsIt(specifier: string, pkg: string): boolean {
  if (pkg === "server-only" || pkg === "client-only") return true;
  if (specifier.startsWith("next/")) return true;
  if (providerShimModules().includes(pkg)) return true;
  return isAuthLibSpecifier(specifier);
}

/**
 * Names of the packages in `<dir>/node_modules`, with `@scope/pkg` entries
 * expanded (a scope directory is not a package). Cached per directory: a sweep
 * walks the same two or three ancestors thousands of times.
 */
function installedNames(
  dir: string,
  cache: Map<string, Set<string> | undefined>,
): Set<string> | undefined {
  const nm = path.join(dir, "node_modules");
  const seen = cache.get(nm);
  if (seen !== undefined) return seen;
  let out: Set<string> | undefined;
  try {
    out = new Set<string>();
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith(".")) continue;
      // A scope directory is not a package: `@acme` answers to no import, and
      // adding it would make every `@acme/*` specifier look installed.
      if (entry.startsWith("@")) {
        try {
          for (const inner of readdirSync(path.join(nm, entry))) out.add(`${entry}/${inner}`);
        } catch {
          /* unreadable scope: nothing to add */
        }
        continue;
      }
      out.add(entry);
    }
  } catch {
    out = undefined;
  }
  cache.set(nm, out);
  return out;
}

/**
 * Is this specifier present in the node_modules of `dir` or any ancestor?
 * Checked by prefix so a subpath (`framer-motion/dom`) counts as its package:
 * exports-map and file-level correctness is not what this reports, and a false
 * "missing" is worse than a false "present".
 */
function isInstalled(
  pkg: string,
  fromDirs: string[],
  cache: Map<string, Set<string> | undefined>,
): boolean {
  for (const start of fromDirs) {
    let dir = start;
    for (let hop = 0; hop < 12; hop++) {
      const names = installedNames(dir, cache);
      if (names) {
        const parts = pkg.split("/");
        for (let n = parts.length; n > 0; n--) {
          if (names.has(parts.slice(0, n).join("/"))) return true;
        }
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return false;
}

/**
 * The bare packages the analysed components import that are installed nowhere
 * the suite will resolve them.
 *
 * Resolution is per IMPORTER, because that is what vite does: the walk-up
 * starts at the file holding the import, so a package installed by a nested
 * package is found by that package's components and missed by everyone else —
 * whose specs really do fail, which is exactly what this reports. `extraDirs`
 * adds roots that are not source directories: the suite directory (its own
 * node_modules holds the test stack) and the project root.
 *
 * Returns nothing when NO node_modules tree is visible from any of those
 * directories. A Yarn-PnP or never-installed checkout cannot be judged by
 * looking for a directory layout it does not use, and a report that called
 * every import missing would be a lie with a straight face.
 */
export function findUnresolvableImports(
  trees: ComponentTree[],
  extraDirs: string[] = [],
): UnresolvableImport[] {
  const cache = new Map<string, Set<string> | undefined>();
  // Bail condition first: is there anything to judge against at all?
  const sourceDirs = flattenTrees(trees).map((c) => path.dirname(c.info.filePath));
  const anyTree = [...sourceDirs, ...extraDirs].some((dir) => {
    let at = dir;
    for (let hop = 0; hop < 12; hop++) {
      if (installedNames(at, cache) !== undefined) return true;
      const up = path.dirname(at);
      if (up === at) break;
      at = up;
    }
    return false;
  });
  if (!anyTree) return [];

  const bySpec = new Map<string, { pkg: string; names: Set<string> }>();
  for (const { info } of flattenTrees(trees)) {
    const fromDirs = [path.dirname(info.filePath), ...extraDirs];
    for (const mi of info.moduleImports ?? []) {
      // `import type` is erased before vite sees it; a side-effect import has
      // no binding to lose, and neither is collected here anyway.
      if (mi.isTypeOnly) continue;
      // The analyser already resolved it — through a tsconfig `paths` alias or a
      // relative path — so the file is on disk and vite will find it too. This
      // is what keeps `@/components/ui` off the list in the app that aliases it.
      if (mi.resolvedPath) continue;
      const pkg = packageNameOf(mi.specifier);
      if (!pkg || isStubsIt(mi.specifier, pkg)) continue;
      if (isInstalled(pkg, fromDirs, cache)) continue;
      const row = bySpec.get(mi.specifier) ?? { pkg, names: new Set<string>() };
      row.names.add(info.componentName);
      bySpec.set(mi.specifier, row);
    }
  }

  const out: UnresolvableImport[] = [];
  for (const [specifier, row] of bySpec) {
    const examples = [...row.names].sort().slice(0, 3);
    out.push({ specifier, pkg: row.pkg, count: row.names.size, examples });
  }
  return out.sort((a, b) => b.count - a.count || (a.specifier < b.specifier ? -1 : 1));
}
