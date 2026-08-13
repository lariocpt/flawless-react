import { useSyncExternalStore } from "react";

declare function subscribe(cb: () => void): () => void;
declare function readToasts(): string[];

/**
 * The guard depends on a store read, so nothing about the first render is
 * knowable. The guard also returns CONTENT rather than null, so there is no
 * honest fallback either — this must produce no answer at all.
 */
export function UndecidableGuard() {
  const toasts = useSyncExternalStore(subscribe, readToasts, readToasts);

  if (toasts.length === 0) {
    return <p>Nothing to show</p>;
  }

  return (
    <ul>
      <li>Latest update</li>
    </ul>
  );
}
