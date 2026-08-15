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
