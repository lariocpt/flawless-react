// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.
import { ReportTitle } from "@/components/ReportTitle";
import { loadHeading } from "@/lib/data";

// Defect #7 shape (b): a PROMISE-VALUED PROP — the shape resolveAsyncUi
// ignored entirely (it only ever recursed el.props.children). The child
// renders the prop directly, so an un-awaited promise suspends the root.
export default async function PromisePropPage() {
  return (
    <main>
      <ReportTitle heading={loadHeading()} />
      <p>below the slot</p>
    </main>
  );
}
