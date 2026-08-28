import type { ClickHandler, ComponentInfo, HandlerEffect } from "../types.ts";

/**
 * What a spec may assert after dispatching an event — and, where the answer is
 * "nothing", why.
 *
 * It replaces a floor assertion that was vacuous or wrong depending on
 * configuration:
 *
 *   expect(container.firstElementChild).not.toBeNull();  // DOM
 *   expect(screen.toJSON()).not.toBeNull();              // native
 *
 * On the dogfood app that line is answered by something the component never
 * rendered, so it cannot fail — 30 of 30 spec files carrying it. Without that,
 * and on the whole native plane, the same line goes RED on a component that
 * legitimately unmounts. Executed both ways before this was written.
 *
 * The MECHANISM is worth stating precisely, because a first reading of it here
 * was wrong. The derived provider renders no wrapper element of its own — it is
 * context providers all the way down. What answers the assertion is next-themes'
 * ThemeProvider injecting a <script> tag, which `container.firstElementChild`
 * then finds. Verified by rendering a component whose whole body is
 * `return null` under that provider: the emitted assertion passes.
 *
 * So the floor was never reliably one thing or the other. Whether it was vacuous
 * or a false red depended on whether some provider in the tree happened to emit
 * a DOM node — which is exactly the kind of accidental dependence an assertion
 * must not have, and a stronger reason to remove it than either half alone.
 *
 * Four independent designs for a smarter survival check were proposed and every
 * one was broken by an adversarial reviewer, in both directions. The surviving
 * answer is not a better floor: it is to assert a boundary the handler provably
 * crosses — a call into a module the spec mocks, or a router navigation — and
 * to say plainly when there is none.
 *
 * Plane-agnostic on purpose. The DOM and native emitters have drifted before
 * (`importedNames`, `hints.disabled`), and a shared decision is the cheapest way
 * to stop them drifting again.
 */
export type PostDispatchClaim =
  | { kind: "prop-spy"; propName: string }
  | { kind: "module-spy"; binding: string }
  | { kind: "router"; method: "push" | "replace" | "navigate" | "back"; target?: string }
  | { kind: "canary"; reason: NoClaimReason }
  | { kind: "skip"; reason: NoClaimReason };

/**
 * Why nothing precise can be asserted. Each maps to one sentence in the emitted
 * TODO, so a reader learns what would make the test real rather than that it is
 * not one.
 */
export type NoClaimReason =
  | "opaque-callback"
  | "foreign-setter"
  | "guarded-call"
  | "disabled-control"
  | "undecidable-render";

export function describeNoClaim(reason: NoClaimReason): string {
  switch (reason) {
    case "opaque-callback":
      return "the handler crosses no boundary this spec controls";
    case "foreign-setter":
      return "the setter comes from a hook this spec does not control";
    case "guarded-call":
      return "the work is behind a guard that returns first at these props";
    case "disabled-control":
      return "its control is disabled at these props";
    case "undecidable-render":
      return "render() branches on a condition this analysis could not decide, so nothing is known to be on screen to press";
  }
}

/** What the caller knows about the spec it is writing. */
export interface PostDispatchContext {
  /**
   * Local binding name → true when the module it came from is mocked by THIS
   * spec. Keyed by binding because that is what the handler names; the caller
   * intersects specifiers itself, since only it knows the spec's directory.
   */
  mockedBindings: Set<string>;
  /** The router is mocked and its calls are observable. */
  routerMocked: boolean;
}

/**
 * The ladder, first match wins.
 *
 * Order is the point: a prop spy is the most precise claim available and the
 * cheapest to verify, a module spy and a router assertion are provable
 * crossings, and everything after them is an admission.
 */
export function decidePostDispatch(
  info: ComponentInfo,
  click: ClickHandler,
  ctx: PostDispatchContext,
): PostDispatchClaim {
  // 0b — nothing is known to be on screen at all.
  if (info.renderUndecidable === true) {
    return { kind: "skip", reason: "undecidable-render" };
  }
  // 0c — user-event and RNTL both refuse to fire on a disabled control, so any
  // claim would be about a press that never happened. `"conditional"` means the
  // expression did not reduce, which is not permission to click.
  if (click.hints.disabled !== undefined) {
    return { kind: "skip", reason: "disabled-control" };
  }
  // 1 — a handler bound to a prop: pass a spy, assert it ran.
  if (click.binding.kind === "prop") {
    return { kind: "prop-spy", propName: click.binding.propName };
  }

  const effects = click.effects ?? [];
  const dominated = effects.filter((e) => e.dominated);

  // 2 — a call into a module this spec mocks.
  const call = dominated.find(
    (e): e is Extract<HandlerEffect, { kind: "call" }> =>
      e.kind === "call" && ctx.mockedBindings.has(e.root),
  );
  if (call) return { kind: "module-spy", binding: call.root };

  // 3 — a router navigation.
  const nav = dominated.find(
    (e): e is Extract<HandlerEffect, { kind: "router" }> => e.kind === "router",
  );
  if (nav && ctx.routerMocked) {
    return { kind: "router", method: nav.method, ...(nav.target ? { target: nav.target } : {}) };
  }

  // 5 — drive it and assert only that nothing escaped, naming why that is all.
  return { kind: "canary", reason: whyNothing(effects, ctx) };
}

/**
 * The most specific true reason, not the first one that fits.
 *
 * A reader who is told "no boundary" when the truth is "the call is behind a
 * guard" goes looking in the wrong place.
 */
function whyNothing(effects: HandlerEffect[], ctx: PostDispatchContext): NoClaimReason {
  const undominated = effects.filter((e) => !e.dominated);
  if (
    undominated.some(
      (e) => (e.kind === "call" && ctx.mockedBindings.has(e.root)) || e.kind === "router",
    )
  ) {
    return "guarded-call";
  }
  if (effects.some((e) => e.kind === "setState")) return "foreign-setter";
  return "opaque-callback";
}
