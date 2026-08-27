import type { FieldInfo } from "../types.ts";
import { nativeElementFor } from "./nativeProps.ts";

/**
 * Facts about React Native's content model that a generated harness has to respect.
 *
 * The peer of htmlContentModel.ts, and much shorter — which is the finding, not
 * an omission. React Native has no `<tbody>`-must-be-inside-`<table>` rules: no
 * required-ancestor chains exist, so this file declares none rather than
 * inventing a table to look symmetrical.
 *
 * What it does encode is the one hard runtime invariant React Native does have,
 * plus the fill model, both of which change what a spec may assert.
 */

/**
 * Whether a raw string may be rendered directly inside this element.
 *
 * React Native throws
 *
 *   Invariant Violation: Text strings must be rendered within a <Text> component
 *
 * — a HARD runtime invariant, which makes this the direct analogue of
 * REQUIRED_ANCESTORS: a fact about the framework, not an inference about the app.
 * It is what stops extractStaticText harvesting copy from `<View>hello</View>`,
 * which no query could ever find because the component never rendered at all.
 *
 * Unknown elements (every component tag) answer false: a component may well
 * render its children inside a <Text> of its own, but we cannot see that from
 * here, and claiming text the render may not produce is the wrong way to be wrong.
 */
export function stringsAllowedIn(element: string | undefined): boolean {
  return element === "Text";
}

/**
 * How (or whether) a native field can be driven — the peer of `fillKind`.
 *
 * There is no "select": React Native has no `<select>`, and a Picker is a
 * third-party component whose driving is library-specific.
 *
 * "frozen" is the interesting one and it is recorded rather than dropped, so the
 * emitter can say WHY it skipped instead of pretending the field is absent. A
 * `<TextInput value={x}/>` with no `onChangeText` cannot be typed into: RN issues
 * no controlled-input warning (unlike the DOM), so a fill-and-assert spec against
 * it fails for the SPEC's fault, not the app's.
 */
export type NativeFillKind = "text" | "toggle" | "skip";

export function nativeFillKind(field: Pick<FieldInfo, "tag" | "control">): NativeFillKind {
  if (field.tag === "Switch") return "toggle";
  if (field.tag !== "TextInput") return "skip";
  return field.control === "frozen" ? "skip" : "text";
}

/**
 * Providers a component's own HOOK calls demand, outermost first.
 *
 * Keyed on hooks rather than on tags, because that is where the throw actually
 * is. `useFocusEffect` reaches `useNavigation()`, which throws
 *
 *   Couldn't find a navigation object. Is your component inside NavigationContainer?
 *
 * so a screen using it cannot be mounted by a bare render at all — it needs
 * `renderRouter` from expo-router/testing-library.
 *
 * `SafeAreaView` is deliberately ABSENT from this list, and that absence is
 * checked by a test. react-native-safe-area-context v5's SafeAreaView renders a
 * native view and reads no context; only `useSafeAreaInsets` and
 * `useSafeAreaFrame` throw. Listing it would encode a required-ancestor fact that
 * is simply false — which is the failure mode this whole file exists to avoid.
 */
export interface RequiredProvider {
  hook: string;
  provider: string;
  from: string;
  note: string;
}

const HOOK_PROVIDERS: Record<string, RequiredProvider> = {
  useFocusEffect: {
    hook: "useFocusEffect",
    provider: "renderRouter",
    from: "expo-router/testing-library",
    note:
      "calls useFocusEffect, which reaches useNavigation() and throws \"Couldn't find a " +
      'navigation object" outside a navigator — mount it with renderRouter() instead of render()',
  },
  useNavigation: {
    hook: "useNavigation",
    provider: "renderRouter",
    from: "expo-router/testing-library",
    note: "calls useNavigation(), which throws outside a navigator — mount it with renderRouter()",
  },
  useLocalSearchParams: {
    hook: "useLocalSearchParams",
    provider: "renderRouter",
    from: "expo-router/testing-library",
    note:
      "reads useLocalSearchParams(), which is empty outside a router — mount it with " +
      "renderRouter() at a URL that supplies the params",
  },
  useSafeAreaInsets: {
    hook: "useSafeAreaInsets",
    provider: "SafeAreaProvider",
    from: "react-native-safe-area-context",
    note:
      'calls useSafeAreaInsets(), which throws "No safe area value available" without a ' +
      "SafeAreaProvider carrying initialMetrics",
  },
};

export function requiredNativeProviders(hooks: readonly string[]): RequiredProvider[] {
  const out: RequiredProvider[] = [];
  const seen = new Set<string>();
  for (const h of hooks) {
    const p = HOOK_PROVIDERS[h];
    if (p && !seen.has(p.provider + p.hook)) {
      seen.add(p.provider + p.hook);
      out.push(p);
    }
  }
  return out;
}

/** True when the element accepts children, per the closed table. */
export function nativeAcceptsChildren(specifier: string, exportedName: string): boolean {
  return nativeElementFor(specifier, exportedName)?.acceptsChildren ?? true;
}
