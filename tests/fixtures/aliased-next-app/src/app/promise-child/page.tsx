// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.
import { loadHeading } from "@/lib/data";

// Defect #7 shape (a): a PROMISE as a child (React 19's suspense-data
// pattern). resolveAsyncUi must await it before createRoot sees the tree;
// un-awaited it suspends the root with no boundary — empty container, no error.
// Two children so the flattening key-warning fires on the same render.
export default async function PromiseChildPage() {
  return (
    <main>
      <section>{loadHeading()}</section>
      <p>below the slot</p>
    </main>
  );
}
