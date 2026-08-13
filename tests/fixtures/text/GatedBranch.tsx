import { useState } from "react";

interface GatedBranchProps {
  outstanding: number;
}

/**
 * The shape that made this module necessary: the component opens collapsed, so
 * the LAST return in the body describes markup the spec never produces.
 */
export function GatedBranch({ outstanding }: GatedBranchProps) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Record payment
      </button>
    );
  }

  return (
    <form>
      <p>Amount due</p>
      <output>{outstanding}</output>
      <label htmlFor="notes">Notes</label>
      <input id="notes" name="notes" />
      <button type="submit">Save payment</button>
    </form>
  );
}
