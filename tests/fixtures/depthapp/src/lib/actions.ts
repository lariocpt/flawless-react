// The server action P10ActionForm wires to through useActionState. A plain
// module: client mock mode is allowlist-only, so the emitted spec leaves it
// REAL and the form's submit has no mock to assert against — that is D4's
// gap, not this file's.
//
// The return shape matches the initial state ({ ok: boolean }) exactly —
// useActionState infers its State type from BOTH the action's return and the
// initial value, and a wider return would fail the check.
export async function saveProfile(
  _prev: { ok: boolean },
  form: FormData,
): Promise<{ ok: boolean }> {
  const name = String(form.get("name") ?? "");
  const email = String(form.get("email") ?? "");
  return { ok: name !== "" && email !== "" };
}
