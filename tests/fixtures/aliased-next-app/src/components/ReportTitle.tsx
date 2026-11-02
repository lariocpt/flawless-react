// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.
"use client";

// Defect #7 shape (b), receiving end: renders its prop directly, so the prop
// must be a plain value by the time React mounts it.
export function ReportTitle({ heading }: { heading: string }) {
  return <h1>{heading}</h1>;
}
