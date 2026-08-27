import type { ImportBinding } from "./parseFile.ts";

/**
 * Which host-element vocabulary a FILE's JSX is written in.
 *
 * - "dom"    — lowercase intrinsics (`<div>`, `<button>`). Every file the tool
 *              has ever analysed, and the answer whenever nothing says otherwise.
 * - "native" — React Native elements, which are IMPORTED capitalised tags
 *              (`<View>` from "react-native").
 *
 * Decided per FILE from that file's own imports, not per run from a flag. Three
 * reasons, in order of how much they cost to get wrong:
 *
 * 1. The evidence is already here. `import { View } from "react-native"` sits in
 *    `parsed.imports` before any extractor runs, so a flag would ask the operator
 *    to assert something the tool can read.
 * 2. A flag cannot express a monorepo. `apps/web` and `apps/mobile` under one
 *    sweep have different answers, and a single global value has to be wrong for
 *    one of them.
 * 3. "An Expo app also targets web" argues AGAINST a run-level axis, not for it.
 *    Under Expo web the source is byte-identical — still `<View>`, still imported
 *    from "react-native". What changes is the runtime (react-native-web maps View
 *    to a div), not the AST. There is nothing here for a platform flag to select.
 *
 * The invariant that makes this safe: **a file with host elements to classify
 * always has the import that proves the dialect**, because a React Native host
 * element is only ever reachable through an import — there are no ambient
 * capitalised intrinsics. A file with no native import either renders lowercase
 * intrinsics (dialect "dom", correct) or renders only component tags (dialect
 * irrelevant, because nothing downstream branches).
 */
export type HostDialect = "dom" | "native";

/**
 * Specifiers whose presence proves the file is React Native source.
 *
 * Broad on purpose: this decides the DIALECT, not the element set. `expo-secure-store`
 * exports no element at all, but a file importing it is unambiguously React
 * Native, and that is the only question being asked here. Which tags are host
 * elements is `nativeProps.ts`'s much narrower, closed table.
 *
 * `react-dom` is deliberately absent — a file may import both under Expo web.
 * The native import is the positive evidence; nothing is evidence against it.
 */
const NATIVE_DIALECT_SPECIFIER =
  /^(react-native|react-native-[\w.-]+|@react-native(-community)?\/|expo|expo-[\w.-]+|@expo\/|@react-navigation\/|nativewind)$|^(react-native|@react-native|expo|@expo|@react-navigation|nativewind)\//;

export function detectHostDialect(imports: Map<string, ImportBinding>): HostDialect {
  for (const binding of imports.values()) {
    if (binding.isTypeOnly) continue;
    if (NATIVE_DIALECT_SPECIFIER.test(binding.specifier)) return "native";
  }
  return "dom";
}

/** Exported for the test that pins which specifiers count. */
export function isNativeSpecifier(specifier: string): boolean {
  return NATIVE_DIALECT_SPECIFIER.test(specifier);
}
