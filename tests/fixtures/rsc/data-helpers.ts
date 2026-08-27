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

// ---------------------------------------------------------------------------
// The three mock shapes dogfood round 6 turned up on the web path.
// ---------------------------------------------------------------------------

export interface Membership {
  id: string;
  building_id: string;
  status: string;
  label: string;
}

/** Async, annotated: the ordinary case, and the control for the two below. */
export async function listMembershipsForUser(userId: string): Promise<Membership[]> {
  return [{ id: userId, building_id: userId, status: "active", label: userId }];
}

/**
 * Synchronous, and called inside JSX rather than awaited — so it never becomes
 * a dataDep. It was stubbed `async () => ({})`: a promise where the page
 * renders a string.
 */
export function formatMoney(cents: number): string {
  return `R${(cents / 100).toFixed(2)}`;
}

/** Returns nothing. A mock for it needs no fixture and no marker asking for one. */
export async function recordVisit(id: string): Promise<void> {
  void id;
}
