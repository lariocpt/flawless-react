import path from "node:path";

/**
 * A path for an emitted file to resolve against itself, rather than the
 * absolute one the generator happened to be looking at.
 *
 * Generated files are committed. An absolute path in one names the machine that
 * produced it, and the same repository lives under a different root on other
 * machines — `/home/lario/Projects/…` on two of them, `/mnt/data/Projects/…` on
 * a third. The consequences are worse than churn: `vitest.config.ts` aliased
 * React to a directory that does not exist there, so the committed suite could
 * not resolve React at all, and regenerating rewrote three files every time.
 *
 * The invariant is about the file's BYTES, not its runtime value. Emitted code
 * still calls `path.resolve(<self>, rel)` and still ends up with an absolute
 * path, because that is what Vite's aliases and Bun's onLoad filter need. Only
 * the question "absolute from where" changes: from the emitted file, not from
 * the machine.
 *
 * Always POSIX-separated, so a suite generated on Windows reads the same as one
 * generated anywhere else.
 */
export function relativeToEmitted(fromDir: string, target: string): string {
  const rel = path.relative(path.resolve(fromDir), path.resolve(target));
  // "" means the target IS the directory; "." is what path.resolve wants back.
  if (rel === "") return ".";
  return rel.split(path.sep).join("/");
}

/**
 * The out dir as the project root sees it — `flawless`, or whatever `--out` said.
 *
 * Emitted prose and emitted shell both name this path, and both used to spell it
 * as the literal "flawless". Under `--out qa` that produced files telling the
 * user to edit a directory the run never created, and an env.sh whose $PWD
 * fallback resolved to nothing. Shared rather than redefined per task: two
 * copies of a path rule drifting apart is its own class of bug here.
 */
export function outDirRel(outDir: string, projectRoot: string): string {
  const rel = path.relative(path.resolve(projectRoot), path.resolve(outDir));
  // "" means the out dir IS the project root. Left empty it composes into
  // "/load/env.sh", which reads as an absolute path and points at the
  // filesystem root — so "." here, and underOutDir drops it again.
  if (rel === "") return ".";
  return rel.split(path.sep).join("/");
}

/** Compose a path under the out dir, without a "./" nobody wants to read. */
export function underOutDir(rel: string, sub: string): string {
  return rel === "." || rel === "" ? sub : `${rel}/${sub}`;
}
