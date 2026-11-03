// No @ts-nocheck here (unlike tests/fixtures/nextapp): this fixture's own
// flat eslint config fires @typescript-eslint/ban-ts-comment on that line.
// The next/font/google and "@/components/*" specifiers typecheck against the
// ambient declarations in next-shims.d.ts at the fixture root instead.
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
