// @ts-nocheck — the "@/…" alias resolves through this fixture's own tsconfig
// and zustand resolves through its (uninstalled) node_modules, not the repo root.
import type { ReactNode } from "react";
import { StoreProvider } from "@/components/providers/store-provider";

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}
