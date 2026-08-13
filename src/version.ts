/**
 * The single source of truth for the version flawless-react reports.
 *
 * A static JSON import, deliberately: `bun build --compile` (the `build` script)
 * inlines this at bundle time, whereas a readFileSync of package.json relative to
 * import.meta.dir cannot be embedded — the standalone binary would print
 * `undefined` or throw. The CLI previously carried a hardcoded copy of the
 * version string, which drifted from package.json.
 */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
