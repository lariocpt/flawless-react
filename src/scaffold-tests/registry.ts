import type { ComponentInfo, ComponentTree, PropsShape, PropValue } from "../types.ts";

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
 * Compound families whose Root opens on a prop — the packages where
 * `<Root open>` is a real, documented state and the wrap is mechanical.
 * Value-driven families (accordion, tabs, radio-group, toggle-group) are
 * deliberately absent: their parts mount against a `value` the wrapper
 * would have to invent, and a wrong wrapper is worse than an honest skip.
 */
const OPEN_ROOT_FAMILIES = new Set([
  "dialog",
  "alert-dialog",
  "popover",
  "dropdown-menu",
  "select",
  "tooltip",
  "hover-card",
  "context-menu",
  "menubar",
  "collapsible",
]);

/**
 * Whether a compound part's family can actually wrap it: a Root sibling
 * exists, the primitive is an open-state family, and non-content parts have
 * a Content sibling to mount inside. One predicate, consulted by the unit
 * spec emitter, the host registry and hostEligibility — three call sites
 * disagreeing on wrappability would strand a part between templates.
 */
export function compoundWrappable(info: ComponentInfo): boolean {
  const family = info.compoundFamily;
  if (!family) return false;
  const base = (family.specifier.split("/").pop() ?? "").replace(/^react-/, "");
  if (!OPEN_ROOT_FAMILIES.has(base)) return false;
  return family.part === "content" || family.part === "trigger" || family.content !== undefined;
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
      // A part whose own file exports an open-state family mounts through the
      // wrapper hostRegistry composes into its own REGISTRY entry.
      if (compoundWrappable(info)) break;
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
  // No exclusion for server-action imports of any binding shape (namespace
  // included): the host stubs those modules by absolute path with their FULL
  // export surface (serverActionExports), so nothing drags in the database
  // driver and every ESM binding — named or namespace member — resolves.
  return { eligible: true };
}

/**
 * Props the component invokes, which a spec has to supply as functions.
 *
 * Three independent pieces of evidence, any one of which is enough: the prop is
 * called (`propUsage` kind "call"), it is bound to an event attribute, or it is
 * named `onSomething` — React's own convention, and the only signal available
 * for a handler passed straight through to a child.
 *
 * The unit specs cover this with vi.fn() spies. The browser host cannot: props
 * reach it through page.evaluate's structured clone, which drops functions
 * silently, so the component receives undefined and throws on the first call.
 */
export function functionProps(info: ComponentInfo): string[] {
  const declared = new Set([...Object.keys(info.propsShape), ...info.unresolvedProps]);
  const names = new Set<string>();
  for (const u of info.propUsage ?? []) {
    if (u.kind === "call") names.add(u.propName);
  }
  for (const c of info.interactions?.clicks ?? []) {
    if (c.binding.kind === "prop") names.add(c.binding.propName);
    // `onClick={reset}` where reset is a prop. classifyBinding calls that a
    // "local" because the binding classifier only promotes names matching
    // /^on[A-Z]/ — but being bound to an event attribute is itself proof the
    // value has to be callable, whatever it is named. AuthError's `reset` is
    // this exact shape, and it threw the moment the click landed.
    if (c.binding.kind === "local" && declared.has(c.binding.localName)) {
      names.add(c.binding.localName);
    }
  }
  for (const f of info.interactions?.forms ?? []) {
    if (f.submit?.kind === "prop") names.add(f.submit.propName);
  }
  for (const p of declared) {
    if (/^on[A-Z]/.test(p)) names.add(p);
  }
  // Sorted: the host file has to be byte-identical across runs or the
  // idempotence gate churns on Set insertion order.
  return [...names].sort();
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

/**
 * A Next.js page's `params`, with real segment values.
 *
 * mapType's default for a string prop is `""`, and it is the right default: an
 * empty string is a legitimate neutral value for a caption or a placeholder.
 * It is never a route param. Next does not match a dynamic segment against an
 * empty string, so `{ params: { id: "" } }` is a request that cannot happen —
 * and the pages then act like it: `getBuildingById(db, "")` finds nothing,
 * `notFound()` fires, and the spec records a guard exit as a pass.
 *
 * Twenty-two of the dogfood app's thirty-two page specs never rendered
 * anything. On the one measured directly, filling this in took the page from 41
 * of 158 lines to 151.
 *
 * `params` only, and only its empty-string leaves — a value the analyser
 * resolved from a literal union or a nested type is evidence and is left alone.
 */
export function withRouteParams(shape: PropsShape): PropsShape {
  const params = shape.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return shape;
  const filled: Record<string, PropValue> = {};
  let changed = false;
  for (const [k, v] of Object.entries(params as Record<string, PropValue>)) {
    if (v === "") {
      filled[k] = `flawless-${k}`;
      changed = true;
    } else if (Array.isArray(v) && v.length === 0) {
      // A catch-all segment (`[...slug]`) is an array of segments, and an empty
      // one is the same non-request as an empty string.
      filled[k] = [`flawless-${k}`];
      changed = true;
    } else {
      filled[k] = v;
    }
  }
  return changed ? { ...shape, params: filled } : shape;
}
