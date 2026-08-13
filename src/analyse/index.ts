import path from "node:path";
import type { AnalyseOptions, ComponentInfo, ComponentTree } from "../types.ts";
import { extractChildAttrs } from "./extractChildAttrs.ts";
import { extractFetchCalls } from "./extractFetchCalls.ts";
import { extractHookDetails, extractHooks } from "./extractHooks.ts";
import { extractInteractions } from "./extractInteractions.ts";
import { extractProps } from "./extractProps.ts";
import { extractPropUsage } from "./extractPropUsage.ts";
import { extractState } from "./extractState.ts";
import { parseFile } from "./parseFile.ts";
import { buildComponentScope } from "./refs.ts";
import { ModuleResolver } from "./resolveModule.ts";
import { walkChildren } from "./walkChildren.ts";

export async function analyse(opts: AnalyseOptions): Promise<ComponentTree> {
  const resolver = new ModuleResolver();
  const visited = new Set<string>();
  return analyseOne(path.resolve(opts.entry), 0, opts, visited, opts.entry, resolver, undefined);
}

async function analyseOne(
  absPath: string,
  depth: number,
  opts: AnalyseOptions,
  visited: Set<string>,
  importSpecifier: string,
  resolver: ModuleResolver,
  preferredName: string | undefined,
): Promise<ComponentTree> {
  const parsed = await parseFile(absPath);
  const unit =
    (preferredName
      ? parsed.components.find((c) => c.componentName === preferredName)
      : undefined) ?? parsed.components[0];
  if (!unit) {
    throw new Error(`parseFile: could not locate a React component in ${absPath}.`);
  }
  visited.add(`${absPath}::${unit.componentName}`);

  const { propsShape, variants, unresolvedProps, propPositions, promiseProps } = extractProps(
    parsed.sourceFile,
    unit.propsTypeRef,
    unit.propsTypeLiteral,
    parsed.imports,
    absPath,
    resolver,
  );
  const hooks = extractHooks(unit.bodyNode);
  const interactions = extractInteractions(
    unit.bodyNode,
    parsed.sourceFile,
    propsShape,
    unresolvedProps,
  );

  const extracted = { propsShape, variants, unresolvedProps, propPositions, promiseProps };
  const state = extractState(unit.bodyNode, parsed.sourceFile);
  const scope = buildComponentScope(unit, extracted, state, unit.bodyNode);
  const hookDetails = extractHookDetails(unit.bodyNode, parsed.sourceFile, scope);
  const propUsage = extractPropUsage(unit.bodyNode, parsed.sourceFile, scope);
  const childAttrs = extractChildAttrs(unit.bodyNode, parsed.sourceFile);
  const fetchCalls = extractFetchCalls(unit.bodyNode, parsed.sourceFile);

  const moduleImports = parsed.moduleImports.map((mi) => {
    const resolvedPath = resolver.resolve(mi.specifier, absPath);
    return resolvedPath ? { ...mi, resolvedPath } : mi;
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
    state,
    hookDetails,
    propUsage,
    childAttrs,
    fetchCalls,
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
export { walkChildren } from "./walkChildren.ts";
