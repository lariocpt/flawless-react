import path from "node:path";
import type { AnalyseOptions, ComponentInfo, ComponentTree, RenderMode } from "../types.ts";
import { deriveCompoundFamily } from "./compoundFamily.ts";
import { extractChildAttrs } from "./extractChildAttrs.ts";
import { extractDataDeps } from "./extractDataDeps.ts";
import { extractFetchCalls } from "./extractFetchCalls.ts";
import { extractFlows } from "./extractFlows.ts";
import { extractGuards } from "./extractGuards.ts";
import { extractHookDetails, extractHooks } from "./extractHooks.ts";
import { extractInteractions } from "./extractInteractions.ts";
import { detectSelfLogging } from "./extractLogging.ts";
import { extractProps } from "./extractProps.ts";
import { extractPropUsage } from "./extractPropUsage.ts";
import { extractRenderMode } from "./extractRenderMode.ts";
import { extractRootTag } from "./extractRootTag.ts";
import { extractState } from "./extractState.ts";
import { extractStaticText } from "./extractStaticText.ts";
import { makeHostTagResolver } from "./hostTag.ts";
import { detectHostDialect } from "./nativeDialect.ts";
import { parseFile } from "./parseFile.ts";
import { buildComponentScope } from "./refs.ts";
import { initialRenderExpression, makeEnv } from "./renderPath.ts";
import { annotatedExportReturns, resolveDepReturns } from "./resolveDepReturns.ts";
import { resolveIndexKeyProps } from "./resolveIndexKeys.ts";
import { ModuleResolver } from "./resolveModule.ts";
import { resolveTagRootTags } from "./resolveTagRootTags.ts";
import { extractServerActionReturns } from "./serverActionReturns.ts";
import { exportedNames, SourceFileCache } from "./sourceCache.ts";
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
  const childAttrs = extractChildAttrs(unit.bodyNode, parsed.sourceFile);
  const fetchCalls = extractFetchCalls(unit.bodyNode, parsed.sourceFile);
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
  );
  const initialRender = initialRenderExpression(unit.bodyNode, renderEnv);
  const flows = extractFlows(unit.bodyNode, renderEnv, hostTag);
  const rootTag = extractRootTag(unit.bodyNode, renderEnv, hostTag);
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
  const dataDeps = unit.isAsync
    ? resolveDepReturns(
        extractDataDeps(unit.bodyNode, parsed.sourceFile, parsed.imports),
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
      return {
        ...mi,
        resolvedPath,
        ...(Object.keys(importedReturns).length > 0 ? { importedReturns } : {}),
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
    isAsync: unit.isAsync,
    isClientComponent: parsed.isClientComponent,
    wrappers: unit.wrappers,
    propPositions,
    promiseProps,
    unresolvedTypes,
    variantOptions,
    variantClasses,
    acceptsChildren,
    ...(hostElement ? { hostElement } : {}),
    ...(hostDialect === "native" ? { hostDialect } : {}),
    state,
    hookDetails,
    propUsage,
    childAttrs,
    fetchCalls,
    staticText,
    dataDeps,
    guards,
    ...(rootTag ? { rootTag } : {}),
    ...(initialRender?.guarded ? { renderGuarded: true } : {}),
    // The THIRD state. renderGuarded is set only when an initial render EXISTS
    // and is guarded, so a total bail — renderPath could not decide which branch
    // runs, and every branch returns content — was indistinguishable from an
    // unconditional render. Downstream that means a spec asserting on markup
    // from a branch the defaults never take.
    ...(initialRender ? {} : { renderUndecidable: true as const }),
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
    for (const ref of refs) {
      const tentativeKey = `${ref.absPath}::${ref.exportedName ?? "*"}`;
      if (visited.has(tentativeKey)) continue;
      visited.add(tentativeKey);
      try {
        const childTree = await analyseOne(
          ref.absPath,
          depth + 1,
          opts,
          visited,
          ref.absPath,
          resolver,
          ref.exportedName,
          cache,
        );
        childTree.entry.localTag = ref.localName;
        children.push(childTree);
      } catch (err) {
        // Skip children we can't parse (no React component inside, etc.); record nothing —
        // the user can re-run with --depth tuned, or edit the generated suite.
        if (!(err instanceof Error && err.message.includes("could not locate a React component"))) {
          throw err;
        }
      }
    }
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
