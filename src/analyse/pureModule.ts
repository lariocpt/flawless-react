import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * Is this LOCAL module a pure calculation — same inputs, same output, no
 * world it can touch?
 *
 * The spec's mock loop replaces whole modules a server component reads data
 * from, and a formatter like `splitCode` gets swept up with them: from one
 * imported call site it looks exactly like a query. The pure-binding
 * exemption rescued only names it had heard of (`cn`), so when the mock loop
 * widened to a render tree's data modules, `drop-format` was mocked and
 * `splitCode` came back as `{}` — `segments.map is not a function`.
 *
 * So ask the module itself. Pure here means: no async, no await, no yield;
 * nothing imported except types (so it reaches no database through a helper
 * of its own); no top-level call (nothing runs, or fetches, at import). A
 * module that passes is not mocked at all — its real code renders.
 */
export function isPureLocalModule(absPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return false;
  }
  if (/^\s*['"]use server['"]/.test(text)) return false;
  const kind = absPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true, kind);
  } catch {
    return false;
  }

  let impure = false;
  const walk = (n: ts.Node, fnDepth: number): void => {
    if (impure) return;
    if (ts.isAwaitExpression(n) || ts.isYieldExpression(n)) {
      impure = true;
      return;
    }
    if (fnDepth === 0 && ts.isCallExpression(n)) {
      impure = true; // something RUNS at import
      return;
    }
    const isFn =
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n);
    if (isFn) {
      if ((n.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        impure = true;
        return;
      }
      fnDepth += 1;
    }
    ts.forEachChild(n, (c) => walk(c, fnDepth));
  };
  walk(sf, 0);
  if (impure) return false;

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.isTypeOnly));
      if (!typeOnly) return false; // imports something LIVE
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      return false; // `export { x } from "./live"`
    } else if (ts.isExpressionStatement(st) || ts.isIfStatement(st) || ts.isForStatement(st)) {
      return false; // a side effect at import time
    }
  }
  return true;
}
