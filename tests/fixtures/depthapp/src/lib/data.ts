// Data functions the P6 RSC page awaits (src/app/guarded/page.tsx). Both
// return typed promises, so the analyser resolves both data deps and can mock
// them — the pattern under test is the TWO-dep guard, not the data access.
export function getUser(): Promise<{ name: string }> {
  return Promise.resolve({ name: "Ada" });
}

export function getOrg(): Promise<{ name: string }> {
  return Promise.resolve({ name: "Acme" });
}
