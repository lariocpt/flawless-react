import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeServerStream, specifierExportsServerStream } from "../src/reactDomServerStream.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import type { ComponentInfo, ComponentTree } from "../src/types.ts";

/**
 * Dogfood defect #3 (chunk 3): the document-root specs rendered through
 * `renderToReadableStream`, but bare `react-dom/server` is aliased by the
 * emitted vitest config to the FILE `react-dom/server.js` →
 * `require("./server.node")` — the node build, which on react-dom 19.1.0
 * (measured) exports only
 * `renderToPipeableStream renderToStaticMarkup renderToString version`.
 * `react-dom/server.browser` carries `renderToReadableStream` on 19.1 AND
 * 19.2 (measured: 19.2's node build gained it too, the browser build kept it),
 * so the specifier — not the alias — is the bug.
 *
 * The specs here simulate the react-dom export surfaces with stub packages
 * rather than waiting for a specific published version: the guard must not
 * encode 19.1's export table as eternal truth, so every assertion re-derives
 * the table from the bytes on disk via probeServerStream.
 */

const dirs: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-rdstream-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function comp(name: string, filePath: string, extra: Partial<ComponentInfo> = {}): ComponentInfo {
  return {
    componentName: name,
    filePath,
    importSpecifier: `./${name}.tsx`,
    propsShape: {},
    variants: [],
    hooks: [],
    unresolvedProps: [],
    exportKind: "default",
    ...extra,
  };
}

function tree(entry: ComponentInfo): ComponentTree {
  return { entry, children: [] };
}

/** Render the document-root spec, optionally pinned to a stub node_modules. */
function docRootSpec(reactPinDir?: string): string {
  const root = tmpRoot();
  const src = path.join(root, "src", "app");
  mkdirSync(src, { recursive: true });
  const files = renderUnitBrowser({
    trees: [
      tree(
        comp("RootLayout", path.join(src, "layout.tsx"), {
          renderMode: "document-root",
          isAsync: true,
          acceptsChildren: true,
        }),
      ),
    ],
    outDir: path.join(root, "flawless"),
    variants: 1,
    browserSpecs: false,
    reactPinDir,
  });
  const spec = files.find((f) => f.relPath.includes("RootLayout"));
  if (!spec) throw new Error(`no RootLayout spec among ${files.map((f) => f.relPath).join(", ")}`);
  return spec.content;
}

/**
 * A react-dom package whose entry files export exactly the named surface,
 * shaped like the real dispatcher layout (`server.js` → `server.node.js` →
 * `cjs/react-dom-server.node.*`), so probeServerStream's require-following is
 * exercised on the same file topology the real package uses.
 */
function stubReactDom(surface: {
  version: string;
  browserHasStream: boolean;
  nodeHasStream: boolean;
}): { nmDir: string; reactDomDir: string } {
  const nmDir = tmpRoot();
  const rd = path.join(nmDir, "react-dom");
  mkdirSync(path.join(rd, "cjs"), { recursive: true });
  writeFileSync(
    path.join(rd, "package.json"),
    JSON.stringify({ name: "react-dom", version: surface.version }),
  );
  writeFileSync(path.join(rd, "server.js"), 'module.exports = require("./server.node");\n');
  writeFileSync(
    path.join(rd, "server.node.js"),
    'module.exports = require("./cjs/react-dom-server.node.development.js");\n',
  );
  writeFileSync(
    path.join(rd, "server.browser.js"),
    'module.exports = require("./cjs/react-dom-server.browser.development.js");\n',
  );
  const body = (stream: boolean): string =>
    [
      "exports.renderToStaticMarkup = renderToStaticMarkup;",
      "exports.renderToString = renderToString;",
      "exports.version = version;",
      stream ? "exports.renderToReadableStream = renderToReadableStream;" : "",
    ]
      .filter(Boolean)
      .join("\n");
  writeFileSync(
    path.join(rd, "cjs", "react-dom-server.node.development.js"),
    `${body(surface.nodeHasStream)}\nexports.renderToPipeableStream = renderToPipeableStream;\n`,
  );
  writeFileSync(
    path.join(rd, "cjs", "react-dom-server.browser.development.js"),
    body(surface.browserHasStream),
  );
  return { nmDir, reactDomDir: rd };
}

// The 19.1.0 surface measured on disk: node build WITHOUT the streaming
// renderer, browser build with it.
const RD_191 = () =>
  stubReactDom({ version: "19.1.0", browserHasStream: true, nodeHasStream: false });
// The 19.2.0 surface measured on disk: BOTH builds carry it (plus resume,
// resumeToPipeableStream on the node side — irrelevant here).
const RD_192 = () =>
  stubReactDom({ version: "19.2.0", browserHasStream: true, nodeHasStream: true });
// A react-dom that satisfies neither candidate — the capability gap.
const RD_GAP = () =>
  stubReactDom({ version: "19.1.0", browserHasStream: false, nodeHasStream: false });

/**
 * The guard (the emitPaths pattern): grep the RENDERED spec for every
 * specifier it imports `renderToReadableStream` from and fail if any of them
 * is not a specifier the pinned react-dom's resolved build actually exports
 * it from. Version-aware by construction — the export table is re-derived
 * from the installed bytes (specifierExportsServerStream), never from a
 * hardcoded table — so it catches a template reverted to bare
 * "react-dom/server" against a 19.1 surface while staying green on a 19.2
 * surface where that specifier would in fact resolve.
 */
function assertStreamSpecifierResolves(content: string, reactDomDir?: string): void {
  const imported: string[] = [];
  for (const m of content.matchAll(/import\s+\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    const names = m[1] ?? "";
    const specifier = m[2];
    if (specifier && names.includes("renderToReadableStream")) imported.push(specifier);
  }
  if (imported.length === 0) {
    // No streaming import is only legitimate for the named-skip path.
    if (!content.includes("test.skip(")) {
      throw new Error("spec neither imports renderToReadableStream nor skips it by name");
    }
    return;
  }
  const probe = probeServerStream(reactDomDir);
  for (const specifier of imported) {
    if (!specifierExportsServerStream(reactDomDir, specifier)) {
      throw new Error(
        `rendered spec imports renderToReadableStream from "${specifier}", but the pinned ` +
          `react-dom${probe.version ? `@${probe.version}` : ""} exports it from ` +
          `"${probe.specifier ?? "neither react-dom/server.browser nor react-dom/server"}"`,
      );
    }
  }
}

describe("document-root streaming specifier (defect #3)", () => {
  test("with no installed react-dom to measure, the spec streams through react-dom/server.browser", () => {
    const content = docRootSpec();
    expect(content).toContain('import { renderToReadableStream } from "react-dom/server.browser"');
    expect(content).not.toContain('from "react-dom/server";');
    // The anti-"simplify" comment the next reader needs.
    expect(content).toContain("do not simplify this back");
    assertStreamSpecifierResolves(content);
  });

  test("guard: against a 19.1 surface (node build lacks the export) the specifier is server.browser", () => {
    const stub = RD_191();
    const content = docRootSpec(stub.nmDir);
    expect(content).toContain('from "react-dom/server.browser"');
    expect(content).not.toContain('from "react-dom/server";');
    assertStreamSpecifierResolves(content, stub.reactDomDir);
  });

  test("guard: against a 19.2 surface (both builds carry the export) the specifier still resolves", () => {
    const stub = RD_192();
    const content = docRootSpec(stub.nmDir);
    expect(content).toContain('from "react-dom/server.browser"');
    assertStreamSpecifierResolves(content, stub.reactDomDir);
  });

  test("the capability gap is a named skip, never an is-not-a-function red", () => {
    const stub = RD_GAP();
    const content = docRootSpec(stub.nmDir);
    expect(content).not.toContain("import { renderToReadableStream }");
    expect(content).toContain("test.skip(");
    // The skip names the export gap AND the version seen — no silent skip.
    expect(content).toContain("react-dom@19.1.0 exports no renderToReadableStream");
    assertStreamSpecifierResolves(content, stub.reactDomDir);
  });

  test("the guard reddens on the old template shape against a 19.1 surface", () => {
    // The regression witness: if the template is ever changed back to bare
    // "react-dom/server", this is what goes red — before any suite runs.
    const stub = RD_191();
    const reverted = 'import { renderToReadableStream } from "react-dom/server";\ntest();';
    expect(() => assertStreamSpecifierResolves(reverted, stub.reactDomDir)).toThrow(
      /exports it from "react-dom\/server\.browser"/,
    );
    // …and stays green on 19.2, where that specifier really does export it:
    // the guard measures, it does not encode 19.1's table as eternal truth.
    const modern = RD_192();
    expect(() => assertStreamSpecifierResolves(reverted, modern.reactDomDir)).not.toThrow();
  });

  test("probeServerStream prefers server.browser and reports the gap version", () => {
    expect(probeServerStream(undefined).specifier).toBe("react-dom/server.browser");
    expect(probeServerStream(RD_191().reactDomDir).specifier).toBe("react-dom/server.browser");
    expect(probeServerStream(RD_192().reactDomDir).specifier).toBe("react-dom/server.browser");
    const gap = RD_GAP();
    const probe = probeServerStream(gap.reactDomDir);
    expect(probe.specifier).toBeUndefined();
    expect(probe.version).toBe("19.1.0");
  });
});
