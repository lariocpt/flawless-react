import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { analyse } from "../src/analyse/index.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";

/**
 * The single-React native pin (chanhdai: 816 failures that were not the
 * suite's fault).
 *
 * pnpm keeps a physically separate react and peer-linked react-dom under
 * every node_modules root. Vitest's aliases only reach code VITE loads — an
 * externalised @testing-library/react requires its pair through plain node
 * resolution and gets the SUITE's copies while transformed components ride
 * the alias to the app's. Two dispatchers: every mount throws "Cannot read
 * properties of null (reading 'useRef')". The fix is in setup.ts's
 * registerHooks resolve hook, so the emitted file is the contract: pin when
 * the canonical pair is known, stay silent (exactly the old setup) when it
 * is not, and redirect bare specifiers, absolute paths and .pnpm realpaths
 * alike.
 *
 * The react pair lives INSIDE each test's own sandbox directory: a fixture
 * at <sandbox>/../node_modules would sit at /tmp/node_modules, where node's
 * upward resolution would pick it up and poison every other execution test
 * running concurrently under /tmp. (It happened.)
 */

async function emitSetup(pinDir: string | undefined, outDir: string): Promise<string> {
  const tree = await analyse({
    entry: path.resolve(__dirname, "fixtures", "Card.tsx"),
    depth: 0,
    includeChildren: false,
  });
  const files = renderUnitBrowser({
    trees: [tree],
    outDir,
    variants: 1,
    reactPinDir: pinDir,
  });
  const setup = files.find((f) => f.relPath === "setup.ts");
  if (!setup) throw new Error("no setup.ts emitted");
  return setup.content;
}

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "flawless-pin-"));
}

describe("setup.ts single-React pin", () => {
  test("emitted when the canonical pair exists, relative to the suite", async () => {
    const base = await sandbox();
    const nm = path.join(base, "node_modules");
    mkdirSync(path.join(nm, "react"), { recursive: true });
    mkdirSync(path.join(nm, "react-dom"), { recursive: true });
    const outDir = path.join(base, "flawless");
    const setup = await emitSetup(nm, outDir);
    expect(setup).toContain("REACT_DIRS");
    expect(setup).toContain("flPinResolve");
    // Relocatable bytes (emitPaths invariant): the suite-relative spelling,
    // never the absolute path of the generating machine. Anchored WITHOUT
    // `new URL(".", import.meta.url)` — vite rewrites that pattern as an
    // asset import (chanhdai proved it: the pin silently degraded).
    expect(setup).toContain("fileURLToPath(import.meta.url)");
    expect(setup).not.toContain('new URL(".", import.meta.url)');
    expect(setup).toContain('../node_modules/react"');
    expect(setup).toContain('../node_modules/react-dom"');
    expect(setup).not.toContain(base);
    // Both spellings of the split: bare specifiers AND .pnpm realpaths.
    expect(setup).toContain("^(react|react-dom)");
    expect(setup).toContain(".pnpm");
  });

  test("silent when reactPinDir is absent — the old setup, byte for byte", async () => {
    const setup = await emitSetup(undefined, await sandbox());
    expect(setup).not.toContain("REACT_DIRS");
    expect(setup).not.toContain("flPinResolve");
    expect(setup).not.toContain("__flFs");
    // The font/navigation hook this grew out of is untouched.
    expect(setup).toContain("registerHooks");
  });

  test("silent when the pin directory carries no react pair", async () => {
    // dir exists but holds neither package: emitting would redirect loads
    // onto a path that cannot stat, so the generator declines instead.
    const setup = await emitSetup(await sandbox(), await sandbox());
    expect(setup).not.toContain("REACT_DIRS");
  });

  test("the pinned setup.ts parses", async () => {
    const base = await sandbox();
    const nm = path.join(base, "node_modules");
    mkdirSync(path.join(nm, "react"), { recursive: true });
    mkdirSync(path.join(nm, "react-dom"), { recursive: true });
    const setup = await emitSetup(nm, path.join(base, "flawless"));
    const sf = ts.createSourceFile(
      "setup.ts",
      setup,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics;
    expect(
      (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
    ).toEqual([]);
  });
});
