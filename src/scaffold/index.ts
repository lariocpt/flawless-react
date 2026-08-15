import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ComponentTree, ScaffoldOptions } from "../types.ts";
import { extractRoutes, loadApiSpec } from "./openapi.ts";
import { renderSuite, toHostRelImport } from "./templates.ts";

export async function scaffold(tree: ComponentTree, opts: ScaffoldOptions): Promise<string[]> {
  const outDir = path.resolve(opts.outDir);
  // Keyed on a suite already being here, not on the directory existing. The
  // directory is not a usable proxy: ensureClientProviderWrapper mkdirs outDir
  // at core.ts:215, before the task loop at :298, so on any --nextjs run outDir
  // exists by the time this is reached and a bare existsSync would refuse every
  // FIRST run. That is why this guard was bypassed with a hardcoded force:true,
  // which cost it the re-run it was actually written to catch.
  const marker = path.join(outDir, "playwright.config.ts");
  if (existsSync(marker) && !opts.force) {
    throw new Error(
      `scaffold: a generated suite already exists at ${outDir}. Pass --force to regenerate (budgets.json and host/main.tsx are kept either way).`,
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
    ...(opts.heaps ? { heaps: opts.heaps } : {}),
    report: opts.report,
    providerImportPath,
    mockRoutes,
    nextjsHost: opts.nextjsHost,
    mswSetup: opts.mswSetup,
  });

  const written: string[] = [];
  for (const f of files) {
    const abs = path.join(outDir, f.relPath);
    // Not gated on --force, unlike the colocated specs: the point of these two
    // is that no flag rebuilds a tuned budget or hand-wired provider. Delete the
    // file to get a fresh one, same as provider.fixtures.ts.
    if (f.writeOnce && existsSync(abs)) continue;
    await mkdir(path.dirname(abs), { recursive: true });
    await Bun.write(abs, f.content);
    if (f.executable) await chmod(abs, 0o755);
    written.push(abs);
  }
  return written;
}

export { renderSuite } from "./templates.ts";
