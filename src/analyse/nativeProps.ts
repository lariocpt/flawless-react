import type { PropsShape, PropValue } from "../types.ts";

/**
 * A curated, closed table of React Native host elements — the peer of
 * hostProps.ts, and deliberately NOT a model of React Native.
 *
 * Keyed by SPECIFIER then by module-side export name, because that is the only
 * evidence there is: `<View>` is a host element because it came from
 * "react-native", and `<View>` imported from "./my-ui" is a component that
 * happens to share the name. Keying on the bare tag would make the second one a
 * host element too.
 *
 * `BASE` is empty, and that is the honest answer rather than an oversight.
 * React Native has no universal prop whose synthesised default is both valid and
 * useful. `className` belongs to NativeWind, not to RN — synthesising it would
 * encode a build-tool assumption into the analysis. `style` mocks to `{}`, which
 * is inert. What this table supplies that hostProps.ts also supplies is
 * `acceptsChildren` and `handlers`; the prop SHAPE is genuinely thinner here,
 * and pretending otherwise is how you get an assertion that cannot fail.
 *
 * Three invariants are baked in, each because breaking it produces a *false test
 * result* rather than missing coverage. tests/nativeProps.test.ts pins all three.
 *
 * 1. Never synthesise `value` (except Switch, which has no `defaultValue`).
 *    `<TextInput value={x} />` with no `onChangeText` is React Native's
 *    controlled-input trap: the input is frozen and `fireEvent.changeText` is a
 *    silent no-op that still passes. Strictly worse than the DOM version, where
 *    React at least logs a controlled-input warning. Always `defaultValue`.
 * 2. Never synthesise `placeholder` / `testID` / `accessibilityLabel` /
 *    `accessibilityHint` / `nativeID`. Those five ARE the entire locator surface
 *    of @testing-library/react-native. An empty default makes
 *    `getByPlaceholderText("")` throw; a non-empty invented one makes the spec
 *    assert a handle the app does not have.
 * 3. Never synthesise `accessibilityRole` / `role`. RNTL resolves role from that
 *    prop ALONE, so an invented role makes `getByRole` pass on a fiction. This is
 *    the structural analogue of the DOM table's "`type` is always a real literal":
 *    the one prop a query resolves against must never be a placeholder.
 */

export interface NativeElementProps {
  shape: PropsShape;
  variantOptions?: Record<string, PropValue[]>;
  acceptsChildren: boolean;
  /** Handler props the scaffolder stubs. */
  handlers: string[];
  /** The only element a raw string may legally be rendered inside. */
  rendersText?: true;
}

const NONE: PropsShape = {};

function el(
  shape: PropsShape,
  acceptsChildren: boolean,
  handlers: string[],
  extra: Partial<NativeElementProps> = {},
): NativeElementProps {
  return { shape, acceptsChildren, handlers, ...extra };
}

const REACT_NATIVE: Record<string, NativeElementProps> = {
  View: el({ ...NONE }, true, []),
  // `onPress` on Text is real and works — RN routes it through the text's own
  // press responder. It is not a Pressable, but it IS drivable.
  Text: el({ ...NONE }, true, ["onPress"], { rendersText: true }),
  Pressable: el({ disabled: false }, true, ["onPress", "onLongPress"]),
  TouchableOpacity: el({ disabled: false }, true, ["onPress", "onLongPress"]),
  TouchableHighlight: el({ disabled: false }, true, ["onPress", "onLongPress"]),
  TouchableWithoutFeedback: el({ ...NONE }, true, ["onPress", "onLongPress"]),
  // defaultValue, never value — invariant 1.
  TextInput: el({ defaultValue: "", editable: true }, false, [
    "onChangeText",
    "onFocus",
    "onBlur",
    "onSubmitEditing",
  ]),
  ScrollView: el({ ...NONE }, true, []),
  FlatList: el({ ...NONE }, false, ["onRefresh"]),
  SectionList: el({ ...NONE }, false, ["onRefresh"]),
  KeyboardAvoidingView: el({ ...NONE }, true, []),
  ActivityIndicator: el({ animating: true, size: "small" }, false, [], {
    variantOptions: { size: ["small", "large"] },
  }),
  RefreshControl: el({ refreshing: false }, false, ["onRefresh"]),
  // The one place `value` appears, and it is forced: RN's Switch has no
  // defaultValue, so value + the mandatory onValueChange is the only
  // representable uncontrolled state. tests/nativeProps.test.ts allows it BY NAME
  // with this reason, rather than weakening invariant 1 for everything.
  Switch: el({ value: false }, false, ["onValueChange"]),
  Image: el({ ...NONE }, false, []),
  ImageBackground: el({ ...NONE }, true, []),
  Modal: el({ visible: true }, true, ["onRequestClose"]),
  // RN's own Button is the ONLY element in this table that sets an
  // accessibilityRole unconditionally in its own source. See NATIVE_TAG_TO_ROLE.
  Button: el({ title: "Button", disabled: false }, false, ["onPress"]),
  SafeAreaView: el({ ...NONE }, true, []),
  StatusBar: el({ ...NONE }, false, []),
};

const SAFE_AREA_CONTEXT: Record<string, NativeElementProps> = {
  SafeAreaView: el({ ...NONE }, true, []),
  SafeAreaProvider: el({ ...NONE }, true, []),
};

/**
 * @expo/vector-icons exports one component per glyph family. They render an
 * icon and no text, which is what makes an icon-only Pressable unaddressable —
 * so they have to be in the table for that to be PROVABLE rather than guessed
 * from the tag name. Exported for the native a11y task, whose icon rule needs
 * "is this a vector icon" answered from the same table the label harvest uses.
 */
export const VECTOR_ICON_FAMILIES = [
  "Ionicons",
  "MaterialIcons",
  "MaterialCommunityIcons",
  "FontAwesome",
  "FontAwesome5",
  "FontAwesome6",
  "Feather",
  "AntDesign",
  "Entypo",
  "EvilIcons",
  "Foundation",
  "Octicons",
  "SimpleLineIcons",
  "Zocial",
] as const;

const VECTOR_ICONS: Record<string, NativeElementProps> = Object.fromEntries(
  VECTOR_ICON_FAMILIES.map((name) => [name, el({ name: "help-circle", size: 24 }, false, [])]),
);

const TABLE: Readonly<Record<string, Readonly<Record<string, NativeElementProps>>>> = {
  "react-native": REACT_NATIVE,
  "react-native-safe-area-context": SAFE_AREA_CONTEXT,
  "@expo/vector-icons": VECTOR_ICONS,
};

export const NATIVE_ELEMENTS = TABLE;

/**
 * Tag -> implicit accessibilityRole. **One row, and pinned at one row.**
 *
 * @testing-library/react-native's `getRole()` returns the explicit
 * `role`/`accessibilityRole` prop, else "text" for Text elements, else "none".
 * There is no Pressable -> button mapping anywhere in the library. So a fuller
 * table here would not improve queries — it would emit `getByRole("button")`
 * against elements that carry no role, which matches nothing. On the dogfood app
 * that is 82 confidently wrong queries.
 *
 * A row may be added only when the element's own React Native source sets the
 * role UNCONDITIONALLY. RN's `<Button>` does; Pressable, Touchable* and TextInput
 * do not. tests/nativeProps.test.ts asserts the size of this table, because
 * "it is nearly empty" is a claim that decays silently.
 */
export const NATIVE_TAG_TO_ROLE: Readonly<Record<string, string>> = { Button: "button" };

/** Elements that render no text, so an element containing only these has no accessible name. */
export const TEXTLESS_ELEMENTS: ReadonlySet<string> = new Set([
  ...VECTOR_ICON_FAMILIES,
  "ActivityIndicator",
  "Image",
  "Switch",
  "RefreshControl",
  "StatusBar",
]);

/**
 * The values React Native accepts for `accessibilityRole`, copied from the
 * `AccessibilityRole` union in react-native 0.81.5's own
 * Libraries/Components/View/ViewAccessibility.js.
 *
 * Copied rather than derived at runtime, for the same reason the element table
 * above is closed: this repo does not depend on react-native, the analysed app
 * may not have it installed when the sweep runs, and a finding set that varies
 * with the target's install state is a nondeterministic report. A closed copy
 * can only go stale, and a membership + size pin in
 * tests/nativeElementModel.test.ts makes staleness a red test at the next RN
 * bump rather than a silent drift.
 *
 * Why the rule exists at all: RN widens the union with `| string` (both the
 * Flow source and the shipped .d.ts), so a typo'd role type-checks clean and
 * then announces NOTHING on either platform. tsc will never catch it; this is
 * the one place that can.
 */
export const VALID_ACCESSIBILITY_ROLES: ReadonlySet<string> = new Set([
  "none",
  "button",
  "dropdownlist",
  "togglebutton",
  "link",
  "search",
  "image",
  "keyboardkey",
  "text",
  "adjustable",
  "imagebutton",
  "header",
  "summary",
  "alert",
  "checkbox",
  "combobox",
  "menu",
  "menubar",
  "menuitem",
  "progressbar",
  "radio",
  "radiogroup",
  "scrollbar",
  "spinbutton",
  "switch",
  "tab",
  "tabbar",
  "tablist",
  "timer",
  "list",
  "toolbar",
  "grid",
  "pager",
  "scrollview",
  "horizontalscrollview",
  "viewgroup",
  "webview",
  "drawerlayout",
  "slidingdrawer",
  "iconmenu",
]);

/**
 * The values React Native accepts for the web-style `role` prop (RN 0.71+) —
 * the `Role` union from the same ViewAccessibility.js, which is a DIFFERENT
 * domain than `accessibilityRole` ("heading" is a Role, "header" is an
 * AccessibilityRole). The two sets are deliberately separate so the invalid-role
 * rule validates each attribute against its own union rather than the blur of
 * both.
 */
export const VALID_ROLES: ReadonlySet<string> = new Set([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "dialog",
  "directory",
  "document",
  "feed",
  "figure",
  "form",
  "grid",
  "group",
  "heading",
  "img",
  "link",
  "list",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "menu",
  "menubar",
  "menuitem",
  "meter",
  "navigation",
  "none",
  "note",
  "option",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "summary",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);

/**
 * The facts for a tag, or undefined when the specifier/name pair is not in the
 * table — which means "this is a component", exactly the state every uppercase
 * tag is in today. Never a guess from the name.
 */
export function nativeElementFor(
  specifier: string,
  exportedName: string,
): NativeElementProps | undefined {
  const known = TABLE[specifier]?.[exportedName];
  if (!known) return undefined;
  return { ...known, shape: { ...known.shape } };
}

/** Every element name in the table, for the tests and the ambiguity census. */
export function nativeElementNames(): string[] {
  return [...new Set(Object.values(TABLE).flatMap((m) => Object.keys(m)))].sort();
}

/**
 * Whether a native element accepts children, by resolved element NAME.
 *
 * For consumers that hold a `ResolvedHostTag` (name + dialect) but not the
 * specifier it came from. Safe because the table's names are unambiguous across
 * specifiers: `SafeAreaView` appears under both "react-native" and
 * "react-native-safe-area-context" with the same answer. A test pins that.
 */
export function nativeAcceptsChildrenByName(name: string): boolean {
  for (const byName of Object.values(TABLE)) {
    const found = byName[name];
    if (found) return found.acceptsChildren;
  }
  // Unknown native-dialect tag: a component, and components take children.
  return true;
}
