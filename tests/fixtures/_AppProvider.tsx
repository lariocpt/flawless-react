import type { ReactNode } from "react";

// Minimal "provider" fixture used by --provider tests. Real-world providers
// would wrap children in Redux <Provider store={...}> / React Query's
// <QueryClientProvider> / etc.; here we just pass children through to keep
// the fixture dependency-free.
export default function AppProvider({ children }: { children: ReactNode }) {
  return children;
}
