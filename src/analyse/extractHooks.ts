import ts from "typescript";

const HOOK_RE = /^use[A-Z]/;

export function extractHooks(bodyNode: ts.Node): string[] {
  const found = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const fn = n.expression;
      if (ts.isIdentifier(fn) && HOOK_RE.test(fn.text)) {
        found.add(fn.text);
      } else if (
        ts.isPropertyAccessExpression(fn) &&
        ts.isIdentifier(fn.name) &&
        HOOK_RE.test(fn.name.text)
      ) {
        found.add(fn.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);
  return [...found].sort();
}
