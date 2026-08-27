// The RNTL selector ladder, tested IN PROCESS.
//
// It was previously exercised only through `bun src/bin.ts` subprocesses, so
// coverage reported 0% functions on it and a refactor would have been caught
// only by a slow end-to-end run — if at all. These are the same rungs, asserted
// directly.
import { describe, expect, test } from "bun:test";
import {
  describeUnlocatableNative,
  emitNativeDispatch,
  emitNativeSelector,
} from "../src/scaffold-tests/selectorsNative.ts";
import type { ClickHandler } from "../src/types.ts";

const handler = (over: Partial<ClickHandler> = {}): ClickHandler => ({
  event: "onPress",
  tag: "Pressable",
  label: { kind: "none" },
  hints: {},
  binding: { kind: "inline" },
  ...over,
});

describe("the ladder, rung by rung", () => {
  test("testID outranks everything", () => {
    const t = emitNativeSelector(
      handler({
        hints: { testid: "save", ariaLabel: "Save", role: "button", placeholder: "p" },
        label: { kind: "text", value: "Save" },
      }),
    );
    expect(t).toEqual({ locator: 'screen.getByTestId("save")', rung: "testID", self: true });
  });

  test("accessibilityLabel next", () => {
    const t = emitNativeSelector(handler({ hints: { ariaLabel: "Go back" } }));
    expect(t?.rung).toBe("label");
    expect(t?.locator).toBe('screen.getAllByLabelText("Go back")[0]');
  });

  test("an EXPLICIT role, with the name when the source spells it out", () => {
    const t = emitNativeSelector(
      handler({ hints: { role: "button" }, label: { kind: "text", value: "Save" } }),
    );
    expect(t?.locator).toBe('screen.getAllByRole("button", { name: "Save" })[0]');
    // No label: a role with no name still narrows, and inventing one would be worse.
    expect(emitNativeSelector(handler({ hints: { role: "switch" } }))?.locator).toBe(
      'screen.getAllByRole("switch")[0]',
    );
  });

  test("placeholder sits ABOVE text, because it names the element not a child", () => {
    const t = emitNativeSelector(
      handler({
        hints: { placeholder: "you@example.com" },
        label: { kind: "text", value: "Email" },
      }),
    );
    expect(t?.rung).toBe("placeholder");
  });

  test("literal text, then a fragment as a regex", () => {
    expect(emitNativeSelector(handler({ label: { kind: "text", value: "Sign in" } }))).toEqual({
      locator: 'screen.getAllByText("Sign in")[0]',
      rung: "text",
      self: false,
    });
    expect(
      emitNativeSelector(handler({ label: { kind: "text-partial", value: "Add" } }))?.locator,
    ).toBe("screen.getAllByText(/Add/)[0]");
  });

  // THE load-bearing case. undefined makes the caller emit a skip that names the
  // gap; anything else here would be a locator that matches nothing, and
  // fireEvent.press on nothing is a green test that touched nothing.
  test("nothing identifies it -> undefined, never a guess", () => {
    expect(emitNativeSelector(handler())).toBeUndefined();
    expect(emitNativeSelector(handler({ hints: { id: "root" } }))).toBeUndefined();
  });

  test("`id` is recorded by the analyser but NEVER read by this ladder", () => {
    // It is a true fact about the source and it works under react-native-web +
    // Playwright, so the analyser keeps it. RNTL has no #id query, so emitting one
    // would be a locator that cannot match.
    const t = emitNativeSelector(handler({ hints: { id: "submit", nativeID: "submit" } as never }));
    expect(t).toBeUndefined();
  });

  test("regex metacharacters in a partial label are escaped", () => {
    // `Add (2)` unescaped becomes /Add (2)/, a capture group that still matches —
    // but `Price: $5.00 *` would not. The emitted regex has to be a literal match.
    const t = emitNativeSelector(
      handler({ label: { kind: "text-partial", value: "Price $5.00 (a+b)" } }),
    );
    expect(t?.locator).toBe("screen.getAllByText(/Price \\$5\\.00 \\(a\\+b\\)/)[0]");
    // And it must be a valid regex literal, not merely a string that looks like one.
    const body = /screen\.getAllByText\((\/.*\/)\)\[0\]/.exec(t?.locator ?? "")?.[1] as string;
    expect(() => new RegExp(body.slice(1, -1))).not.toThrow();
  });

  test("a label containing a quote survives JSON escaping", () => {
    const t = emitNativeSelector(handler({ label: { kind: "text", value: 'Say "hi"' } }));
    // JSON.stringify is what keeps the emitted TypeScript parseable.
    expect(t?.locator).toBe('screen.getAllByText("Say \\"hi\\"")[0]');
    expect(() => JSON.parse((t?.locator.match(/\((".*")\)/)?.[1] ?? "") as string)).not.toThrow();
  });
});

describe("describeUnlocatableNative", () => {
  test("icon-only wins over ambiguous when BOTH apply", () => {
    // One accessibilityLabel fixes both, so the message that leads there is the
    // more useful one.
    const msg = describeUnlocatableNative(handler({ iconOnly: true, ambiguousTag: true }));
    expect(msg).toMatch(/renders only an icon/);
    expect(msg).toMatch(/accessibilityLabel/);
  });

  test("ambiguous, when it is the only problem", () => {
    expect(describeUnlocatableNative(handler({ ambiguousTag: true }))).toMatch(/more than one/);
  });

  test("the generic case names every rung it tried", () => {
    const msg = describeUnlocatableNative(handler());
    for (const rung of ["testID", "accessibilityLabel", "accessibilityRole"]) {
      expect(msg).toContain(rung);
    }
  });

  test("every wording names the element and a remedy", () => {
    for (const h of [handler(), handler({ iconOnly: true }), handler({ ambiguousTag: true })]) {
      const msg = describeUnlocatableNative(h);
      expect(msg).toContain("<Pressable>");
      expect(msg.length).toBeGreaterThan(40);
    }
  });
});

describe("the dispatch map is CLOSED", () => {
  const target = { locator: "el", rung: "testID" as const, self: true };
  const textTarget = { locator: "el", rung: "text" as const, self: false };

  test("a self rung with userEvent allowed presses through userEvent", () => {
    expect(emitNativeDispatch("onPress", target, "el0", true)).toBe("await user.press(el0)");
  });

  test("a TEXT rung always uses fireEvent, which walks up to the responder", () => {
    // RNTL's userEvent.press requires a pressable host element and rejects a Text
    // that is not one; fireEvent.press walks up. The rung is the evidence.
    expect(emitNativeDispatch("onPress", textTarget, "el0", true)).toBe('fireEvent(el0, "press")');
  });

  test("route specs never use userEvent, because renderRouter enables fake timers", () => {
    expect(emitNativeDispatch("onPress", target, "el0", false)).toBe('fireEvent(el0, "press")');
  });

  test.each([
    ["onChangeText", "fireEvent.changeText(el0, SAMPLE_TEXT)"],
    ["onSubmitEditing", 'fireEvent(el0, "submitEditing")'],
    ["onValueChange", 'fireEvent(el0, "valueChange", true)'],
    ["onFocus", 'fireEvent(el0, "focus")'],
    ["onBlur", 'fireEvent(el0, "blur")'],
  ])("%s -> %s", (event, want) => {
    expect(emitNativeDispatch(event as string, target, "el0", false)).toBe(want as string);
  });

  test("an event with no honest dispatch returns undefined, never a fallback click", () => {
    // The DOM emitter has `default: userEvent.click(...)`. A click on a React
    // Native tree is nonsense that would pass silently, so this switch has no
    // permissive default and the caller skips instead.
    for (const event of ["onRefresh", "onScroll", "onLayout", "onEndReached", "onClick"]) {
      expect(`${event}:${emitNativeDispatch(event, target, "el0", false)}`).toBe(
        `${event}:undefined`,
      );
    }
  });
});
