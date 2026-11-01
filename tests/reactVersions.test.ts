import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  appReactPin,
  detectAppReact,
  mergePackageJson,
  repairReactPin,
} from "../src/packageJson.ts";
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

describe("appReactPin: the pin IS the copy the config anchors its react aliases on", () => {
  // code-forge-io/react-router-devtools, the app #97 was filed against: no
  // react at the workspace root, so the pin walk found nothing and answered
  // the ^18.3.0 default, while the copy the SOURCES resolve — what the
  // emitted aliases point at — is a linked React 19.2.7 in the sibling `docs`
  // package. The pin walked UP and answered 18; the alias walked DOWN and
  // answered 19. React 18's react-dom/test-utils then read React 19's renamed
  // internals: "Cannot read properties of undefined (reading
  // 'ReactCurrentOwner')", 180 spec files collecting zero tests.
  async function dualWorkspace(withReactDom = true) {
    const base = await mkdtemp(path.join(tmpdir(), "flawless-dual-"));
    writeFileSync(path.join(base, "package.json"), JSON.stringify({ name: "root-workspace" }));
    const anchor = path.join(base, "docs", "node_modules");
    const installed: Array<readonly [string, string]> = [["react", "19.2.7"]];
    if (withReactDom) installed.push(["react-dom", "19.2.7"]);
    for (const [name, version] of installed) {
      mkdirSync(path.join(anchor, name), { recursive: true });
      writeFileSync(path.join(anchor, name, "package.json"), JSON.stringify({ name, version }));
    }
    const suiteDir = path.join(base, ".flawless");
    mkdirSync(suiteDir);
    return { base, suiteDir, anchor };
  }

  test("the anchor copy answers when the walk finds nothing", async () => {
    const { suiteDir, anchor } = await dualWorkspace();
    expect(appReactPin(suiteDir, anchor)).toEqual({ react: "19.2.7", reactDom: "19.2.7" });
    // Without the anchor the old derivation still answers "no app react" —
    // callers that have no anchor change nothing.
    expect(appReactPin(suiteDir)).toBeUndefined();
  });

  test("so the manifest written from it carries the harness that matches", async () => {
    const { suiteDir, anchor } = await dualWorkspace();
    const pkg = JSON.parse(suitePackageJson(suiteDir, false, false, false, anchor));
    expect(pkg.dependencies.react).toBe("19.2.7");
    expect(pkg.dependencies["react-dom"]).toBe("19.2.7");
    // @types follow the runtime they describe, and the harness follows the
    // major: an RTL 14/15 against a React 19 react is the other half of the
    // split this app was paid in.
    expect(pkg.devDependencies["@types/react"]).toBe("^19.0.0");
    expect(pkg.devDependencies["@testing-library/react"]).toBe("^16.0.0");
    // The same call with no anchor keeps the pre-fix answer, so the apps that
    // were never in this situation do not move.
    expect(JSON.parse(suitePackageJson(suiteDir, false)).dependencies.react).toBe("^18.3.0");
  });

  test("and an existing suite manifest is repaired to it through the real merge", async () => {
    // What writeSuitePackageJson does: the merge lets the existing ^18.3.0
    // win, and the repair is what notices it disagrees with the copy the
    // aliases point at.
    const { suiteDir, anchor } = await dualWorkspace();
    const existing = JSON.stringify({
      dependencies: { react: "^18.3.0", "react-dom": "^18.3.0" },
      scripts: { "test:something-of-mine": "echo mine" },
    });
    const pin = appReactPin(suiteDir, anchor);
    const merged = JSON.parse(
      repairReactPin(
        mergePackageJson(existing, suitePackageJson(suiteDir, false, false, false, anchor)),
        pin,
      ),
    );
    expect(merged.dependencies.react).toBe("19.2.7");
    expect(merged.dependencies["react-dom"]).toBe("19.2.7");
    expect(merged.scripts["test:something-of-mine"]).toBe("echo mine");
  });

  test("an anchor that is the suite's own install is not a second copy", async () => {
    const { suiteDir } = await dualWorkspace();
    // computeResolveAliases answers with the suite itself when the app tree
    // holds no react: that tree is THIS install, about to happen, so the walk
    // stays in charge instead of reading a version nobody installed yet.
    expect(appReactPin(suiteDir, path.join(suiteDir, "node_modules"))).toBeUndefined();
    expect(appReactPin(suiteDir, suiteDir)).toBeUndefined();
  });

  test("a copy carrying react alone still answers the question the alias asks", async () => {
    const { suiteDir, anchor } = await dualWorkspace(false);
    expect(appReactPin(suiteDir, anchor)).toEqual({ react: "19.2.7", reactDom: "19.2.7" });
  });

  test("an anchor holding no react leaves the walk in charge", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "flawless-dual-none-"));
    writeFileSync(
      path.join(base, "package.json"),
      JSON.stringify({ dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" } }),
    );
    const suiteDir = path.join(base, ".flawless");
    mkdirSync(suiteDir);
    expect(appReactPin(suiteDir, path.join(base, "packages", "empty", "node_modules"))).toEqual({
      react: "19.2.0",
      reactDom: "19.2.0",
    });
  });
});

describe("the suite's React stays the app's React across a manifest merge", () => {
  test("a stale major from an older generation is brought back to the app's", () => {
    // bradgarropy.com: its suite was written before the app pin was read, so
    // the merge kept OUR OWN ^18.3.0 under an app declaring 19.2.x (react in
    // devDependencies, 19.2.8 installed). Two Reacts, and 90 of its 93 spec
    // files died at collect with "Cannot read properties of undefined (reading
    // 'ReactCurrentOwner')" — the signature the pin exists to prevent.
    const manifest = JSON.stringify({
      dependencies: { react: "^18.3.0", "react-dom": "^18.3.0", "react-scan": "^0.4.3" },
    });
    const fixed = JSON.parse(repairReactPin(manifest, { react: "19.2.0", reactDom: "19.2.0" }));
    // Exact, not a caret: `^19.2.0` is a floor, and the floor is how the suite
    // ends up with a different patch than the app tree it renders beside.
    expect(fixed.dependencies.react).toBe("19.2.0");
    expect(fixed.dependencies["react-dom"]).toBe("19.2.0");
    // Only the keys that disagree move; the rest of the file is the merge's
    // business, not this repair's.
    expect(fixed.dependencies["react-scan"]).toBe("^0.4.3");
  });

  test("a same-major drift is a disagreement too; an exact pin and an unreadable range are not", () => {
    // The guard react-dom runs at load time compares VERSIONS, not majors:
    // an app tree on 19.2.8 beside a suite that installed 19.3.1 from `^19.2.0`
    // dies every spec file on "Incompatible React versions" — the same 91-of-93
    // collapse as the stale major, one patch later.
    const drifted = JSON.stringify({
      dependencies: { react: "^19.2.0", "react-dom": "~19.2.0" },
    });
    const fixed = JSON.parse(repairReactPin(drifted, { react: "19.2.8", reactDom: "19.2.8" }));
    expect(fixed.dependencies.react).toBe("19.2.8");
    expect(fixed.dependencies["react-dom"]).toBe("19.2.8");
    // Already exact, and no app pin at all, are both leave-alone cases.
    const exact = JSON.stringify({
      dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
      devDependencies: { "@types/react": "^18.0.0" },
    });
    expect(repairReactPin(exact, { react: "18.3.1", reactDom: "18.3.1" })).toBe(exact);
    expect(repairReactPin(exact, undefined)).toBe(exact);
    // A range whose major cannot be read (workspace protocol, dist-tags) is
    // not a disagreement, it is an unreadable preference — guessing at it is
    // how a repair becomes a break.
    const odd = JSON.stringify({ dependencies: { react: "catalog:", "react-dom": "latest" } });
    expect(repairReactPin(odd, { react: "19.2.0", reactDom: "19.2.0" })).toBe(odd);
  });

  test("@types follow the runtime they describe", () => {
    const manifest = JSON.stringify({
      dependencies: { react: "^18.3.0" },
      devDependencies: {
        "@types/react": "^18.0.0",
        "@types/react-dom": "^18.0.0",
        vitest: "^2.1.0",
      },
    });
    const fixed = JSON.parse(repairReactPin(manifest, { react: "19.2.0", reactDom: "19.2.0" }));
    expect(fixed.devDependencies["@types/react"]).toBe("^19.0.0");
    expect(fixed.devDependencies["@types/react-dom"]).toBe("^19.0.0");
    expect(fixed.devDependencies.vitest).toBe("^2.1.0");
  });

  test("through the real merge path: a regenerated suite manifest carries the app's React", async () => {
    // The two writers of <suite>/package.json merge into what the other left,
    // and the merge lets existing pins win — so the repair has to hold at the
    // call site, not only in isolation.
    const base = await mkdtemp(path.join(tmpdir(), "flawless-rpin-"));
    const suiteDir = path.join(base, "flawless");
    mkdirSync(suiteDir);
    writeFileSync(
      path.join(base, "package.json"),
      JSON.stringify({
        dependencies: { "react-dom": "^19.2.0" },
        devDependencies: { react: "^19.2.0" },
      }),
    );
    const stale = JSON.stringify({
      dependencies: { react: "^18.3.0", "react-dom": "^18.3.0" },
      scripts: { "test:something-of-mine": "echo mine" },
    });
    const merged = repairReactPin(
      mergePackageJson(stale, suitePackageJson(suiteDir, false)),
      detectAppReact(suiteDir),
    );
    expect(JSON.parse(merged).dependencies.react).toBe("19.2.0");
    expect(JSON.parse(merged).dependencies["react-dom"]).toBe("19.2.0");
    // The merge's own promises survive the repair untouched.
    expect(JSON.parse(merged).scripts["test:something-of-mine"]).toBe("echo mine");
  });

  test("the app's INSTALLED React outranks its declared range", async () => {
    // `^19.2.0` is what bradgarropy.com declares; 19.2.8 is what sits in its
    // node_modules and what its components import. Pinning the declaration
    // would put a different patch in the suite and trip the same load-time
    // guard, so the pair that the graph actually shares is the one to read.
    const base = await mkdtemp(path.join(tmpdir(), "flawless-installed-"));
    // detectAppReact starts from the directory ABOVE what it is handed, since
    // callers pass a file or a suite directory. Hand it a suite directory.
    const suiteDir = path.join(base, "flawless");
    mkdirSync(suiteDir);
    writeFileSync(
      path.join(base, "package.json"),
      JSON.stringify({ dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" } }),
    );
    expect(detectAppReact(suiteDir)).toEqual({ react: "19.2.0", reactDom: "19.2.0" });
    for (const [name, version] of [
      ["react", "19.2.8"],
      ["react-dom", "19.2.8"],
    ] as const) {
      mkdirSync(path.join(base, "node_modules", name), { recursive: true });
      writeFileSync(
        path.join(base, "node_modules", name, "package.json"),
        JSON.stringify({ name, version }),
      );
    }
    expect(detectAppReact(suiteDir)).toEqual({ react: "19.2.8", reactDom: "19.2.8" });
    // Both or neither: a half-readable installed pair would author the very
    // mismatch this exists to prevent, so the declared range keeps charge.
    rmSync(path.join(base, "node_modules", "react-dom", "package.json"));
    expect(detectAppReact(suiteDir)).toEqual({ react: "19.2.0", reactDom: "19.2.0" });
  });

  test("a peer-only app is detected from its installed copy", () => {
    // lightswind-ui-library declares react ONLY as a peer — `"react":
    // "^18.0.0 || ^19.0.0"` — so no version is declared at all and the walk
    // used to fall through to the emitter's React-18 default while the app tree
    // ran 19.3.0. Two Reacts, 401 of 401 spec files dead at collect.
    const base = path.join(tmpdir(), "flawless-peeronly");
    mkdirSync(path.join(base, "flawless"), { recursive: true });
    writeFileSync(
      path.join(base, "package.json"),
      JSON.stringify({
        peerDependencies: { react: "^18.0.0 || ^19.0.0", "react-dom": "^18.0.0 || ^19.0.0" },
        devDependencies: { "@types/react": "^18.2.64" },
      }),
    );
    for (const name of ["react", "react-dom"] as const) {
      mkdirSync(path.join(base, "node_modules", name), { recursive: true });
      writeFileSync(
        path.join(base, "node_modules", name, "package.json"),
        JSON.stringify({ name, version: "19.3.0" }),
      );
    }
    expect(detectAppReact(path.join(base, "flawless"))).toEqual({
      react: "19.3.0",
      reactDom: "19.3.0",
    });
    // Scope of the fallback: an installed copy that is merely NEARER must not
    // out-vote a version a package actually declares — monorepo roots carry a
    // react of their own for their tooling.
    writeFileSync(
      path.join(base, "package.json"),
      JSON.stringify({ devDependencies: { react: "17.0.2", "react-dom": "17.0.2" } }),
    );
    rmSync(path.join(base, "node_modules", "react", "package.json"));
    rmSync(path.join(base, "node_modules", "react-dom", "package.json"));
    const deep = path.join(base, "packages", "app", "flawless");
    mkdirSync(deep, { recursive: true });
    mkdirSync(path.join(base, "packages", "app", "node_modules", "react"), { recursive: true });
    writeFileSync(
      path.join(base, "packages", "app", "node_modules", "react", "package.json"),
      JSON.stringify({ name: "react", version: "19.3.0" }),
    );
    expect(detectAppReact(deep)).toEqual({ react: "17.0.2", reactDom: "17.0.2" });
  });

  test("an app with a react and NO react-dom still fixes the version", async () => {
    // ospfranco/sol: `"react": "19.1.4"`, no react-dom in the manifest and no
    // react-dom installed anywhere either — it renders through a native layer.
    // The both-or-neither rule read NOTHING there, so its suite manifest kept
    // the emitter's React-18 default under a React-19.1.4 app, which is the
    // mismatch this file exists to prevent. The suite is what supplies a
    // renderer, and the only version that cannot drift beside the app's react
    // is that same version.
    const base = await mkdtemp(path.join(tmpdir(), "flawless-sodoreact-"));
    const suiteDir = path.join(base, "flawless");
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(
      path.join(base, "package.json"),
      JSON.stringify({ dependencies: { react: "19.1.4" } }),
    );
    mkdirSync(path.join(base, "node_modules", "react"), { recursive: true });
    writeFileSync(
      path.join(base, "node_modules", "react", "package.json"),
      JSON.stringify({ name: "react", version: "19.1.4" }),
    );
    expect(detectAppReact(suiteDir)).toEqual({ react: "19.1.4", reactDom: "19.1.4" });
    // And it reaches the manifest the merge left stale, which is the point: on
    // that app a run carrying the repair had already rewritten the manifest and
    // left `"react": "^18.3.0"` exactly where it was.
    const stale = JSON.stringify({ dependencies: { react: "^18.3.0", "react-dom": "^18.3.0" } });
    const fixed = JSON.parse(
      repairReactPin(
        mergePackageJson(stale, suitePackageJson(suiteDir, false)),
        detectAppReact(suiteDir),
      ),
    );
    expect(fixed.dependencies.react).toBe("19.1.4");
    expect(fixed.dependencies["react-dom"]).toBe("19.1.4");
  });

  test("a react declared alone answers when nothing is installed to read", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "flawless-solodecl-"));
    mkdirSync(path.join(base, "flawless"), { recursive: true });
    writeFileSync(
      path.join(base, "package.json"),
      JSON.stringify({ devDependencies: { react: "19.0.0" } }),
    );
    expect(detectAppReact(path.join(base, "flawless"))).toEqual({
      react: "19.0.0",
      reactDom: "19.0.0",
    });
  });

  test("the app's own react copy outranks a farther ancestor's installed pair", async () => {
    // Same scoping rule as the declaration above it: an ancestor that carries
    // react for its own tooling must not out-vote the copy the app's imports
    // actually land on. Here the app has react alone and the root has a pair.
    const base = await mkdtemp(path.join(tmpdir(), "flawless-solocloser-"));
    for (const [dir, name, version] of [
      ["packages/app", "react", "19.1.4"],
      [".", "react", "18.3.1"],
      [".", "react-dom", "18.3.1"],
    ] as const) {
      const at = path.join(base, dir, "node_modules", name);
      mkdirSync(at, { recursive: true });
      writeFileSync(path.join(at, "package.json"), JSON.stringify({ name, version }));
    }
    expect(detectAppReact(path.join(base, "packages/app", "flawless"))).toEqual({
      react: "19.1.4",
      reactDom: "19.1.4",
    });
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
    // Defect #3: bare "react-dom/server" is aliased to the node build, which
    // on react-dom < 19.2 lacks renderToReadableStream — the emitted specifier
    // is measured (probeServerStream) and prefers react-dom/server.browser.
    expect(spec).toContain('import { renderToReadableStream } from "react-dom/server.browser"');
    expect(spec).toContain("PROMISE_PROPS");
    expect(spec).not.toContain("renderToStaticMarkup(ui");
  });
});
