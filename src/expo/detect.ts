import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { detectReactCompiler } from "../reactCompiler.ts";
import { type ExpoContext, UsageError } from "../types.ts";

/**
 * Read an Expo project off disk, the way `detectNextjs` reads a Next.js one.
 *
 * Deliberately the same shape: probe for the framework, throw a UsageError
 * naming the fix when it is not there, and return a context object carrying the
 * facts downstream needs — so a task branches once on `ctx.expo` instead of
 * re-reading app.json.
 *
 * Everything here is filesystem-only. Nothing is inferred from a component, and
 * nothing is defaulted where a wrong value would be worse than an absent one
 * (see `sdkMajor`).
 */
export async function detectExpo(root: string): Promise<ExpoContext> {
  const abs = path.resolve(root);
  if (!existsSync(abs)) {
    throw new UsageError(`expo: directory not found: ${abs}`);
  }
  if (!looksLikeExpo(abs)) {
    throw new UsageError(
      `expo: ${abs} does not look like an Expo project ` +
        `(no app.json/app.config with an "expo" key, and no "expo" in package.json).`,
    );
  }

  const pkg = readJson(path.join(abs, "package.json"));
  const deps = {
    ...((pkg?.dependencies as Record<string, string>) ?? {}),
    ...((pkg?.devDependencies as Record<string, string>) ?? {}),
  };

  const routerRoot = detectRouterRoot(abs, deps);
  // One probe for every mode (src/reactCompiler.ts), so the web and expo answers
  // cannot drift and `perf-static` reads one fact. The boolean is all ExpoContext
  // has ever carried; the evidence beside it reaches tasks on RunContext.
  return {
    root: abs,
    routerRoot,
    sdkMajor: majorOf(deps.expo, path.join(abs, "node_modules", "expo", "package.json")),
    routerMajor: majorOf(
      deps["expo-router"],
      path.join(abs, "node_modules", "expo-router", "package.json"),
    ),
    reactCompiler: detectReactCompiler(abs).state === "on",
    nativewind: detectNativewind(abs),
    webPort: expoWebPort(pkg?.scripts as Record<string, string> | undefined),
  };
}

function looksLikeExpo(dir: string): boolean {
  for (const f of ["app.json", "app.config.js", "app.config.ts", "app.config.mjs"]) {
    const p = path.join(dir, f);
    if (!existsSync(p)) continue;
    // A config file alone is not proof — app.json is a generic name. The `expo`
    // key is, and for the .js/.ts forms (which we will not execute) the string
    // is the closest honest signal.
    if (f === "app.json") {
      if (readJson(p)?.expo !== undefined) return true;
      continue;
    }
    try {
      if (/\bexpo\b/.test(readFileSync(p, "utf8"))) return true;
    } catch {
      /* unreadable config proves nothing either way */
    }
  }
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return false;
  const deps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };
  return deps.expo !== undefined;
}

/**
 * The expo-router app directory, or undefined for a project that routes some
 * other way (react-navigation by hand, a single-screen app).
 *
 * `app/` alone is not enough: the directory name is generic and a Next.js
 * project has one too. expo-router has to actually be a dependency.
 */
function detectRouterRoot(dir: string, deps: Record<string, string>): string | undefined {
  if (deps["expo-router"] === undefined) return undefined;
  for (const rel of ["app", "src/app"]) {
    const candidate = path.join(dir, rel);
    if (isDir(candidate)) return candidate;
  }
  return undefined;
}

/** NativeWind is wired through babel — the only route by which `className` works. */
function detectNativewind(dir: string): boolean {
  return configMentions(
    dir,
    ["babel.config.js", "babel.config.cjs", "babel.config.mjs"],
    ["nativewind"],
  );
}

function configMentions(dir: string, files: string[], needles: string[]): boolean {
  for (const f of files) {
    const p = path.join(dir, f);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, "utf8");
      if (needles.some((n) => text.includes(n))) return true;
    } catch {
      /* unreadable config proves nothing */
    }
  }
  return false;
}

/**
 * The port `expo start --web` serves on.
 *
 * A sibling of `devScriptPort`, not a parameterisation of it: the script key
 * differs (`web`, then `start` — never `dev`) AND the default differs (Metro's
 * 8081, not 3000). One function with two key lists and two defaults would encode
 * a coincidence as a rule, which is the mistake `NEXT_SCRIPT`'s own comment
 * warns about. Only the flag regex is genuinely shared, and it is one line.
 */
export function expoWebPort(scripts: Record<string, string> | undefined): number {
  for (const key of ["web", "start"]) {
    const script = scripts?.[key];
    if (script === undefined) continue;
    const m = /(?:-p|--port)[=\s]*(\d+)/.exec(script);
    if (m?.[1]) {
      const port = Number(m[1]);
      if (Number.isFinite(port)) return port;
    }
  }
  return 8081;
}

/**
 * The major version of a dependency, from the project's declared range and
 * failing that from what is actually installed.
 *
 * Installed truth beats a declared range on purpose: `~54.0.33` and an installed
 * 54.0.34 agree, but `latest`, `*` and a git or file: specifier name no version
 * at all, and node_modules does. Returns undefined when neither answers —
 * because jest-expo's major has to MATCH the SDK's, and a guessed 54 against an
 * SDK 53 project fails deep inside expo-modules-core with a message that names
 * nothing. The caller says "unknown"; it never substitutes a number.
 */
export function majorOf(range: string | undefined, installedPkgJson: string): number | undefined {
  const fromRange = range === undefined ? undefined : majorOfRange(range);
  if (fromRange !== undefined) return fromRange;
  const installed = readJson(installedPkgJson)?.version;
  return typeof installed === "string" ? majorOfRange(installed) : undefined;
}

function majorOfRange(range: string): number | undefined {
  // The leading digits of the first version-looking token: covers "54.0.33",
  // "~54.0.33", "^54", ">=54.0.0 <55", and "54.x". Not "latest", "*", "next",
  // a git url or a file: path — all of which have no major to report.
  const m = /(?:^|[^\w.])(\d+)\.(?:\d+|x)/.exec(range) ?? /^\s*[~^>=<\s]*(\d+)\s*$/.exec(range);
  if (!m?.[1]) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function readJson(p: string): Record<string, unknown> | undefined {
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
