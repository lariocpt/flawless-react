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

/**
 * Stands in for a slow data call handed to JSX UNAWAITED (defect #7): the
 * promise-child and promise-prop shapes pass this straight into the tree.
 * The macrotask delay is the point — a late resolution is what lands outside
 * act() and produces "a suspended resource finished loading inside a test".
 */
export function loadHeading(): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve("Quarterly report"), 10));
}

/**
 * A data call the render graph reaches only through src/lib/labels.ts — a
 * file the analysis never opens (a lib, never an entry, never a rendered
 * tag). The page's evidenced getInboxItems import forces this module's
 * mock, so the factory must still export signOff or the real labels.ts dies
 * at import time with `No "signOff" export is defined on the "@/lib/data"
 * mock` (defect #13).
 */
export function signOff(): string {
  return "Signed";
}
