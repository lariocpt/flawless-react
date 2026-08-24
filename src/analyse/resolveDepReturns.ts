import ts from "typescript";
import type { DataDepInfo } from "../types.ts";
import { extractFetchCalls } from "./extractFetchCalls.ts";
import { resolveTypeNodeValue } from "./extractProps.ts";
import type { ImportBinding } from "./parseFile.ts";
import type { ModuleResolver } from "./resolveModule.ts";
import { exportedFunctions } from "./serverActionReturns.ts";
import type { SourceFileCache } from "./sourceCache.ts";

/**
 * Second-chance enrichment for data deps whose USAGE told us nothing: when
 * the component only hands the awaited value onward, extractDataDeps lands
 * on unknown/uncertain and the mock is an honest {} plus a TODO. This pass
 * reads the dep function's own DECLARATION instead:
 *
 * - Path A: a `Promise<T>` return annotation — T resolved to one concrete
 *   fixture value (resolveTypeNodeValue's bail-on-any-hole policy), stored
 *   as `inferredReturn` with provenance "annotation".
 * - Path B: an UNANNOTATED wrapper whose body performs exactly one
 *   fetch() — recorded as `wrapsFetch` (method + path). The join to the
 *   OpenAPI response example happens at emit time, where the route table
 *   lives; provenance there is "openapi".
 *
 * Runs only for uncertain/unknown deps — a usage-derived shape is the
 * component's own testimony and outranks any declaration. Dotted callees
 * (`db.query.findMany`) stay TODOs: chasing member functions is FR-014,
 * deliberately deferred.
 */
export function resolveDepReturns(
  deps: DataDepInfo[],
  imports: Map<string, ImportBinding>,
  file: string,
  resolver: ModuleResolver,
  cache: SourceFileCache,
): DataDepInfo[] {
  return deps.map((dep) => {
    if (!dep.uncertain && dep.shape.kind !== "unknown") return dep;
    if (dep.callee !== dep.calleeRoot) return dep;
    const binding = imports.get(dep.calleeRoot);
    if (!binding || binding.isTypeOnly || binding.kind === "namespace") return dep;
    const target = resolver.resolve(binding.specifier, file);
    if (!target) return dep;
    const sf = cache.get(target);
    if (!sf) return dep;
    const wanted =
      binding.kind === "default" ? "default" : (binding.importedName ?? dep.calleeRoot);
    const fn = new Map(exportedFunctions(sf)).get(wanted);
    if (!fn) return dep;

    const promiseArg = promiseTypeArg(fn.type);
    if (promiseArg) {
      const value = resolveTypeNodeValue(promiseArg, sf, target, resolver, cache);
      if (value === undefined) return dep;
      return { ...dep, inferredReturn: { provenance: "annotation" as const, value } };
    }
    // Annotated with something that is not Promise<T>: outside the narrow
    // case, and a sync annotation on an awaited dep is somebody's refactor
    // in progress — not a thing to build a fixture on.
    if (fn.type) return dep;

    if (!fn.body) return dep;
    const fetches = extractFetchCalls(fn.body, sf);
    const f = fetches[0];
    if (!f || fetches.length !== 1) return dep;
    return { ...dep, wrapsFetch: { method: f.method.toUpperCase(), path: f.urlTemplate } };
  });
}

function promiseTypeArg(type: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === "Promise"
  ) {
    return type.typeArguments?.[0];
  }
  return undefined;
}
