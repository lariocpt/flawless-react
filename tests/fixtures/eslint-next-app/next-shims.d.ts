// Ambient stand-ins for the two module families this fixture's layout.tsx
// imports: next/font/google (the `next` dependency is not installed in this
// repo's own node_modules) and the "@/components/*" path alias.
//
// A SHIM rather than `@ts-nocheck` (which is what tests/fixtures/nextapp uses
// for the same class of problem): this fixture's own flat eslint config
// enables @typescript-eslint/ban-ts-comment, so a `// @ts-nocheck` line would
// be the one error the fixture exists to keep at zero. With these
// declarations the fixture is still fully typechecked and linted; only module
// resolution is stood in for.
//
// The "@/components/*" wildcard mirrors the fixture tsconfig's own "paths"
// mapping. The analyser reads the real files through that mapping (it never
// resolves ambient declarations), so nothing the tool emits depends on this
// shim; it exists for the repo's own `tsc --noEmit`, which typechecks
// tests/**.

declare module "next/font/google" {
  export function Inter(config?: { subsets?: string[] }): {
    className: string;
    variable: string;
  };
}

declare module "@/components/*" {
  import type { ComponentType, ReactNode } from "react";
  const Component: ComponentType<{ children?: ReactNode; [prop: string]: unknown }>;
  export default Component;
}
