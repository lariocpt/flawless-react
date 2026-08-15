"use client";

import type { ReactNode } from "react";

/**
 * `fonts` is declared because layout.tsx passes it.
 *
 * It is not used by the body on purpose — its whole job is to be the computed
 * (non-literal) attribute that ensureClientProviderWrapper has to hoist into
 * provider.fixtures.ts. Before it was declared here, the emitted wrapper's
 * `ComponentProps<typeof Providers>["fonts"]` indexed a prop that did not
 * exist, and emittedTypes.test.ts reported TS2339/TS2322 against generated
 * code that was doing exactly what it was designed to do — the fixture app was
 * the thing that was wrong. layout.tsx is `@ts-nocheck`, so nothing else in the
 * repo could notice the mismatch.
 */
export default function Providers({
  children,
  theme,
}: {
  children: ReactNode;
  theme: string;
  fonts?: { className: string };
}) {
  return <div data-theme={theme}>{children}</div>;
}
