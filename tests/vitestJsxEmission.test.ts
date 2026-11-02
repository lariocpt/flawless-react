import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModuleResolver } from "../src/analyse/resolveModule.ts";
import {
  hostViteFamily,
  jsxTransformFor,
  topMajorOf,
  vitestRangeToViteFamily,
} from "../src/packageJson.ts";
import { JSX_MECHANISM_COMMENT, renderUnitBrowser } from "../src/scaffold-tests/templates.ts";

/**
 * The readers behind the emitted config's JSX mechanism (chunk #10): the
 * vitest-major → vite-major table, the top-of-range reading of declared
 * ranges, the four-leg hostViteFamily walk, the jsxTransformFor switch and
 * the effective tsconfig `jsx` query. No installs here — every fixture is a
 * scratch dir carrying hand-written manifests, and the range table is
 * measured from the shipped package.json files (vitest 2.1.9 → vite ^5.0.0;
 * 3.x → ^5.0.0 || ^6.0.0 || ^7.0.0-0; 4.1.12 → ^6.0.0 || ^7.0.0 || ^8.0.0;
 * 5.1.0 → ^6.4.0 || ^7.0.0 || ^8.0.0).
 */

// The tool's own generated default (suitePackageJson's vitest pin): leg 2 of
// hostViteFamily compares the suite manifest's pin against it, byte for byte.
const DEFAULT_VITEST = "^2.1.0";

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function scratch(name: string): string {
  tmpRoot ??= mkdtempSync(path.join(tmpdir(), "flawless-jsx-"));
  const dir = path.join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir: string, name: string, obj: unknown): void {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

describe("topMajorOf: the range grammar", () => {
  test("single comparators read their top major", () => {
    expect(topMajorOf("^2.1.0")).toBe(2);
    expect(topMajorOf("^2")).toBe(2);
    expect(topMajorOf("2.1.9")).toBe(2);
    expect(topMajorOf("~4.1.0")).toBe(4);
    expect(topMajorOf("^0.5.0")).toBe(0);
    expect(topMajorOf("<6")).toBe(5);
    expect(topMajorOf("<=6.0.0")).toBe(6);
  });

  test("a disjunction is bounded by its widest part", () => {
    expect(topMajorOf("^2 || ^5")).toBe(5);
    expect(topMajorOf(">=2 <6")).toBe(5);
    expect(topMajorOf(">=2.1.0 <6.0.0")).toBe(5);
    expect(topMajorOf("^5.0.0 || ^6.0.0 || ^7.0.0-0")).toBe(7);
  });

  test("open ranges answer unbounded; versionless ranges answer undefined", () => {
    expect(topMajorOf(">=2")).toBe("unbounded");
    expect(topMajorOf(">=2.1.0")).toBe("unbounded");
    expect(topMajorOf("*")).toBe("unbounded");
    expect(topMajorOf("latest")).toBe("unbounded");
    expect(topMajorOf("workspace:*")).toBeUndefined();
    expect(topMajorOf("git+https://example.com/repo.git")).toBeUndefined();
    expect(topMajorOf("next")).toBeUndefined();
    expect(topMajorOf("")).toBeUndefined();
  });
});

describe("vitestRangeToViteFamily: the measured table", () => {
  const cases: Array<[string, number]> = [
    ["^2", 5],
    ["^2.1.0", 5],
    ["2.1.9", 5],
    ["~2.1.0", 5],
    ["^3", 7],
    ["~4.1.0", 8],
    ["^4", 8],
    ["^5", 8],
    ["^6", 8],
    ["*", 8],
    ["latest", 8],
    ["^2 || ^5", 8],
    [">=2 <6", 8],
  ];
  for (const [range, family] of cases) {
    test(`${range} → vite ${family}`, () => {
      expect(vitestRangeToViteFamily(range)).toBe(family);
    });
  }
});

describe("jsxTransformFor: the mechanism per vite generation", () => {
  test("vite below 8 transforms with esbuild (an oxc key is inert there)", () => {
    expect(jsxTransformFor(5)).toBe("esbuild");
    expect(jsxTransformFor(6)).toBe("esbuild");
    expect(jsxTransformFor(7)).toBe("esbuild");
  });

  test("vite 8+ transforms with oxc (the esbuild key is discarded there)", () => {
    expect(jsxTransformFor(8)).toBe("oxc");
  });
});

describe("hostViteFamily, leg 1: an installed vitest answers", () => {
  test("a store-root vite outranks the vitest manifest's declared range", () => {
    const app = scratch("l1-root-vite");
    // The manifest SAYS vite ^5 (a fresh install would fetch it)…
    writeJson(path.join(app, "node_modules", "vitest"), "package.json", {
      name: "vitest",
      version: "5.1.0",
      dependencies: { vite: "^5.0.0" },
    });
    // …but the copy actually present at the store root is 8: that is the one
    // that runs, and it outranks the declaration.
    writeJson(path.join(app, "node_modules", "vite"), "package.json", {
      name: "vite",
      version: "8.3.5",
    });
    expect(hostViteFamily({ suiteDir: app, fallbackRange: DEFAULT_VITEST })).toBe(8);
  });

  test("vitest's nested vite outranks its manifest's range when the store root has none", () => {
    const app = scratch("l1-nested-vite");
    writeJson(path.join(app, "node_modules", "vitest"), "package.json", {
      name: "vitest",
      version: "3.2.4",
      dependencies: { vite: "^5.0.0" },
    });
    writeJson(path.join(app, "node_modules", "vitest", "node_modules", "vite"), "package.json", {
      name: "vite",
      version: "7.3.7",
    });
    expect(hostViteFamily({ suiteDir: app, fallbackRange: DEFAULT_VITEST })).toBe(7);
  });

  test("no installed vite anywhere in the store: the vitest manifest's range answers", () => {
    const app = scratch("l1-range");
    writeJson(path.join(app, "node_modules", "vitest"), "package.json", {
      name: "vitest",
      version: "4.1.12",
      dependencies: { vite: "^6.0.0 || ^7.0.0 || ^8.0.0" },
    });
    expect(hostViteFamily({ suiteDir: app, fallbackRange: DEFAULT_VITEST })).toBe(8);
  });

  test("a store without a vitest is not a store for this question", () => {
    const root = scratch("l1-no-vitest");
    writeJson(root, "package.json", { name: "root", devDependencies: { vitest: "^5.0.0" } });
    const app = path.join(root, "app");
    writeJson(path.join(app, "node_modules", "typescript"), "package.json", {
      name: "typescript",
      version: "5.6.2",
    });
    const suite = path.join(app, "flawless");
    mkdirSync(suite, { recursive: true });
    // app/node_modules exists but carries no vitest: the walk continues to the
    // root manifest (no .git/lock boundary anywhere in this scratch tree) and
    // leg 3's host pin answers.
    expect(hostViteFamily({ suiteDir: suite, fallbackRange: DEFAULT_VITEST })).toBe(8);
  });

  test("the walk stops after a .git boundary: a vitest store above the repo is invisible", () => {
    const outer = scratch("l1-boundary-git-outer");
    writeJson(path.join(outer, "node_modules", "vitest"), "package.json", {
      name: "vitest",
      version: "2.1.9",
      dependencies: { vite: "^5.0.0" },
    });
    writeJson(path.join(outer, "node_modules", "vite"), "package.json", {
      name: "vite",
      version: "5.4.21",
    });
    const repo = path.join(outer, "repo");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    writeJson(repo, "package.json", { name: "repo", devDependencies: { vitest: "^5.0.0" } });
    const suite = path.join(repo, "flawless");
    mkdirSync(suite, { recursive: true });
    // The outer store would answer vite 5 if consulted — it is not: the walk
    // breaks at the repo's .git, and the repo's own declared ^5 answers via
    // leg 3. The boundary is what keeps a home-dir tooling install from
    // answering for the app.
    expect(hostViteFamily({ suiteDir: suite, fallbackRange: DEFAULT_VITEST })).toBe(8);
  });

  test("the walk stops after a bun.lock boundary too", () => {
    const outer = scratch("l1-boundary-lock-outer");
    writeJson(path.join(outer, "node_modules", "vite"), "package.json", {
      name: "vite",
      version: "5.4.21",
    });
    writeJson(path.join(outer, "node_modules", "vitest"), "package.json", {
      name: "vitest",
      version: "2.1.9",
      dependencies: { vite: "^5.0.0" },
    });
    const repo = path.join(outer, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, "bun.lockb"), "lock");
    writeJson(repo, "package.json", { name: "repo", devDependencies: { vitest: "^3.0.0" } });
    const suite = path.join(repo, "flawless");
    mkdirSync(suite, { recursive: true });
    // leg 3: ^3 → vite 7, never the outer store's vite 5.
    expect(hostViteFamily({ suiteDir: suite, fallbackRange: DEFAULT_VITEST })).toBe(7);
  });
});

describe("hostViteFamily, leg 2: the suite manifest's own pin", () => {
  test("a pin identical to the tool's generated default is not a declaration: the host answers", () => {
    const repo = scratch("l2-default-manifest");
    writeJson(repo, "package.json", { name: "repo", devDependencies: { vitest: "^5.0.0" } });
    const suite = path.join(repo, "flawless");
    mkdirSync(suite, { recursive: true });
    // The fresh manifest the tool itself wrote: its vitest pin IS the
    // generated default. Without the fall-through this would answer vite 5
    // and emit the esbuild spelling — red on the host's vite 8. With it, the
    // host's ^5 answers.
    writeJson(suite, "package.json", {
      name: "suite",
      devDependencies: { vitest: DEFAULT_VITEST },
    });
    expect(hostViteFamily({ suiteDir: suite, fallbackRange: DEFAULT_VITEST })).toBe(8);
  });

  test("a user-chosen manifest pin outranks the host, defanging a boundary-spanning range", () => {
    const repo = scratch("l2-user-pin");
    writeJson(repo, "package.json", {
      name: "repo",
      devDependencies: { vitest: "^2.1.0 || ^5.0.0" },
    });
    const suite = path.join(repo, "flawless");
    mkdirSync(suite, { recursive: true });
    // The manifest is where the suite's install lives: an exact pin the user
    // chose (not the generated default) says the suite runs vitest 2.
    writeJson(suite, "package.json", { name: "suite", devDependencies: { vitest: "2.1.9" } });
    expect(hostViteFamily({ suiteDir: suite, fallbackRange: DEFAULT_VITEST })).toBe(5);
  });
});

describe("hostViteFamily, leg 3: the host-declared vitest", () => {
  test("a boundary-spanning range resolves at its top", () => {
    const repo = scratch("l3-spanning");
    writeJson(repo, "package.json", { name: "repo", devDependencies: { vitest: ">=2 <6" } });
    const suite = path.join(repo, "flawless");
    mkdirSync(suite, { recursive: true });
    // `>=2 <6` installs vitest 5 → vite 8. The config must be written for the
    // top of the range, not its floor.
    expect(hostViteFamily({ suiteDir: suite, fallbackRange: DEFAULT_VITEST })).toBe(8);
  });

  test("an unreadable pin yields: the walk continues to the next readable one", () => {
    const root = scratch("l3-unreadable");
    writeJson(root, "package.json", { name: "root", devDependencies: { vitest: "^2.1.0" } });
    const app = path.join(root, "app");
    // No workspaces field, no pnpm-workspace.yaml: workspace:* resolves to
    // nothing — unreadable, so the hop yields and the walk continues.
    writeJson(app, "package.json", { name: "app", devDependencies: { vitest: "workspace:*" } });
    const suite = path.join(app, "flawless");
    mkdirSync(suite, { recursive: true });
    expect(hostViteFamily({ suiteDir: suite, fallbackRange: DEFAULT_VITEST })).toBe(5);
  });

  test("a catalog: pin resolves through the declaring manifest's catalogs", () => {
    const root = scratch("l3-catalog");
    writeJson(root, "package.json", {
      name: "root",
      devDependencies: { vitest: "catalog:" },
      catalogs: { default: { vitest: "^5.0.0" } },
    });
    const app = path.join(root, "app");
    mkdirSync(app, { recursive: true });
    const suite = path.join(app, "flawless");
    mkdirSync(suite, { recursive: true });
    expect(hostViteFamily({ suiteDir: suite, fallbackRange: DEFAULT_VITEST })).toBe(8);
  });
});

describe("hostViteFamily, leg 4: the generated default", () => {
  test("nothing installed, declared or pinned: the fallback range answers", () => {
    const app = scratch("l4-default");
    const suite = path.join(app, "flawless");
    mkdirSync(suite, { recursive: true });
    expect(hostViteFamily({ suiteDir: suite, fallbackRange: "^2.1.0" })).toBe(5);
    expect(hostViteFamily({ suiteDir: suite, fallbackRange: "latest" })).toBe(8);
  });
});

describe("ModuleResolver.jsxFor: the effective jsx through the extends chain", () => {
  test("the child's own declaration wins over the base", () => {
    const root = scratch("jsx-extends");
    writeJson(path.join(root, "base"), "tsconfig.json", {
      compilerOptions: { jsx: "react-jsx" },
    });
    const base = path.join(root, "base");
    const app = path.join(root, "app");
    writeJson(app, "tsconfig.json", {
      extends: "../base/tsconfig.json",
      compilerOptions: { jsx: "preserve" },
    });
    const resolver = new ModuleResolver();
    expect(resolver.jsxFor(app)).toBe("preserve");
    expect(resolver.jsxFor(base)).toBe("react-jsx");
  });

  test("an undeclared key inherits the base's value", () => {
    const root = scratch("jsx-inherit");
    writeJson(path.join(root, "base"), "tsconfig.json", {
      compilerOptions: { jsx: "react-jsx" },
    });
    const app = path.join(root, "app");
    writeJson(app, "tsconfig.json", {
      extends: "../base/tsconfig.json",
      compilerOptions: { strict: true },
    });
    expect(new ModuleResolver().jsxFor(app)).toBe("react-jsx");
  });

  test("no tsconfig at all: undefined (the TS default is preserve)", () => {
    const app = scratch("jsx-none");
    expect(new ModuleResolver().jsxFor(app)).toBeUndefined();
  });
});

// The mechanism marker (the comment's first line) and the two key spellings
// exactly as they are emitted, indentation included: one line each, and the
// whole of the file's jsx mechanism.
const MARKER = "JSX runtime, picked by the vite the suite RUNS";
const OXC_KEY_LINE = '  oxc: { jsx: { runtime: "automatic" } },';
const ESB_KEY_LINE = '  esbuild: { jsx: "automatic" },';

function keyLineFor(key: "esbuild" | "oxc"): string {
  return key === "oxc" ? OXC_KEY_LINE : ESB_KEY_LINE;
}

/** The empty-tree config (no aliases, shims or env root) for one layout+mechanism. */
function renderConfig(outDir: string, colocate: boolean, jsxTransform?: "esbuild" | "oxc"): string {
  const files = renderUnitBrowser({
    trees: [],
    outDir,
    variants: 0,
    colocate,
    jsxTransform,
    browserSpecs: false,
  });
  return files.find((f) => f.relPath === "vitest.config.mts")?.content ?? "";
}

/**
 * The contiguous `//` block starting at the mechanism marker, plus the first
 * line after it — the mechanism key.
 */
function blockAfterMarker(content: string): { block: string; keyLine: string } {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.includes(MARKER));
  expect(start).toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  let i = start;
  for (;;) {
    const line = lines[i];
    if (line === undefined || !line.trim().startsWith("//")) break;
    block.push(line);
    i += 1;
  }
  return { block: block.join("\n"), keyLine: lines[i] ?? "" };
}

describe("renderUnitBrowser: the emitted mechanism and its one comment", () => {
  // undefined is the historical default: a caller that never computes the
  // family must keep emitting the exact esbuild bytes older versions emitted.
  for (const jsx of ["oxc", "esbuild", undefined] as const) {
    for (const colocate of [true, false] as const) {
      test(`jsxTransform=${String(jsx)} in the ${colocate ? "colocate" : "standalone"} layout`, () => {
        const app = scratch(`emit-${String(jsx)}-${colocate ? "col" : "std"}`);
        const content = renderConfig(path.join(app, "flawless"), colocate, jsx);
        const { block, keyLine } = blockAfterMarker(content);
        // The key line is exactly the one the mechanism names — and the
        // OTHER spelling appears nowhere: the comment mentions both words but
        // never as a key (`oxc: { target }` is the injected default it
        // describes, not a key this file declares).
        expect(keyLine).toBe(keyLineFor(jsx === "oxc" ? "oxc" : "esbuild"));
        expect(content.includes("oxc: { jsx")).toBe(jsx === "oxc");
        expect(content.includes("esbuild: { jsx")).toBe(jsx !== "oxc");
        // The comment is the WHOLE explanation: exactly one block, and it is
        // the shared constant, complete.
        expect(content.split(JSX_MECHANISM_COMMENT).length - 1).toBe(1);
        expect(block).toBe(JSX_MECHANISM_COMMENT);
      });
    }
  }

  test("the comment block is byte-identical between the two layouts", () => {
    for (const jsx of ["oxc", "esbuild"] as const) {
      const app = scratch(`ident-${jsx}`);
      const col = blockAfterMarker(renderConfig(path.join(app, "col"), true, jsx)).block;
      const std = blockAfterMarker(renderConfig(path.join(app, "std"), false, jsx)).block;
      expect(col).toBe(std);
    }
  });
});

describe("the guard: a host jsx shape never meets a mechanism absent for its vite", () => {
  // The jsx key ACTUALLY EFFECTIVE per vite generation, written as a literal
  // rather than derived from jsxTransformFor: a guard that recomputed the
  // switch could only prove the switch self-consistent. The entries are the
  // measurements —
  //   vite 5/6/7: esbuild is the transformer, and an explicit
  //     `esbuild: { jsx: "automatic" }` overrides any host tsconfig jsx —
  //     proven on the worst shape ("preserve", aliased-next-app's own
  //     setting) by the frozen vitest 2 execution tests staying green;
  //   vite 8: the `esbuild` key is discarded beside vitest 4/5's
  //     always-injected `oxc: { target }` (both-set warning), and the
  //     explicit `oxc: { jsx: ... }` measured green on ALL FOUR shapes
  //     below with a clean stderr.
  const EFFECTIVE_KEY: ReadonlyArray<readonly [number, "esbuild" | "oxc"]> = [
    [5, "esbuild"],
    [6, "esbuild"],
    [7, "esbuild"],
    [8, "oxc"],
  ];

  // The tsconfig `jsx` values as hosts declare them. "unset" is what TS
  // treats as preserve — the shape that kills every spec when the only
  // mechanism is absent for the vite running.
  const HOST_SHAPES: Array<{
    label: string;
    tsconfig: { compilerOptions?: { jsx?: string } };
    readback: string | undefined;
  }> = [
    { label: "preserve", tsconfig: { compilerOptions: { jsx: "preserve" } }, readback: "preserve" },
    {
      label: "react-jsx",
      tsconfig: { compilerOptions: { jsx: "react-jsx" } },
      readback: "react-jsx",
    },
    { label: "unset", tsconfig: {}, readback: undefined },
    { label: "classic", tsconfig: { compilerOptions: { jsx: "react" } }, readback: "react" },
  ];

  for (const shape of HOST_SHAPES) {
    for (const [family, effective] of EFFECTIVE_KEY) {
      test(`${shape.label} host on vite ${family}: the emitted key is the effective one`, () => {
        const app = scratch(`guard-${shape.label}-${family}`);
        writeJson(app, "tsconfig.json", shape.tsconfig);
        // The scratch tsconfig must read back as the shape it claims, or the
        // cell is not testing what its name says.
        expect(new ModuleResolver().jsxFor(app)).toBe(shape.readback);
        const jsxTransform = jsxTransformFor(family);
        const content = renderConfig(path.join(app, "flawless"), true, jsxTransform);
        expect(blockAfterMarker(content).keyLine).toBe(keyLineFor(effective));
      });
    }
  }
});
