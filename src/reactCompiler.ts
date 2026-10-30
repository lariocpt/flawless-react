import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ReactCompilerProbe } from "./types.ts";

/** Expo's own flag, in the app config a person edits. Parsed: it is JSON. */
const APP_CONFIG = "app.json";

/** Next ≥15's stable `reactCompiler` flag, plus its earlier `experimental` home. */
const NEXT_CONFIGS = ["next.config.ts", "next.config.js", "next.config.mjs", "next.config.cjs"];

/** The project's Babel entry — where the plugin goes when Babel runs at all. */
const BABEL_CONFIGS = ["babel.config.js", "babel.config.cjs", "babel.config.mjs"];

/**
 * Bundler configs whose presence means "this project's transform pipeline is
 * declared here, in this file". Deliberately a list of config-file CONVENTIONS
 * we recognise and not a general scan: a bundler we do not know has no honest
 * answer, and says so.
 */
const BUNDLER_CONFIGS = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "webpack.config.js",
  "webpack.config.cjs",
  "webpack.config.mjs",
  "webpack.config.ts",
  "rspack.config.js",
  "rsbuild.config.ts",
  "rsbuild.config.js",
];

const PLUGIN_NEEDLE = "babel-plugin-react-compiler";

/** `reactCompiler: true`, `"reactCompiler": true`, `'react-compiler': false`. */
const FLAG_ASSIGNMENT = /["']?(reactCompiler|react-compiler)["']?\s*:\s*(true|false)/;

/**
 * Read the React Compiler state for a project root.
 *
 * The ladder is the same in every mode, and it is a ladder of authority rather
 * than a search: a positive spelling in any config the project actually uses
 * turns it on, and only the absence of every positive spelling in every config
 * we could read turns it off.
 *
 * Everything read here is a config file, as text, never executed — and never
 * package.json or a lockfile. The dogfood web app's `bun.lock` carries
 * `babel-plugin-react-compiler` because Next ships it as a dependency of its
 * own while the compiler is OFF; a dependency-presence check would have
 * suppressed 127 valid findings on that run. Dependency presence ≠ activation.
 */
export function detectReactCompiler(root: string): ReactCompilerProbe {
  const abs = path.resolve(root);
  const positives: string[] = [];
  const read: string[] = [];

  // Expo's flag first, parsed rather than grepped: app.json is JSON, so the key
  // is decisive in a way no text scan is. `app.config.{js,ts}` is not read at
  // all — executing a project's config to ask it a question is not something a
  // static analyser does, and the babel plugin spelling below still catches a
  // project that turns the compiler on that way.
  const appJson = readJson(path.join(abs, APP_CONFIG));
  if (appJson) {
    read.push(APP_CONFIG);
    const experiments = (appJson.expo as { experiments?: Record<string, unknown> } | undefined)
      ?.experiments;
    if (experiments?.reactCompiler === true) {
      positives.push(`${APP_CONFIG} experiments.reactCompiler`);
    }
  }

  for (const file of [...NEXT_CONFIGS, ...BABEL_CONFIGS, ...BUNDLER_CONFIGS]) {
    const text = readText(path.join(abs, file));
    if (text === undefined) continue;
    read.push(file);
    const positive = configSaysOn(file, text);
    if (positive !== undefined) positives.push(positive);
  }

  // The first positive names a sufficient reason, so several spellings in one
  // project cost one evidence line, not a list.
  if (positives.length > 0) return { state: "on", evidence: positives[0] as string };

  if (read.length === 0) {
    return {
      state: "undetermined",
      evidence: "no app.json, next.config, babel config or recognised bundler config to read",
    };
  }
  const more = read.length > 3 ? `, +${read.length - 3} more` : "";
  return {
    state: "off",
    evidence: `no React Compiler flag in ${read.slice(0, 3).join(", ")}${more}`,
  };
}

/**
 * What one config file says. Undefined means the file does not speak about the
 * compiler at all — which is not the same as it saying no, and is why the caller
 * collects what was READ separately from what was POSITIVE.
 *
 * Order matters. An explicit assignment wins over the plugin name because a
 * preset option is the gate; the plugin name wins over the bare flag word
 * because the bare word can be anything (`isReactCompilerEnabled` in a comment,
 * a local variable) — kept only because it is a real spelling of expo's preset
 * options and the detector has always accepted it.
 */
function configSaysOn(file: string, text: string): string | undefined {
  const flag = FLAG_ASSIGNMENT.exec(text);
  if (flag) {
    return flag[2] === "true" ? `${file} ${flag[1]}` : undefined;
  }
  if (text.includes(PLUGIN_NEEDLE)) return `${file} ${PLUGIN_NEEDLE}`;
  if (/\breactCompiler\b/.test(text)) return `${file} reactCompiler`;
  return undefined;
}

/**
 * The project root a framework-less run's configs sit in.
 *
 * The same upward walk `ignoreRootFor` makes for the same reason: the tool is
 * run from wherever the person happens to be, and the configs are not
 * necessarily beside the out dir. The first ancestor that is a project — a
 * `.git` or a `package.json` — wins, so a run from a monorepo package reads that
 * package's configs rather than the repo's. Unlike the ignore case there is no
 * last-resort answer: a tree with no package.json anywhere has no configs to
 * read either, so the caller gets its own start back and says undetermined.
 */
export function configRootFor(outDir: string): string {
  let dir = path.resolve(outDir);
  for (;;) {
    if (existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(outDir);
    dir = parent;
  }
}

function readText(p: string): string | undefined {
  if (!existsSync(p)) return undefined;
  try {
    return readFileSync(p, "utf8");
  } catch {
    // An unreadable config proves nothing. It is not evidence of an absent flag.
    return undefined;
  }
}

function readJson(p: string): Record<string, unknown> | undefined {
  const text = readText(p);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
