import ts from "typescript";

/**
 * Whether the component reports errors itself, and through what.
 *
 * `app/(auth)/error.tsx` is an error boundary: it exists to catch a render
 * failure and log it, which it does from a mount effect. The generated browser
 * spec then asserted "mounts without console errors" and failed it — the
 * harness marking a component wrong for meeting its contract. Three of the
 * dogfood app's error boundaries failed that way.
 *
 * Two shapes count, and the qualification on the second is what keeps this from
 * becoming a name guess:
 *
 * - `console.error(...)` / `console.warn(...)` — unambiguous.
 * - `x.error(...)` / `x.warn(...)` where `x` is an IMPORTED binding. That is a
 *   module the component pulled in for the purpose (`logger`, `log`, `pino`),
 *   not an arbitrary local whose method happens to share the name — a form
 *   object's `.error()`, say, which reaches no console at all.
 *
 * Returns the call as written, so the spec can cite it instead of asserting
 * something it cannot justify.
 */
export function detectSelfLogging(
  bodyNode: ts.Node,
  importedNames: Set<string>,
): string | undefined {
  let found: string | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const target = n.expression.expression;
      if ((method === "error" || method === "warn") && ts.isIdentifier(target)) {
        if (target.text === "console" || importedNames.has(target.text)) {
          found = `${target.text}.${method}()`;
          return;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(bodyNode);
  return found;
}
