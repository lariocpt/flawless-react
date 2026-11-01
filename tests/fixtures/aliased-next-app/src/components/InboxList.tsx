// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.
"use client";

import { useToasts } from "@/lib/store/selectors";
import type { InboxItem } from "@/lib/data";

export function InboxList({ items }: { items: InboxItem[] }) {
  const toasts = useToasts();
  return (
    <div>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.title}</li>
        ))}
      </ul>
      <div role="status">
        {toasts.map((t) => (
          <span key={t.id}>{t.text}</span>
        ))}
      </div>
    </div>
  );
}
