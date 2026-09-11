// @ts-nocheck — parsed, not typechecked, like its siblings.
import { listRecentInsights, getDb } from "./data-helpers.ts";

export async function AsyncChild() {
  const rows = await listRecentInsights(getDb(), "b1", 3);
  return <ul>{rows.map((r) => <li key={r.id}>{r.title}</li>)}</ul>;
}
