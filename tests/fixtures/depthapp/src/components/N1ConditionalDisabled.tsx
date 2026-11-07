// N1 — the refusal control: a conditionally disabled control. `flags` is
// typed `Pick<FlagSource, "pending">` — a generic instantiation both prop
// resolvers refuse (mapType is syntactic; the strict fixture resolver only
// floors Record/Partial), so no generated DEFAULTS can say what
// `flags?.pending` is. `pending` is the resolvable half (boolean -> false).
// The disabled expression therefore does not reduce: the emitter must skip
// the click by name ("its control is disabled at these props") and must NOT
// assert toBeDisabled() — a claim no default provably satisfies.
"use client";

type FlagSource = {
  pending: boolean;
  source: "client" | "server";
};

type N1ConditionalDisabledProps = {
  /** The resolvable half of the disabled expression. */
  pending?: boolean;
  /** The unresolvable half: only `flags?.pending` is read. */
  flags?: Pick<FlagSource, "pending">;
};

export function N1ConditionalDisabled({ pending, flags }: N1ConditionalDisabledProps) {
  function confirm() {}
  return (
    <div>
      <button type="button" disabled={pending || flags?.pending} onClick={confirm}>
        Confirm order
      </button>
    </div>
  );
}
