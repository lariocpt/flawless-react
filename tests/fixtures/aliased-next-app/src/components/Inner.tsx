// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.

// Defect #7 shape (c), innermost: the deepest async component in the tree.
export async function Inner() {
  return <span>nested-inner</span>;
}
