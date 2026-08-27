// Ambient stand-ins for the React Native / Expo packages this fixture imports.
//
// A SHIM rather than `@ts-nocheck` (which is what tests/fixtures/nextapp uses for
// the same class of problem): `@ts-nocheck` would silence every error in the
// file, so a typo like `<Vew>` or a misspelled prop would ride into the corpus
// unnoticed — and this fixture's whole job is to be a faithful description of
// React Native source. With these declarations the fixture is still fully
// typechecked; only the module resolution is stood in for.
//
// Installing react-native for real is the alternative, and it is not worth
// ~100 MB of node_modules to typecheck seven fixture files in a CLI that ships
// as a compiled binary. Nothing under src/ imports any of these specifiers, so
// an ambient declaration here cannot mask a real type in the tool itself.
//
// The analyser never needs these to resolve either: it recognises React Native
// elements from the IMPORT SPECIFIER, not by walking node_modules (which
// resolveModule.ts deliberately never does).

declare module "react-native" {
  import type { ComponentType, ReactNode } from "react";
  interface Base {
    className?: string;
    style?: unknown;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityHint?: string;
    accessible?: boolean;
    children?: ReactNode;
  }
  export const View: ComponentType<Base>;
  export const Text: ComponentType<Base & { numberOfLines?: number; onPress?: () => void }>;
  export const Pressable: ComponentType<Base & { onPress?: () => void; onLongPress?: () => void; disabled?: boolean }>;
  export const TouchableOpacity: ComponentType<Base & { onPress?: () => void; disabled?: boolean }>;
  export const ScrollView: ComponentType<Base & { contentContainerClassName?: string }>;
  export const ActivityIndicator: ComponentType<Base & { color?: string; size?: "small" | "large" }>;
  export const Image: ComponentType<Base & { source?: unknown; alt?: string }>;
  export const Switch: ComponentType<Base & { value?: boolean; onValueChange?: (v: boolean) => void }>;
  export const TextInput: ComponentType<
    Base & {
      placeholder?: string;
      placeholderTextColor?: string;
      value?: string;
      defaultValue?: string;
      editable?: boolean;
      secureTextEntry?: boolean;
      autoComplete?: string;
      autoCapitalize?: string;
      keyboardType?: string;
      onChangeText?: (t: string) => void;
      onSubmitEditing?: () => void;
    }
  >;
  export const FlatList: <T>(props: Base & {
    data: readonly T[];
    keyExtractor?: (item: T, index: number) => string;
    renderItem: (info: { item: T; index: number }) => ReactNode;
    contentContainerClassName?: string;
  }) => ReactNode;
  export const Alert: { alert: (title: string, message?: string, buttons?: unknown[]) => void };
  export const Platform: { OS: "ios" | "android" | "web" };
}

declare module "react-native-safe-area-context" {
  import type { ComponentType, ReactNode } from "react";
  export const SafeAreaView: ComponentType<{
    className?: string;
    edges?: readonly string[];
    children?: ReactNode;
  }>;
  export const SafeAreaProvider: ComponentType<{ children?: ReactNode }>;
}

declare module "expo-router" {
  import type { ComponentType, ReactNode } from "react";
  export const Stack: ComponentType<{ screenOptions?: unknown }>;
  export const Tabs: ComponentType<{ screenOptions?: unknown }>;
  export const Link: ComponentType<{ href: string; className?: string; children?: ReactNode }>;
  export const Redirect: ComponentType<{ href: string }>;
  export function useRouter(): {
    push: (href: string) => void;
    replace: (href: string) => void;
    back: () => void;
  };
  export function useLocalSearchParams<T = Record<string, string>>(): T;
  export function useFocusEffect(effect: () => void | (() => void)): void;
}

declare module "@expo/vector-icons" {
  import type { ComponentType } from "react";
  interface IconProps {
    name: string;
    size?: number;
    color?: string;
    testID?: string;
    accessibilityLabel?: string;
    className?: string;
  }
  export const Ionicons: ComponentType<IconProps>;
  export const MaterialIcons: ComponentType<IconProps>;
  export const Feather: ComponentType<IconProps>;
}

