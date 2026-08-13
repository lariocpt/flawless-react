import { getDb, listMemberIds, loadMember } from "./data-helpers.ts";

export default async function MembersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const memberIds = await listMemberIds(db, id);
  const members = await Promise.all(memberIds.map((memberId) => loadMember(db, memberId)));

  return (
    <ul>
      {members.map((member) => (
        <li key={member.id}>{member.name}</li>
      ))}
    </ul>
  );
}
