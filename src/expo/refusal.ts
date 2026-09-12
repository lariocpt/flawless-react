import type { TaskId, TaskResult } from "../types.ts";

/**
 * A task that has no Expo implementation yet, refusing by name.
 *
 * This is the mechanism that lets the mode ship one wave at a time without the
 * docs lying about it. The alternative shapes are both worse:
 *
 *   - Rejecting `--expo` at parse time until every task is ported would mean the
 *     flag lands in one enormous PR, which is how a seam stops being reviewable.
 *   - Silently emitting the DOM artefacts for a React Native project would
 *     produce a suite that runs, passes, and tests nothing — the vacuous green
 *     this project scores itself on removing.
 *
 * A refusal is a TaskResult rather than a thrown error on purpose: it lands in
 * `results[]`, in the `--ci` blob and in REPORT.md, where a machine can read it.
 * A thrown error would exit 1 with the reason only on stderr, which is where
 * B-13 already found `--ci` losing things it needed to say.
 *
 * Same shape as `e2eRoutes.ts`'s long-standing "not a Next.js run" branch — the
 * precedent, not a new convention.
 */
/**
 * The tasks that actually run under `--expo`, as the escape hatch names them.
 *
 * A literal `perf-static,react-rules` was correct when five tasks refused, and
 * wrong from wave 3 onward — `unit-browser` is the whole point of the mode and
 * the refusal was telling every reader to leave it out. Kept beside the refusal
 * so the two cannot disagree, and pinned by a test that runs each of these under
 * `--expo` and asserts it does NOT refuse.
 */
export const EXPO_IMPLEMENTED: readonly TaskId[] = [
  "unit-browser",
  "perf-static",
  "a11y",
  "react-rules",
  "e2e",
  "load",
];

export function expoNotImplemented(id: TaskId, wave: string): TaskResult {
  return {
    id,
    ok: false,
    outputs: [],
    findings: [],
    summary: `${id}: no Expo implementation yet (${wave}) — run --tasks ${EXPO_IMPLEMENTED.join(",")}`,
    // The escape is spelled as the flag the reader would actually type, not as
    // prose naming two ids. Told only that something is unsupported, they have
    // to go and read the source to find out what to select instead.
    error:
      `${id} has no Expo implementation yet — it is ${wave}. ` +
      `Under --expo today, run \`--tasks ${EXPO_IMPLEMENTED.join(",")}\`; every other task ` +
      `refuses rather than emit DOM artefacts for a React Native project. ` +
      `See the Expo section of README.md.`,
  };
}
