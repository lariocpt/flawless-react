import path from "node:path";

/**
 * Map an expo-router file to its route.
 *
 * Close to the Next.js app router, and deliberately a SIBLING of pageFileToRoute
 * rather than a parameterisation of it, because the central rule is different:
 * in expo-router **the leaf file IS the route** (`app/login.tsx` -> `/login`),
 * where Next needs a `page.tsx` inside a directory. Sharing one function would
 * mean a `kind` parameter that changes what the last path segment means, which
 * is the sort of coincidence-as-rule NEXT_SCRIPT's own comment warns about.
 */
export interface ExpoRoute {
  /** URL path with dynamic segments kept in brackets: /items/[id]. */
  urlPath: string;
  /** Dynamic segment names in order: ["id"]. */
  params: string[];
  /** Safe file stem for a spec: items-id. */
  specStem: string;
  /**
   * The `_layout` chain this route mounts inside, outermost first, as paths
   * relative to the router root without extension: ["_layout", "(tabs)/_layout"].
   *
   * renderRouter needs them: a screen under `(tabs)` renders inside that Tabs
   * navigator, and mounting it without its layouts is not the screen the app
   * ships.
   */
  layouts: string[];
}

const ROUTE_EXT = /\.(tsx|jsx|ts|js)$/;

/**
 * Files expo-router does not route.
 *
 * `_layout` is a layout. The `+` prefix is RESERVED by expo-router for its own
 * files — `+not-found`, `+html`, `+native-intent`, `+api` — so anything starting
 * with it is excluded by rule rather than by listing the four, which would rot
 * the moment expo-router adds a fifth.
 */
function isRoutable(base: string): boolean {
  if (base.startsWith("+")) return false;
  return base !== "_layout";
}

export function expoFileToRoute(file: string, routerRoot: string): ExpoRoute | undefined {
  const abs = path.resolve(file);
  const rel = path.relative(path.resolve(routerRoot), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;

  const parts = rel.split(path.sep);
  const last = parts.pop();
  if (!last || !ROUTE_EXT.test(last)) return undefined;
  const base = last.replace(ROUTE_EXT, "");
  if (!isRoutable(base)) return undefined;

  const layouts = layoutChain(parts);

  // The leaf contributes a segment unless it is `index`, which IS its directory.
  const leafSegments = base === "index" ? [] : [base];
  const segments: string[] = [];
  const params: string[] = [];

  for (const seg of [...parts, ...leafSegments]) {
    // Route groups vanish from the URL — including as the leaf, so
    // `app/(tabs)/index.tsx` is "/", not "/(tabs)".
    if (/^\(.*\)$/.test(seg)) continue;
    const rest = /^\[\.\.\.(.+)\]$/.exec(seg);
    if (rest?.[1]) {
      params.push(rest[1]);
      segments.push(`[...${rest[1]}]`);
      continue;
    }
    const dynamic = /^\[(.+)\]$/.exec(seg);
    if (dynamic?.[1]) {
      params.push(dynamic[1]);
      segments.push(`[${dynamic[1]}]`);
      continue;
    }
    segments.push(seg);
  }

  const urlPath = segments.length === 0 ? "/" : `/${segments.join("/")}`;
  return { urlPath, params, specStem: stemFor(segments), layouts };
}

/**
 * The `_layout` chain enclosing a route, outermost first.
 *
 * Derived from the path alone — every ancestor directory MAY have a layout, and
 * whether it does is a filesystem question the caller answers. Returned as
 * extensionless module ids because that is what renderRouter's in-memory context
 * is keyed by.
 */
function layoutChain(dirs: string[]): string[] {
  const out = ["_layout"];
  const acc: string[] = [];
  for (const d of dirs) {
    acc.push(d);
    out.push(`${acc.join("/")}/_layout`);
  }
  return out;
}

/**
 * A spec stem. Collisions are REAL here in a way they are not on the Next side:
 * `app/(a)/x.tsx` and `app/(b)/x.tsx` are different routes that both stem to
 * "x", because groups vanish. The caller resolves that with allocateStems below
 * rather than hoping.
 */
function stemFor(segments: string[]): string {
  if (segments.length === 0) return "index";
  return segments
    .map((s) => s.replace(/\[\.\.\.(.+)\]/, "$1").replace(/\[(.+)\]/, "$1"))
    .join("-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Unique stems over the FULL route list.
 *
 * The same invariant allocateSpecNames documents: allocate over everything, then
 * filter. Doing it the other way makes two callers disagree about a name, and
 * here it would silently overwrite one route's spec with another's.
 */
export function allocateRouteStems(routes: ExpoRoute[]): Map<ExpoRoute, string> {
  const taken = new Set<string>();
  const out = new Map<ExpoRoute, string>();
  for (const r of routes) {
    let stem = r.specStem;
    let i = 2;
    while (taken.has(stem)) stem = `${r.specStem}-${i++}`;
    taken.add(stem);
    out.set(r, stem);
  }
  return out;
}

/** The module id renderRouter's in-memory context keys a file by. */
export function routeModuleId(file: string, routerRoot: string): string {
  const rel = path.relative(path.resolve(routerRoot), path.resolve(file));
  return rel.split(path.sep).join("/").replace(ROUTE_EXT, "");
}
