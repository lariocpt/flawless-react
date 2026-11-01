import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Which react-dom specifier a document-root spec must import
 * `renderToReadableStream` from — measured against the react-dom the suite is
 * pinned to, never assumed from a version table.
 *
 * Measured 1 Nov on installed packages (dogfood defect #3):
 *
 * ```text
 * react-dom@19.1.0  server.node.js    renderToPipeableStream renderToStaticMarkup renderToString version
 *                   server.browser.js renderToReadableStream renderToStaticMarkup renderToString version
 * react-dom@19.2.0  server.node.js    + renderToReadableStream resume resumeToPipeableStream
 *                   server.browser.js renderToReadableStream renderToStaticMarkup renderToString resume version
 * ```
 *
 * The emitted vitest config aliases `react-dom/server` to the FILE
 * `react-dom/server.js`, which is `module.exports = require("./server.node")`
 * — the node build. So on 19.1.0 the specifier the specs used carried no
 * streaming renderer ("renderToReadableStream is not a function"), while
 * `react-dom/server.browser` carries it on 18.x, 19.1 and 19.2 alike: the
 * specifier is the bug, not the alias (other specs legitimately want the node
 * build's `renderToString`). This module reads the installed files instead of
 * encoding that table as eternal truth — if a future react-dom moves the
 * export again, the probe follows the bytes.
 */

export interface ServerStreamProbe {
  /**
   * The specifier whose resolved build exports `renderToReadableStream`.
   * Undefined only when an installed react-dom was measured and NEITHER
   * candidate carries the export — the capability gap the spec must skip by
   * name instead of reddening with "is not a function".
   */
  specifier?: string;
  /** The react-dom version that was inspected; undefined when none is installed. */
  version?: string;
}

const EXPORT = "renderToReadableStream";

/** The specifier that carries the export on every react-dom from 18 up —
 *  the answer when there is no installed package to measure. */
const PREFERRED_SPECIFIER = "react-dom/server.browser";

/** Preference order: `server.browser` first — it carries the export on every
 *  react-dom from 18 up, while bare `server` (the node build) only gained it
 *  in 19.2. Measured, see the table above. */
const CANDIDATES: ReadonlyArray<readonly [specifier: string, entry: string]> = [
  [PREFERRED_SPECIFIER, "server.browser.js"],
  ["react-dom/server", "server.js"],
];

/**
 * Does the file export the name — directly, or through the dispatcher files
 * react-dom uses (`module.exports = require("./cjs/…")` under a NODE_ENV
 * branch)? Bounded depth: react-dom's chain is entry → cjs bundle, two hops
 * at most (`server.js` → `server.node.js` → `cjs/react-dom-server.node.*`).
 */
function fileExports(file: string, name: string, depth = 2): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (new RegExp(`exports\\.${name}\\s*=`).test(text)) return true;
  if (depth <= 0) return false;
  for (const m of text.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
    const rel = m[1];
    if (!rel) continue;
    const target = path.resolve(path.dirname(file), rel);
    const resolved = existsSync(target) ? target : `${target}.js`;
    if (fileExports(resolved, name, depth - 1)) return true;
  }
  return false;
}

/**
 * Does the build the given `react-dom/…` specifier resolves to actually
 * export `renderToReadableStream` in this react-dom package? The guard's
 * primitive: it checks the specifier a spec ACTUALLY used, not the probe's
 * preference — on a 19.2 surface bare `react-dom/server` passes too, and a
 * guard that said otherwise would encode 19.1's table as eternal truth.
 * With no package to measure, nothing can be refuted: returns true.
 */
export function specifierExportsServerStream(
  reactDomDir: string | undefined,
  specifier: string,
): boolean {
  if (!reactDomDir || !existsSync(reactDomDir)) return true;
  const entry = CANDIDATES.find(([s]) => s === specifier)?.[1];
  if (!entry) return false;
  return fileExports(path.join(reactDomDir, entry), EXPORT);
}

/**
 * Probe the react-dom package directory (e.g. `<node_modules>/react-dom`) the
 * emitted aliases point at and answer which specifier its build exports
 * `renderToReadableStream` from. With nothing installed to measure, answer the
 * specifier that is correct for every react-dom from 18 up (table above) —
 * generation before `bun install` must not emit the 19.1-broken specifier.
 */
export function probeServerStream(reactDomDir?: string): ServerStreamProbe {
  if (!reactDomDir || !existsSync(reactDomDir)) return { specifier: PREFERRED_SPECIFIER };
  let version: string | undefined;
  try {
    version = (
      JSON.parse(readFileSync(path.join(reactDomDir, "package.json"), "utf8")) as {
        version?: string;
      }
    ).version;
  } catch {
    // No readable package.json: the probe still answers by the bytes of the
    // entry files; the version only decorates the skip reason.
  }
  for (const [specifier] of CANDIDATES) {
    if (specifierExportsServerStream(reactDomDir, specifier)) return { specifier, version };
  }
  return { version };
}
