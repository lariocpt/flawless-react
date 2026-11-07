// P10 — D4 (not yet shipped): a form with named fields wired to a server
// action (useActionState — stable in the react 19 this app declares). Client
// mock mode is allowlist-only, so the action's module stays REAL and the
// submit has no mock to assert against: the emitted test fills and reads the
// fields back, clicks submit, and asserts nothing about the action call (no
// toHaveBeenCalledWith, no vi.mocked(saveProfile)).
"use client";
import { useActionState } from "react";
import { saveProfile } from "../lib/actions";

export function P10ActionForm() {
  const [, action] = useActionState(saveProfile, { ok: false });
  return (
    <form action={action}>
      <label htmlFor="p10-name">Name</label>
      <input id="p10-name" name="name" type="text" />
      <label htmlFor="p10-email">Email</label>
      <input id="p10-email" name="email" type="email" />
      <button type="submit">Save profile</button>
    </form>
  );
}
