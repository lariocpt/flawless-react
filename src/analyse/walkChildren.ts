import ts from "typescript";
import type { SourcePosition } from "../types.ts";
import type { ImportBinding } from "./parseFile.ts";
import { posOf } from "./pos.ts";
import type { ModuleResolver } from "./resolveModule.ts";

export interface ChildRef {
  /** Full tag as written in JSX: "Card", "UI.Badge". */
  localName: string;
  /** Absolute path to the module holding the component. */
  absPath: string;
  /** Preferred component name inside the target file (named import / member tag). */
  exportedName?: string;
  /** First JSX usage site. */
  pos: SourcePosition;
}

/**
 * Walk JSX in `bodyNode`, collect referenced child components that resolve to a
 * project-local module — via relative import, tsconfig path alias, or a
 * same-file component declaration. Bare package imports are skipped.
 */
export function walkChildren(
  bodyNode: ts.Node,
  imports: Map<string, ImportBinding>,
  entryFile: string,
  sourceFile: ts.SourceFile,
  resolver: ModuleResolver,
  localComponents: Set<string>,
  selfName: string,
): ChildRef[] {
  const seen = new Set<string>();
  const out: ChildRef[] = [];

  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName;
      let rootName: string | undefined;
      let fullName: string | undefined;
      let memberName: string | undefined;

      if (ts.isIdentifier(tag)) {
        rootName = tag.text;
        fullName = tag.text;
      } else if (ts.isPropertyAccessExpression(tag)) {
        let root: ts.Expression = tag.expression;
        const segments: string[] = [tag.name.text];
        while (ts.isPropertyAccessExpression(root)) {
          segments.unshift(root.name.text);
          root = root.expression;
        }
        if (ts.isIdentifier(root)) {
          rootName = root.text;
          fullName = `${root.text}.${segments.join(".")}`;
          memberName = segments[segments.length - 1];
        }
      }

      if (rootName && fullName && /^[A-Z]/.test(rootName) && !seen.has(fullName)) {
        const binding = imports.get(rootName);
        if (binding && !binding.isTypeOnly) {
          const abs = resolver.resolve(binding.specifier, entryFile);
          if (abs) {
            seen.add(fullName);
            out.push({
              localName: fullName,
              absPath: abs,
              exportedName: resolveExportedName(binding, rootName, memberName),
              pos: posOf(n, sourceFile),
            });
          }
        } else if (!binding && localComponents.has(rootName) && rootName !== selfName) {
          // Same-file secondary component.
          seen.add(fullName);
          out.push({
            localName: fullName,
            absPath: entryFile,
            exportedName: rootName,
            pos: posOf(n, sourceFile),
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(bodyNode, visit);
  return out;
}

function resolveExportedName(
  binding: ImportBinding,
  rootName: string,
  memberName: string | undefined,
): string | undefined {
  if (binding.kind === "namespace") return memberName;
  if (binding.kind === "named") return binding.importedName ?? rootName;
  return undefined; // default import — primary component of the target file
}
