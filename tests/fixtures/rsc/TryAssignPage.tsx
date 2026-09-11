// @ts-nocheck — parsed, not typechecked, like its siblings.
// The ticket-detail shape: the dep is assigned inside a top-level try (the
// data layer throws domain errors), and the guard on it compares `!==` to a
// route param. Before the try-assignment rule the variable never became a
// dep, so no field note existed for the polarity capture to land on.
import { notFound } from "next/navigation";
import { getTicketDetail, listOptions } from "./data-helpers.ts";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function TryAssignPage({ params }: Props) {
  const { id } = await params;
  let ticket: Awaited<ReturnType<typeof getTicketDetail>>;
  try {
    ticket = await getTicketDetail(id);
  } catch {
    notFound();
  }
  if (!ticket || ticket.building_id !== id) notFound();
  const options = await listOptions(id);
  const total = options.reduce((acc, o) => acc + o.w, 0);
  return (
    <main>
      <h1>{ticket.title}</h1>
      <b>{total}</b>
    </main>
  );
}
