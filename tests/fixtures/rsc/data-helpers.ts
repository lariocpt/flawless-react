export interface Db {
  url: string;
}

export interface Insight {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export interface Building {
  id: string;
  name: string;
  floors: number;
}

export interface Member {
  id: string;
  name: string;
}

export function getDb(): Db {
  return { url: "postgres://localhost/flawless" };
}

export async function listRecentInsights(
  buildingId: string,
  limit: number,
): Promise<Insight[]> {
  return [
    {
      id: `${buildingId}-1`,
      title: "Occupancy up",
      body: "Weekday occupancy rose 12%.",
      createdAt: new Date().toISOString(),
    },
  ].slice(0, limit);
}

export async function getBuildingById(db: Db, id: string): Promise<Building | undefined> {
  return db.url ? { id, name: "Riverside HQ", floors: 12 } : undefined;
}

/**
 * Legacy helper: the payload changed from a plain array to a paginated
 * envelope and the return type was never tightened. This is exactly how a
 * component ends up reading both `.length` and `.total` off one value.
 */
export async function loadInsightsLegacy(db: Db, id: string): Promise<any> {
  return { items: [], total: 0, buildingId: id, db: db.url };
}

export async function listMemberIds(db: Db, buildingId: string): Promise<string[]> {
  return db.url ? [`${buildingId}-a`, `${buildingId}-b`] : [];
}

export async function loadMember(db: Db, memberId: string): Promise<Member> {
  return { id: memberId, name: db.url };
}

/** Stand-in for next/navigation's notFound so the fixtures need no next dep. */
export function notFound(): never {
  throw new Error("NEXT_NOT_FOUND");
}
