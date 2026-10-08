import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensurePnpmSuiteSettings,
  scaffoldUnitBrowser,
  suitePackageJson,
} from "../src/scaffold-tests/index.ts";
import { hashBody, STAMP_RE, splitStamp } from "../src/scaffold-tests/stamp.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import type { ComponentInfo, ComponentTree } from "../src/types.ts";

const dirs: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-scaffold-tests-"));
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

function tree(entry: ComponentInfo, children: ComponentTree[] = []): ComponentTree {
  return { entry, children };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("scaffoldUnitBrowser (file writes)", () => {
  test("writes the expected file set and reports written + skipped", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    const { written, skipped } = await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(src, "Widget.tsx")))],
      outDir,
      variants: 3,
    });

    const expected = [
      path.join(outDir, "vitest.config.mts"),
      path.join(outDir, "setup.ts"),
      path.join(outDir, "server-only-stub.ts"),
      path.join(outDir, "browser", "playwright.config.ts"),
      path.join(outDir, "unit", "Widget.test.tsx"),
      path.join(outDir, "browser", "Widget.spec.ts"),
      path.join(outDir, "package.json"),
      path.join(outDir, "pnpm-workspace.yaml"),
      path.join(outDir, "tsconfig.json"),
    ];
    expect(written.sort()).toEqual([...expected].sort());
    expect(skipped).toEqual([]);
    for (const file of expected) expect(existsSync(file)).toBe(true);
    expect(readFileSync(path.join(outDir, "unit", "Widget.test.tsx"), "utf8")).toContain(
      "Widget mounts at defaults without throwing",
    );
  });

  test("creates outDir when it does not exist and skips the browser spec for async components", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "nested", "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    const { written } = await scaffoldUnitBrowser({
      trees: [tree(comp("Page", path.join(src, "Page.tsx"), { isAsync: true }))],
      outDir,
      variants: 2,
      skipInnerPackageJson: true,
    });

    expect(existsSync(path.join(outDir, "unit", "Page.test.tsx"))).toBe(true);
    expect(existsSync(path.join(outDir, "browser", "Page.spec.ts"))).toBe(false);
    expect(written).not.toContain(path.join(outDir, "package.json"));
    expect(existsSync(path.join(outDir, "package.json"))).toBe(false);
  });
});

describe("scaffoldUnitBrowser inner package.json", () => {
  test("creates one with the test:unit / test:browser scripts it owns", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");

    await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
      skipInnerPackageJson: false,
    });

    const pkg = readJson(path.join(outDir, "package.json"));
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts["test:unit"]).toBe("vitest run");
    expect(scripts["test:browser"]).toBe("playwright test --config browser/playwright.config.ts");
    // test:perf belongs to perf-harness, which declares it in every run this
    // emitter would have. Two spellings of it — `playwright test` here,
    // `playwright test profile` there — left the file depending on task order.
    // tests/core.test.ts holds the two emitters against each other.
    expect(scripts["test:perf"]).toBeUndefined();
    expect(pkg.name).toBe("flawless-suite");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect((pkg.dependencies as Record<string, string>).react).toBe("^18.3.0");
    expect((pkg.devDependencies as Record<string, string>).vitest).toBe("^2.1.0");
  });

  test("skipInnerPackageJson true writes no package.json", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
      skipInnerPackageJson: true,
    });
    expect(existsSync(path.join(outDir, "package.json"))).toBe(false);
  });

  test("merging an existing tab-indented package.json keeps its tabs and its own fields", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    mkdirSync(outDir, { recursive: true });
    const pkgPath = path.join(outDir, "package.json");
    writeFileSync(
      pkgPath,
      '{\n\t"name": "existing-suite",\n\t"version": "1.2.3",\n\t"scripts": {\n\t\t"dev": "vite"\n\t},\n\t"devDependencies": {\n\t\t"vitest": "^1.0.0"\n\t}\n}\n',
    );

    await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
      skipInnerPackageJson: false,
    });

    const text = readFileSync(pkgPath, "utf8");
    expect(text).toContain('\t"');
    expect(text).not.toContain('\n  "');
    expect(text.endsWith("\n")).toBe(true);

    const pkg = readJson(pkgPath);
    const scripts = pkg.scripts as Record<string, string>;
    expect(pkg.name).toBe("existing-suite");
    expect(pkg.version).toBe("1.2.3");
    expect(scripts.dev).toBe("vite");
    expect(scripts["test:unit"]).toBe("vitest run");
    // Existing dependency pins win over the defaults.
    expect((pkg.devDependencies as Record<string, string>).vitest).toBe("^1.0.0");
  });

  test("an unparseable package.json is replaced rather than crashing the scaffold", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    mkdirSync(outDir, { recursive: true });
    const pkgPath = path.join(outDir, "package.json");
    writeFileSync(pkgPath, "{ not json");

    await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
    });

    const pkg = readJson(pkgPath);
    expect((pkg.scripts as Record<string, string>)["test:unit"]).toBe("vitest run");
  });
});

describe("scaffoldUnitBrowser colocate", () => {
  test("existing colocated specs are skipped and left byte-identical", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    const cardSpec = path.join(src, "Card.flawless.test.tsx");
    const original = "// flawless-sentinel: keep this file\n";
    writeFileSync(cardSpec, original);

    const trees = [
      tree(comp("Card", path.join(src, "Card.tsx"))),
      tree(comp("Chip", path.join(src, "Chip.tsx"))),
    ];
    const { written, skipped } = await scaffoldUnitBrowser({
      trees,
      outDir,
      variants: 2,
      colocate: true,
      skipInnerPackageJson: true,
    });

    expect(skipped).toEqual([cardSpec]);
    expect(written).not.toContain(cardSpec);
    expect(readFileSync(cardSpec, "utf8")).toBe(original);

    // The component without a pre-existing spec is still written next to its source.
    const chipSpec = path.join(src, "Chip.flawless.test.tsx");
    expect(written).toContain(chipSpec);
    expect(readFileSync(chipSpec, "utf8")).toContain("Chip mounts at defaults without throwing");
    // Shared config still lands in outDir.
    expect(existsSync(path.join(outDir, "vitest.config.mts"))).toBe(true);
    expect(existsSync(path.join(outDir, "browser", "Card.spec.ts"))).toBe(true);
  });

  // The --force decision matrix. Colocated specs are the only skipIfExists
  // files, and the stamp is what lets --force tell "generated, untouched"
  // from "someone worked on this" — so each verdict is pinned here against
  // the writer's four result buckets.
  const colocateScaffold = (root: string, force: boolean): ReturnType<typeof scaffoldUnitBrowser> =>
    scaffoldUnitBrowser({
      trees: [tree(comp("Card", path.join(root, "src", "Card.tsx")))],
      outDir: path.join(root, "flawless"),
      variants: 2,
      colocate: true,
      force,
      skipInnerPackageJson: true,
    });

  test("a new colocated spec is written stamped; in-outDir files never are", async () => {
    const root = tmpRoot();
    mkdirSync(path.join(root, "src"), { recursive: true });
    const res = await colocateScaffold(root, false);

    const cardSpec = path.join(root, "src", "Card.flawless.test.tsx");
    expect(res.written).toContain(cardSpec);
    expect(res.keptEdited).toEqual([]);
    expect(res.keptLegacy).toEqual([]);
    const text = readFileSync(cardSpec, "utf8");
    expect(STAMP_RE.test(text)).toBe(true);
    const { hash, body } = splitStamp(text);
    expect(hash).toBe(hashBody(body));
    expect(body).toContain("Card mounts at defaults without throwing");
    // The regenerated set is identified by rewriting it, not by stamping it.
    expect(STAMP_RE.test(readFileSync(path.join(root, "flawless", "setup.ts"), "utf8"))).toBe(
      false,
    );
  });

  test("force + untouched stamp → rewritten", async () => {
    const root = tmpRoot();
    mkdirSync(path.join(root, "src"), { recursive: true });
    await colocateScaffold(root, false);
    const cardSpec = path.join(root, "src", "Card.flawless.test.tsx");

    const res = await colocateScaffold(root, true);
    expect(res.written).toContain(cardSpec);
    expect(res.skipped).toEqual([]);
    expect(res.keptEdited).toEqual([]);
    expect(res.keptLegacy).toEqual([]);
    expect(STAMP_RE.test(readFileSync(cardSpec, "utf8"))).toBe(true);
  });

  test("force + edited body → kept byte-identical in keptEdited", async () => {
    const root = tmpRoot();
    mkdirSync(path.join(root, "src"), { recursive: true });
    await colocateScaffold(root, false);
    const cardSpec = path.join(root, "src", "Card.flawless.test.tsx");
    writeFileSync(cardSpec, `${readFileSync(cardSpec, "utf8")}// hand-hardened\n`);
    const edited = readFileSync(cardSpec, "utf8");

    const res = await colocateScaffold(root, true);
    expect(res.keptEdited).toEqual([cardSpec]);
    expect(res.keptLegacy).toEqual([]);
    expect(res.written).not.toContain(cardSpec);
    expect(res.skipped).toEqual([]);
    expect(readFileSync(cardSpec, "utf8")).toBe(edited);
  });

  test("force + no stamp → kept byte-identical in keptLegacy", async () => {
    const root = tmpRoot();
    mkdirSync(path.join(root, "src"), { recursive: true });
    const cardSpec = path.join(root, "src", "Card.flawless.test.tsx");
    const legacy = "// flawless-sentinel: a spec from before stamping existed\n";
    writeFileSync(cardSpec, legacy);

    const res = await colocateScaffold(root, true);
    expect(res.keptLegacy).toEqual([cardSpec]);
    expect(res.keptEdited).toEqual([]);
    expect(res.written).not.toContain(cardSpec);
    expect(readFileSync(cardSpec, "utf8")).toBe(legacy);
  });

  test("no force + exists → skipped without classification, kept lists empty", async () => {
    const root = tmpRoot();
    mkdirSync(path.join(root, "src"), { recursive: true });
    await colocateScaffold(root, false);
    const cardSpec = path.join(root, "src", "Card.flawless.test.tsx");
    writeFileSync(cardSpec, `${readFileSync(cardSpec, "utf8")}// hand-hardened\n`);

    const res = await colocateScaffold(root, false);
    expect(res.skipped).toEqual([cardSpec]);
    expect(res.keptEdited).toEqual([]);
    expect(res.keptLegacy).toEqual([]);
  });

  test("multi-component files colocate one spec per component", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });
    const modulePath = path.join(src, "card.tsx");

    const { written } = await scaffoldUnitBrowser({
      trees: [
        tree(comp("Card", modulePath, { exportKind: "named" }), [
          tree(comp("CardHeader", modulePath, { exportKind: "named" })),
        ]),
      ],
      outDir,
      variants: 2,
      colocate: true,
      skipInnerPackageJson: true,
    });

    const cardSpec = path.join(src, "card.Card.flawless.test.tsx");
    const headerSpec = path.join(src, "card.CardHeader.flawless.test.tsx");
    expect(written).toContain(cardSpec);
    expect(written).toContain(headerSpec);
    expect(readFileSync(cardSpec, "utf8")).toContain('import { Card } from "./card";');
    expect(readFileSync(headerSpec, "utf8")).toContain('import { CardHeader } from "./card";');
  });
});

// FR-061: a browser spec's component left the mountable set between runs. The
// spec can never run again (the registry no longer carries the component —
// mount throws "unknown component"), so a kept file is a suite that is red by
// the tool's own doing. Provenance decides: untouched tool output is removed,
// anything a human may have worked on is kept and reported.
describe("scaffoldUnitBrowser stale browser specs", () => {
  const run = (outDir: string, trees: ComponentTree[], variants = 2) =>
    scaffoldUnitBrowser({ trees, outDir, variants });

  test("emits browser specs with a provenance stamp", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    await run(outDir, [tree(comp("Widget", path.join(src, "Widget.tsx")))]);
    const first = readFileSync(path.join(outDir, "browser", "Widget.spec.ts"), "utf8");
    expect(first).toMatch(STAMP_RE);
    expect(splitStamp(first).hash).toBe(hashBody(splitStamp(first).body));
  });

  test("removes a browser spec whose component is no longer rendered", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    await run(outDir, [tree(comp("Widget", path.join(src, "Widget.tsx")))]);
    const spec = path.join(outDir, "browser", "Widget.spec.ts");
    expect(existsSync(spec)).toBe(true);

    // The component went async: still unit-tested, no longer host-mountable.
    const res = await run(outDir, [
      tree(comp("Widget", path.join(src, "Widget.tsx"), { isAsync: true })),
    ]);
    expect(existsSync(spec)).toBe(false);
    expect(res.staleRemoved).toEqual([spec]);
    expect(res.staleKept).toEqual([]);
  });

  test("keeps and reports a hand-edited stale browser spec", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    await run(outDir, [tree(comp("Widget", path.join(src, "Widget.tsx")))]);
    const spec = path.join(outDir, "browser", "Widget.spec.ts");
    const edited = `${readFileSync(spec, "utf8")}// hand-hardened: a real assertion lives here\n`;
    writeFileSync(spec, edited);

    const res = await run(outDir, [
      tree(comp("Widget", path.join(src, "Widget.tsx"), { isAsync: true })),
    ]);
    expect(readFileSync(spec, "utf8")).toBe(edited);
    expect(res.staleKept).toEqual([{ abs: spec, verdict: "edited" }]);
    expect(res.staleRemoved).toEqual([]);
  });

  test("keeps and reports a stampless stale browser spec", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    await run(outDir, [tree(comp("Widget", path.join(src, "Widget.tsx")))]);
    const spec = path.join(outDir, "browser", "Widget.spec.ts");
    // Pre-stamp suites (and hand-written specs) carry no stamp: the writer
    // cannot prove the file is its own, so it keeps it and says so.
    writeFileSync(spec, readFileSync(spec, "utf8").replace(STAMP_RE, ""));

    const res = await run(outDir, [
      tree(comp("Widget", path.join(src, "Widget.tsx"), { isAsync: true })),
    ]);
    expect(existsSync(spec)).toBe(true);
    expect(res.staleKept).toEqual([{ abs: spec, verdict: "stampless" }]);
  });

  test("leaves still-rendered browser specs untouched by the stale scan", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    await run(outDir, [tree(comp("Widget", path.join(src, "Widget.tsx")))]);
    const spec = path.join(outDir, "browser", "Widget.spec.ts");
    const before = readFileSync(spec, "utf8");

    const res = await run(outDir, [tree(comp("Widget", path.join(src, "Widget.tsx")))]);
    expect(readFileSync(spec, "utf8")).toBe(before);
    expect(res.staleRemoved).toEqual([]);
    expect(res.staleKept).toEqual([]);
  });
});

// FR-061, the emission half: the browser spec mounts through the perf host's
// REGISTRY by name, so a spec is only runnable for a component the host
// actually carries. The emitter used to re-derive that with its own broader
// `renderMode === "client"` check — a client component whose render() is
// undecidable drew a spec the host refused ("unknown component" every run),
// and a wrappable compound part the host DOES carry drew no spec at all. The
// predicate is now hostEligibility, the single source the host registry, the
// report and the unit emitter already consult.
describe("browser spec emission predicate", () => {
  const renderedBrowser = (trees: ComponentTree[], outDir: string): Set<string> => {
    const files = renderUnitBrowser({ trees, outDir, variants: 2, browserSpecs: true });
    return new Set(files.filter((f) => f.relPath.startsWith("browser/")).map((f) => f.relPath));
  };

  test("does not emit a browser spec for a client component with an undecidable render", () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    // renderMode is still "client" — the undecidable guard does not change the
    // mode, it only makes the initial render unprovable. The old predicate
    // (mode === client) emitted a spec here; the host refuses to mount it.
    const c = comp("Guarded", path.join(src, "Guarded.tsx"), {
      renderMode: "client",
      renderUndecidable: true,
    });
    const set = renderedBrowser([tree(c)], outDir);
    expect(set.has("browser/Guarded.spec.ts")).toBe(false);
  });

  test("emits a browser spec for a wrappable compound part the host carries", () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    const c = comp("DialogTrigger", path.join(src, "DialogTrigger.tsx"), {
      renderMode: "compound-part",
      compoundFamily: {
        root: "DialogRoot",
        content: "DialogContent",
        part: "trigger",
        specifier: "@base-ui/react/dialog",
      },
    });
    const set = renderedBrowser([tree(c)], outDir);
    expect(set.has("browser/DialogTrigger.spec.ts")).toBe(true);
  });

  test("still emits no browser spec for an un-wrappable compound part", () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const src = path.join(root, "src");
    mkdirSync(src, { recursive: true });

    // A part from a family with no open-state Root: the host cannot wrap it,
    // so it is ineligible and draws no spec.
    const c = comp("TooltipX", path.join(src, "TooltipX.tsx"), {
      renderMode: "compound-part",
      compoundFamily: {
        root: "TooltipRoot",
        part: "other",
        specifier: "@base-ui/react/tooltip",
      },
    });
    const set = renderedBrowser([tree(c)], outDir);
    expect(set.has("browser/TooltipX.spec.ts")).toBe(false);
  });
});

// Lives here rather than in tests/scaffold.test.ts (which owns the rest of the
// perf-suite scaffold coverage) because that file belongs to another cluster of
// the same fix wave.
describe("scaffold keeps hand-edited mock fixtures", () => {
  test("mock/routes.ts survives a --force regeneration, as its header promises", async () => {
    const { scaffold } = await import("../src/scaffold/index.ts");
    const root = tmpRoot();
    const outDir = path.join(root, "perf");
    const apiSpec = path.resolve(__dirname, "fixtures", "_api.json");
    const trees = tree(comp("Widget", path.join(root, "src", "Widget.tsx")));
    const opts = {
      outDir,
      variants: 2,
      force: false,
      report: false,
      provider: undefined,
      apiSpec,
    };

    await scaffold(trees, opts);
    const routes = path.join(outDir, "mock", "routes.ts");
    const emitted = readFileSync(routes, "utf8");
    // The emitted header makes the promise this test holds the writer to.
    expect(emitted).toContain("no regeneration step that will overwrite this file");

    const edited = `${emitted}\n// hand-tuned fixture body — must survive --force\n`;
    writeFileSync(routes, edited);

    await scaffold(trees, { ...opts, force: true });
    expect(readFileSync(routes, "utf8")).toBe(edited);
  });
});

describe("suite-local install surface (nextjs self-contained suite)", () => {
  test("the unit-browser default emits the whole installable triad — the nextjs-mode skip that left the suite without a manifest is gone", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    const { written } = await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
      mswSetup: true,
      browserSpecs: true,
    });
    expect(existsSync(path.join(outDir, "package.json"))).toBe(true);
    expect(existsSync(path.join(outDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(path.join(outDir, "pnpm-workspace.yaml"))).toBe(true);
    expect(written.map((w) => path.basename(w))).toContain("tsconfig.json");
  });

  test("the tsconfig is write-once — user edits survive a regen", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    mkdirSync(outDir, { recursive: true });
    const edited = '{ "compilerOptions": { "strict": false } }\n';
    writeFileSync(path.join(outDir, "tsconfig.json"), edited);
    await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
    });
    expect(readFileSync(path.join(outDir, "tsconfig.json"), "utf8")).toBe(edited);
  });

  test("react-scan belongs to the perf host and msw to the MSW setup — each declared exactly when its consumer is emitted", () => {
    const both = JSON.parse(suitePackageJson("/app/flawless", true, true)) as {
      dependencies: Record<string, string>;
    };
    // Same react-scan pin as perf-harness's own emitter: divergent pins would
    // make the file's bytes depend on which task ran last.
    expect(both.dependencies["react-scan"]).toBe("^0.4.3");
    expect(both.dependencies.msw).toBe("^2.7.0");
    const unitOnly = JSON.parse(suitePackageJson("/app/flawless", false, false)) as {
      dependencies: Record<string, string>;
    };
    expect(unitOnly.dependencies["react-scan"]).toBeUndefined();
    expect(unitOnly.dependencies.msw).toBeUndefined();
  });

  test("a nextjs manifest omits the module-type loader switch — the playwright configs under it load with the app's CJS default, and the nearest package.json picks that loader", () => {
    const standalone = JSON.parse(suitePackageJson("/app/flawless", true, false)) as Record<
      string,
      unknown
    >;
    expect(standalone.type).toBe("module");
    const next = JSON.parse(suitePackageJson("/app/flawless", true, true, true)) as Record<
      string,
      unknown
    >;
    expect(next.type).toBeUndefined();
    // Dropping the loader switch must not take anything else with it.
    expect(next.dependencies.msw).toBe("^2.7.0");
    expect(next.dependencies["react-scan"]).toBe("^0.4.3");
  });

  test("regen over a nextjs manifest that declared module removes the declaration — every other key stays the user's", async () => {
    const root = tmpRoot();
    const outDir = path.join(root, "flawless");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, "package.json"),
      '{\n\t"name": "mine",\n\t"type": "module",\n\t"customValue": 42\n}\n',
    );
    await scaffoldUnitBrowser({
      trees: [tree(comp("Widget", path.join(root, "src", "Widget.tsx")))],
      outDir,
      variants: 1,
      mswSetup: true,
      nextjs: true,
    });
    const pkg = readJson(path.join(outDir, "package.json"));
    expect(pkg.type).toBeUndefined();
    expect(pkg.customValue).toBe(42);
    expect((pkg.dependencies as Record<string, string>).msw).toBe("^2.7.0");
  });
});

describe("ensurePnpmSuiteSettings", () => {
  test("a missing yaml is written whole — esbuild and msw both allowed, twice is a no-op", async () => {
    const file = path.join(tmpRoot(), "pnpm-workspace.yaml");
    expect(await ensurePnpmSuiteSettings(file)).toBe(true);
    const body = readFileSync(file, "utf8");
    expect(body).toMatch(/^\s+- esbuild$/m);
    expect(body).toMatch(/^\s+- msw$/m);
    expect(body).toMatch(/^\s+esbuild: true$/m);
    expect(await ensurePnpmSuiteSettings(file)).toBe(false);
  });

  test("an old esbuild-only yaml gains msw once; user keys survive the touch", async () => {
    const file = path.join(tmpRoot(), "pnpm-workspace.yaml");
    writeFileSync(
      file,
      "onlyBuiltDependencies:\n  - esbuild\nallowBuilds:\n  esbuild: true\nnodeLinker: hoisted\n",
    );
    expect(await ensurePnpmSuiteSettings(file)).toBe(true);
    const body = readFileSync(file, "utf8");
    expect(body.match(/- msw/g)).toHaveLength(1);
    expect(body.match(/msw: true/g)).toHaveLength(1);
    expect(body).toContain("nodeLinker: hoisted");
    expect(await ensurePnpmSuiteSettings(file)).toBe(false);
  });

  test("a key rewritten inline belongs to the user — the pass hands off instead of duplicating it", async () => {
    const file = path.join(tmpRoot(), "pnpm-workspace.yaml");
    const inline =
      "onlyBuiltDependencies: [esbuild, msw]\nallowBuilds: { esbuild: true, msw: true }\n";
    writeFileSync(file, inline);
    expect(await ensurePnpmSuiteSettings(file)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(inline);
  });

  test("a yaml without the blocks gains them appended, existing content untouched", async () => {
    const file = path.join(tmpRoot(), "pnpm-workspace.yaml");
    writeFileSync(file, "packages: []\n");
    expect(await ensurePnpmSuiteSettings(file)).toBe(true);
    const body = readFileSync(file, "utf8");
    expect(body).toContain("packages: []");
    expect(body).toMatch(/onlyBuiltDependencies:\n\s+- esbuild\n\s+- msw\n/);
    expect(body).toMatch(/allowBuilds:\n\s+esbuild: true\n\s+msw: true\n/);
  });
});
