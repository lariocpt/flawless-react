// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.
import { Outer } from "@/components/Outer";

// Defect #7 shape (c): a NESTED async component — the page renders an async
// component that renders another async component. resolveAsyncUi already
// invokes async function components; this proves the recursion holds.
export default async function NestedPage() {
  return (
    <main>
      <Outer />
    </main>
  );
}
