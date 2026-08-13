import type { ReactNode } from "react";

interface AmbiguousRootProps {
  loading: boolean;
  rows: string[];
}

const UI = {
  Badge: ({ children }: { children?: ReactNode }) => <span className="badge">{children}</span>,
};

export function AmbiguousRoot({ loading, rows }: AmbiguousRootProps) {
  if (loading) return <aside>Loading rows</aside>;
  return <section>{rows.length} rows</section>;
}

export function FragmentRoot() {
  return (
    <>
      <h3>Fragment heading</h3>
    </>
  );
}

export function QualifiedRoot() {
  return <UI.Badge>Qualified root</UI.Badge>;
}
