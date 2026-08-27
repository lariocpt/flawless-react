import { detectHostDialect, type HostDialect } from "./nativeDialect.ts";
import { nativeElementFor } from "./nativeProps.ts";
import type { ImportBinding } from "./parseFile.ts";

/**
 * Whether a JSX tag names a host element, and which one.
 *
 * ONE predicate, replacing the `/^[a-z][a-z0-9-]*$/` test that was written out
 * five times — extractRootTag, extractRenderMode, extractFlows, extractChildAttrs
 * and selectors.ts. Five copies of a rule is the defect class this project keeps
 * finding in its own docs, and it was about to become ten.
 *
 * The rule is EVIDENCE-BASED in both directions:
 *
 *   - lowercase          -> a DOM intrinsic. Byte-identical to the old test.
 *   - Capitalised        -> a host element IF AND ONLY IF this file imports that
 *                           name from a specifier in the closed native table.
 *   - anything else      -> undefined, meaning "this is a component" — exactly
 *                           the state every uppercase tag is in today.
 *
 * Never a guess from the name. `<IconButton>` is not a button, `<TicketRow>` is
 * not a row, and shadcn's `<ButtonPrimitive>` must keep answering undefined on
 * the web path or the DOM regression this predicate was extracted from returns.
 */
export interface ResolvedHostTag {
  /**
   * The canonical element name: the MODULE-SIDE export, never the local alias.
   *
   * `import { View as Box }` gives tag "Box" and name "View". This is the same
   * refusal extractRootTag already makes for `<UI.Badge/>` — "Badge" and
   * "UI.Badge" are both lies about the emitted element — applied in the other
   * direction, and it is what makes rootTag comparable across files.
   */
  name: string;
  dialect: HostDialect;
}

export type HostTagResolver = (tag: string) => ResolvedHostTag | undefined;

const LOWERCASE_INTRINSIC = /^[a-z][a-z0-9-]*$/;

/**
 * Today's rule, exactly: lowercase intrinsics only.
 *
 * The default everywhere, so every existing call site behaves byte-identically
 * until it is handed a native resolver on purpose.
 */
export const domOnlyResolver: HostTagResolver = (tag) =>
  LOWERCASE_INTRINSIC.test(tag) ? { name: tag, dialect: "dom" } : undefined;

/**
 * A resolver for one file, built from that file's own imports.
 *
 * Returns `domOnlyResolver` unchanged for a DOM file — not a wrapper around it,
 * the same function object — so the web path cannot pick up so much as an extra
 * closure.
 */
export function makeHostTagResolver(imports: Map<string, ImportBinding>): HostTagResolver {
  if (detectHostDialect(imports) === "dom") return domOnlyResolver;
  return (tag) => {
    // A lowercase tag in a React Native file is still a DOM intrinsic as far as
    // this predicate is concerned. It cannot render on a device, but saying so
    // is extractRenderMode's job, not this one's.
    if (LOWERCASE_INTRINSIC.test(tag)) return { name: tag, dialect: "dom" };
    if (!/^[A-Z]/.test(tag)) return undefined;
    const binding = imports.get(tag);
    if (!binding || binding.isTypeOnly || binding.kind === "namespace") return undefined;
    const exported = binding.importedName ?? tag;
    if (nativeElementFor(binding.specifier, exported) === undefined) return undefined;
    return { name: exported, dialect: "native" };
  };
}
