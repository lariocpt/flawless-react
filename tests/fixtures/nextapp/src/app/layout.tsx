// @ts-nocheck — next/font and the "@/…" alias resolve through this fixture's
// own tsconfig / (uninstalled) next dependency, not the repo root.
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import Providers from "@/components/Providers";
import Toast from "@/components/Toast";

const inter = Inter({ subsets: ["latin"] });

export default async function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.className}>
      <body>
        <Providers theme="dark" fonts={inter}>
          {children}
        </Providers>
        <Toast />
      </body>
    </html>
  );
}
