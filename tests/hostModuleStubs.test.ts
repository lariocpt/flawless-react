import { describe, expect, test } from "bun:test";
import { renderSuite } from "../src/scaffold/templates.ts";
import type { ComponentInfo } from "../src/types.ts";

/**
 * Two ways a module the host cannot run decides what a component looks like.
 * Both were found on the talkformai dogfood, and both made a healthy component
 * red for a reason no error message mentioned.
 */

function component(name: string, imports: ComponentInfo["moduleImports"] = []): ComponentInfo {
  return {
    componentName: name,
    filePath: `/proj/src/${name}.tsx`,
    importSpecifier: `./${name}.tsx`,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    moduleImports: imports,
  };
}

function hostSource(...infos: ComponentInfo[]): string {
  return (
    renderSuite({
      tree: { entry: infos[0] ?? component("Widget"), children: [] } as never,
      extraTrees: infos.slice(1).map((entry) => ({ entry, children: [] })) as never,
      outDir: "/proj/flawless",
      variants: 3,
      report: false,
    }).find((f) => f.relPath === "host/server.ts")?.content ?? ""
  );
}

describe("next/script in the perf host", () => {
  // The real module renders NOTHING into the tree — it injects its tag through
  // Next's client router context, which this host does not have. So a component
  // built only out of <Script> mounted as an empty container and the browser
  // smoke failed on its markup floor with a clean, error-free mount
  // (GoogleAnalytics, PostHogScript: 2 of 9 browser failures).
  test("renders an inert script in place rather than an empty container", () => {
    const host = hostSource();
    expect(host).toContain("flawless-next-script-stub");
    // Rendered in place, so the component's own render is what gets measured...
    expect(host).toContain("React.createElement('script'");
    // ...but type="text/plain" means the browser neither fetches src nor runs
    // inline code: third-party analytics does not belong inside a benchmark.
    expect(host).toContain("type: 'text/plain'");
    expect(host).toContain("'data-flawless-stub': 'next/script'");
    // The .js spelling a bundled library asks for is intercepted too.
    expect(host).toContain("script(\\.js)?");
  });
});

describe("a named host stub outranks the database pattern", () => {
  // The Supabase family is matched in the host by PACKAGE PATTERN
  // (@supabase/*) and by EXACT NAME in the generated stub map, and esbuild asks
  // hooks in registration order — the pattern hook came first, so the
  // signed-out auth-helpers stub sat in the map unused while components got the
  // inert Proxy. NavBar, SignInForm, SignUpForm, DashboardMode and Page all
  // timed out on "useSessionContext is not a function".
  test("the pattern hook defers to a specifier with a generated stub", () => {
    const host = hostSource(
      component("NavBar", [
        {
          specifier: "@supabase/auth-helpers-react",
          names: ["useSessionContext"],
          importedNames: ["useSessionContext"],
          kind: "value",
          isTypeOnly: false,
          hasDefault: false,
          pos: { file: "/proj/src/NavBar.tsx", line: 1, column: 1 },
        },
      ]),
    );
    // The stub is generated for that specifier...
    expect(host).toContain('"@supabase/auth-helpers-react"');
    expect(host).toContain("export const useSessionContext");
    // ...and the pattern hook gives it up rather than answering first.
    expect(host).toMatch(
      /SERVER_STUB_SPECIFIERS\[args\.path\]\s*\?\s*undefined\s*:\s*\{\s*path:\s*args\.path,\s*namespace:\s*"flawless-node-stub"\s*\}/,
    );
  });

  test("a database driver with no named stub is still cut", () => {
    // The deferral is per-specifier, not a blanket yield: pg, kysely and
    // @supabase/supabase-js (the SDK, deliberately never stubbed) would
    // otherwise load a native engine into a browser bundle again.
    const host = hostSource();
    expect(host).toContain("@prisma\\/adapter");
    expect(host).toContain("mongodb|mongoose|pg|kysely|drizzle-orm");
  });
});
