import ts from "typescript";
import type { DataDepInfo } from "../types.ts";
import { extractFetchCalls } from "./extractFetchCalls.ts";
import { resolveTypeNodeValue } from "./extractProps.ts";
import { ownReturns } from "./ownReturns.ts";
import type { ImportBinding } from "./parseFile.ts";
import type { ModuleResolver } from "./resolveModule.ts";
import { exportedFunctions } from "./serverActionReturns.ts";
import { findExportedDecl, type SourceFileCache } from "./sourceCache.ts";

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
    // A "use server" module's mock is serverActionMock's channel, and it
    // never reads dataDeps — enriching a dep here would suppress the RSC
    // skip escape for a fixture that is never emitted, turning the honest
    // skip into a false RED that blames the application.
    if (cache.hasPrologueDirective(target, "use server")) return dep;
    const wanted =
      binding.kind === "default" ? "default" : (binding.importedName ?? dep.calleeRoot);
    // Barrel-aware: chase re-exports to the DECLARING file, so an annotation
    // behind `export * from "./api"` still enriches the dep.
    const located = findExportedDecl(target, wanted, cache, resolver, (sf, name) =>
      new Map(exportedFunctions(sf)).get(name),
    );
    if (!located) return dep;
    const { sf, file: declFile, decl: fn } = located;
    // The barrel itself rarely carries the directive — the declaring module
    // is what decides whether this is serverActionMock's channel.
    if (declFile !== target && cache.hasPrologueDirective(declFile, "use server")) return dep;

    const promiseArg = promiseTypeArg(fn.type);
    if (promiseArg) {
      const value = resolveTypeNodeValue(promiseArg, sf, declFile, resolver, cache);
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
    // The wrapper must RETURN the fetched json — an envelope unwrapper
    // (`return envelope.data`) or a side-effect fetch would join an OpenAPI
    // example to a value the function never returns, false-pass capable for
    // a shape-tolerant component.
    if (!returnsFetchedJson(fn)) return dep;
    return { ...dep, wrapsFetch: { method: f.method.toUpperCase(), path: f.urlTemplate } };
  });
}

/**
 * True iff the wrapper's single return IS the fetch response's json():
 * `return res.json()` / `return await res.json()` where `res` was bound to
 * (an awaited) fetch; `const data = await res.json(); return data;`; or the
 * direct `return (await fetch(...)).json()`. Anything else — a second
 * return, a transformed value, a different binding — is not a wrapper.
 */
function returnsFetchedJson(fn: { body?: ts.Node }): boolean {
  const body = fn.body;
  if (!body) return false;
  // A concise arrow body IS the single return expression.
  const returns = ts.isBlock(body)
    ? ownReturns(body).map((r) => r.expression)
    : [body as ts.Expression];
  if (returns.length !== 1 || returns[0] === undefined) return false;

  // Bindings: `const res = await fetch(...)` and `const data = await res.json()`.
  const fetchVars = new Set<string>();
  const jsonVars = new Set<string>();
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = unwrapAwait(decl.initializer);
        if (isFetchCall(init)) fetchVars.add(decl.name.text);
        else if (isJsonCallOn(init, fetchVars)) jsonVars.add(decl.name.text);
      }
    }
  }

  const expr = unwrapAwait(returns[0]);
  if (ts.isIdentifier(expr)) return jsonVars.has(expr.text);
  return isJsonCallOn(expr, fetchVars);
}

function unwrapAwait(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isAwaitExpression(e)) e = e.expression;
    else return e;
  }
}

function isFetchCall(expr: ts.Expression): boolean {
  return (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "fetch"
  );
}

/** `<receiver>.json()` where the receiver is a fetch binding or a fetch call. */
function isJsonCallOn(expr: ts.Expression, fetchVars: Set<string>): boolean {
  if (!ts.isCallExpression(expr) || expr.arguments.length !== 0) return false;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "json") return false;
  const receiver = unwrapAwait(callee.expression);
  if (ts.isIdentifier(receiver)) return fetchVars.has(receiver.text);
  return isFetchCall(receiver);
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
