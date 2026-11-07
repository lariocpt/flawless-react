// Layout for the depth-surface fixture: a plain document root, so the layout
// spec exercises the document-root render mode with no provider to derive.
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
