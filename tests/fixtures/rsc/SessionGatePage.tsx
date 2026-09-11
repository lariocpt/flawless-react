// @ts-nocheck — parsed, not typechecked, like its siblings.
// The landing-page shape: a truthy guard on a nullable-annotated dep. The
// fixture makes the session truthy, the redirect fires, and the entire page
// below is unexercised — flipping to null (the annotation's own other arm)
// is the only way to render it.
import { redirect } from "next/navigation";
import { verifySession2 } from "./data-helpers.ts";

export default async function SessionGatePage() {
  const session = await verifySession2();
  if (session) redirect("/dashboard");
  return (
    <main>
      <h1>Welcome to the landing page</h1>
      <p>Manage your building together.</p>
    </main>
  );
}
