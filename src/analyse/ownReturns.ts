import ts from "typescript";

/**
 * The block's own return statements — a nested function's returns are its own.
 *
 * Shared by the render-mode detector (parseFile.ts) and the server-action
 * return extractor (serverActionReturns.ts): both ask "what does THIS function
 * yield", and both would be lied to by a closure's returns. Accessors and
 * constructors are function boundaries too — a getter's return is not the
 * enclosing function's.
 */
export function ownReturns(body: ts.Block): ts.ReturnStatement[] {
  const out: ts.ReturnStatement[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isArrowFunction(n) ||
      ts.isFunctionExpression(n) ||
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isConstructorDeclaration(n)
    ) {
      return;
    }
    if (ts.isReturnStatement(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}
