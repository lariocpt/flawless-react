// @ts-nocheck — next/navigation resolves through the target project, not this
// repo, so this fixture is parsed rather than typechecked. Same as its siblings.
// The two shapes behind the dogfood guard-exit residue that survived the
// equals/equalsProp round:
//
//   `if (!invoice || invoice.building_id !== id) notFound()` — the pass side
//   of a `!==` guard is uniquely `=== id`, but equals-capture skipped `!==`
//   everywhere, so the synthesised field never matched the route param;
//
//   `members.find((m) => m.user_id === user.id)` — neither side is a literal
//   or a prop, and two independently synthesised spellings never match;
//   the row's `status` is then checked off the find RESULT, which classic
//   element-field collection cannot see at all.
//
// Plus the polarity control: `invoice.kind === "deleted"` INSIDE a guard must
// capture nothing — the captured value would fire the very exit the fixture
// exists to avoid — while `invoice.status !== "paid"` in render position must
// also capture nothing, exactly as before.
import { notFound } from "next/navigation";
import { getCurrentUser, getInvoiceById, listMembershipsForBuilding } from "./data-helpers.ts";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function GuardPolarityPage({ params }: Props) {
  const { id } = await params;
  const user = await getCurrentUser();
  const invoice = await getInvoiceById(id);
  if (!invoice || invoice.building_id !== id) notFound();
  if (invoice.kind === "deleted") notFound();
  const members = await listMembershipsForBuilding(id);
  const myMembership = members.find((m) => m.user_id === user.id);
  if (!myMembership || myMembership.status !== "active") notFound();
  return (
    <main>
      <h1>{invoice.number}</h1>
      {invoice.status !== "paid" ? <b>Due</b> : null}
      <p>{myMembership.label}</p>
      <span>{user.name}</span>
    </main>
  );
}
