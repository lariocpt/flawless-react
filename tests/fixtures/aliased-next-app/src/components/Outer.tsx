// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.
import { Inner } from "@/components/Inner";

// Defect #7 shape (c): async component rendered by an async page, itself
// rendering an async component. Two children so the recursion also crosses
// the array-children path resolveAsyncUi flattens.
export async function Outer() {
  return (
    <div>
      <Inner />
      <span>outer-static</span>
    </div>
  );
}
