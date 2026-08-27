import type { Platform, RunContext } from "./types.ts";

/**
 * Which element vocabulary a run speaks.
 *
 * ONE derivation, in one place, for the same reason `TAG_TO_ROLE` is exported
 * from hostProps.ts and `SUITE_SCRIPT` lives in suiteScripts.ts: a rule spelled
 * twice is a rule that drifts. Every task and every emitter asks this rather
 * than testing `ctx.expo !== undefined` itself, so widening the rule later —
 * a React Native project that is not Expo, say — happens here and nowhere else.
 *
 * It is deliberately NOT a stored field on RunContext. Storing it would let a
 * caller construct a context whose `platform` disagrees with its `expo`, and
 * there is no legitimate run where those two differ.
 */
export function platformOf(ctx: Pick<RunContext, "expo">): Platform {
  return ctx.expo === undefined ? "web" : "native";
}
