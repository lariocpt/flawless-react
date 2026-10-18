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

import { statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { flattenTrees } from "../scaffold-tests/registry.ts";
import type { ComponentTree, ProviderRef } from "../types.ts";
import {
  type ImportBinding,
  type ParsedComponentUnit,
  type ParsedFile,
  parseFile,
} from "./parseFile.ts";
import { ModuleResolver } from "./resolveModule.ts";
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

/** Every bare module specifier that carries a shim's provider-gated surface:
 *  the canonical `module` plus any alias that re-exports the same thing. */
const shimModules = (spec: { module: string; modules?: string[] }): string[] => [
  spec.module,
  ...(spec.modules ?? []),
];

/**
 * Providers the project cannot be expected to import: the context lives in a
 * node_modules library, and its hooks throw when no library provider sits
 * above the mount — "No QueryClient set, use QueryClientProvider to set one"
 * is the dominant class when a suite first meets a react-query app. The route
 * tree mounts these and NO analysed component ever imports them, so the
 * derivation synthesises a generated provider module instead.
 *
 * Placement is the importing package's root: bare library imports from the
 * generated file resolve through THAT package's node_modules. An outDir shim
 * would resolve through the suite's, and workspaces that hoist nothing (bun's
 * per-package default) could never find the library there.
 */
interface LibraryShimSpec {
  module: string;
  /**
   * Other bare module specifiers that carry the SAME provider-gated surface:
   * `react-router-dom` re-exports the `react-router` core (v5 and v6 do that,
   * v7 moved it and left the old name as the alias), so the same hook or
   * component can arrive under either name and needs the same provider. The
   * generated wrap still imports from `module`, the canonical one, because a
   * package that imports either almost always depends on both — an app that
   * really has only the alias gets an unresolvable import, which is a louder
   * failure than a silent no-wrap.
   */
  modules?: string[];
  hooks: string[];
  /**
   * Provider-gated COMPONENTS, the same requirement seen from the other side:
   * a file that renders `<FormattedMessage>` calls no hook of the library at
   * all, and the mount throws exactly the same "needs to exist in the
   * component tree". saleor-dashboard is the evidence — 1038 files import
   * react-intl and most of them only ever render the component.
   */
  components?: string[];
  componentName: string;
  fileBase: string;
  /** Imports for the generated module (the React types included). */
  imports: string;
  /** Component body: mounts the library's real provider. */
  body: string;
}

const LIBRARY_SHIMS: LibraryShimSpec[] = [
  {
    module: "@tanstack/react-query",
    hooks: [
      "useInfiniteQuery",
      "useIsFetching",
      "useIsMutating",
      "useMutation",
      "useMutationState",
      "useQueries",
      "useQuery",
      "useQueryClient",
      "useQueryErrorResetBoundary",
      "useSuspenseInfiniteQuery",
      "useSuspenseQuery",
    ],
    componentName: "FlawlessQueryClientProvider",
    fileBase: "flawless-query-client.tsx",
    imports: `import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";`,
    body: `  // Fresh client per mount — state must not leak between specs — and no
  // retries: a spec never reaches a real backend, and a retry storm buries
  // the one error worth seeing.
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;`,
  },
  {
    // nakama is a client-rendered router-dom SPA: CommandPalette calls
    // useNavigate and the mount dies with "useNavigate() may be used only in
    // the context of a <Router>". MemoryRouter is the standard test context.
    module: "react-router-dom",
    // The same surface is also exported by `react-router` itself: v5 and v6
    // re-export the core through react-router-dom, v7 moved it and left the old
    // name as the alias. saleor-dashboard writes both (146 files against
    // react-router-dom, 48 against react-router), and a component that renders
    // <Link> calls no hook at all — "You should not use <Link> outside a
    // <Router>" is what the mount says for it.
    modules: ["react-router"],
    components: ["Link", "NavLink"],
    hooks: [
      "useHref",
      "useLinkClickHandler",
      "useLocation",
      "useMatches",
      "useNavigate",
      "useOutlet",
      "useOutletContext",
      "useParams",
      "useRoutes",
      "useSearchParams",
    ],
    componentName: "FlawlessRouterProvider",
    fileBase: "flawless-router.tsx",
    imports: `import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";`,
    body: `  // An in-memory router rooted at "/": navigation hooks work, nothing moves
  // a real history, and no spec leaks location state into the next.
  // Data-router hooks (useFetcher, useSubmit, useBlocker) are deliberately
  // absent — MemoryRouter cannot serve them, and wrapping would trade one
  // throw for another.
  return <MemoryRouter>{children}</MemoryRouter>;`,
  },
  {
    // Form-through-context: useFormContext / useController / useWatch /
    // useFieldArray / useFormState read the form off React context and get
    // NULL with no FormProvider above the mount, which the library then
    // dereferences — "Cannot read properties of null (reading 'control')".
    // Wrapping is what the library's own test docs prescribe. Discovered on
    // invoify's shadcn form.tsx, where it is also NOT the whole story: that
    // FormField spec passes no props at all, because its contract arrives as
    // one opaque spread (...props: ControllerProps<…> from node_modules), so
    // with the wrap in place it fails one level deeper on the missing `name`.
    // A required prop the analyser cannot see is a different gap, and stays a
    // documented tail rather than being papered over with a invented form.
    // A component that supplies `control` itself is wrapped for nothing: an
    // outer provider loses to an explicit control, so the wrap stays harmless.
    //
    // React 19 exports its own useFormState, and the gate matches on the
    // IMPORTED MODULE as well as the name (deriveContextProviderWraps), so
    // listing it here cannot wrap a component that got it from "react".
    module: "react-hook-form",
    hooks: [
      "useController",
      "useFieldArray",
      "useFormState",
      "useWatch",
      // The read-only accessor the rest of the family is built on, and the one
      // shadcn's form.tsx imports directly.
      "useFormContext",
    ],
    componentName: "FlawlessFormProvider",
    fileBase: "flawless-form.tsx",
    imports: `import type { ReactNode } from "react";
import { FormProvider, useForm } from "react-hook-form";`,
    body: `  // A form with no defaultValues and nothing wired to submit: a field
  // component's contract is about the field, not about data, and an unset value
  // is the honest starting point for a spec that supplies none. Fresh per mount
  // so one spec's typing cannot leak into the next spec's formState.
  const methods = useForm();
  return <FormProvider {...methods}>{children}</FormProvider>;`,
  },
  {
    // The dominant failure class when a suite first meets a react-intl app:
    // "[React Intl] Could not find required `intl` object. <IntlProvider>
    // needs to exist in the component tree" — 715 of saleor-dashboard's 1171
    // failing spec files, and the same shape anywhere the app formats copy
    // through the library. An IntlProvider with a locale and no message table
    // resolves every message back to its own `defaultMessage`, which is the
    // literal text the source wrote and the specs assert on: so the wrap makes
    // the mount work WITHOUT inventing a translation, and an assertion that
    // still fails is failing on the component, not on a missing context.
    // `useIntl().formatMessage` reads the same empty table for the same reason.
    module: "react-intl",
    hooks: ["useIntl", "useCreateIntl", "useFormatters"],
    components: [
      "FormattedMessage",
      "FormattedDate",
      "FormattedNumber",
      "FormattedTime",
      "FormattedPlural",
      "FormattedList",
      "FormattedListParts",
      "FormattedRelativeTime",
      "FormattedHTMLMessage",
    ],
    componentName: "FlawlessIntlProvider",
    fileBase: "flawless-intl.tsx",
    imports: `import type { ReactNode } from "react";
import { IntlProvider } from "react-intl";`,
    body: `  // "en" is not a claim about the app's locales, it is the locale of the
  // strings the source itself wrote. Nothing is fetched, so nothing can hang a
  // spec; onError is left alone because a genuinely missing message is a real
  // finding and should still print.
  return <IntlProvider locale="en">{children}</IntlProvider>;`,
  },
];

export interface LibraryProviderShim {
  /** Bare module specifier whose hooks need the wrap. */
  module: string;
  /** Alias module specifiers for the same surface (see LibraryShimSpec). */
  modules?: string[];
  /** Module-side hook names that require the provider above them. */
  hooks: string[];
  /** Module-side component names that require it too (see LibraryShimSpec). */
  components?: string[];
  /** The generated component to wrap with. */
  componentName: string;
  /** Absolute path of the module that exports componentName. */
  filePath: string;
}

/** Nearest directory whose package.json claims this file. */
function packageRootOf(file: string): string {
  const fallback = path.dirname(path.resolve(file));
  let dir = fallback;
  for (;;) {
    try {
      if (statSync(path.join(dir, "package.json")).isFile()) return dir;
    } catch {
      // Keep walking: a directory with no package.json is simply not one.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}

/** One shim per (library, importing package) pair the analysis can reach. */
export function libraryProviderShimsFor(componentFiles: string[]): LibraryProviderShim[] {
  const roots = new Set<string>();
  for (const file of componentFiles) roots.add(packageRootOf(file));
  const out: LibraryProviderShim[] = [];
  for (const spec of LIBRARY_SHIMS) {
    for (const root of roots) {
      out.push({
        module: spec.module,
        modules: spec.modules,
        hooks: spec.hooks,
        components: spec.components,
        componentName: spec.componentName,
        filePath: path.join(root, ".flawless", spec.fileBase),
      });
    }
  }
  return out;
}

/** The shims a wrap map actually references — a scaffold writes those files
 *  only when something in the run will import them. */
export function referencedLibraryShims(
  wraps: Map<string, ProviderRef[]> | undefined,
  componentFiles: string[],
): LibraryProviderShim[] {
  if (!wraps || wraps.size === 0) return [];
  const used = new Set<string>();
  for (const refs of wraps.values()) {
    for (const r of refs) used.add(`${r.filePath}::${r.componentName}`);
  }
  return libraryProviderShimsFor(componentFiles).filter((s) =>
    used.has(`${s.filePath}::${s.componentName}`),
  );
}

/** Source for the generated module: the real library provider, mounted fresh
 *  per mount so state never leaks between specs. */
export function libraryShimSource(module: string, componentName: string): string {
  const spec = LIBRARY_SHIMS.find((s) => s.module === module && s.componentName === componentName);
  if (!spec) return "";
  return `// Generated by flawless-react. Do not edit: regenerations overwrite it.
// The provider lives here, inside the importing package, because a bare
// import of ${module} only resolves through this package's node_modules.
${spec.imports}

export function ${componentName}({ children }: { children?: ReactNode }) {
${spec.body}
}
`;
}

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
function tagNameParts(tag: ts.JsxTagNameExpression | ts.QualifiedName): {
  base: string;
  member?: string;
} {
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
  const firstParam = fnNode?.parameters[0];
  const pattern =
    firstParam && ts.isObjectBindingPattern(firstParam.name) ? firstParam.name : undefined;
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
/** A context object as one file mentions it: imported (module, exported name)
 *  or locally defined (no module). Resolved to (file::name) keys by the caller,
 *  which owns the async ModuleResolver. */
interface RawCtxRef {
  module?: string;
  name: string;
}

const rawCtxRefFor = (ident: string, imports: Map<string, ImportBinding>): RawCtxRef => {
  const b = imports.get(ident);
  if (!b || b.isTypeOnly) return { name: ident };
  return { module: b.specifier, name: b.importedName ?? ident };
};

interface CtxFacts {
  /** Module-side hook name → provider component name in the same file. */
  providerByHook: Map<string, string>;
  /** Module-side hook name → every context object it reads (transitively). */
  readsRaw: Map<string, Set<RawCtxRef>>;
  /** Component name → the first context object it renders as `<Ctx.Provider>`. */
  suppliesRaw: Map<string, RawCtxRef>;
  /** Module-side hook name → shim-library modules whose provider-gated hooks
   *  it calls, possibly through local wrappers (the useSaveTelegramSettings
   *  shape: a project hook wrapping useMutation). */
  libsByHook: Map<string, Set<string>>;
  /** Hook name → every callee identifier in its body (direct, not closed
   *  over). Derive follows the ones that are cross-file import bindings so
   *  two-level wrappers — useMcpServerDialogState → useMcpServerDetailQuery
   *  → useQuery — still reach the library. */
  callsByHook: Map<string, Set<string>>;
  /** Component name → bare JSX tag names that component's body renders. The
   *  library shim table reads it for the components a file IMPORTS: rendering
   *  a provider-gated component requires the provider exactly like calling its
   *  hook does, and calls are all the scan above can see. */
  tagsByFn: Map<string, Set<string>>;
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

  const direct = new Map<string, { ctx: Set<string>; calls: Set<string>; libs: Set<string> }>();
  for (const [hook, body] of bodies) {
    const ctx = new Set<string>();
    const calls = new Set<string>();
    const libs = new Set<string>();
    const scan = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        // `useContext(Ctx)` and `React.useContext(Ctx)` — the namespace form
        // is how `import * as React` files write it.
        const fn = ts.isIdentifier(n.expression)
          ? n.expression.text
          : ts.isPropertyAccessExpression(n.expression)
            ? n.expression.name.text
            : undefined;
        const firstArg = n.arguments[0];
        if (fn === undefined) {
          // nothing to key on
        } else if (fn === "useContext" && firstArg && ts.isIdentifier(firstArg)) {
          ctx.add(firstArg.text);
        } else {
          calls.add(fn);
          // A callee that is an IMPORT of a provider-gated library hook means
          // this local hook needs the library's provider too — the
          // useSaveTelegramSettings shape: a project hook wrapping useMutation.
          const b = parsed.imports.get(fn);
          if (b && !b.isTypeOnly) {
            for (const s of LIBRARY_SHIMS) {
              if (shimModules(s).includes(b.specifier) && s.hooks.includes(b.importedName ?? fn)) {
                libs.add(s.module);
              }
            }
          }
        }
      }
      ts.forEachChild(n, scan);
    };
    scan(body);
    direct.set(hook, { ctx, calls, libs });
  }

  // Transitively close over local hook calls: useCollapsibleAnimation reads
  // the context through the useCollapsible it calls.
  const read = new Map<string, Set<string>>();
  for (const [hook, { ctx }] of direct) read.set(hook, new Set(ctx));
  const readLibs = new Map<string, Set<string>>();
  for (const [hook, { libs }] of direct) readLibs.set(hook, new Set(libs));
  const readCalls = new Map<string, Set<string>>();
  for (const [hook, { calls }] of direct) readCalls.set(hook, new Set(calls));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [hook, { calls }] of direct) {
      const mine = read.get(hook);
      const mineLibs = readLibs.get(hook);
      const mineCalls = readCalls.get(hook);
      if (!mine || !mineLibs || !mineCalls) continue;
      for (const called of calls) {
        if (called === hook) continue;
        const sub = read.get(called);
        if (sub)
          for (const ident of sub) {
            if (!mine.has(ident)) {
              mine.add(ident);
              grew = true;
            }
          }
        const subLibs = readLibs.get(called);
        if (subLibs)
          for (const m of subLibs) {
            if (!mineLibs.has(m)) {
              mineLibs.add(m);
              grew = true;
            }
          }
        // Callers reach libraries through local hooks too: merge the whole
        // callee set so the cross-file walk below sees calls the chain makes.
        const subCalls = readCalls.get(called);
        if (subCalls)
          for (const c2 of subCalls) {
            if (!mineCalls.has(c2)) {
              mineCalls.add(c2);
              grew = true;
            }
          }
      }
    }
  }

  // Components rendering <Ctx.Provider> — the supplier per context object,
  // both by identifier text (same-file pairing) and by raw (module, name)
  // reference for the cross-file join.
  const supplier = new Map<string, string>();
  const suppliesRaw = new Map<string, RawCtxRef>();
  for (const u of parsed.components) {
    const visit = (n: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
        ts.isPropertyAccessExpression(n.tagName) &&
        n.tagName.name.text === "Provider" &&
        ts.isIdentifier(n.tagName.expression)
      ) {
        const ident = n.tagName.expression.text;
        supplier.set(ident, u.componentName);
        if (!suppliesRaw.has(u.componentName)) {
          suppliesRaw.set(u.componentName, rawCtxRefFor(ident, parsed.imports));
        }
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
  const readsRaw = new Map<string, Set<RawCtxRef>>();
  for (const [hook, ctxs] of read) {
    const refs = new Set<RawCtxRef>();
    for (const ident of ctxs) {
      const r = rawCtxRefFor(ident, parsed.imports);
      if (![...refs].some((e) => e.module === r.module && e.name === r.name)) refs.add(r);
    }
    readsRaw.set(hook, refs);
  }
  const libsByHook = new Map<string, Set<string>>();
  for (const [hook, libs] of readLibs) if (libs.size > 0) libsByHook.set(hook, libs);
  // The JSX tags each of this file's components renders, keyed by component
  // name — the same requirement, seen where the hook scan above is blind: a
  // component that renders <FormattedMessage> calls no hook of the library at
  // all. Only a bare tag is recorded, because that is what an import binding
  // names; `Namespace.Member` is namespaceFacts' business below.
  const tagsByFn = new Map<string, Set<string>>();
  for (const u of parsed.components) {
    if (!u.bodyNode) continue;
    const tags = new Set<string>();
    const visitTags = (n: ts.Node): void => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const { base, member } = tagNameParts(n.tagName);
        if (base && !member) tags.add(base);
      }
      ts.forEachChild(n, visitTags);
    };
    visitTags(u.bodyNode);
    tagsByFn.set(u.componentName, tags);
  }
  return { providerByHook, readsRaw, suppliesRaw, libsByHook, callsByHook: readCalls, tagsByFn };
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
  // `const ToastProvider = ToastPrimitives.Provider` — the shadcn shape, where
  // the provider is an ALIAS of the namespace's own `.Provider` rather than a
  // component declaration. No parsed unit renders it, so a file full of members
  // (`Toast` = `ToastPrimitives.Root`) looked unwrappable while exporting
  // exactly the provider that would have wrapped them: invoify's Toast, Toaster
  // and every variant spec died on "must be used within ToastProvider". Only an
  // EXPORTED alias is a wrap — an import is the only way the mount reaches it —
  // and it outranks the Root-as-provider reading, because a radix Root consumes
  // that same context: wrapping its members in the Root just reproduces the
  // throw one level up.
  const aliasByBase = new Map<string, string[]>();
  const exportedAs = new Map<string, string>();
  const markExported = (local: string, exported: string): void => {
    if (!exportedAs.has(local)) exportedAs.set(local, exported);
  };
  const isExportStatement = (n: ts.Node): boolean =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const stmt of parsed.sourceFile.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        if (isExportStatement(stmt)) markExported(d.name.text, d.name.text);
        const init = d.initializer;
        if (
          init &&
          ts.isPropertyAccessExpression(init) &&
          ts.isIdentifier(init.expression) &&
          init.name.text === "Provider" &&
          external.has(init.expression.text)
        ) {
          aliasByBase.set(init.expression.text, [
            ...(aliasByBase.get(init.expression.text) ?? []),
            d.name.text,
          ]);
        }
      }
    } else if (ts.isExportDeclaration(stmt)) {
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const spec of clause.elements) {
          markExported((spec.propertyName ?? spec.name).text, spec.name.text);
        }
      }
    } else if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      stmt.name &&
      isExportStatement(stmt)
    ) {
      markExported(stmt.name.text, stmt.name.text);
    }
  }
  const aliasProviderFor = (base: string): ProviderRef | undefined => {
    for (const local of aliasByBase.get(base) ?? []) {
      const exported = exportedAs.get(local);
      if (exported !== undefined)
        return { componentName: exported, filePath: parsed.filePath, exportKind: "named" };
    }
    return undefined;
  };
  const providerFor = (base: string): number =>
    usage.findIndex((r, i) => {
      const unit = parsed.components[i];
      return (
        unit !== undefined &&
        (r.provider.has(base) || r.bare.has(base) || rootIsProvider(r, base)) &&
        unit.exportKind !== "none" &&
        !unit.isAsync &&
        providerMountsBare(unit)
      );
    });
  let provider: ProviderRef | undefined;
  for (const base of memberBases) {
    // An explicit <N.Provider> renderer is the file's own mount surface and
    // wins; with none, an exported alias of <N.Provider> beats the Root
    // reading; with neither, the Root (or bare) renderer provides.
    const aliased = explicitProvider(base) ? undefined : aliasProviderFor(base);
    const pi = aliased ? -1 : providerFor(base);
    const unit = pi === -1 ? undefined : parsed.components[pi];
    // `providerFor` already excludes a unit the file does not export; restating
    // it here is what narrows `exportKind` to the two kinds a mount can import.
    const fromUnit: ProviderRef | undefined =
      unit && unit.exportKind !== "none"
        ? {
            componentName: unit.componentName,
            filePath: parsed.filePath,
            exportKind: unit.exportKind,
            exportedAs: unit.exportedAs,
          }
        : undefined;
    const ref = aliased ?? fromUnit;
    if (!ref) continue;
    // A unit that mounts the provider itself — as the <N.Provider> tag OR as
    // the file's wrapper around it (Toaster renders <ToastProvider>, not
    // <ToastPrimitive.Provider>) — supplies its own context and a nested
    // second provider can actively break it.
    const providerTag = ref.componentName;
    usage.forEach((r, ui) => {
      const consumer = parsed.components[ui];
      if (
        consumer &&
        r.member.has(base) &&
        (aliased || (!r.provider.has(base) && !rootIsProvider(r, base))) &&
        ui !== pi &&
        !r.bareAll.has(providerTag)
      ) {
        consumers.add(consumer.componentName);
      }
    });
    provider ??= ref;
  }
  return { consumers, provider };
}

/** `${filePath}::${componentName}` → providers to mount around that component. */
export async function deriveContextProviderWraps(
  trees: ComponentTree[],
  cache: SourceFileCache,
  shims?: (c: { info: { filePath: string } }) => LibraryProviderShim[],
): Promise<Map<string, ProviderRef[]>> {
  const flat = flattenTrees(trees);
  // parseFile is per-file work the sweep's cache already pays for; failures to
  // read a resolved file skip silently — derivation is opportunistic. Hook
  // modules often carry no component at all (nakama's use-auth.ts is exactly
  // one), so the no-component throw must not erase their import tables.
  const parse = async (file: string) => {
    try {
      return await parseFile(file, cache, { tolerateNoComponents: true });
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
  const ctxCache = new Map<string, CtxFacts>();
  const ctxOnce = (parsed: ParsedFile): CtxFacts => {
    let f = ctxCache.get(parsed.filePath);
    if (!f) {
      f = ctxFactsOf(parsed);
      ctxCache.set(parsed.filePath, f);
    }
    return f;
  };

  // The cross-file context join. Hook and provider need not share a file:
  // nakama's `useAuth` reads `AuthContext` imported from `auth-context-shared`,
  // and `AuthProvider` renders `<AuthContext.Provider>` from `auth-context.tsx`
  // — the context object is the join key, so resolve each mention to a
  // (module, exported-name) pair and index every component that renders one.
  const resolver = new ModuleResolver();
  const ctxKeyOf = (file: string, ref: RawCtxRef): string | undefined => {
    if (!ref.module) return `${file}::${ref.name}`;
    const resolved = resolver.resolve(ref.module, file);
    return resolved ? `${resolved}::${ref.name}` : undefined;
  };
  const supplierByKey = new Map<string, { file: string; componentName: string }[]>();
  for (const file of new Set(flat.map((c) => c.info.filePath))) {
    const parsed = await parseOnce(file);
    if (!parsed) continue;
    for (const [componentName, ref] of ctxOnce(parsed).suppliesRaw) {
      const key = ctxKeyOf(file, ref);
      if (!key) continue;
      const arr = supplierByKey.get(key);
      if (arr) arr.push({ file, componentName });
      else supplierByKey.set(key, [{ file, componentName }]);
    }
  }

  // compKey → provKey → ref. A Map, not a Set: the closure below merges along
  // component edges and the dedupe is by provider identity.
  const reqs = new Map<string, Map<string, ProviderRef>>();
  const addReq = (compKey: string, ref: ProviderRef) => {
    if (provKey(ref) === compKey) return; // never wraps itself
    let m = reqs.get(compKey);
    if (!m) {
      m = new Map();
      reqs.set(compKey, m);
    }
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
      let hookSpec: string | undefined;
      for (const mi of c.info.moduleImports ?? []) {
        if (mi.isTypeOnly) continue;
        const i = mi.names.indexOf(hook);
        if (i === -1) continue;
        hookSpec = mi.specifier;
        if (mi.resolvedPath) {
          sourceFile = mi.resolvedPath;
          moduleSide = mi.importedNames?.[i] ?? hook;
        }
        // A bare library import binds the name too — but there is no file to
        // parse, so the derivation stays on the component's own file and the
        // shim table below decides.
        break;
      }
      if (!moduleSide.startsWith("use")) continue; // aliased to a non-hook name
      const candidate = `${moduleSide.slice(3)}Provider`;
      const parsed = await parseOnce(sourceFile);
      let unit = parsed?.components.find((u) => u.componentName === candidate);
      let providerFile = sourceFile;
      if (parsed && (!unit || unit.exportKind === "none")) {
        // The convention missed — find the component that supplies the
        // context this hook actually reads, however it is named.
        const facts = ctxOnce(parsed);
        const supplied = facts.providerByHook.get(moduleSide);
        if (supplied) unit = parsed.components.find((u) => u.componentName === supplied);
        // Still nothing, and the pairing lives across files: join the context
        // objects this hook reads against the components that render them.
        if (!unit) {
          for (const ref of facts.readsRaw.get(moduleSide) ?? []) {
            const key = ctxKeyOf(sourceFile, ref);
            if (!key) continue;
            for (const cand of supplierByKey.get(key) ?? []) {
              const candParsed = await parseOnce(cand.file);
              const u = candParsed?.components.find((x) => x.componentName === cand.componentName);
              if (u && u.exportKind !== "none" && !u.isAsync && providerMountsBare(u)) {
                unit = u;
                providerFile = cand.file;
                break;
              }
            }
            if (unit) break;
          }
        }
      }
      if (unit && unit.exportKind !== "none" && !unit.isAsync && providerMountsBare(unit)) {
        addReq(compKey, {
          componentName: unit.componentName,
          filePath: providerFile,
          exportKind: unit.exportKind,
          exportedAs: unit.exportedAs,
        });
      } else if (!unit) {
        // Nothing in the project pairs with this hook — a library context
        // does. Either the hook is imported from the library itself, or the
        // module-side hook is a project WRAPPER whose body calls one —
        // possibly through more wrappers across files: McpServerDialog →
        // useMcpServerDialogState → useMcpServerDetailQuery → useQuery, and
        // the component never names the library at all.
        const libs = new Set<string>(hookSpec ? [hookSpec] : []);
        const seenHooks = new Set<string>();
        const walkLibs = async (file: string, name: string): Promise<void> => {
          const key = `${file}::${name}`;
          if (seenHooks.has(key)) return;
          seenHooks.add(key);
          const p = await parseOnce(file);
          if (!p) return;
          const f = ctxOnce(p);
          for (const m of f.libsByHook.get(name) ?? []) libs.add(m);
          for (const called of f.callsByHook.get(name) ?? []) {
            if (called === name) continue;
            const b = p.imports.get(called);
            if (!b || b.isTypeOnly) continue;
            const target = resolver.resolve(b.specifier, file);
            if (target) await walkLibs(target, b.importedName ?? called);
          }
        };
        if (parsed) await walkLibs(sourceFile, moduleSide);
        const shim = shims?.(c).find(
          (s) =>
            shimModules(s).some((m) => libs.has(m)) &&
            (shimModules(s).includes(hookSpec ?? "") ? s.hooks.includes(moduleSide) : true),
        );
        if (shim) {
          addReq(compKey, {
            componentName: shim.componentName,
            filePath: shim.filePath,
            exportKind: "named",
          });
        }
      }
    }
    // The library COMPONENT ladder: rendering a provider-gated component asks
    // for that library's provider exactly like calling its hook does. This was
    // the gap saleor-dashboard fell into — components that render
    // <FormattedMessage> and never name `useIntl`, so the hook walk above found
    // nothing to key on and the mount died on the missing provider.
    const own = await parseOnce(c.info.filePath);
    const ownTags = own ? ctxOnce(own).tagsByFn.get(c.info.componentName) : undefined;
    if (own && ownTags) {
      for (const s of shims?.(c) ?? []) {
        if (!s.components || s.components.length === 0) continue;
        if (reqs.get(compKey)?.has(`${s.filePath}::${s.componentName}`)) continue;
        for (const tag of ownTags) {
          const b = own.imports.get(tag);
          if (!b || b.isTypeOnly || !shimModules(s).includes(b.specifier)) continue;
          if (!s.components.includes(b.importedName ?? tag)) continue;
          addReq(compKey, {
            componentName: s.componentName,
            filePath: s.filePath,
            exportKind: "named",
          });
          break;
        }
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
        if (!s) {
          s = new Set();
          edges.set(pk, s);
        }
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
