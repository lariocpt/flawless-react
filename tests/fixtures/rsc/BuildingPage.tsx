import { getBuildingById, getDb, notFound } from "./data-helpers.ts";

export default async function BuildingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const building = await getBuildingById(db, id);
  if (!building) {
    return notFound();
  }

  return (
    <main>
      <h1>{building.name}</h1>
      <p>{building.floors}</p>
    </main>
  );
}
