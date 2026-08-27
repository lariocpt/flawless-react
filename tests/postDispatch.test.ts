// The ladder that replaced the post-dispatch floor.
//
// The floor was `expect(container.firstElementChild).not.toBeNull()` on the DOM
// plane and `expect(screen.toJSON()).not.toBeNull()` on native. Both halves were
// verified by EXECUTION before this existed:
//
//   under a provider  container.firstElementChild is the PROVIDER's node, so a
//                     component returning null after the click still passes —
//                     30 of 30 spec files carrying it on the dogfood app
//   without one       the same line fails on a component that legitimately
//                     unmounts: "expected null not to be null"
//
// Four independent designs for a smarter survival check were proposed and every
// one was broken by an adversarial reviewer, in BOTH directions. The surviving
// answer is not a better floor: assert a boundary the handler provably crosses,
// or say plainly that there is none.
import { describe, expect, test } from "bun:test";
import { decidePostDispatch, describeNoClaim } from "../src/scaffold-tests/postDispatch.ts";
import type { ClickHandler, ComponentInfo } from "../src/types.ts";

const click = (over: Partial<ClickHandler> = {}): ClickHandler =>
  ({
    event: "onClick",
    tag: "button",
    label: { kind: "text", value: "Go" },
    hints: {},
    binding: { kind: "inline" },
    pos: { line: 1, column: 1 },
    ...over,
  }) as ClickHandler;

const info = (over: Partial<ComponentInfo> = {}): ComponentInfo =>
  ({ componentName: "X", ...over }) as ComponentInfo;

const ctx = (over: Partial<Parameters<typeof decidePostDispatch>[2]> = {}) => ({
  mockedBindings: new Set<string>(),
  routerMocked: false,
  ...over,
});

describe("the ladder, in order", () => {
  test("an undecidable render skips the whole thing — nothing is known to be on screen", () => {
    const c = decidePostDispatch(info({ renderUndecidable: true }), click(), ctx());
    expect(c).toEqual({ kind: "skip", reason: "undecidable-render" });
  });

  test("a disabled control skips — user-event refuses to fire on it", () => {
    // Any claim would be about a press that never happened. "conditional" means
    // the expression did not reduce, which is not permission to click.
    for (const disabled of ["always", "conditional"]) {
      const c = decidePostDispatch(info(), click({ hints: { disabled } } as never), ctx());
      expect(c).toEqual({ kind: "skip", reason: "disabled-control" });
    }
  });

  test("a prop-bound handler wins — the most precise claim available", () => {
    const c = decidePostDispatch(
      info(),
      click({ binding: { kind: "prop", propName: "onSave" } }),
      ctx({ mockedBindings: new Set(["save"]) }),
    );
    expect(c).toEqual({ kind: "prop-spy", propName: "onSave" });
  });

  test("a dominated call into a mocked module is asserted", () => {
    const c = decidePostDispatch(
      info(),
      click({ effects: [{ kind: "call", root: "saveThing", dominated: true }] }),
      ctx({ mockedBindings: new Set(["saveThing"]) }),
    );
    expect(c).toEqual({ kind: "module-spy", binding: "saveThing" });
  });

  test("the same call UNDOMINATED is not — and the reason says which", () => {
    // The repair that matters most. hasConditionalBetween walks ANCESTORS only,
    // so `if (!ok) { setErr(…); return; }` as a preceding SIBLING read as
    // unguarded; asserting there is a claim about a path the defaults may never
    // take.
    const c = decidePostDispatch(
      info(),
      click({ effects: [{ kind: "call", root: "saveThing", dominated: false }] }),
      ctx({ mockedBindings: new Set(["saveThing"]) }),
    );
    expect(c).toEqual({ kind: "canary", reason: "guarded-call" });
  });

  test("a router navigation is asserted only when the router is mocked", () => {
    const nav = click({
      effects: [{ kind: "router", method: "push", target: "/x", dominated: true }],
    });
    expect(decidePostDispatch(info(), nav, ctx({ routerMocked: true }))).toEqual({
      kind: "router",
      method: "push",
      target: "/x",
    });
    // Unmocked, the call writes to a spy nothing can see.
    expect(decidePostDispatch(info(), nav, ctx({ routerMocked: false })).kind).toBe("canary");
  });

  test("a setter from a hook this spec does not control names itself", () => {
    const c = decidePostDispatch(
      info(),
      click({ effects: [{ kind: "setState", setter: "setTheme", dominated: true }] }),
      ctx(),
    );
    expect(c).toEqual({ kind: "canary", reason: "foreign-setter" });
  });

  test("nothing at all falls to the canary, not to a survival claim", () => {
    expect(decidePostDispatch(info(), click(), ctx())).toEqual({
      kind: "canary",
      reason: "opaque-callback",
    });
  });

  test("every reason has a sentence a reader can act on", () => {
    // A skip that says "cannot assert" teaches nothing. Each of these names what
    // would make the test real.
    for (const r of [
      "opaque-callback",
      "foreign-setter",
      "guarded-call",
      "disabled-control",
      "undecidable-render",
    ] as const) {
      expect(describeNoClaim(r).length).toBeGreaterThan(20);
    }
  });
});

describe("a form's action is the one DOM claim this app's shapes support", () => {
  const ANALYSE = "../src/analyse/index.ts";

  async function formOf(src: string) {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { analyse } = await import(ANALYSE);
    const dir = mkdtempSync(path.join(os.tmpdir(), "form-"));
    const f = path.join(dir, "F.tsx");
    writeFileSync(f, src);
    try {
      const t = await analyse({ entry: f, depth: 0, includeChildren: false });
      return (t.entry.interactions?.forms ?? [])[0];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("useActionState(action, …) is unwrapped to the action itself", async () => {
    // React invokes the wrapped action on submit with NO guard in between —
    // unlike every CLICK handler on the dogfood app, which puts its action
    // behind a guard AND inside a startTransition callback.
    const f = await formOf(`import { useActionState } from "react";
import { loginAction } from "./actions";
export function F() {
  const [state, action] = useActionState(loginAction, undefined);
  void state;
  return <form action={action}><button type="submit">Go</button></form>;
}
`);
    expect(f?.actionBinding).toBe("loginAction");
  });

  test("a .bind() wrapper is followed — a bound function calls the original", async () => {
    // `createAction.bind(null, id)` is how this app passes a route param into an
    // action. Without following it the binding came back as the local name and
    // 13 of 19 claims were lost.
    const f = await formOf(`import { useActionState } from "react";
import { inviteMemberAction } from "./actions";
export function F({ id }: { id: string }) {
  const bound = inviteMemberAction.bind(null, id);
  const [state, formAction] = useActionState(bound, {});
  void state;
  return <form action={formAction}><button type="submit">Go</button></form>;
}
`);
    expect(f?.actionBinding).toBe("inviteMemberAction");
  });

  test("a direct action={fn} is recorded as itself", async () => {
    const f = await formOf(`import { createAction } from "./actions";
export function F() {
  return <form action={createAction}><button type="submit">Go</button></form>;
}
`);
    expect(f?.actionBinding).toBe("createAction");
  });

  test("no action attribute means no binding to claim on", async () => {
    // The control. Without it the field could be set for every form.
    const f = await formOf(`export function F() {
  return <form onSubmit={(e) => e.preventDefault()}><button type="submit">Go</button></form>;
}
`);
    expect(f?.actionBinding).toBeUndefined();
  });
});
