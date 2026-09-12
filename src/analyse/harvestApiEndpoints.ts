import ts from "typescript";
import type { FetchCallInfo } from "../types.ts";
import { parseUrlArg, readMethod } from "./extractFetchCalls.ts";
import type { ImportBinding } from "./parseFile.ts";
import { posOf } from "./pos.ts";
import { hookCalleeName } from "./refs.ts";
import type { ModuleResolver } from "./resolveModule.ts";
import { exportedFunctions } from "./serverActionReturns.ts";
import { findExportedDecl, type SourceFileCache } from "./sourceCache.ts";

/**
 * Endpoints a component reaches through the app's OWN fetch wrapper, resolved
 * one hop — the harvest the load task needs on React Native and could never get
 * from `extractFetchCalls`.
 *
 * A React Native screen never writes `fetch()`: it calls a named api function
 * (`listBuildings()`) imported from `lib/api`, whose body calls a module-local
 * wrapper with a literal path (`apiFetch("/api/buildings")`), and the wrapper is
 * the only thing that touches `fetch`. So `fetchCalls` is empty on every screen
 * (0 endpoints on the whole dogfood app), and the endpoint URL lives two hops
 * away: screen → api function → apiFetch.
 *
 * This reads exactly that chain, and no deeper:
 *
 *   1. the screen CALLS an imported name (imported-but-uncalled is dead, and
 *      load-testing an endpoint the screen never hits would be a fiction);
 *   2. the name resolves — through barrels — to an exported function whose body
 *      calls a module-LOCAL fetch wrapper with a string-literal or template
 *      path;
 *   3. the wrapper is proven to be one: its single `fetch()` addresses one of
 *      its own parameters. A function merely NAMED apiFetch is not trusted; a
 *      helper that happens to take a string is not mistaken for the client.
 *
 * Anything it cannot see it drops rather than guesses: a call mediated by a
 * store, a path built from a non-literal, a wrapper two modules deep. A missing
 * endpoint costs a pipe; a wrong one measures a URL the app never requests.
 */
export function harvestApiEndpoints(
  bodyNode: ts.Node,
  sourceFile: ts.SourceFile,
  imports: Map<string, ImportBinding>,
  file: string,
  resolver: ModuleResolver,
  cache: SourceFileCache,
): FetchCallInfo[] {
  // Every imported name the component actually invokes, with the call node for
  // its position (imported-but-uncalled contributes nothing).
  const invoked = new Map<string, ts.CallExpression>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      if (imports.has(name) && !invoked.has(name)) invoked.set(name, n);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);

  const out: FetchCallInfo[] = [];
  const seen = new Set<string>();
  for (const [local, callNode] of invoked) {
    const binding = imports.get(local);
    if (!binding || binding.isTypeOnly || binding.kind === "namespace") continue;
    // Default-imported api clients exist, but the named-export idiom is the one
    // every RN app uses and the only one worth the resolution cost until a
    // real default-exported client turns up to measure against.
    if (binding.kind === "default") continue;
    const target = resolver.resolve(binding.specifier, file);
    if (!target) continue;
    const wanted = binding.importedName ?? local;
    const located = findExportedDecl(
      target,
      wanted,
      cache,
      resolver,
      (sf, name) => new Map(exportedFunctions(sf)).get(name),
      true,
    );
    if (!located) continue;
    const endpoint = wrapperCallIn(located.decl, located.sf);
    if (!endpoint) continue;
    const key = `${endpoint.method} ${endpoint.template}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      urlTemplate: endpoint.template,
      holes: endpoint.holes,
      method: endpoint.method,
      // The screen's own call site, not the api-module declaration: the endpoint
      // is a fact about THIS component, and its position is where the component
      // asks for it.
      pos: posOf(callNode, sourceFile),
      inEffect: isInsideEffect(callNode, bodyNode),
    });
  }
  return out;
}

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useFocusEffect"]);

function isInsideEffect(call: ts.Node, bodyNode: ts.Node): boolean {
  let cur: ts.Node | undefined = call.parent;
  while (cur && cur !== bodyNode) {
    if (ts.isCallExpression(cur)) {
      const name = hookCalleeName(cur.expression);
      if (name && EFFECT_HOOKS.has(name)) return true;
    }
    cur = cur.parent;
  }
  return false;
}

interface WrapperEndpoint {
  template: string;
  holes: string[];
  method: string;
}

/**
 * Drop everything from the first NON-path interpolation onward, keeping the
 * base endpoint.
 *
 * A path parameter always follows a `/`: `/api/buildings/${id}` →
 * `…/buildings/:id`. A query string built inline — `…/invoices${scope ?
 * "?scope=mine" : ""}` — produces a hole glued straight onto the previous
 * segment (`…/invoices:q`), which is not a path parameter and cannot be filled
 * from params.json. The base path IS the load target: the query is an optional
 * filter, and load-testing `…/invoices` is exactly right. So the template is
 * truncated at that hole and the hole dropped.
 */
function pathOnly(template: string, holes: string[]): { template: string; holes: string[] } {
  const kept: string[] = [];
  let cursor = 0;
  for (const hole of holes) {
    const at = template.indexOf(`:${hole}`, cursor);
    if (at < 0) {
      kept.push(hole);
      continue;
    }
    if (template[at - 1] !== "/") {
      const base = template.slice(0, at).replace(/\/$/, "");
      return { template: base, holes: kept };
    }
    kept.push(hole);
    cursor = at + hole.length + 1;
  }
  return { template, holes: kept };
}

/**
 * The endpoint an api function declares: the first call in its body to a
 * module-local fetch wrapper, with a literal/template path. undefined when the
 * body calls no wrapper, or calls one with a non-literal path (a joined URL, a
 * variable) — which the harvest cannot turn into a pipe honestly.
 */
function wrapperCallIn(fn: FnLike, sf: ts.SourceFile): WrapperEndpoint | undefined {
  const wrappers = fetchWrappersOf(sf);
  if (wrappers.size === 0) return undefined;
  const body = fn.body;
  if (!body) return undefined;

  let found: WrapperEndpoint | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      wrappers.has(n.expression.text)
    ) {
      const urlArg = n.arguments[0];
      const parsed = urlArg ? parseUrlArg(urlArg) : undefined;
      if (parsed) {
        const norm = pathOnly(parsed.template, parsed.holes);
        found = { template: norm.template, holes: norm.holes, method: readMethod(n.arguments[1]) };
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

type FnLike =
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | { body?: ts.Node };

const WRAPPER_CACHE = new WeakMap<ts.SourceFile, Set<string>>();

/**
 * The names of the module-local functions that ARE fetch wrappers: a function
 * whose body performs a `fetch()` whose URL argument references one of the
 * function's own parameters (`apiFetch(path) => fetch(\`${BASE}${path}\`)`).
 *
 * Structural, never by name: the point is to trust `apiFetch` because it wraps
 * fetch, not because of what it is called — an app's client may be `request`,
 * `http`, `call`. A function that takes a string and does something else is not
 * a client, and its literal-string callers are not endpoints.
 */
function fetchWrappersOf(sf: ts.SourceFile): Set<string> {
  const cached = WRAPPER_CACHE.get(sf);
  if (cached) return cached;
  const names = new Set<string>();
  for (const [name, fn] of localFunctions(sf)) {
    if (isFetchWrapper(fn)) names.add(name);
  }
  WRAPPER_CACHE.set(sf, names);
  return names;
}

/** name → function node for every top-level function-ish declaration, exported
 *  or not — the wrapper is almost always a NON-exported module-local. */
function localFunctions(sf: ts.SourceFile): Map<string, FnLike> {
  const out = new Map<string, FnLike>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      out.set(stmt.name.text, stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
          out.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return out;
}

function isFetchWrapper(fn: FnLike): boolean {
  const params = paramNames(fn);
  if (params.size === 0) return false;
  const body = fn.body;
  if (!body) return false;
  let wraps = false;
  const visit = (n: ts.Node): void => {
    if (wraps) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fetch") {
      const urlArg = n.arguments[0];
      if (urlArg && referencesAnyParam(urlArg, params)) wraps = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return wraps;
}

function paramNames(fn: FnLike): Set<string> {
  const names = new Set<string>();
  const params = (fn as ts.FunctionLikeDeclarationBase).parameters;
  if (!params) return names;
  for (const p of params) {
    if (ts.isIdentifier(p.name)) names.add(p.name.text);
  }
  return names;
}

function referencesAnyParam(node: ts.Node, params: Set<string>): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isIdentifier(n) && params.has(n.text)) {
      hit = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}
