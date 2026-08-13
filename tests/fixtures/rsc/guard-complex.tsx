// @ts-nocheck — next/navigation and the "@/…" alias resolve through this
// fixture's pretend Next.js project, not through the repo root tsconfig.
import { getUser, getWorkspace, listInvites } from "@/lib/session";
import { notFound, redirect } from "next/navigation";

export default async function WorkspacePage() {
  const user = await getUser();
  const workspace = await getWorkspace();
  const invites = await listInvites();

  if (!user || !workspace) redirect("/login");

  if (!invites.length || invites.length === 0) notFound();

  if (workspace === null) redirect("/onboarding");

  if (user.role !== "owner") redirect("/workspace/read-only");

  return (
    <section>
      <h2>{workspace.name}</h2>
      <p>{invites.length} pending invites</p>
    </section>
  );
}
