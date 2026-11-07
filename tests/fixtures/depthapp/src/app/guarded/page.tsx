// P6 — D1 item 5: an RSC page guarded on TWO resolvable data deps. No single
// mocked value trips a two-dep guard (classifyLogical only yields a trigger
// when both operands name the SAME single dep), so emitGuardTests skips it
// without emitting anything — the census row is the evidence.
import { getOrg, getUser } from "../../lib/data";

export default async function GuardedPage() {
  const [user, org] = await Promise.all([getUser(), getOrg()]);
  if (!user || !org) throw new Error("user and org are required");
  return <h1>{user.name} @ {org.name}</h1>;
}
