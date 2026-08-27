import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ComponentTree, ExpoContext, TodoCounter } from "../types.ts";
import { renderNativeUnit } from "./nativeTemplates.ts";

export interface ScaffoldNativeOptions {
  trees: ComponentTree[];
  outDir: string;
  expo: ExpoContext;
  force?: boolean;
  todos?: TodoCounter;
}

export interface ScaffoldNativeResult {
  written: string[];
  /** write-once files that already existed and were left alone. */
  kept: string[];
}

export async function scaffoldNativeUnit(
  opts: ScaffoldNativeOptions,
): Promise<ScaffoldNativeResult> {
  const outDir = path.resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const kept: string[] = [];
  for (const f of renderNativeUnit(opts)) {
    const abs = path.join(outDir, f.relPath);
    if (f.skipIfExists && existsSync(abs)) {
      kept.push(abs);
      continue;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await Bun.write(abs, f.content);
    written.push(abs);
  }
  // Jest cannot parse CSS, and app/_layout.tsx imports global.css for NativeWind.
  // Emitted unconditionally: it costs three bytes and its absence kills every
  // route spec at import time with an error that names the stylesheet, not the cause.
  const stub = path.join(outDir, "styleStub.js");
  await Bun.write(stub, "module.exports = {};\n");
  written.push(stub);
  return { written, kept };
}
