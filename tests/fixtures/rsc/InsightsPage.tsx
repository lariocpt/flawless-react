import { listRecentInsights } from "./data-helpers.ts";

export default async function InsightsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const items = await listRecentInsights(id, 3);

  return (
    <section>
      {items.length === 0 ? (
        <p>No insights yet.</p>
      ) : (
        <ul>
          {items.map((insight) => (
            <li key={insight.id}>
              <strong>{insight.title}</strong>
              {insight.body}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
