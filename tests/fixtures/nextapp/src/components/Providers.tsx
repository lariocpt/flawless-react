"use client";

import type { ReactNode } from "react";

export default function Providers({ children, theme }: { children: ReactNode; theme: string }) {
  return <div data-theme={theme}>{children}</div>;
}
