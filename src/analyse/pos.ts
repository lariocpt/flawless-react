import type ts from "typescript";
import type { SourcePosition } from "../types.ts";

/** 1-based line/column of a node's start. `sf.fileName` is the absolute path. */
export function posOf(node: ts.Node, sf: ts.SourceFile): SourcePosition {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { file: sf.fileName, line: line + 1, column: character + 1 };
}
