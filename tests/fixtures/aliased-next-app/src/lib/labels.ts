// @ts-nocheck — see layout.tsx; "@/…" resolves through the fixture's tsconfig.
import { signOff } from "./data";

/** The type the importers spell first: the merge base for the value import. */
export interface Signature {
  name: string;
}

/**
 * A plain (non-component) lib file: the entry pattern is `*.tsx` and nothing
 * in the component graph is tagged from it, so the analysis never opens it
 * (defect #13). Its module-scope import of signOff runs the moment an
 * analysed file imports it.
 */
export function signatureLine(sig: Signature): string {
  return String(signOff()) + " " + sig.name;
}
