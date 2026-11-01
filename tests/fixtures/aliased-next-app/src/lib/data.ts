// @ts-nocheck — see layout.tsx; "@/…" and zustand resolve through the fixture.
export interface InboxItem {
  id: string;
  title: string;
}

/** Stands in for the app's DB call: the page awaits this before rendering. */
export async function getInboxItems(): Promise<InboxItem[]> {
  return [
    { id: "1", title: "Welcome to the inbox" },
    { id: "2", title: "Second message" },
  ];
}
