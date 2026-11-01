// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.
import { InboxList } from "@/components/InboxList";
import { getInboxItems } from "@/lib/data";

export default async function InboxPage() {
  const items = await getInboxItems();
  return (
    <main>
      <h1>Inbox</h1>
      <InboxList items={items} />
    </main>
  );
}
