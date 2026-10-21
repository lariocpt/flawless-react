import path from "node:path";
import { synthesiseDefaults } from "../scaffold-tests/registry.ts";
import type {
  AnalyseOptions,
  ComponentInfo,
  ComponentTree,
  DataDepInfo,
  ModuleImportInfo,
  RenderMode,
} from "../types.ts";
import { bridgeDataShapes } from "./childBridge.ts";
import { childrenIntoSlot } from "./childrenIntoSlot.ts";
import { deriveCompoundFamily } from "./compoundFamily.ts";
import { dataConstantExports } from "./dataExports.ts";
import { extractChildAttrs } from "./extractChildAttrs.ts";
import { extractDataDeps } from "./extractDataDeps.ts";
import { extractFetchCalls } from "./extractFetchCalls.ts";
import { extractFlows } from "./extractFlows.ts";
import { extractGuards } from "./extractGuards.ts";
import { extractHookDetails, extractHooks } from "./extractHooks.ts";
import { extractInteractions } from "./extractInteractions.ts";
import { detectSelfLogging } from "./extractLogging.ts";
import { extractPredicates } from "./extractPredicates.ts";
import { extractProps } from "./extractProps.ts";
import { extractPropUsage } from "./extractPropUsage.ts";
import { extractRenderMode } from "./extractRenderMode.ts";
import { extractRootTag } from "./extractRootTag.ts";
import { extractState } from "./extractState.ts";
import { errorFallbackText, extractStaticText } from "./extractStaticText.ts";
import { harvestApiEndpoints } from "./harvestApiEndpoints.ts";
import { makeHostTagResolver } from "./hostTag.ts";
import { detectHostDialect } from "./nativeDialect.ts";
import { declaresComponentName, parseFile } from "./parseFile.ts";
import { isPureLocalModule } from "./pureModule.ts";
import { followHandoff, reexportTableOf } from "./reexportTable.ts";
import { buildComponentScope } from "./refs.ts";
import { initialRenderExpression, makeEnv } from "./renderPath.ts";
import {
  annotatedExportReturns,
  asyncComponentExports,
  resolveDepReturns,
} from "./resolveDepReturns.ts";
import { resolveIndexKeyProps } from "./resolveIndexKeys.ts";
import { ModuleResolver } from "./resolveModule.ts";
import { resolveTagRootTags } from "./resolveTagRootTags.ts";
import { extractServerActionReturns } from "./serverActionReturns.ts";
import { exportedNames, SourceFileCache } from "./sourceCache.ts";
import { inheritSpreadSiblingProps } from "./spreadSiblings.ts";
import { walkChildren } from "./walkChildren.ts";

/**
 * State shareable across EVERY entry of a sweep: both hold only
 * filesystem-derived facts (parsed sources, prologue directives, tsconfig
 * chains). Per-entry state — the visited sets above all — must never live
 * here. Omit it and each call builds a fresh pair, so the public API is
 * unchanged.
 */
export interface AnalyseSharedContext {
  cache: SourceFileCache;
  resolver: ModuleResolver;
}

export function createAnalyseSharedContext(): AnalyseSharedContext {
  return { cache: new SourceFileCache(), resolver: new ModuleResolver() };
}

export async function analyse(
  opts: AnalyseOptions,
  shared?: AnalyseSharedContext,
): Promise<ComponentTree> {
  const trees = await analyseFile({ ...opts, roots: "primary" }, shared);
  const first = trees[0];
  if (!first) {
    throw new Error(`parseFile: could not locate a React component in ${opts.entry}`);
  }
  return first;
}

/**
 * One tree per root component in the entry file.
 *
 * `roots: "primary"` keeps the historical behaviour (the file's main component).
 * `roots: "exported"` returns one tree per *exported* component, which is what a
 * whole-app sweep needs: `ui/card.tsx` exports 7 components, and pointing the
 * tool at that file previously described only the first.
 *
 * Each root gets its OWN `visited` set. Sharing one would make the second root
 * come back childless, because the first would already have claimed their
 * shared children. The resolver and parse cache ARE shared — that is what keeps
 * a 175-root sweep affordable.
 */
export async function analyseFile(
  opts: AnalyseOptions,
  shared?: AnalyseSharedContext,
): Promise<ComponentTree[]> {
  const resolver = shared?.resolver ?? new ModuleResolver();
  const cache = shared?.cache ?? new SourceFileCache();
  const absPath = path.resolve(opts.entry);

  let rootNames: Array<string | undefined> = [undefined];
  if (opts.roots === "exported") {
    const parsed = await parseFile(absPath, cache);
    const exported = parsed.components.filter((c) => c.exportKind !== "none");
    const chosen = exported.length > 0 ? exported : parsed.components.slice(0, 1);
    rootNames = chosen.map((c) => c.componentName);
  }

  const out: ComponentTree[] = [];
  for (const name of rootNames) {
    out.push(
      await analyseOne(absPath, 0, opts, new Set<string>(), opts.entry, resolver, name, cache),
    );
  }
  return out;
}

async function analyseOne(
  absPath: string,
  depth: number,
  opts: AnalyseOptions,
  visited: Set<string>,
  importSpecifier: string,
  resolver: ModuleResolver,
  preferredName: string | undefined,
  cache: SourceFileCache,
): Promise<ComponentTree> {
  const parsed = await parseFile(absPath, cache);
  const unit =
    (preferredName
      ? parsed.components.find((c) => c.componentName === preferredName)
      : undefined) ?? parsed.components[0];
  if (!unit) {
    throw new Error(`parseFile: could not locate a React component in ${absPath}.`);
  }
  visited.add(`${absPath}::${unit.componentName}`);

  const props = extractProps(
    parsed.sourceFile,
    unit.propsTypeNode,
    unit.propsTypeLiteral,
    parsed.imports,
    absPath,
    resolver,
    cache,
  );
  const {
    propsShape: typedProps,
    variants,
    unresolvedProps: unresolvedFromTypes,
    unresolvedTypes,
    propPositions,
    promiseProps,
    variantOptions,
    variantClasses,
    hostElement,
    acceptsChildren,
  } = props;
  // A prop the type layer could not resolve, but which the body uses as an index
  // key into a same-file literal table, has its values written out in that
  // table. Recovering them here means the rest of the analysis — the render env,
  // the interaction harvest, the spec's DEFAULTS — all see a real value.
  const indexKeys = resolveIndexKeyProps(unit.bodyNode, parsed.sourceFile, unresolvedFromTypes);
  const propsShape = { ...typedProps, ...indexKeys.defaults };
  // Names bound by the destructured first param ARE props, whatever the type
  // layer made of them. `({ searchParams }: PageProps<'/'>)` types the Next 15+
  // contract through a generated-route generic no syntactic resolver can see
  // through — without this, the binding is invisible to usage extraction, the
  // {} floor, and the promise-wrap below, and the render dies on
  // `searchParams.then` of undefined. Alias-aware, and `children` stays out:
  // finalise removes it from the value world on purpose.
  for (const local of unit.destructuredProps) {
    const name = unit.destructuredAliases.get(local) ?? local;
    if (name === "children") continue;
    if (name in typedProps || props.unresolvedProps.includes(name)) continue;
    props.unresolvedProps.push(name);
  }
  const unresolvedProps = unresolvedFromTypes.filter((p) => !(p in indexKeys.defaults));

  // Decided once, from this file's own imports, before any extractor runs. A
  // file with host elements to classify always has the import that proves the
  // dialect, because a React Native element is only ever reachable through one.
  const hostDialect = detectHostDialect(parsed.imports);
  const hostTag = makeHostTagResolver(parsed.imports);

  const hooks = extractHooks(unit.bodyNode);
  const state = extractState(unit.bodyNode, parsed.sourceFile);
  const scope = buildComponentScope(unit, props, state, unit.bodyNode);
  const hookDetails = extractHookDetails(unit.bodyNode, parsed.sourceFile, scope);
  const propUsage = extractPropUsage(unit.bodyNode, parsed.sourceFile, scope);
  // `.then(...)` on a destructured prop IS promise evidence — and often the
  // only evidence available: Next 15+ page props arrive typed through the
  // framework's `PageProps<'/'>` generic, which the (checkerless) type layer
  // cannot see through, so walkMembers never marks them. Stand the prop up as
  // unresolved (→ the {} floor in synthesiseDefaults) and mark it for the
  // spec's Promise.resolve wrap; otherwise the render dies on
  // `undefined.then`, or on `use(undefined)` for a page that awaits.
  for (const u of propUsage) {
    if (u.member !== "then" || u.propName in propsShape) continue;
    if (!unresolvedProps.includes(u.propName)) unresolvedProps.push(u.propName);
    if (!promiseProps.includes(u.propName)) promiseProps.push(u.propName);
  }
  // `<Sibling {...props} />` in this same file: the forwarding is the
  // consuming. NavLink resolves no props at all (Omit<T> & {…}) yet its
  // default-mount spec dies inside NavLinkInner's `props.href.toString()`.
  // `known` is RESOLVED shapes only — an already-unresolved prop must NOT be
  // skipped: the sibling's member read is the evidence that arms its {}
  // floor, and without it NavLink's href stays unresolved-but-unevidenced
  // and the mount dies exactly the same way.
  inheritSpreadSiblingProps(
    unit,
    parsed.components,
    new Set<string>(Object.keys(propsShape)),
    unresolvedProps,
    propUsage,
    parsed.sourceFile,
  );
  const childAttrs = extractChildAttrs(unit.bodyNode, parsed.sourceFile);
  const fetchCalls = extractFetchCalls(unit.bodyNode, parsed.sourceFile);
  // Endpoints reached through the app's own fetch wrapper (one hop). Native
  // only: a React Native screen never has a bare fetch() for extractFetchCalls
  // to find — it calls api functions that wrap it — so this is the entire load
  // harvest on Expo, and running it on web (where fetchCalls already sees the
  // direct calls) would only add resolution cost. B-16 wave 7.
  const apiCalls =
    hostDialect === "native"
      ? harvestApiEndpoints(
          unit.bodyNode,
          parsed.sourceFile,
          parsed.imports,
          absPath,
          resolver,
          cache,
        )
      : [];
  // The CLASS for a class component, not just render(): componentDidCatch is
  // where an error boundary logs, and bodyNode is render(). Reading render()
  // alone left logsErrors false for a component whose whole contract is to log
  // what it caught, and the spec then asserted a clean console against it.
  const logsErrors = detectSelfLogging(
    unit.classNode ?? unit.bodyNode,
    new Set(parsed.moduleImports.flatMap((mi) => mi.names)),
  );
  // The values the generated spec will actually pass. Everything below describes
  // the render those values produce, rather than the last return in the body.
  const renderEnv = makeEnv(propsShape, unresolvedProps, state);
  // What each component tag in this render actually produces, so "is <button>
  // ambiguous here" is answered with evidence rather than with a guess about
  // what a name ending in Button probably renders.
  const tagRootTags = await resolveTagRootTags(
    unit.bodyNode,
    parsed.sourceFile,
    parsed.imports,
    absPath,
    resolver,
    cache,
  );
  const interactions = extractInteractions(
    unit.bodyNode,
    parsed.sourceFile,
    propsShape,
    unresolvedProps,
    renderEnv,
    tagRootTags,
    hostTag,
    hostDialect,
    new Set(state.map((st) => st.setterName).filter((n): n is string => n !== undefined)),
  );
  const initialRender = initialRenderExpression(unit.bodyNode, renderEnv);
  const flows = extractFlows(unit.bodyNode, renderEnv, hostTag);
  const rootTag = extractRootTag(unit.bodyNode, renderEnv, hostTag);
  // Fixture-children shape: an asChild Slot / <Slot> child site cannot take
  // the bare text the unit template otherwise passes (Slot clones elements).
  const childrenSlotted = acceptsChildren && childrenIntoSlot(unit.bodyNode);
  const staticText = extractStaticText(unit.bodyNode, renderEnv);
  // Sibling components' modes, so a wrapper around a part is recognised as one
  // too. Computed without local modes of their own: one hop is enough for the
  // shadcn shape (SubContent → Content → MenuPrimitive.Popup) and keeps this
  // free of ordering and cycle concerns.
  const localModes = new Map<string, RenderMode>();
  for (const other of parsed.components) {
    if (other.componentName === unit.componentName) continue;
    localModes.set(
      other.componentName,
      extractRenderMode(other.bodyNode, parsed.imports, other.isAsync).mode,
    );
  }
  const render = extractRenderMode(
    unit.bodyNode,
    parsed.imports,
    unit.isAsync,
    renderEnv,
    localModes,
  );
  // A part that cannot mount alone may still name its own wrapper: the family
  // its file exports. Derived only for compound parts — everything else has
  // nothing to wrap.
  const compoundFamily =
    render.mode === "compound-part"
      ? deriveCompoundFamily(unit, parsed.components, parsed.imports)
      : undefined;
  // Data deps and guards only mean something for a server component that
  // awaits its data; running them elsewhere would be noise. Deps whose usage
  // told us nothing get a second chance from their own declaration
  // (Promise<T> annotation, or a single-fetch body) — see resolveDepReturns.
  // A same-file sibling's deps count too when this unit doesn't already dep
  // on that callee: the spec's module mock replaces the module for the WHOLE
  // render, and the sibling is real code inside it. CurrentUserAvatar awaits
  // only getCurrentUserHandle, but the <UserAvatar> it renders awaits
  // getUserByHandle and reads user.displayName.charAt(0) off the result —
  // without the sibling's evidence the shared mock hands back {} and the
  // mount dies in the child. Own evidence wins: it sits on this unit's
  // primary render path.
  const dataDeps = unit.isAsync
    ? resolveDepReturns(
        (() => {
          const own = extractDataDeps(unit.bodyNode, parsed.sourceFile, parsed.imports);
          const extras: DataDepInfo[] = [];
          for (const c of parsed.components) {
            if (c === unit || !c.isAsync) continue;
            for (const d of extractDataDeps(c.bodyNode, parsed.sourceFile, parsed.imports)) {
              if (
                !own.some((o) => o.callee === d.callee) &&
                !extras.some((e) => e.callee === d.callee)
              )
                extras.push(d);
            }
          }
          return [...own, ...extras];
        })(),
        parsed.imports,
        absPath,
        resolver,
        cache,
      )
    : [];
  const guards = extractGuards(
    unit.bodyNode,
    parsed.sourceFile,
    parsed.imports,
    new Set(dataDeps.map((d) => d.varName).filter((v): v is string => v !== undefined)),
  );

  const moduleImports = parsed.moduleImports.map((mi) => {
    const resolvedPath = resolver.resolve(mi.specifier, absPath);
    if (!resolvedPath) return mi;
    // A "use server" module cannot run under jsdom or in a browser bundle: its
    // exports reach for the database, the mailer and next/cache. Flagging it here
    // — where the resolver and the cache are in scope — lets both the spec
    // emitter and the perf host stub it by name rather than by guesswork.
    if (!cache.hasPrologueDirective(resolvedPath, "use server")) {
      // Return annotations for the names this component imports, so a helper
      // called inside JSX rather than awaited into a variable is mocked from its
      // declaration instead of from `{}`. resolveDepReturns covers the awaited
      // ones; this is the same evidence for the rest.
      const importedReturns = annotatedExportReturns(mi, resolvedPath, resolver, cache);
      // Async-ness of JSX-tag imports: the RSC emitter stubs an async child
      // rather than mounting what React's client renderer refuses.
      const asyncComponents =
        mi.kind === "component" ? asyncComponentExports(mi, resolvedPath, resolver, cache) : [];
      // Data-constant exports (config modules): when every name the component
      // imports is one, the mock emitter leaves the module REAL — a factory
      // replacement would starve transitive importers of the exports this
      // component never named.
      const dataExports =
        mi.kind === "value" ? dataConstantExports(mi, resolvedPath, resolver, cache) : [];
      // A local module that only CALCULATES (no await, no live imports, no
      // top-level call) is not a data source no matter where it was imported
      // from — the mock loop must leave it real, or `splitCode` comes back as
      // {} and the render dies on segments.map.
      const pure = !resolvedPath.includes("node_modules") && isPureLocalModule(resolvedPath);
      return {
        ...mi,
        resolvedPath,
        ...(Object.keys(importedReturns).length > 0 ? { importedReturns } : {}),
        ...(asyncComponents.length > 0 ? { asyncComponents } : {}),
        ...(dataExports.length > 0 ? { dataExports } : {}),
        ...(pure ? { isPureModule: true } : {}),
      };
    }
    const target = cache.get(resolvedPath);
    // Only names with a single literal-derivable return land in the record;
    // the emitters keep {} stubs (and the TODO) for everything absent.
    const returns = target ? extractServerActionReturns(target) : {};
    return {
      ...mi,
      resolvedPath,
      isServerAction: true,
      // Every export, not just the ones this component imports: a transitive
      // importer needs the others, and a missing name fails the bundle.
      serverActionExports: target ? exportedNames(target) : [...mi.names],
      ...(Object.keys(returns).length > 0 ? { serverActionReturns: returns } : {}),
    };
  });

  // B-19: predicates a spec can invert, certified against the same values the
  // emitted mocks will hold. Async server components only — the same gate as
  // dataDeps/guards, and the plane where the one-mount-all-true problem lives.
  const predicates = unit.isAsync
    ? extractPredicates({
        bodyNode: unit.bodyNode,
        sourceFile: parsed.sourceFile,
        dataDeps,
        guards,
        moduleImports,
        propsShape,
        unresolvedProps,
        staticText,
      })
    : { inversions: [], refusals: [] };

  const info: ComponentInfo = {
    componentName: unit.componentName,
    filePath: absPath,
    importSpecifier,
    propsShape,
    variants,
    hooks,
    unresolvedProps,
    interactions,
    pos: unit.pos,
    exportKind: unit.exportKind,
    exportedAs: unit.exportedAs,
    isAsync: unit.isAsync,
    isClientComponent: parsed.isClientComponent,
    wrappers: unit.wrappers,
    propPositions,
    promiseProps,
    unresolvedTypes,
    variantOptions,
    variantClasses,
    acceptsChildren,
    ...(childrenSlotted ? { childrenSlotted: true } : {}),
    ...(hostElement ? { hostElement } : {}),
    ...(hostDialect === "native" ? { hostDialect } : {}),
    state,
    hookDetails,
    propUsage,
    childAttrs,
    fetchCalls,
    ...(apiCalls.length > 0 ? { apiCalls } : {}),
    staticText,
    dataDeps,
    guards,
    ...(predicates.inversions.length > 0 ? { predicateInversions: predicates.inversions } : {}),
    ...(predicates.refusals.length > 0 ? { predicateRefusals: predicates.refusals } : {}),
    ...(rootTag ? { rootTag } : {}),
    ...(initialRender?.guarded ? { renderGuarded: true } : {}),
    // The THIRD state. renderGuarded is set only when an initial render EXISTS
    // and is guarded, so a total bail — renderPath could not decide which branch
    // runs, and every branch returns content — was indistinguishable from an
    // unconditional render. Downstream that means a spec asserting on markup
    // from a branch the defaults never take.
    ...(initialRender ? {} : { renderUndecidable: true as const }),
    // An error boundary is the exception to the refusal above: its fallback
    // branch is reachable by construction, so the spec asserts both paths
    // instead of declining both.
    ...(unit.isErrorBoundary
      ? { errorBoundary: { fallbackText: errorFallbackText(unit.bodyNode) } }
      : {}),
    childrenFlow: flows.children,
    classNameFlow: flows.className,
    renderMode: render.mode,
    ...(render.note ? { renderNotes: [render.note] } : {}),
    ...(compoundFamily ? { compoundFamily } : {}),
    ...(logsErrors ? { logsErrors } : {}),
    moduleImports,
  };

  let children: ComponentTree[] = [];
  if (opts.includeChildren && depth < opts.depth) {
    const localComponents = new Set(parsed.components.map((c) => c.componentName));
    const refs = walkChildren(
      unit.bodyNode,
      parsed.imports,
      absPath,
      parsed.sourceFile,
      resolver,
      localComponents,
      unit.componentName,
    );
    children = [];
    const childAt = async (
      file: string,
      exportedName: string | undefined,
      localTag: string,
    ): Promise<ComponentTree | undefined> => {
      const key = `${file}::${exportedName ?? "*"}`;
      if (visited.has(key)) return undefined;
      visited.add(key);
      try {
        const childTree = await analyseOne(
          file,
          depth + 1,
          opts,
          visited,
          file,
          resolver,
          exportedName,
          cache,
        );
        childTree.entry.localTag = localTag;
        return childTree;
      } catch (err) {
        // Skip children we can't parse (no React component inside, etc.); record nothing —
        // the user can re-run with --depth tuned, or edit the generated suite.
        if (!(err instanceof Error && err.message.includes("could not locate a React component"))) {
          throw err;
        }
        return undefined;
      }
    };
    const throughHandoff = async (
      file: string,
      exportedName: string | undefined,
    ): Promise<{ file: string; name: string } | undefined> => {
      // A default import asks for the file's own primary component, so there is
      // no name to look up.
      if (!exportedName) return undefined;
      const source = cache.get(file);
      if (!source) return undefined;
      const table = reexportTableOf(source);
      // The cheap gate: a file that hands nothing along — nearly every file —
      // is answered off a statement walk, with no component detection at all.
      if (!table.named.has(exportedName) && table.stars.length === 0) return undefined;
      if (declaresComponentName(file, exportedName, cache)) return undefined;
      return followHandoff(file, exportedName, {
        read: (f) => cache.get(f),
        resolve: (specifier, from) => resolver.resolve(specifier, from),
        declares: (f, name) => declaresComponentName(f, name, cache),
      });
    };
    for (const ref of refs) {
      // The hand-off, tried FIRST. A Feature-Sliced component is imported from
      // its slice's index, and an index hands the name along instead of
      // declaring it — so the direct read either died there (no component in
      // the file at all) or, worse, silently bound analyseOne's first-component
      // fallback and made the parent a child of whatever the barrel happened to
      // declare first. ton-console's EmptyApiKeys renders <CreateApiKeyModal>
      // from '../index', and its spec mounted without the QueryClientProvider
      // that modal calls through. Both dead ends cost the tree the child edge,
      // and the transitive provider pass has nothing to inherit without it.
      const held = await throughHandoff(ref.absPath, ref.exportedName);
      const attempts = held
        ? [
            { file: held.file, name: held.name },
            { file: ref.absPath, name: ref.exportedName },
          ]
        : [{ file: ref.absPath, name: ref.exportedName }];
      for (const attempt of attempts) {
        const tree = await childAt(attempt.file, attempt.name, ref.localName);
        // The direct read stays as the fallback: a hand-off that leads nowhere
        // must not lose the edge the old binding produced.
        if (tree) {
          children.push(tree);
          break;
        }
      }
    }
  }

  // The spec renders its descendants for real, and they fetch their own
  // data: Drop awaits getUserDropInteractions though the page imports only
  // getDropsByAuthor. Collect the tree's data imports and the call-site
  // shapes the descendants read, so the shared module mock is built with
  // the whole render's evidence. The unit's own evidence wins for a callee
  // (it sits on the primary path); tree entries fill what the unit never
  // touched.
  if (children.length > 0) {
    const ownCallees = new Set((info.dataDeps ?? []).map((d) => d.callee));
    const extras = new Map<string, ModuleImportInfo>();
    const depExtras: DataDepInfo[] = [];
    // The child bridge (analyse/childBridge.ts): a rendered component knows
    // more about the value it is handed than this unit's reads show — the
    // RelativeTime that calls date.getTime() on `drop.createdAt`. Collect
    // each tag's expected prop values (that component's OWN defaults, which
    // already carry ITS descendants' bridges: the recursion is post-order).
    // The whole subtree counts, not just direct children: `visited` gives a
    // shared component to whichever branch claims it first, so ProfileFeed's
    // <Drop> can hide under DropList while still being rendered by its body.
    // Direct children register first — their evidence wins for a tag.
    const childExpected: Record<string, Record<string, unknown>> = {};
    for (const ct of children) {
      const tag = ct.entry.localTag ?? ct.entry.componentName;
      if (!childExpected[tag]) childExpected[tag] = synthesiseDefaults(ct.entry);
    }
    // A descendant parked AT the depth limit shows childless whatever it
    // renders: the app page's tree sees Drop but not the RelativeTime
    // buried one level under him, and the expectation from that truncated
    // entry omits the Date RelativeTime demands. Resolve such a tag from a
    // FRESH walk of its own file — full depth budget from there, parse
    // cache already warm, so a component's expectations never depend on how
    // far down the host's tree it happened to be discovered.
    const truncated = new Map<string, ComponentTree>();
    // A mocked module is served to EVERY importer in the graph, so its factory
    // must cover every name ANY file imports from it — sonner: one file's
    // { toast } stood for the whole mock while components/toaster's
    // { Toaster } was dropped, and the real importer died at import time on
    // the missing export. The walk merges per-specifier name sets (the unit's
    // own statements included); a default arriving late is skipped — its
    // index-0 slot belongs to the entry that registered first.
    const mergeImport = (base: ModuleImportInfo, extra: ModuleImportInfo): ModuleImportInfo => {
      const add = extra.names
        .map((n, i) => ({ n, i }))
        .filter(({ n, i }) => !base.names.includes(n) && !(extra.hasDefault && i === 0));
      if (add.length === 0) return base;
      // The added names' return annotations travel with them: RelativeTime's
      // `timeAgo(d): string` is what makes the stub SYNC when the module ends
      // up mocked anyway — an async stub rendered as a JSX child silently
      // suspends the whole tree.
      const returns: Record<string, unknown> = { ...base.importedReturns };
      for (const { n, i } of add) {
        const m = extra.importedNames?.[i] ?? extra.names[i] ?? n;
        const r = extra.importedReturns?.[m];
        if (r !== undefined && returns[m] === undefined) returns[m] = r;
      }
      const baseReturns = Object.keys(returns).length > 0;
      return {
        ...base,
        names: [...base.names, ...add.map(({ n }) => n)],
        importedNames: [
          ...(base.importedNames ?? base.names),
          ...add.map(({ n, i }) => extra.importedNames?.[i] ?? extra.names[i] ?? n),
        ],
        mergedNames: [...(base.mergedNames ?? []), ...add.map(({ n }) => n)],
        ...(base.dataExports || extra.dataExports
          ? {
              dataExports: [
                ...new Set([...(base.dataExports ?? []), ...(extra.dataExports ?? [])]),
              ],
            }
          : {}),
        ...(baseReturns ? { importedReturns: returns as never } : {}),
      };
    };
    const walkTree = (trees: ComponentTree[]): void => {
      for (const t of trees) {
        for (const mi of t.entry.moduleImports ?? []) {
          const prev = extras.get(mi.specifier);
          if (prev) {
            extras.set(mi.specifier, mergeImport(prev, mi));
          } else {
            const own = moduleImports.find((m) => m.specifier === mi.specifier);
            if (own) extras.set(mi.specifier, mergeImport(own, mi));
            else extras.set(mi.specifier, mi);
          }
        }
        for (const d of t.entry.dataDeps ?? []) {
          if (!ownCallees.has(d.callee) && !depExtras.some((e) => e.callee === d.callee)) {
            depExtras.push(d);
          }
        }
        const tag = t.entry.localTag ?? t.entry.componentName;
        if (!childExpected[tag]) {
          childExpected[tag] = synthesiseDefaults(t.entry);
          if (t.children.length === 0 && t.entry.childExpected === undefined) {
            truncated.set(tag, t);
          }
        }
        walkTree(t.children);
      }
    };
    walkTree(children);
    if (truncated.size > 0) {
      const resolved = new Map<string, Record<string, unknown>>();
      for (const [tag, t] of truncated) {
        const key = `${t.entry.filePath}::${t.entry.componentName}`;
        let exp = resolved.get(key);
        if (exp === undefined) {
          try {
            const fresh = await analyseOne(
              t.entry.filePath,
              0,
              opts,
              new Set<string>(),
              t.entry.filePath,
              resolver,
              t.entry.componentName,
              cache,
            );
            exp = synthesiseDefaults(fresh.entry);
          } catch {
            continue; // keep the partial expectation registered by the walk
          }
          resolved.set(key, exp);
        }
        childExpected[tag] = exp;
      }
    }
    if (extras.size > 0) info.treeImports = [...extras.values()];
    if (depExtras.length > 0) info.treeDataDeps = depExtras;

    info.childExpected = childExpected;
    if (info.dataDeps) bridgeDataShapes(unit.bodyNode, info.dataDeps, childExpected);
  }

  return { entry: info, children };
}

export { extractHooks } from "./extractHooks.ts";
export { extractInteractions } from "./extractInteractions.ts";
export { extractProps } from "./extractProps.ts";
export { parseFile } from "./parseFile.ts";
export { posOf } from "./pos.ts";
export { ModuleResolver, probeModuleFile } from "./resolveModule.ts";
export { SourceFileCache } from "./sourceCache.ts";
export { walkChildren } from "./walkChildren.ts";
