import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ComponentTree } from "../types.ts";
import { renderUnitBrowser } from "./templates.ts";

export interface ScaffoldUnitBrowserOptions {
  trees: ComponentTree[];
  outDir: string;
  variants: number;
}

export async function scaffoldUnitBrowser(opts: ScaffoldUnitBrowserOptions): Promise<string[]> {
  const outDir = path.resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });

  const files = renderUnitBrowser(opts);
  const written: string[] = [];
  for (const f of files) {
    const abs = path.join(outDir, f.relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await Bun.write(abs, f.content);
    written.push(abs);
  }

  await mergePackageJson(outDir);
  written.push(path.join(outDir, "package.json"));
  return written;
}

async function mergePackageJson(outDir: string): Promise<void> {
  const pkgPath = path.join(outDir, "package.json");
  type Pkg = {
    name?: string;
    version?: string;
    private?: boolean;
    type?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  let pkg: Pkg = {};
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(await readFile(pkgPath, "utf8")) as Pkg;
    } catch {
      pkg = {};
    }
  } else {
    pkg = {
      name: `${path.basename(outDir).replace(/[^a-zA-Z0-9_-]+/g, "-")}-suite`,
      version: "0.0.0",
      private: true,
      type: "module",
    };
  }

  pkg.scripts = {
    ...(pkg.scripts ?? {}),
    "test:unit": "vitest run",
    "test:perf": "playwright test tests/",
    "test:browser": "playwright test --config browser/playwright.config.ts",
  };

  pkg.dependencies = {
    ...(pkg.dependencies ?? {}),
    react: pkg.dependencies?.react ?? "^18.3.0",
    "react-dom": pkg.dependencies?.["react-dom"] ?? "^18.3.0",
  };

  pkg.devDependencies = {
    ...(pkg.devDependencies ?? {}),
    "@playwright/test": pkg.devDependencies?.["@playwright/test"] ?? "^1.49.0",
    "@types/node": pkg.devDependencies?.["@types/node"] ?? "^22.0.0",
    "@types/react": pkg.devDependencies?.["@types/react"] ?? "^18.3.0",
    "@types/react-dom": pkg.devDependencies?.["@types/react-dom"] ?? "^18.3.0",
    typescript: pkg.devDependencies?.typescript ?? "^5.6.0",
    vitest: pkg.devDependencies?.vitest ?? "^2.1.0",
    "@vitest/ui": pkg.devDependencies?.["@vitest/ui"] ?? "^2.1.0",
    jsdom: pkg.devDependencies?.jsdom ?? "^25.0.0",
    "@testing-library/react": pkg.devDependencies?.["@testing-library/react"] ?? "^16.0.0",
    "@testing-library/user-event":
      pkg.devDependencies?.["@testing-library/user-event"] ?? "^14.5.0",
    "@testing-library/jest-dom": pkg.devDependencies?.["@testing-library/jest-dom"] ?? "^6.5.0",
  };

  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}
