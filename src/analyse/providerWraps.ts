/**
 * Context providers the mount planes cannot see.
 *
 * A component under a real layout mounts inside SidebarProvider, InfobarProvider,
 * whatever — but the sweeps analyse COMPONENTS (src/components/**), and the
 * layout that supplies the context is a route file outside the entry glob. The
 * kiranism dogfood: every Sidebar* and Infobar* mount failed with "useSidebar
 * must be used within a SidebarProvider" because nothing in the analysed tree
 * had ever imported SidebarProvider — only app/dashboard/layout.tsx does.
 *
 * Three derivations, strongest evidence first:
 *
 * 1. HOOK CALL. A component that CALLS useX needs XProvider mounted. Same-file
 *    call → the provider lives in the component's own file; cross-file call →
 *    the hook's import resolves to the provider's file, and only that file's
 *    provider counts, so an unrelated FooProvider elsewhere never wraps an
 *    unrelated useFoo caller.
 *
 * 2. NAMESPACE COMPOUND. shadcn primitives wrap a third-party namespace
 *    (cmdk, base-ui): CommandInput renders <CommandPrimitive.Input> and throws
 *    on undefined store context unless <Command> — the same file's bare
 *    <CommandPrimitive> renderer, or its <ToastPrimitive.Provider> renderer —
 *    is mounted around it.
 *
 * 3. TRANSITIVE REQUIREMENT. AppSidebar never calls useSidebar — its child
 *    <Sidebar> does, and the error surfaces at AppSidebar's mount. Whatever a
 *    component renders, it must also satisfy.
 *
 * The provider may be no analysed component at all (the layout-only case), so
 * its file is PARSED here for the export shape — non-async and exported is the
 * whole gate; a provider that cannot mount bare takes down the wraps it guards,
 * and the dogfood failure then names it.
 */

import ts from "typescript";
import { flattenTrees } from "../scaffold-tests/registry.ts";
import type { ComponentTree, ProviderRef } from "../types.ts";
import { type ParsedComponentUnit, type ParsedFile, parseFile } from "./parseFile.ts";
import type { SourceFileCache } from "./sourceCache.ts";

/** React's own hooks — none of them names a provider. */
const CORE_HOOKS = new Set([
  "useCallback",
  "useContext",
  "useDebugValue",
  "useDeferredValue",
  "useEffect",
  "useId",
  "useImperativeHandle",
  "useInsertionEffect",
  "useLayoutEffect",
  "useMemo",
  "useOptimistic",
  "useReducer",
  "useRef",
  "useSyncExternalStore",
  "useTransition",
  "useActionState",
  "useFormState",
  "useFormStatus",
  "useActionCount",
  "useReportError",
]);

export const providerKey = (info: { filePath: string; componentName: string }): string =>
  `${info.filePath}::${info.componentName}`;

const provKey = (ref: ProviderRef): string => `${ref.filePath}::${ref.componentName}`;

/** Internal import (relative or tsconfig alias): its bindings are not primitives. */
const isInternalSpecifier = (s: string): boolean =>
  s.startsWith(".") || s.startsWith("@/") || s.startsWith("~/");

interface NamespaceFacts {
  /** Components that render N.<member> without already rendering N.<something>.Provider. */
  consumers: Set<string>;
  /** The file's own provider for that namespace, if it has one. */
  provider?: ProviderRef;
}

/**
 * Third-party compound families inside one file: every component that renders
 * `Namespace.Member` JSX needs the file's provider component — the one that
 * renders `Namespace.Provider` (base-ui shape: ToastProvider), else the one
 * that renders the bare `Namespace` (cmdk shape: Command wrapping
 * <CommandPrimitive>). Members are identified anywhere in the body because a
 * part's root is often a styled wrapper, not the primitive itself.
 */
/** A JSX tag as (base identifier, last member): Identifier → base only;
 *  `<A.B.C>` parses as a PropertyAccessExpression chain (TS 5.x) — QualifiedName
 *  handling stays for old ASTs. */
function tagNameParts(tag: ts.JsxTagName): { base: string; member?: string } {
  if (ts.isIdentifier(tag)) return { base: tag.text };
  if (ts.isQualifiedName(tag)) {
    return ts.isIdentifier(tag.left)
      ? { base: tag.left.text, member: tag.right.text }
      : { base: "" };
  }
  if (ts.isPropertyAccessExpression(tag)) {
    const parts: string[] = [];
    let node: ts.Node = tag;
    while (ts.isPropertyAccessExpression(node)) {
      parts.unshift(node.name.text);
      node = node.expression;
    }
    return ts.isIdentifier(node)
      ? { base: node.text, member: parts[parts.length - 1] }
      : { base: "" };
  }
  return { base: "" };
}

/**
 * Whether the provider can be mounted with NO props and still supply what
 * consumers read from the context. A typed-literal prop beyond `children`
 * that is neither optional nor rescued by a destructuring default cannot
 * mount bare: <ChartProvider value={...}> mounts with value undefined and
 * every consumer's context check throws right back out — the wrap only
 * relocates the error, so the wrap must not be added. Anything the shape
 * analysis cannot judge (a `props` identifier, a type reference instead of
 * a literal) is assumed mountable: the rule stays opportunistic.
 */
function providerMountsBare(unit: ParsedComponentUnit): boolean {
  const lit = unit.propsTypeLiteral;
  if (!lit) return true;
  // bodyNode is the function for `export function P(...)` and the body for
  // other shapes — the parameter lives on either node, and parent links are
  // not guaranteed, so check the node itself and its parent directly.
  const fnNode = [unit.bodyNode, unit.bodyNode.parent].find(
    (n): n is ts.FunctionLikeDeclaration =>
      n !== undefined && ts.isFunctionLike(n) && n.parameters.length > 0,
  );
  const pattern =
    fnNode && ts.isObjectBindingPattern(fnNode.parameters[0].name)
      ? fnNode.parameters[0].name
      : undefined;
  const defaulted = new Set<string>();
  if (pattern) {
    for (const el of pattern.elements) {
      if (el.initializer && ts.isIdentifier(el.name)) defaulted.add(el.name.text);
    }
  }
  return lit.members.every((m) => {
    if (!ts.isPropertySignature(m) || !m.name || !ts.isIdentifier(m.name)) return true;
    const name = m.name.text;
    if (name === "children" || m.questionToken) return true;
    return defaulted.has(name);
  });
}

/**
 * Providers whose NAME breaks the `useX` → `XProvider` convention: the hook
 * reads a context object, and the provider component renders that object's
 * `.Provider` — chanhdai's `useCollapsible` is fed by `CollapsibleWithContext`
 * (exported, no less, as `Collapsible`). The context object is the ground
 * truth both the hook and the provider must mention, so read it: a hook
 * supplies a context when it calls `useContext(Ctx)` itself or reaches one
 * through hooks defined in the same file.
 */
interface CtxFacts {
  /** Module-side hook name → provider component name in the same file. */
  providerByHook: Map<string, string>;
}

function ctxFactsOf(parsed: ParsedFile): CtxFacts {
  // Local hook definitions: name → body node.
  const bodies = new Map<string, ts.Node>();
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      if (/^use[A-Z]/.test(n.name.text) && !CORE_HOOKS.has(n.name.text)) {
        bodies.set(n.name.text, n.body);
      }
    } else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          /^use[A-Z]/.test(d.name.text) &&
          !CORE_HOOKS.has(d.name.text) &&
          d.initializer &&
          ts.isFunctionLike(d.initializer) &&
          d.initializer.body
        ) {
          bodies.set(d.name.text, d.initializer.body);
        }
      }
    }
    ts.forEachChild(n, collect);
  };
  for (const stmt of parsed.sourceFile.statements) collect(stmt);

  const direct = new Map<string, { ctx: Set<string>; calls: Set<string> }>();
  for (const [hook, body] of bodies) {
    const ctx = new Set<string>();
    const calls = new Set<string>();
    const scan = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        // `useContext(Ctx)` and `React.useContext(Ctx)` — the namespace form
        // is how `import * as React` files write it.
        const fn = ts.isIdentifier(n.expression)
          ? n.expression.text
          : ts.isPropertyAccessExpression(n.expression)
            ? n.expression.name.text
            : undefined;
        if (fn === undefined) {
          // nothing to key on
        } else if (
          fn === "useContext" &&
          n.arguments.length > 0 &&
          ts.isIdentifier(n.arguments[0])
        ) {
          ctx.add((n.arguments[0] as ts.Identifier).text);
        } else {
          calls.add(fn);
        }
      }
      ts.forEachChild(n, scan);
    };
    scan(body);
    direct.set(hook, { ctx, calls });
  }

  // Transitively close over local hook calls: useCollapsibleAnimation reads
  // the context through the useCollapsible it calls.
  const read = new Map<string, Set<string>>();
  for (const [hook, { ctx }] of direct) read.set(hook, new Set(ctx));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [hook, { calls }] of direct) {
      const mine = read.get(hook)!;
      for (const called of calls) {
        if (called === hook || !read.has(called)) continue;
        for (const ident of read.get(called)!) {
          if (!mine.has(ident)) {
            mine.add(ident);
            grew = true;
          }
        }
      }
    }
  }

  // Components rendering <Ctx.Provider> — the supplier per context object.
  const supplier = new Map<string, string>();
  for (const u of parsed.components) {
    const visit = (n: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
        ts.isPropertyAccessExpression(n.tagName) &&
        n.tagName.name.text === "Provider" &&
        ts.isIdentifier(n.tagName.expression)
      ) {
        supplier.set(n.tagName.expression.text, u.componentName);
      }
      ts.forEachChild(n, visit);
    };
    visit(u.bodyNode);
  }

  const providerByHook = new Map<string, string>();
  for (const [hook, ctxs] of read) {
    for (const ident of ctxs) {
      const p = supplier.get(ident);
      if (p && p !== hook) {
        providerByHook.set(hook, p);
        break;
      }
    }
  }
  return { providerByHook };
}

export function namespaceFacts(parsed: ParsedFile): NamespaceFacts {
  const external = new Set<string>();
  for (const [local, b] of parsed.imports) {
    if (b.isTypeOnly || isInternalSpecifier(b.specifier)) continue;
    external.add(local);
  }
  const consumers = new Set<string>();
  if (external.size === 0) return { consumers };
  // Per unit, which external namespaces it touches as `<N>` (bare) or as
  // `<N.Member>`. A namespace only becomes a COMPOUND family when the file
  // shows both sides: members somewhere, and a provider — a `<N.Provider>`
  // renderer (base-ui) or a bare `<N>` renderer (cmdk). Icon imports render
  // bare with no members — they are leaves, not providers, and the pairing
  // requirement is what keeps them out.
  const usage: {
    bare: Set<string>;
    bareAll: Set<string>;
    provider: Set<string>;
    root: Set<string>;
    member: Set<string>;
  }[] = [];
  for (const u of parsed.components) {
    const rec = {
      bare: new Set<string>(),
      bareAll: new Set<string>(),
      provider: new Set<string>(),
      root: new Set<string>(),
      member: new Set<string>(),
    };
    const visit = (n: ts.Node): void => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const { base, member } = tagNameParts((n as ts.JsxOpeningLikeElement).tagName);
        if (!member && ts.isIdentifier((n as ts.JsxOpeningLikeElement).tagName)) {
          rec.bareAll.add(base);
        }
        if (external.has(base)) {
          if (!member) rec.bare.add(base);
          // `.Root` cuts both ways: base-ui's N.Root REQUIRES the context its
          // N.Provider supplies (Toast.Root), while radix's namespace shape
          // makes N.Root the provider itself (Dialog.Root). It is recorded as
          // both a candidate and a member; providerFor demotes it wherever an
          // explicit N.Provider renderer exists in the same file.
          else if (member === "Provider") rec.provider.add(base);
          else if (member === "Root") {
            rec.root.add(base);
            rec.member.add(base);
          } else rec.member.add(base);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(u.bodyNode);
    usage.push(rec);
  }
  const memberBases = new Set(usage.flatMap((r) => [...r.member]));
  // A base-ui file names its provider out loud (`<N.Provider>`); a radix
  // namespace file never does — there the `<N.Root>` renderer IS the
  // provider. Where an explicit provider exists, `.Root` demotes back to
  // a plain member (base-ui's Toast.Root needs the ToastProvider wrap).
  const explicitProvider = (base: string): boolean => usage.some((r) => r.provider.has(base));
  const rootIsProvider = (r: { root: Set<string> }, base: string): boolean =>
    r.root.has(base) && !explicitProvider(base);
  const providerFor = (base: string): number =>
    usage.findIndex(
      (r, i) =>
        (r.provider.has(base) || r.bare.has(base) || rootIsProvider(r, base)) &&
        parsed.components[i].exportKind !== "none" &&
        !parsed.components[i].isAsync &&
        providerMountsBare(parsed.components[i]),
    );
  let provider: ProviderRef | undefined;
  for (const base of memberBases) {
    const pi = providerFor(base);
    if (pi === -1) continue;
    const u = parsed.components[pi];
    // A unit that mounts the provider itself — as the <N.Provider> tag OR as
    // the file's wrapper around it (Toaster renders <ToastProvider>, not
    // <ToastPrimitive.Provider>) — supplies its own context and a nested
    // second provider can actively break it.
    const providerTag = u.componentName;
    usage.forEach((r, ui) => {
      if (
        r.member.has(base) &&
        !r.provider.has(base) &&
        !rootIsProvider(r, base) &&
        ui !== pi &&
        !r.bareAll.has(providerTag)
      ) {
        consumers.add(parsed.components[ui].componentName);
      }
    });
    provider ??= {
      componentName: u.componentName,
      filePath: parsed.filePath,
      exportKind: u.exportKind,
      exportedAs: u.exportedAs,
    };
  }
  return { consumers, provider };
}

/** `${filePath}::${componentName}` → providers to mount around that component. */
export async function deriveContextProviderWraps(
  trees: ComponentTree[],
  cache: SourceFileCache,
): Promise<Map<string, ProviderRef[]>> {
  const flat = flattenTrees(trees);
  // parseFile is per-file work the sweep's cache already pays for; failures to
  // read a resolved file skip silently — derivation is opportunistic.
  const parse = async (file: string) => {
    try {
      return await parseFile(file, cache);
    } catch {
      return undefined;
    }
  };
  const parsedCache = new Map<string, ParsedFile | undefined>();
  const parseOnce = async (file: string) => {
    let p = parsedCache.get(file);
    if (p === undefined && !parsedCache.has(file)) {
      p = await parse(file);
      parsedCache.set(file, p);
    }
    return p;
  };
  const nsCache = new Map<string, NamespaceFacts>();
  const nsOnce = async (file: string) => {
    let f = nsCache.get(file);
    if (!f) {
      const parsed = await parseOnce(file);
      f = parsed ? namespaceFacts(parsed) : { consumers: new Set<string>() };
      nsCache.set(file, f);
    }
    return f;
  };
  const ctxCache = new Map<string, Map<string, string>>();
  const ctxOnce = (parsed: ParsedFile): Map<string, string> => {
    let f = ctxCache.get(parsed.filePath);
    if (!f) ctxCache.set(parsed.filePath, (f = ctxFactsOf(parsed).providerByHook));
    return f;
  };

  // compKey → provKey → ref. A Map, not a Set: the closure below merges along
  // component edges and the dedupe is by provider identity.
  const reqs = new Map<string, Map<string, ProviderRef>>();
  const addReq = (compKey: string, ref: ProviderRef) => {
    if (provKey(ref) === compKey) return; // never wraps itself
    let m = reqs.get(compKey);
    if (!m) reqs.set(compKey, (m = new Map()));
    m.set(provKey(ref), ref);
  };

  for (const c of flat) {
    const compKey = providerKey(c.info);
    for (const hook of new Set((c.info.hookDetails ?? []).map((h) => h.name))) {
      if (!/^use[A-Z]/.test(hook) || CORE_HOOKS.has(hook)) continue;
      // Where does the hook come from? Imported → its module; otherwise the
      // component's own file (the co-located shadcn shape). An alias
      // (`import { useSidebar as useSb }`) binds a local name the call site
      // uses, but the provider is named after the MODULE-side hook.
      let sourceFile = c.info.filePath;
      let moduleSide = hook;
      for (const mi of c.info.moduleImports ?? []) {
        if (mi.isTypeOnly || !mi.resolvedPath) continue;
        const i = mi.names.indexOf(hook);
        if (i === -1) continue;
        sourceFile = mi.resolvedPath;
        moduleSide = mi.importedNames?.[i] ?? hook;
        break;
      }
      if (!moduleSide.startsWith("use")) continue; // aliased to a non-hook name
      const candidate = `${moduleSide.slice(3)}Provider`;
      const parsed = await parseOnce(sourceFile);
      let unit = parsed?.components.find((u) => u.componentName === candidate);
      if (parsed && (!unit || unit.exportKind === "none")) {
        // The convention missed — find the component that supplies the
        // context this hook actually reads, however it is named.
        const supplied = ctxOnce(parsed).get(moduleSide);
        if (supplied) unit = parsed.components.find((u) => u.componentName === supplied);
      }
      if (unit && unit.exportKind !== "none" && !unit.isAsync && providerMountsBare(unit)) {
        addReq(compKey, {
          componentName: unit.componentName,
          filePath: sourceFile,
          exportKind: unit.exportKind,
          exportedAs: unit.exportedAs,
        });
      }
    }
    const ns = await nsOnce(c.info.filePath);
    if (ns.provider && ns.consumers.has(c.info.componentName)) {
      addReq(compKey, ns.provider);
    }
  }

  // Transitive requirement: the analysis trees record what renders what, and a
  // mount fails at the ancestor whose untouched leaf threw. Iterate to a
  // fixpoint — provider cycles converge because self-references drop.
  const edges = new Map<string, Set<string>>();
  const walk = (t: ComponentTree): void => {
    const pk = providerKey(t.entry);
    for (const c of t.children) {
      const ck = providerKey(c.entry);
      if (ck !== pk) {
        let s = edges.get(pk);
        if (!s) edges.set(pk, (s = new Set()));
        s.add(ck);
      }
      walk(c);
    }
  };
  for (const t of trees) walk(t);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pk, kids] of edges) {
      for (const ck of kids) {
        const kid = reqs.get(ck);
        if (!kid) continue;
        for (const [key, ref] of kid) {
          const mine = reqs.get(pk);
          if (key === pk || mine?.has(key)) continue;
          addReq(pk, ref);
          changed = true;
        }
      }
    }
  }

  const out = new Map<string, ProviderRef[]>();
  for (const [compKey, m] of reqs) {
    if (m.size > 0) {
      out.set(
        compKey,
        [...m.values()].sort((a, b) => (a.componentName < b.componentName ? -1 : 1)),
      );
    }
  }
  return out;
}
