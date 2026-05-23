import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ComponentTree, ScaffoldOptions } from "../types.ts";
import { extractRoutes, loadApiSpec } from "./openapi.ts";
import { renderSuite, toHostRelImport } from "./templates.ts";

export async function scaffold(tree: ComponentTree, opts: ScaffoldOptions): Promise<string[]> {
  const outDir = path.resolve(opts.outDir);
  if (existsSync(outDir) && !opts.force) {
    throw new Error(
      `scaffold: ${outDir} already exists. Pass --force to overwrite (existing files will be replaced).`,
    );
  }
  await mkdir(outDir, { recursive: true });

  const providerImportPath = opts.provider ? toHostRelImport(outDir, opts.provider) : undefined;
  const mockRoutes = opts.apiSpec ? extractRoutes(await loadApiSpec(opts.apiSpec)) : undefined;

  const files = renderSuite({
    tree,
    extraTrees: opts.extraTrees,
    suiteName: opts.suiteName,
    outDir,
    variants: opts.variants,
    report: opts.report,
    providerImportPath,
    mockRoutes,
  });

  const written: string[] = [];
  for (const f of files) {
    const abs = path.join(outDir, f.relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await Bun.write(abs, f.content);
    if (f.executable) await chmod(abs, 0o755);
    written.push(abs);
  }
  return written;
}

export { renderSuite } from "./templates.ts";
