import { getDb, loadInsightsLegacy } from "./data-helpers.ts";

export default async function EnvelopePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const insights = await loadInsightsLegacy(db, id);

  return (
    <section>
      <p>{insights.length} shown</p>
      <p>{insights.total} total</p>
    </section>
  );
}
