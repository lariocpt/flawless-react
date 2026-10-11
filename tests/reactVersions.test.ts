import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { renderSuite } from "../src/scaffold/templates.ts";
import { repairRtlPin, suitePackageJson } from "../src/scaffold-tests/index.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import type { ComponentInfo, ComponentTree } from "../src/types.ts";

/**
 * React 17 / 18 / 19 support.
 *
 * React 17 predates react-dom/client, createRoot, the streaming server
 * renderer and promise-as-child, and @testing-library/react 13+ dropped it
 * from its peer ranges (14.3.1 hard-requires the react-dom 18 client entry
 * at load, so even declaring the peer is not enough). The emitters that
 * touch those APIs branch on the
 * app's detected React major — this file pins both sides of each branch,
 * because a default that only ever ran on 18/19 proves nothing about the
 * legacy path, and an unexercised streaming path silently regresses 18/19.
 */

function comp(name: string, extra: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    componentName: name,
    filePath: `${name}.tsx`,
    importSpecifier: `./${name}.tsx`,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    ...extra,
  };
}

function tree(entry: ComponentInfo): ComponentTree {
  return { entry, children: [] };
}

/** <tmp>/app declaring the given react/react-dom, plus a flawless/ dir. */
async function appWith(react: string): Promise<string> {
  const base = await mkdtemp(path.join(tmpdir(), "flawless-rmajor-"));
  const app = path.join(base, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(
    path.join(app, "package.json"),
    JSON.stringify({ name: "app", dependencies: { react, "react-dom": react } }),
  );
  const outDir = path.join(app, "flawless");
  mkdirSync(outDir);
  return outDir;
}

function parseErrors(file: string, content: string): string[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.ESNext, true, kind);
  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
  return (diagnostics ?? []).map(
    (d) => `${file}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
  );
}

describe("suite manifest per React major", () => {
  test("React 17 app: RTL 12 (the last major whose peers carry <18)", async () => {
    const outDir = await appWith("17.0.2");
    const pkg = JSON.parse(suitePackageJson(outDir, false));
    expect(pkg.dependencies.react).toBe("17.0.2");
    expect(pkg.dependencies["react-dom"]).toBe("17.0.2");
    expect(pkg.devDependencies["@testing-library/react"]).toBe("^12.1.5");
    // user-event 14's dom peer is only transitively reachable from RTL 12;
    // the manifest has to name it for pnpm to link it.
    expect(pkg.devDependencies["@testing-library/dom"]).toBe("^8.20.1");
    expect(pkg.devDependencies["@types/react"]).toBe("^17.0.0");
  });

  test("React 18 and 19 apps: RTL 16, pins follow the app", async () => {
    for (const version of ["18.3.1", "19.2.8"]) {
      const outDir = await appWith(version);
      const pkg = JSON.parse(suitePackageJson(outDir, false));
      expect(pkg.dependencies.react).toBe(version);
      expect(pkg.devDependencies["@testing-library/react"]).toBe("^16.0.0");
      expect(pkg.devDependencies["@testing-library/dom"]).toBeUndefined();
      expect(pkg.devDependencies["@types/react"]).toBe(`^${version.split(".")[0]}.0.0`);
    }
  });

  test("no detectable app React keeps the old defaults (RTL ^16)", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "flawless-rmajor-none-"));
    const pkg = JSON.parse(suitePackageJson(path.join(base, "flawless"), false));
    expect(pkg.dependencies.react).toBe("^18.3.0");
    expect(pkg.devDependencies["@testing-library/react"]).toBe("^16.0.0");
  });

  test("merge survivors: a stale RTL 13+ range on a React-17 app is repaired", async () => {
    // The manifest merge lets an existing file win — including this tool's
    // own pre-fix ^14.0.0, which cannot load under React 17 at all.
    const manifest = JSON.stringify({
      devDependencies: { "@testing-library/react": "^14.0.0", vitest: "^2.1.0" },
    });
    const fixed = JSON.parse(repairRtlPin(manifest, { react: "17.0.2", reactDom: "17.0.2" }));
    expect(fixed.devDependencies["@testing-library/react"]).toBe("^12.1.5");
    expect(fixed.devDependencies["@testing-library/dom"]).toBe("^8.20.1");
    expect(fixed.devDependencies.vitest).toBe("^2.1.0");
  });

  test("merge survivors: workable ranges and other majors are left alone", async () => {
    const pin17 = { react: "17.0.2", reactDom: "17.0.2" };
    const pin18 = { react: "18.3.1", reactDom: "18.3.1" };
    // RTL 12 on 17 is the target; hand-pinned odd formats the tool never
    // emitted (workspace protocol, bare latest) are the user's business.
    for (const [range, pin] of [
      ["^12.1.5", pin17],
      ["catalog:", pin17],
      ["latest", pin17],
      ["^16.0.0", pin18],
    ] as const) {
      const manifest = JSON.stringify({ devDependencies: { "@testing-library/react": range } });
      expect(repairRtlPin(manifest, pin)).toBe(manifest);
    }
    // Undefined pin (no detectable app react): nothing to branch on.
    const manifest = JSON.stringify({ devDependencies: { "@testing-library/react": "^14.0.0" } });
    expect(repairRtlPin(manifest, undefined)).toBe(manifest);
  });
});

describe("perf host main.tsx per React major", () => {
  async function hostMain(outDir: string): Promise<string> {
    const files = renderSuite({ tree: tree(comp("Card")), outDir, variants: 1, report: true });
    const main = files.find((f) => f.relPath === "host/main.tsx");
    if (!main) throw new Error("no host/main.tsx emitted");
    return main.content;
  }

  test("React 17: legacy renderer behind the same Root interface", async () => {
    const main = await hostMain(await appWith("17.0.2"));
    expect(main).toContain('import * as ReactDOM from "react-dom"');
    expect(main).toContain("ReactDOM.unmountComponentAtNode(el)");
    // No react-dom/client to import — that specifier does not resolve on 17.
    expect(main).not.toContain("react-dom/client");
    expect(main).not.toContain("createRoot");
    expect(parseErrors("host/main.tsx", main)).toEqual([]);
  });

  test("React 18/19 and unknown: the createRoot path unchanged", async () => {
    for (const version of ["18.3.1", "19.2.8", undefined]) {
      const outDir = version
        ? await appWith(version)
        : await mkdtemp(path.join(tmpdir(), "flawless-rmajor-x-"));
      const main = await hostMain(outDir);
      expect(main).toContain('import { createRoot, type Root } from "react-dom/client"');
      expect(main).not.toContain("unmountComponentAtNode");
    }
  });

  test("scan() survives a throw on every major", async () => {
    const main = await hostMain(await appWith("19.2.8"));
    expect(main).toContain("react-scan disabled");
  });
});

describe("document-root spec per React major", () => {
  async function docRootSpec(outDir: string): Promise<string> {
    const files = renderUnitBrowser({
      trees: [
        tree(
          comp("RootLayout", {
            exportKind: "default",
            renderMode: "document-root",
            renderNotes: ["renders <html> at its root"],
          }),
        ),
      ],
      outDir,
      variants: 1,
    });
    const spec = files.find((f) => f.relPath === "unit/RootLayout.test.tsx");
    if (!spec) throw new Error("no spec emitted");
    return spec.content;
  }

  test("React 17: static markup, no promise-prop wrapping", async () => {
    const spec = await docRootSpec(await appWith("17.0.2"));
    expect(spec).toContain('import { renderToStaticMarkup } from "react-dom/server"');
    // renderToReadableStream is 18+; a named import of it would kill the
    // spec at collection on 17. Promise children do not exist on 17 either.
    expect(spec).not.toContain("renderToReadableStream");
    expect(spec).not.toContain("PROMISE_PROPS");
    expect(spec).toContain("expect(html).toMatch(/^<html/)");
    expect(parseErrors("RootLayout.test.tsx", spec)).toEqual([]);
  });

  test("React 18/19: the streaming renderer, promise props awaited", async () => {
    const spec = await docRootSpec(await appWith("19.2.8"));
    expect(spec).toContain('import { renderToReadableStream } from "react-dom/server"');
    expect(spec).toContain("PROMISE_PROPS");
    expect(spec).not.toContain("renderToStaticMarkup(ui");
  });
});
