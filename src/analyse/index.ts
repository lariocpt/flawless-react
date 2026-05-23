import path from "node:path";
import type { AnalyseOptions, ComponentInfo, ComponentTree } from "../types.ts";
import { extractHooks } from "./extractHooks.ts";
import { extractInteractions } from "./extractInteractions.ts";
import { extractProps } from "./extractProps.ts";
import { parseFile } from "./parseFile.ts";
import { walkChildren } from "./walkChildren.ts";

export async function analyse(opts: AnalyseOptions): Promise<ComponentTree> {
  const visited = new Set<string>();
  return analyseOne(path.resolve(opts.entry), 0, opts, visited, opts.entry);
}

async function analyseOne(
  absPath: string,
  depth: number,
  opts: AnalyseOptions,
  visited: Set<string>,
  importSpecifier: string,
): Promise<ComponentTree> {
  visited.add(absPath);
  const parsed = await parseFile(absPath);
  const { propsShape, variants, unresolvedProps } = extractProps(
    parsed.sourceFile,
    parsed.propsTypeRef,
  );
  const hooks = extractHooks(parsed.bodyNode);
  const interactions = extractInteractions(parsed.bodyNode, propsShape, unresolvedProps);

  const info: ComponentInfo = {
    componentName: parsed.componentName,
    filePath: absPath,
    importSpecifier,
    propsShape,
    variants,
    hooks,
    unresolvedProps,
    interactions,
  };

  let children: ComponentTree[] = [];
  if (opts.includeChildren && depth < opts.depth) {
    const refs = walkChildren(parsed.bodyNode, parsed.imports, absPath);
    children = [];
    for (const ref of refs) {
      if (visited.has(ref.absPath)) continue;
      try {
        const childTree = await analyseOne(ref.absPath, depth + 1, opts, visited, ref.absPath);
        children.push(childTree);
      } catch (err) {
        // Skip children we can't parse (no React.FC inside, etc.); record nothing —
        // the user can re-run with --depth tuned, or edit the generated suite.
        if (!(err instanceof Error && err.message.includes("could not locate a React component"))) {
          throw err;
        }
      }
    }
  }

  return { entry: info, children };
}

export { extractHooks } from "./extractHooks.ts";
export { extractInteractions } from "./extractInteractions.ts";
export { extractProps } from "./extractProps.ts";
export { parseFile } from "./parseFile.ts";
export { walkChildren } from "./walkChildren.ts";
