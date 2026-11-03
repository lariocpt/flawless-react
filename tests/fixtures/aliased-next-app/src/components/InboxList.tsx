// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.
"use client";

// The type import deliberately PRECEDES the value import from the same
// module: statement order is the merge order, and only a type-only merge
// base keeps the @/lib/labels view type-only — which keeps the module REAL,
// the only wiring in which its own import of the mocked @/lib/data runs and
// defect #13 manifests. A value-first order mocks labels and hides the hazard.
import type { Signature } from "@/lib/labels";
import { signatureLine } from "@/lib/labels";
import { useToasts } from "@/lib/store/selectors";
import type { InboxItem } from "@/lib/data";

const SIGNATURE: Signature = { name: "Inbox" };

export function InboxList({ items }: { items: InboxItem[] }) {
  const toasts = useToasts();
  const line = signatureLine(SIGNATURE);
  return (
    <div>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.title}</li>
        ))}
      </ul>
      <span className="sig">{line}</span>
      <div role="status">
        {toasts.map((t) => (
          <span key={t.id}>{t.text}</span>
        ))}
      </div>
    </div>
  );
}
