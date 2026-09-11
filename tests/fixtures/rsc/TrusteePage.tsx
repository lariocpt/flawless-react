// @ts-nocheck — parsed, not typechecked, like its siblings.
// The B-19 exemplar: a boolean-annotated predicate deciding paired-witness
// and absence-only ternaries plus a data-selection ternary, an array dep with
// an empty side, and the two refusal shapes (a `true` literal annotation, a
// callee invoked twice).
import {
  canModerate,
  isManagerOf,
  isTrusteeOf,
  listAllItems,
  listContractors,
  listMyItems,
} from "./data-helpers.ts";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function TrusteePage({ params }: Props) {
  const { id } = await params;
  const userIsTrustee = isTrusteeOf(id);
  const alwaysManager = isManagerOf(id);
  const canPost = await canModerate(id);
  const canPin = await canModerate(id);
  const rows = await (userIsTrustee ? listAllItems(id) : listMyItems(id));
  const contractors = await listContractors(id);
  return (
    <main>
      <h1>Contractors</h1>
      {userIsTrustee ? <button type="button">Add contractor</button> : null}
      <p>{userIsTrustee ? "All items" : "My items"}</p>
      {alwaysManager ? <b>Manager tools</b> : <i>never rendered</i>}
      {canPost ? <em>Post box</em> : null}
      {contractors.length === 0 ? (
        <p>No contractors yet</p>
      ) : (
        <ul>
          {contractors.map((c) => (
            <li key={c.name}>{c.name}</li>
          ))}
        </ul>
      )}
      <span>{rows.length}</span>
      <span>{canPin ? "pinned" : "unpinned"}</span>
    </main>
  );
}
