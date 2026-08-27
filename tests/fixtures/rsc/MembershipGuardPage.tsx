// @ts-nocheck — next/navigation resolves through the target project, not this
// repo, so this fixture is parsed rather than typechecked. Same as its siblings.
// The shape twenty-two of the dogfood web app's thirty-two page specs share: a
// page that looks up the viewer's own membership for the building in the URL,
// and calls notFound() when it does not find one.
//
// Both halves of that predicate rejected the synthesised row — `status` was
// "flawless-status" and `building_id` was "flawless-building_id" against a
// route param of "" — so the page took the guard on every generated spec and
// the spec recorded the guard exit as a pass.
import { notFound } from "next/navigation";
import { formatMoney, listMembershipsForUser, recordVisit } from "./data-helpers.ts";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function MembershipGuardPage({ params }: Props) {
  const { id } = await params;
  const memberships = await listMembershipsForUser(id);
  const mine = memberships.find((m) => m.building_id === id && m.status === "active");
  if (!mine) notFound();
  await recordVisit(id);
  return (
    <main>
      {memberships.map((m) => (
        <span key={m.id}>{m.label} {formatMoney(100)}</span>
      ))}
    </main>
  );
}
