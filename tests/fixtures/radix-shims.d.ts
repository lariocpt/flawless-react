// Ambient stand-ins for the two Radix packages the disclosure fixtures import.
// Same shape and same reasoning as expo-shims.d.ts beside this file: a shim
// keeps the fixture fully typechecked (a misspelled primitive or prop still
// errors) and stands in only for module resolution, which `@ts-nocheck` would
// have silenced along with it.
//
// Installing @radix-ui/react-toast and react-slot for real is not worth it:
// these three files are ANALYSABLE INPUTS for the library-decided-render and
// provider-alias rules, and the analyser recognises Radix from the IMPORT
// SPECIFIER — it never walks node_modules. Nothing under src/ imports either
// specifier, so these declarations cannot mask a real type in the tool.
//
// The props named here are exactly the ones the fixtures pass: Radix's open
// state (`open`) and Slot's `asChild`.

declare module "@radix-ui/react-toast" {
  import type { ComponentType, ReactNode } from "react";
  export const Root: ComponentType<{ open?: boolean; children?: ReactNode }>;
  export const Description: ComponentType<{ children?: ReactNode }>;
}

declare module "@radix-ui/react-slot" {
  import type { ComponentType, ReactNode } from "react";
  export const Root: ComponentType<{ asChild?: boolean; children?: ReactNode }>;
}
