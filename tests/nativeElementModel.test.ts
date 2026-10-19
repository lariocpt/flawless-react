// The React Native element model: which tags are host elements, what they carry,
// and what a spec may say about them.
//
// Every invariant here exists because breaking it produces a FALSE TEST RESULT
// in someone else's repo rather than missing coverage — so each one names the
// failure it prevents.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { Glob } from "bun";
import { domOnlyResolver, makeHostTagResolver } from "../src/analyse/hostTag.ts";
import { analyse, analyseFile } from "../src/analyse/index.ts";
import {
  nativeFillKind,
  requiredNativeProviders,
  stringsAllowedIn,
} from "../src/analyse/nativeContentModel.ts";
import {
  detectHostDialect,
  type HostDialect,
  isNativeSpecifier,
  rendersNativeSource,
} from "../src/analyse/nativeDialect.ts";
import {
  NATIVE_TAG_TO_ROLE,
  nativeAcceptsChildrenByName,
  nativeElementFor,
  nativeElementNames,
  TEXTLESS_ELEMENTS,
  VALID_ACCESSIBILITY_ROLES,
  VALID_ROLES,
} from "../src/analyse/nativeProps.ts";
import { parseFile } from "../src/analyse/parseFile.ts";
import { SourceFileCache } from "../src/analyse/sourceCache.ts";
import type { ComponentTree } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures");
const EXPOAPP = path.join(FIXTURES, "expoapp");
const cache = new SourceFileCache();

const importsOf = async (file: string) => (await parseFile(file, cache)).imports;

describe("host dialect — decided per file, from its own imports", () => {
  test("every pre-existing fixture is still dom", async () => {
    let seen = 0;
    for (const f of new Glob("*.tsx").scanSync({ cwd: FIXTURES, absolute: true })) {
      // A few fixtures are provider wrappers or helpers with no component in
      // them; parseFile refuses those by design, and their dialect is moot.
      let imports: Awaited<ReturnType<typeof importsOf>>;
      try {
        imports = await importsOf(f);
      } catch {
        continue;
      }
      seen++;
      expect(`${path.basename(f)}:${detectHostDialect(imports)}`).toBe(`${path.basename(f)}:dom`);
    }
    // A canary: a broken sweep must fail, not pass by checking nothing.
    expect(seen).toBeGreaterThan(20);
  });

  test("a React Native file is native, even with no react-native import of its own", async () => {
    // app/(tabs)/_layout.tsx imports only expo-router. The dialect question is
    // "is this React Native source", and expo-router answers it.
    expect(detectHostDialect(await importsOf(path.join(EXPOAPP, "app/(tabs)/_layout.tsx")))).toBe(
      "native",
    );
    expect(detectHostDialect(await importsOf(path.join(EXPOAPP, "app/login.tsx")))).toBe("native");
  });

  test("a tree is native-source when ANY component under it is", async () => {
    // The DOM plane's question is not what a root file imports — it is what a
    // SPEC loads, and importing a component loads everything below it. One
    // <View> anywhere puts react-native in the graph, and vitest cannot parse
    // RN's source at all, so the spec dies at COLLECT rather than at assert.
    const node = (dialect: HostDialect, children: ComponentTree[] = []): ComponentTree =>
      ({
        entry:
          dialect === "native"
            ? { componentName: "Screen", hostDialect: "native" as const }
            : { componentName: "Shell" },
        children,
      }) as unknown as ComponentTree;
    expect(rendersNativeSource(node("dom"))).toBe(false);
    expect(rendersNativeSource(node("dom", [node("dom"), node("native")]))).toBe(true);
    expect(rendersNativeSource(node("dom", [node("dom", [node("native")])]))).toBe(true);
    // And the analyser actually POPULATES the field the rule keys on: hand-built
    // trees cannot witness that link, and without it the whole rule is dead code.
    const screen = await analyse({
      entry: path.join(EXPOAPP, "app/(tabs)/index.tsx"),
      depth: 3,
      includeChildren: true,
    });
    expect(screen.entry.hostDialect).toBe("native");
    expect(rendersNativeSource(screen)).toBe(true);
  });

  test.each([
    ["react-native", true],
    ["react-native-safe-area-context", true],
    ["react-native/Libraries/Alert", true],
    ["expo-router", true],
    ["expo", true],
    ["@expo/vector-icons", true],
    ["@react-navigation/native", true],
    ["nativewind", true],
    ["react", false],
    ["react-dom", false],
    // The trap this regex has to avoid: a package whose name merely STARTS with
    // a native prefix is not React Native.
    ["expositive", false],
    ["react-native-web-ish-thing-not-a-scope", true],
  ])("isNativeSpecifier(%s) === %p", (spec, want) => {
    expect(isNativeSpecifier(spec as string)).toBe(want as boolean);
  });
});

describe("the native element table", () => {
  // Invariant 1. <TextInput value={x}/> with no onChangeText is React Native's
  // controlled-input trap: the field is frozen and fireEvent.changeText is a
  // SILENT NO-OP THAT STILL PASSES. Worse than the DOM version, where React at
  // least logs a warning.
  test("never synthesises `value` — except Switch, which has no defaultValue", () => {
    const offenders: string[] = [];
    for (const name of nativeElementNames()) {
      const el =
        nativeElementFor("react-native", name) ??
        nativeElementFor("react-native-safe-area-context", name) ??
        nativeElementFor("@expo/vector-icons", name);
      if (el && "value" in el.shape && name !== "Switch") offenders.push(name);
    }
    expect(offenders).toEqual([]);
    // Allowed BY NAME, with the reason, rather than by weakening the rule:
    // RN's Switch has no defaultValue, so value + the mandatory onValueChange is
    // the only representable uncontrolled state.
    expect(nativeElementFor("react-native", "Switch")?.shape.value).toBe(false);
    expect(nativeElementFor("react-native", "Switch")?.handlers).toContain("onValueChange");
    expect(nativeElementFor("react-native", "TextInput")?.shape.defaultValue).toBe("");
  });

  // Invariant 2. These five ARE the entire RNTL locator surface. An empty default
  // makes getByPlaceholderText("") throw; an invented one makes the spec assert a
  // handle the app does not have.
  test("never synthesises a locator prop", () => {
    const FORBIDDEN = [
      "placeholder",
      "testID",
      "accessibilityLabel",
      "accessibilityHint",
      "nativeID",
    ];
    for (const name of nativeElementNames()) {
      for (const spec of ["react-native", "react-native-safe-area-context", "@expo/vector-icons"]) {
        const el = nativeElementFor(spec, name);
        if (!el) continue;
        for (const f of FORBIDDEN)
          expect(`${name}.${f}=${f in el.shape}`).toBe(`${name}.${f}=false`);
      }
    }
  });

  // Invariant 3. RNTL resolves role from this prop ALONE, so an invented role
  // makes getByRole pass on a fiction.
  test("never synthesises accessibilityRole or role", () => {
    for (const name of nativeElementNames()) {
      for (const spec of ["react-native", "react-native-safe-area-context", "@expo/vector-icons"]) {
        const el = nativeElementFor(spec, name);
        if (!el) continue;
        expect("accessibilityRole" in el.shape).toBe(false);
        expect("role" in el.shape).toBe(false);
      }
    }
  });

  // THE control test. RNTL's getRole() reads the explicit prop, else "text" for
  // Text, else "none" — there is no Pressable -> button mapping anywhere in the
  // library. A fuller table would emit getByRole("button") against 82 elements
  // on the dogfood app that carry no role, matching nothing every time.
  test("the implicit-role table has exactly one row, and it is RN's own Button", () => {
    expect(Object.keys(NATIVE_TAG_TO_ROLE)).toEqual(["Button"]);
    expect(NATIVE_TAG_TO_ROLE.Button).toBe("button");
    // Named explicitly so adding a row is a deliberate act with a test to update.
    expect(NATIVE_TAG_TO_ROLE.Pressable).toBeUndefined();
    expect(NATIVE_TAG_TO_ROLE.TouchableOpacity).toBeUndefined();
    expect(NATIVE_TAG_TO_ROLE.TextInput).toBeUndefined();
  });

  // The native a11y task's invalid-role rule validates against these. RN widens
  // both unions with `| string`, so tsc never catches a typo'd role — which is
  // the rule's whole reason to exist. Size-pinned so an RN bump that grows a
  // union reddens here instead of drifting silently.
  test("the role unions are RN 0.81.5's, size-pinned, and genuinely different domains", () => {
    expect(VALID_ACCESSIBILITY_ROLES.size).toBe(40);
    expect(VALID_ROLES.size).toBe(65);
    // One value from each union that the OTHER rejects — the reason invalid-role
    // validates each attribute against its own set.
    expect(VALID_ACCESSIBILITY_ROLES.has("header")).toBe(true);
    expect(VALID_ROLES.has("header")).toBe(false);
    expect(VALID_ROLES.has("heading")).toBe(true);
    expect(VALID_ACCESSIBILITY_ROLES.has("heading")).toBe(false);
    // The overlap that matters most in practice.
    for (const shared of ["button", "link", "checkbox", "switch", "tab", "none"]) {
      expect(VALID_ACCESSIBILITY_ROLES.has(shared)).toBe(true);
      expect(VALID_ROLES.has(shared)).toBe(true);
    }
  });

  test("keyed by specifier, so a same-named component is NOT a host element", () => {
    expect(nativeElementFor("react-native", "View")).toBeDefined();
    // The whole reason the table is two levels deep.
    expect(nativeElementFor("./my-ui", "View")).toBeUndefined();
    expect(nativeElementFor("react-native", "TicketRow")).toBeUndefined();
  });

  test("leaves do not accept children, and SafeAreaView agrees across both specifiers", () => {
    for (const leaf of [
      "TextInput",
      "Image",
      "ActivityIndicator",
      "Switch",
      "FlatList",
      "Ionicons",
    ])
      expect(`${leaf}:${nativeAcceptsChildrenByName(leaf)}`).toBe(`${leaf}:false`);
    for (const box of ["View", "Text", "Pressable", "ScrollView", "SafeAreaView"])
      expect(`${box}:${nativeAcceptsChildrenByName(box)}`).toBe(`${box}:true`);
    expect(nativeElementFor("react-native", "SafeAreaView")?.acceptsChildren).toBe(
      nativeElementFor("react-native-safe-area-context", "SafeAreaView")?.acceptsChildren,
    );
  });

  test("icons are textless, which is what makes an icon-only control unaddressable", () => {
    expect(TEXTLESS_ELEMENTS.has("Ionicons")).toBe(true);
    expect(TEXTLESS_ELEMENTS.has("ActivityIndicator")).toBe(true);
    expect(TEXTLESS_ELEMENTS.has("Text")).toBe(false);
    expect(TEXTLESS_ELEMENTS.has("View")).toBe(false);
  });
});

describe("the native content model", () => {
  // React Native throws "Text strings must be rendered within a <Text> component"
  // — a hard runtime invariant, the direct analogue of <tbody>-needs-<table>.
  test("strings are only allowed inside <Text>", () => {
    expect(stringsAllowedIn("Text")).toBe(true);
    expect(stringsAllowedIn("View")).toBe(false);
    expect(stringsAllowedIn("Pressable")).toBe(false);
    expect(stringsAllowedIn(undefined)).toBe(false);
  });

  test.each([
    [{ tag: "TextInput", control: "controlled" }, "text"],
    [{ tag: "TextInput", control: "uncontrolled" }, "text"],
    // The controlled-input trap, recorded rather than dropped so the emitter can
    // say WHY it skipped instead of pretending the field is absent.
    [{ tag: "TextInput", control: "frozen" }, "skip"],
    [{ tag: "Switch" }, "toggle"],
    [{ tag: "input" }, "skip"],
  ])("nativeFillKind(%o) === %p", (field, want) => {
    expect(nativeFillKind(field as any)).toBe(want as ReturnType<typeof nativeFillKind>);
  });

  test("useFocusEffect demands a router; SafeAreaView demands nothing", () => {
    const p = requiredNativeProviders(["useState", "useFocusEffect"]);
    expect(p).toHaveLength(1);
    expect(p[0]?.provider).toBe("renderRouter");
    expect(p[0]?.from).toBe("expo-router/testing-library");
    expect(p[0]?.note).toMatch(/navigation object/);
    // The anti-false-claim case. react-native-safe-area-context v5's SafeAreaView
    // renders a native view and reads NO context — only useSafeAreaInsets and
    // useSafeAreaFrame throw. An earlier draft would have encoded a
    // required-ancestor fact that is simply false.
    expect(requiredNativeProviders(["useState"])).toEqual([]);
    expect(requiredNativeProviders(["useSafeAreaInsets"])[0]?.provider).toBe("SafeAreaProvider");
  });
});

describe("the host-tag predicate", () => {
  test("the DOM rule is unchanged, and still refuses a component root", () => {
    expect(domOnlyResolver("div")).toEqual({ name: "div", dialect: "dom" });
    expect(domOnlyResolver("my-element")).toEqual({ name: "my-element", dialect: "dom" });
    // THE web regression. shadcn's Button returns <ButtonPrimitive>, and
    // reporting that let a caller conclude the render contained an element
    // called "ButtonPrimitive" and no button at all.
    expect(domOnlyResolver("ButtonPrimitive")).toBeUndefined();
    expect(domOnlyResolver("Button")).toBeUndefined();
  });

  test("a DOM file gets the DOM resolver itself, not a wrapper around it", async () => {
    const r = makeHostTagResolver(await importsOf(path.join(FIXTURES, "Hello.tsx")));
    expect(r).toBe(domOnlyResolver);
  });

  test("a native file resolves imported RN elements, and refuses everything else", async () => {
    const r = makeHostTagResolver(await importsOf(path.join(EXPOAPP, "app/(tabs)/index.tsx")));
    expect(r("View")).toEqual({ name: "View", dialect: "native" });
    expect(r("Pressable")).toEqual({ name: "Pressable", dialect: "native" });
    expect(r("SafeAreaView")).toEqual({ name: "SafeAreaView", dialect: "native" });
    // Imported, but from the app — a component, not a host element.
    expect(r("ItemRow")).toBeUndefined();
    // Not imported at all. Never guessed from the name.
    expect(r("Pressible")).toBeUndefined();
    expect(r("IconButton")).toBeUndefined();
    // A lowercase tag in an RN file is still a DOM intrinsic as far as this
    // predicate goes; whether it can render on a device is a different question.
    expect(r("div")).toEqual({ name: "div", dialect: "dom" });
  });
});

describe("what the analyser now sees in React Native source", () => {
  const analyse = (rel: string) =>
    analyseFile({
      entry: path.join(EXPOAPP, rel),
      depth: 0,
      includeChildren: false,
      roots: "exported",
    });

  test("rootTag resolves, where it was undefined for EVERY RN component before", async () => {
    expect((await analyse("app/login.tsx"))[0]?.entry.rootTag).toBe("View");
    expect((await analyse("app/(tabs)/index.tsx"))[0]?.entry.rootTag).toBe("SafeAreaView");
    expect((await analyse("components/icon.tsx"))[0]?.entry.rootTag).toBe("Text");
  });

  test("hostDialect is recorded on the component, and only when native", async () => {
    expect((await analyse("app/login.tsx"))[0]?.entry.hostDialect).toBe("native");
    const web = await analyseFile({
      entry: path.join(FIXTURES, "Hello.tsx"),
      depth: 0,
      includeChildren: false,
      roots: "primary",
    });
    expect(web[0]?.entry.hostDialect).toBeUndefined();
  });

  test("classNameFlow is false on native, however many classNames the source has", async () => {
    // NativeWind compiles className into a `style` through BABEL at build time.
    // The string reaches neither the jest-expo tree nor the react-native-web DOM
    // (measured: docs/reviews/2026-08-expo-probes.md, P1), so asserting it lands
    // somewhere is a test that can never pass.
    const info = (await analyse("app/(tabs)/index.tsx"))[0]?.entry;
    expect(info?.classNameFlow).toBe(false);
  });

  test("press handlers are found and labelled through the descendant <Text>", async () => {
    const clicks = (await analyse("app/(tabs)/index.tsx"))[0]?.entry.interactions?.clicks ?? [];
    // Before this wave onPress was not in EVENT_PATTERN at all, so this was 0.
    expect(clicks.length).toBeGreaterThan(0);
    const add = clicks.find((c) => c.label.kind === "text" && c.label.value === "Add");
    expect(add?.tag).toBe("Pressable");
    // testID still outranks text, as it does on the DOM.
    expect(clicks.find((c) => c.hints.testid === "reload")).toBeDefined();
  });

  test("a label behind a PARENTHESISED ternary is still found", async () => {
    // The bug the dogfood app caught and the fixture originally hid: prettier and
    // biome both format a multi-line JSX ternary as `cond ? (<A/>) : (<B/>)`, so
    // the branch is a ParenthesizedExpression. A bare isJsxElement check misses
    // every real submit button — on the dogfood app it was half the addressable
    // press targets, 20.8% against 41.7%.
    const clicks = (await analyse("app/login.tsx"))[0]?.entry.interactions?.clicks ?? [];
    const submit = clicks.find((c) => c.event === "onPress");
    expect(submit?.label).toEqual({ kind: "text", value: "Sign in" });
  });

  test("an icon-only control stays honestly unaddressable", async () => {
    // <Pressable><Icon/></Pressable> with no testID and no accessibilityLabel has
    // no handle, and inventing one would emit a query that matches nothing while
    // reporting coverage. The same absence is what makes it silent to a screen
    // reader, so one accessibilityLabel fixes both.
    const clicks = (await analyse("app/items/[id].tsx"))[0]?.entry.interactions?.clicks ?? [];
    const back = clicks.find((c) => c.event === "onPress");
    expect(back).toBeDefined();
    expect(back?.label.kind).toBe("none");
    expect(back?.hints.testid).toBeUndefined();
    expect(back?.hints.ariaLabel).toBeUndefined();
  });

  test("TextInput placeholders are collected, and `name`/`type` never are", async () => {
    const clicks = (await analyse("app/login.tsx"))[0]?.entry.interactions?.clicks ?? [];
    const fields = clicks.filter((c) => c.event === "onChangeText");
    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.hints.placeholder)).toEqual(["you@example.com", "••••••••"]);
    // Leaving these empty is what makes selectors.ts's DOM-only branches
    // naturally inert on native data instead of emitting a query that cannot match.
    for (const f of fields) {
      expect(f.hints.name).toBeUndefined();
      expect(f.hints.type).toBeUndefined();
    }
  });
});
