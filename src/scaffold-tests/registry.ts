import { bridgePropValues } from "../analyse/childBridge.ts";
import {
  type ComponentInfo,
  type ComponentTree,
  DATE_PROP_ISO,
  DATE_PROP_SENTINEL,
  type PropsShape,
  type PropValue,
} from "../types.ts";

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
  // No decidable initial render: profiling it measures whichever branch the host
  // happens to take, which is the thing that could not be decided. The host also
  // has to mount it, and for a class with required props there is nothing to pass.
  if (info.renderUndecidable === true) {
    return {
      eligible: false,
      reason:
        "render() branches on a condition this analysis could not decide — no render to profile",
    };
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
  // next/og is the exception that proves the rule: ImageResponse is an
  // edge-runtime renderer (satori + resvg.wasm + sharp), not a DOM component
  // — app/icon.tsx and opengraph-image.tsx are route handlers in clothing.
  for (const mi of info.moduleImports ?? []) {
    if (mi.specifier === "next/og" || mi.specifier.startsWith("next/og/")) {
      return {
        eligible: false,
        reason: "renders through next/og (edge ImageResponse) — not a browser component",
      };
    }
  }
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

/** Method names only Date values answer — a chain ending in one floors a live Date. */
const DATE_MEMBERS = new Set([
  "getTime",
  "toISOString",
  "toLocaleDateString",
  "toLocaleTimeString",
  "toLocaleString",
  "getFullYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "setTime",
]);

/**
 * What the LAST segment of a chain demands of the value it was read off:
 * [] for collection methods, a live Date for the date methods, "" for
 * length and every other read (charAt, split, an unknown field — "" answers
 * length, string methods and JSX children alike).
 */
function chainTerminal(member: string): unknown {
  if (member === "length") return "";
  if (ARRAY_MEMBERS.has(member)) return [];
  if (DATE_MEMBERS.has(member)) return DATE_PROP_SENTINEL;
  return "";
}

/**
 * Stand-in richness: "" answers length but not map or getTime; [] answers
 * collections; a Date answers the date methods; a nested object is deeper
 * evidence than any primitive. A richer terminal seen anywhere wins — and
 * the DATE sentinel is a string, so ranking it by typeof would be wrong.
 */
function terminalRank(v: unknown): number {
  if (v === DATE_PROP_SENTINEL) return 3;
  if (v === null || typeof v !== "object") return typeof v === "string" ? 1 : 0;
  if (Array.isArray(v)) return 2;
  return 4;
}

/**
 * Fold `prop.a.b`-style chains into one nested stand-in. The terminal
 * segment is NOT a key to store — it is a read off the value one hop up:
 * `drop.body.length` wants a body that HAS a length, so body becomes "",
 * not `{ length: [] }`. Hops before that are walked through and must be
 * objects; a lone field read (`embeddedCode.lang`) only guarantees the
 * holder exists.
 */
function foldChains(chains: string[][]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const segs of chains) {
    const holderPath = segs.slice(0, -1);
    let cur: Record<string, unknown> = out;
    for (let i = 0; i < holderPath.length - 1; i++) {
      const k = holderPath[i];
      const ex = cur[k];
      // The read went THROUGH this hop, so it has to be an object — an
      // earlier "" or [] terminal here died on the hop after it.
      if (typeof ex !== "object" || ex === null) cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
    const key = holderPath[holderPath.length - 1];
    const v = chainTerminal(segs[segs.length - 1]);
    const ex = cur[key];
    if (ex === undefined || terminalRank(v) > terminalRank(ex)) cur[key] = v;
  }
  return out;
}

/**
 * The props a generated test should pass, including stand-ins for the ones no
 * type resolved.
 *
 * A prop that could not be resolved is absent from propsShape, so the component
 * receives undefined and `prop.field` throws before anything renders. Where the
 * analyser SAW a member access, the read itself says which empty value survives
 * it: {} still throws on .length/.map, so anything used as a collection gets [].
 *
 * A CHAIN read survives even fewer: `drop.body.length` walks two hops, and {}
 * satisfies the first only — Drop died exactly there, and ProfileFeed reproduced
 * it through the same component. Chains therefore floor to a nested stand-in
 * whose terminal value answers the last hop ("", [] or a live Date).
 *
 * The unit scaffolder did this and the perf host did not, so a component like
 * `ProfileForm({ user }: { user: User })` mounted fine under jsdom and failed in
 * the browser host with "did not render within 5000ms" — the same defect wearing
 * a different error message.
 */
export function synthesiseDefaults(info: ComponentInfo): PropsShape {
  const objectish: PropsShape = {};
  const chains = new Map<string, string[][]>();
  for (const u of info.propUsage ?? []) {
    if (!u.member) continue;
    if (!info.unresolvedProps.includes(u.propName)) continue;
    if (u.chain && u.chain.length > 1) {
      const list = chains.get(u.propName) ?? [];
      if (!list.some((c) => c.join(".") === u.chain?.join("."))) list.push(u.chain);
      chains.set(u.propName, list);
      objectish[u.propName] ??= {};
      continue;
    }
    if (ARRAY_MEMBERS.has(u.member)) objectish[u.propName] = [];
    else objectish[u.propName] ??= {};
  }
  // Chains fold last: their nested stand-ins must not be overwritten by the
  // plain {} floor a sibling single-hop access would give the same prop —
  // and a prop whose only evidence is []-via-ARRAY_MEMBERS keeps that.
  for (const [propName, list] of chains) {
    if (Array.isArray(objectish[propName])) continue;
    const folded = foldChains(list);
    objectish[propName] =
      Object.keys(objectish[propName] as object).length > 0
        ? { ...(objectish[propName] as object), ...folded }
        : folded;
  }
  // The child bridge: `<RelativeTime date={drop.createdAt}/>` is evidence
  // about drop.createdAt from the CHILD's side — RelativeTime's own defaults
  // say its date is a live Date, so drop grows a createdAt Date even though
  // no read in THIS body ever asked. Rank-guarded: a child's expectation
  // only ever upgrades the stand-in, never downgrades real evidence.
  const exp = info.childExpected;
  if (exp) {
    for (const u of info.propUsage ?? []) {
      if (!u.tag || !u.attr) continue;
      if (!info.unresolvedProps.includes(u.propName)) continue;
      const expected = exp[u.tag]?.[u.attr];
      if (expected === undefined) continue;
      const bridged = bridgePropValues(objectish[u.propName], u.member, expected);
      if (bridged !== undefined) objectish[u.propName] = bridged as PropsShape[string];
    }
  }
  // A Promise prop is wrapped by the spec (`Promise.resolve(v)`), but the wrap
  // skips missing keys — so an unresolved `page: Promise<Page>` reached
  // `use(page)` as undefined ("An unsupported type was passed to use()").
  // Floor every promise prop at {}: the await resolves to an object, and
  // destructured fields read as undefined, which renders as nothing.
  for (const p of info.promiseProps ?? []) objectish[p] ??= {};
  const merged = { ...objectish, ...info.propsShape };
  // An identifier, not copy. A required string prop spelled `…Id` is fed to
  // something that looks the value up or validates it — Liveblocks threw
  // "RoomProvider id property is required" over the empty string Room passes
  // straight through. Same reasoning as withRouteParams below, one layer up:
  // the empty string is neutral for a caption and never for an id.
  for (const [k, v] of Object.entries(merged)) {
    if (v === "" && /Id$/.test(k)) merged[k] = `flawless-${k.toLowerCase()}`;
  }
  return merged;
}

/**
 * JSON.stringify for a PropsShape that may carry `DATE_PROP_SENTINEL`. Every
 * caller embeds the result in GENERATED SOURCE, so rewrite the sentinel into
 * a live `new Date(...)`: an ISO string would crash exactly the methods
 * (getTime, toLocaleTimeString) a Date-typed prop is written to be called
 * with, and JSON has no Date.
 */
export function defaultsJson(shape: PropsShape): string {
  return JSON.stringify(shape).replaceAll(
    JSON.stringify(DATE_PROP_SENTINEL),
    `new Date(${JSON.stringify(DATE_PROP_ISO)})`,
  );
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
      // /Id$/ too: the caller may synthesiseDefaults first, but the fill here
      // is the last pass before the literal — an id leaf must not stay empty.
      filled[k] = /Id$/.test(k) ? `flawless-${k.toLowerCase()}` : `flawless-${k}`;
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
