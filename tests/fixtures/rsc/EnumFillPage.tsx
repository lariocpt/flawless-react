// @ts-nocheck — parsed, not typechecked, like its siblings.
// `job.status` is read only into lookups, so usage synthesises
// "flawless-status" — but the return annotation's literal union names the
// legal values, and the child that indexes a Record by this field crashes on
// anything else. `job.note` is the control: a plain-string annotation
// resolves to another placeholder, which must NOT replace the name-seeded one.
import { getJob } from "./data-helpers.ts";

const LABEL = { open: "Open", closed: "Closed" };

export default async function EnumFillPage() {
  const job = await getJob("j1");
  return (
    <main>
      <b>{LABEL[job.status]}</b>
      <i>{job.note}</i>
    </main>
  );
}
