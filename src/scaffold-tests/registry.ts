import type { ComponentInfo, ComponentTree, PropsShape } from "../types.ts";

/**
 * The one place that decides what a component is CALLED and whether it can be
 * mounted, shared by both scaffolders.
 *
 * They previously kept separate copies, and the copies disagreed. The unit
 * scaffolder deduped on filePath::componentName and allocated unique spec names;
 * the perf host deduped on filePath alone — silently dropping every sibling
 * component in a multi-component file, which in the dogfood app is 84 of 181 —
 * and keyed its REGISTRY on the bare component name, so two components called
 * CommentForm produced duplicate import identifiers that would not compile.
 *
 * INVARIANT, and it is easy to break: allocate names over the FULL flattened
 * list and filter afterwards. Filtering first makes the two scaffolders assign
 * different names to the same component, and the browser specs — which look
 * components up in the perf host's registry by name — stop finding them.
 */

export interface FlatComponent {
  info: ComponentInfo;
  /** Component name of the nearest parent in the tree (undefined for roots). */
  parentName: string | undefined;
}

/** Dedupe on filePath::componentName — siblings in one file are distinct components. */
export function flattenTrees(trees: ComponentTree[]): FlatComponent[] {
  const out: FlatComponent[] = [];
  const seen = new Set<string>();
  const walk = (t: ComponentTree, parentName: string | undefined): void => {
    const key = `${t.entry.filePath}::${t.entry.componentName}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ info: t.entry, parentName });
    }
    for (const c of t.children) walk(c, t.entry.componentName);
  };
  for (const t of trees) walk(t, undefined);
  return out;
}

/** First claimant keeps the bare name; same-named later components get Parent__Name, then __2. */
export function allocateSpecNames(flat: FlatComponent[]): Map<FlatComponent, string> {
  const taken = new Set<string>();
  const out = new Map<FlatComponent, string>();
  for (const c of flat) {
    let name = c.info.componentName;
    if (taken.has(name) && c.parentName) name = `${c.parentName}__${c.info.componentName}`;
    let i = 2;
    while (taken.has(name)) name = `${c.info.componentName}__${i++}`;
    taken.add(name);
    out.set(c, name);
  }
  return out;
}

export interface HostEligibility {
  eligible: boolean;
  /** Why not, in words a run report can print verbatim. */
  reason?: string;
}

/**
 * Whether a component can be mounted in the browser profiling host.
 *
 * The host is one bundle with one #root: a component that cannot mount there
 * does not merely fail its own profile spec, it can take the bundle down. Saying
 * why out loud is the difference between "175 components covered" and a number
 * that means something.
 */
export function hostEligibility(info: ComponentInfo): HostEligibility {
  if (info.exportKind === "none") {
    return { eligible: false, reason: "not exported — the host cannot import it" };
  }
  const mode = info.renderMode ?? (info.isAsync ? "rsc" : "client");
  switch (mode) {
    case "rsc":
      return {
        eligible: false,
        reason: "async server component — it awaits data and cannot mount in a browser",
      };
    case "compound-part":
      return {
        eligible: false,
        reason: info.renderNotes?.[0] ?? "renders a compound part that needs its Root",
      };
    case "document-root":
      return {
        eligible: false,
        reason: "returns a document root (<html>) — it cannot mount inside #root",
      };
    case "null":
      return { eligible: false, reason: "renders null — there is nothing to profile" };
    default:
      break;
  }
  // A namespace import of a server-action module cannot be stubbed by name, and
  // bundling it for the browser drags in the database driver.
  const namespaceAction = (info.moduleImports ?? []).find(
    (mi) => mi.isServerAction && mi.names.length === 1 && !mi.hasDefault && mi.kind === "value",
  );
  if (namespaceAction && namespaceAction.names.length === 0) {
    return {
      eligible: false,
      reason: `imports the server-action module ${namespaceAction.specifier} without naming its exports`,
    };
  }
  return { eligible: true };
}

/** Members whose presence proves a value has to be a collection, not an object. */
const ARRAY_MEMBERS = new Set([
  "length",
  "map",
  "filter",
  "forEach",
  "find",
  "slice",
  "some",
  "every",
  "reduce",
]);

/**
 * The props a generated test should pass, including stand-ins for the ones no
 * type resolved.
 *
 * A prop that could not be resolved is absent from propsShape, so the component
 * receives undefined and `prop.field` throws before anything renders. Where the
 * analyser SAW a member access, the read itself says which empty value survives
 * it: {} still throws on .length/.map, so anything used as a collection gets [].
 *
 * The unit scaffolder did this and the perf host did not, so a component like
 * `ProfileForm({ user }: { user: User })` mounted fine under jsdom and failed in
 * the browser host with "did not render within 5000ms" — the same defect wearing
 * a different error message.
 */
export function synthesiseDefaults(info: ComponentInfo): PropsShape {
  const objectish: PropsShape = {};
  for (const u of info.propUsage ?? []) {
    if (!u.member) continue;
    if (!info.unresolvedProps.includes(u.propName)) continue;
    if (ARRAY_MEMBERS.has(u.member)) objectish[u.propName] = [];
    else objectish[u.propName] ??= {};
  }
  return { ...objectish, ...info.propsShape };
}
