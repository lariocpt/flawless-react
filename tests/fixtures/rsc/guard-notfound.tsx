// @ts-nocheck — next/navigation and the "@/…" alias resolve through this
// fixture's pretend Next.js project, not through the repo root tsconfig.
import { getBuilding, listUnits, loadAudit } from "@/lib/buildings";
import { notFound, redirect } from "next/navigation";

interface BuildingPageProps {
  params: { id: string };
}

export default async function BuildingPage({ params }: BuildingPageProps) {
  const building = await getBuilding(params.id);
  const units = await listUnits(params.id);
  const audit = await loadAudit(params.id);

  if (!building) notFound();

  if (!units.length) {
    notFound();
  }

  if (building.status === "archived") redirect("/buildings/archived");

  if (!audit) {
    console.warn("audit missing for", params.id);
    redirect("/buildings");
  }

  return (
    <main>
      <h1>{building.name}</h1>
      <p>{units.length} units</p>
    </main>
  );
}
