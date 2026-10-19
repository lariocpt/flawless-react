import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findUnresolvableImports, packageNameOf } from "../src/analyse/bootability.ts";
import type { ComponentInfo, ComponentTree, ModuleImportInfo } from "../src/types.ts";

function imported(specifier: string, isTypeOnly = false): ModuleImportInfo {
  return {
    specifier,
    names: ["X"],
    kind: "value",
    isTypeOnly,
    hasDefault: false,
    pos: { file: "/proj/src/Card.tsx", line: 1, column: 1 },
  };
}

function info(componentName: string, filePath: string, specifiers: ModuleImportInfo[]) {
  return {
    componentName,
    filePath,
    importSpecifier: filePath,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    moduleImports: specifiers,
  } satisfies ComponentInfo;
}

function tree(componentName: string, filePath: string, imports: string[]): ComponentTree {
  return {
    entry: info(
      componentName,
      filePath,
      imports.map((s) => imported(s)),
    ),
    children: [],
  };
}

describe("which package is a specifier asking for", () => {
  test("bare names, subpaths and scopes — and everything that is not a package", () => {
    expect(packageNameOf("framer-motion")).toBe("framer-motion");
    expect(packageNameOf("framer-motion/dom")).toBe("framer-motion");
    expect(packageNameOf("lucide-react/dist/x.js")).toBe("lucide-react");
    expect(packageNameOf("@acme/thing/sub/deep.js")).toBe("@acme/thing");
    expect(packageNameOf("@acme/thing")).toBe("@acme/thing");
    // Not packages: project files, runtime schemes, vite's asset loaders (with
    // and without a query), and a bare scope with no package under it.
    for (const spec of [
      "./Card",
      "../ui/button",
      "/abs/path",
      "node:fs",
      "bun:test",
      "virtual:routes",
      "./theme.css",
      "@/components/lib/utils",
      "@/Card",
      "@acme/core/styles.css?inline",
      "./logo.svg",
      "@acme",
      "",
    ]) {
      expect(packageNameOf(spec)).toBeUndefined();
    }
  });
});

describe("what will not resolve when the suite collects", () => {
  /** <base>/node_modules holds `real` and `@acme/thing`; nothing else exists. */
  async function fixture(): Promise<string> {
    const base = await mkdtemp(path.join(tmpdir(), "flawless-boot-"));
    for (const pkg of ["real", "@acme/thing"]) {
      const dir = path.join(base, "node_modules", pkg);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: pkg, version: "1.0.0" }),
      );
    }
    mkdirSync(path.join(base, "src", "components"), { recursive: true });
    return base;
  }

  test("an installed package is silent; a missing one is named, counted, exemplared", async () => {
    const base = await fixture();
    const from = path.join(base, "src", "components");
    const card = tree("Card", path.join(from, "Card.tsx"), ["real", "missing"]);
    // A child of the tree counts toward the same module, and the same component
    // twice (entry + a duplicate path) must not double-count.
    card.children.push(tree("Banner", path.join(from, "Banner.tsx"), ["missing"]));
    const out = findUnresolvableImports([card, card], [from, base]);
    expect(out).toEqual([
      { specifier: "missing", pkg: "missing", count: 2, examples: ["Banner", "Card"] },
    ]);
  });

  test("scoped packages are read one level deep, in both directions", async () => {
    const base = await fixture();
    const from = path.join(base, "src", "components");
    const out = findUnresolvableImports(
      [tree("Card", path.join(from, "Card.tsx"), ["@acme/thing", "@acme/thing/sub", "@acme/nope"])],
      [from, base],
    );
    expect(out.map((u) => u.specifier)).toEqual(["@acme/nope"]);
    expect(out[0]?.pkg).toBe("@acme/nope");
  });

  test("what the suite already answers for is never reported", async () => {
    const base = await fixture();
    const from = path.join(base, "src", "components");
    const specs = [
      "next/navigation",
      "next/headers",
      "server-only",
      "client-only",
      // Provider shims: canonical name and alias module.
      "react-router-dom",
      "react-router",
      "@tanstack/react-query",
      "react-hook-form",
      "react-intl",
      // Auth stubs.
      "@clerk/nextjs",
      "next-auth/react",
      "@supabase/ssr",
      "@supabase/auth-helpers-react",
    ];
    expect(
      findUnresolvableImports([tree("Card", path.join(from, "Card.tsx"), specs)], [from, base]),
    ).toEqual([]);
    // `@supabase/supabase-js` is NOT one of them on purpose — it is the SDK,
    // not the provider — so a component that imports it without having it
    // installed really does fail, and the report says so.
    const sdk = findUnresolvableImports(
      [tree("Card", path.join(from, "Card.tsx"), ["@supabase/supabase-js"])],
      [from, base],
    );
    expect(sdk.map((u) => u.specifier)).toEqual(["@supabase/supabase-js"]);
  });

  test("a type-only import is erased before vite sees it", async () => {
    const base = await fixture();
    const from = path.join(base, "src", "components");
    const one: ComponentTree = {
      entry: info("Card", path.join(from, "Card.tsx"), [
        imported("gone-as-a-type", true),
        imported("also-gone"),
      ]),
      children: [],
    };
    const out = findUnresolvableImports([one], [from, base]);
    expect(out.map((u) => u.specifier)).toEqual(["also-gone"]);
  });

  test("resolution starts from the importing file, so a nested install counts", async () => {
    const base = await fixture();
    // An app whose package installs its own deps (monorepo package, or a
    // registry/ sub-project): visible from the IMPORTER, not from the root.
    const nested = path.join(base, "packages", "ui");
    mkdirSync(path.join(nested, "node_modules", "local-only"), { recursive: true });
    writeFileSync(
      path.join(nested, "node_modules", "local-only", "package.json"),
      JSON.stringify({ name: "local-only", version: "1.0.0" }),
    );
    const out = findUnresolvableImports(
      [tree("Card", path.join(nested, "src", "Card.tsx"), ["local-only", "real"])],
      [base],
    );
    expect(out).toEqual([]);
    // Same import from a file the nested install cannot see → reported.
    const far = findUnresolvableImports(
      [tree("Other", path.join(base, "src", "Other.tsx"), ["local-only"])],
      [base],
    );
    expect(far.map((u) => u.specifier)).toEqual(["local-only"]);
  });

  test("an import the analyser resolved project-locally is not a missing package", async () => {
    const base = await fixture();
    const from = path.join(base, "src", "components");
    const aliased = imported("@/components/lib/utils");
    aliased.resolvedPath = path.join(base, "src", "lib", "utils.ts");
    const one: ComponentTree = {
      entry: info("Card", path.join(from, "Card.tsx"), [aliased, imported("also-gone")]),
      children: [],
    };
    expect(findUnresolvableImports([one], [from, base])).toEqual([
      { specifier: "also-gone", pkg: "also-gone", count: 1, examples: ["Card"] },
    ]);
  });

  test("a checkout with no node_modules anywhere is not judged at all", async () => {
    // Yarn PnP, or a clone nobody installed: every import would look missing,
    // and saying so would be a confident lie. Only meaningful when the temp
    // root itself carries no install, so check that before claiming it.
    if (existsSync(path.join(tmpdir(), "node_modules"))) return;
    const base = await mkdtemp(path.join(tmpdir(), "flawless-nonm-"));
    const out = findUnresolvableImports(
      [tree("Card", path.join(base, "Card.tsx"), ["framer-motion", "react"])],
      [base],
    );
    expect(out).toEqual([]);
  });
});
