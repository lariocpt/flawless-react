import ts from "typescript";

export interface ParsedComponent {
  sourceFile: ts.SourceFile;
  componentName: string;
  /** The arrow/function expression whose body holds the JSX + hooks. */
  bodyNode: ts.Node;
  /** The `Props` type reference, when discoverable via `React.FC<Props>`. */
  propsTypeRef: ts.TypeReferenceNode | undefined;
  /** Local-name → module specifier, for JSX child resolution. */
  imports: Map<string, string>;
}

export async function parseFile(entry: string): Promise<ParsedComponent> {
  const src = await Bun.file(entry).text();
  const sourceFile = ts.createSourceFile(
    entry,
    src,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );

  const imports = collectImports(sourceFile);
  const found = findComponent(sourceFile);
  if (!found) {
    throw new Error(
      `parseFile: could not locate a React component in ${entry}. ` +
        `Expected either a default export or a \`const Name: React.FC<...> = ...\` declaration.`,
    );
  }

  return { sourceFile, ...found, imports };
}

function collectImports(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) out.set(clause.name.text, spec);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        out.set(el.name.text, spec);
      }
    }
  }
  return out;
}

function findComponent(
  sf: ts.SourceFile,
):
  | { componentName: string; bodyNode: ts.Node; propsTypeRef: ts.TypeReferenceNode | undefined }
  | undefined {
  for (const stmt of sf.statements) {
    const r = tryReactFCDecl(stmt) ?? tryDefaultExportFn(stmt);
    if (r) return r;
  }
  return undefined;
}

/** Matches: `const Foo: React.FC<Props> = (props) => { ... }` */
function tryReactFCDecl(
  stmt: ts.Statement,
):
  | { componentName: string; bodyNode: ts.Node; propsTypeRef: ts.TypeReferenceNode | undefined }
  | undefined {
  if (!ts.isVariableStatement(stmt)) return undefined;
  for (const decl of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name)) continue;
    if (!decl.initializer) continue;
    const typeRef = decl.type && ts.isTypeReferenceNode(decl.type) ? decl.type : undefined;
    const looksLikeFC =
      typeRef &&
      ((ts.isQualifiedName(typeRef.typeName) &&
        ts.isIdentifier(typeRef.typeName.right) &&
        (typeRef.typeName.right.text === "FC" ||
          typeRef.typeName.right.text === "FunctionComponent")) ||
        (ts.isIdentifier(typeRef.typeName) &&
          (typeRef.typeName.text === "FC" || typeRef.typeName.text === "FunctionComponent")));
    if (!looksLikeFC) continue;
    if (!ts.isArrowFunction(decl.initializer) && !ts.isFunctionExpression(decl.initializer))
      continue;
    const propsArg = typeRef?.typeArguments?.[0];
    const propsTypeRef = propsArg && ts.isTypeReferenceNode(propsArg) ? propsArg : undefined;
    return { componentName: decl.name.text, bodyNode: decl.initializer, propsTypeRef };
  }
  return undefined;
}

/** Matches: `export default function Foo(props: Props) { ... }` and the arrow/var-decl form. */
function tryDefaultExportFn(
  stmt: ts.Statement,
):
  | { componentName: string; bodyNode: ts.Node; propsTypeRef: ts.TypeReferenceNode | undefined }
  | undefined {
  if (ts.isFunctionDeclaration(stmt)) {
    const isDefault = stmt.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
    );
    if (!isDefault || !stmt.name) return undefined;
    const propType = stmt.parameters[0]?.type;
    const propsTypeRef = propType && ts.isTypeReferenceNode(propType) ? propType : undefined;
    return { componentName: stmt.name.text, bodyNode: stmt, propsTypeRef };
  }
  return undefined;
}
