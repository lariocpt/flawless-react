import { getDb } from "./db-helper.ts";

export default async function ServerPage() {
  const db = getDb();
  return <main>{String(db)}</main>;
}
