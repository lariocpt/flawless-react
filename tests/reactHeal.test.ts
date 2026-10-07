import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { healReactIdentity } from "../src/runner/runTests.ts";

// The suite tree must not contain a second physical react: node's require
// cache is keyed by realpath, so an installed copy beside the app's is a
// second hook dispatcher no alias can erase (aurorascharff: 56 specs red on
// "Cannot read properties of null (reading 'useContext')" until the copies
// converged).

let root: string;
let app: string;
let suite: string;

function pkgJson(dir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: path.basename(dir), version: "0.0.0", ...extra }),
  );
}

/** A REAL directory copy of react (not a symlink) — the second instance. */
function installCopy(nm: string, name: string, version = "1.2.3"): void {
  const dir = path.join(nm, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "index.js"), `module.exports = { copy: "${nm}" };`);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flawless-heal-"));
  app = path.join(root, "app");
  suite = path.join(app, "flawless");
  pkgJson(app, { dependencies: { react: "1.2.3" } });
  mkdirSync(path.join(app, "node_modules"), { recursive: true });
  installCopy(path.join(app, "node_modules"), "react");
  installCopy(path.join(app, "node_modules"), "react-dom");
  pkgJson(suite);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("healReactIdentity", () => {
  test("replaces the suite's installed copies with links onto the app's copy", () => {
    installCopy(path.join(suite, "node_modules"), "react");
    installCopy(path.join(suite, "node_modules"), "react-dom");
    const healed = healReactIdentity(suite);
    expect(healed.sort()).toEqual(["node_modules/react", "node_modules/react-dom"]);
    expect(realpathSync(path.join(suite, "node_modules", "react"))).toBe(
      realpathSync(path.join(app, "node_modules", "react")),
    );
    // The app's copy survives untouched — the repair points AT it.
    expect(existsSync(path.join(app, "node_modules", "react", "index.js"))).toBe(true);
  });

  test("relinks pnpm's @testing-library peer copies, where RTL actually renders", () => {
    const peer = path.join(
      suite,
      "node_modules",
      ".pnpm",
      "@testing-library+react@16.0.0",
      "node_modules",
    );
    installCopy(peer, "react");
    installCopy(peer, "react-dom");
    const healed = healReactIdentity(suite);
    expect(healed.length).toBe(2);
    expect(realpathSync(path.join(peer, "react"))).toBe(
      realpathSync(path.join(app, "node_modules", "react")),
    );
  });

  test("is silent when identity already holds, and when the app has no react", () => {
    const nm = path.join(suite, "node_modules");
    mkdirSync(nm, { recursive: true });
    symlinkSync(path.join(app, "node_modules", "react"), path.join(nm, "react"));
    expect(healReactIdentity(suite)).toEqual([]);
    rmSync(path.join(app, "node_modules", "react"), { recursive: true });
    rmSync(path.join(app, "node_modules", "react-dom"), { recursive: true });
    expect(healReactIdentity(suite)).toEqual([]);
  });

  test("links are relative, so a moved checkout keeps healing", () => {
    installCopy(path.join(suite, "node_modules"), "react");
    healReactIdentity(suite);
    const link = readlinkSync(path.join(suite, "node_modules", "react"));
    expect(link.startsWith("..")).toBe(true);
  });

  test("never collapses copies that disagree on version", () => {
    // react-dom@N renders only react@N: an older suite pinned beside a
    // newer app must keep its own pair rather than crash on the link.
    installCopy(path.join(suite, "node_modules"), "react", "9.9.9");
    installCopy(path.join(suite, "node_modules"), "react-dom", "9.9.9");
    expect(healReactIdentity(suite)).toEqual([]);
    expect(realpathSync(path.join(suite, "node_modules", "react"))).not.toBe(
      realpathSync(path.join(app, "node_modules", "react")),
    );
  });
});
