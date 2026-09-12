import type { TaskId, TaskResult } from "../types.ts";

/**
 * A task that does not run under `--expo`, refusing by name with its reason.
 *
 * This carried the mode through B-16 one wave at a time without the docs lying
 * about it, and now that B-16 is complete it carries the one task that will
 * never run: `perf-harness`, measured-and-declined (a browser host cannot mount
 * a route screen, which is nearly every component in a real Expo app). The
 * `reason` is free text — a wave string while a wave was pending, a decline
 * record now — so the message never claims "not yet" over a task that is
 * actually declined for good. The alternative shapes were both worse:
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

export function expoNotImplemented(id: TaskId, reason: string): TaskResult {
  return {
    id,
    ok: false,
    outputs: [],
    findings: [],
    summary: `${id}: does not run under --expo (${reason}) — run --tasks ${EXPO_IMPLEMENTED.join(",")}`,
    // The escape is spelled as the flag the reader would actually type, not as
    // prose naming ids. Told only that something is unsupported, they have to go
    // and read the source to find out what to select instead.
    error:
      `${id} does not run under --expo — ${reason}. ` +
      `Under --expo, run \`--tasks ${EXPO_IMPLEMENTED.join(",")}\`; every other task ` +
      `refuses rather than emit DOM artefacts for a React Native project. ` +
      `See the Expo section of README.md.`,
  };
}
