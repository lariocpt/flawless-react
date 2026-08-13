// @ts-nocheck — the "@/…" alias resolves through this fixture's pretend
// Next.js project, not through the repo root tsconfig.
import { getBuilding } from "@/lib/buildings";
import { notFound } from "@/lib/nav";

export default async function LocalNavPage({ id }: { id: string }) {
  const building = await getBuilding(id);

  if (!building) notFound();

  return (
    <main>
      <h1>{building.name}</h1>
    </main>
  );
}
