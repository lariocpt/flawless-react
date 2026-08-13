export function helper(): string {
  // Not a prologue directive — it is an expression statement inside a function,
  // and it does not make this module a server-action module.
  "use server";
  return "nope";
}
