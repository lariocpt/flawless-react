// @ts-nocheck — parsed, not typechecked, like its siblings.
// A server page rendering an async server CHILD: React's client renderer
// refuses an async function component, so mounting this page with AsyncChild
// left real produces an empty container. The sync child is the control — it
// stays real.
import { AsyncChild } from "./AsyncChild.tsx";
import { SyncChild } from "./SyncChild.tsx";
import { getBuildingById, getDb } from "./data-helpers.ts";

export default async function AsyncParentPage() {
  const building = await getBuildingById(getDb(), "b1");
  return (
    <main>
      <h1>{building.name}</h1>
      <AsyncChild />
      <SyncChild />
    </main>
  );
}
