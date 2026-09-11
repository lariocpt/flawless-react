// The second layer under the guard-exit residue: once the polarity round let
// the detail pages render, two masked defects surfaced on the dogfood app —
// a child crashing on `ALLOWED_TRANSITIONS["flawless-status"]`, and a page
// rendering an async server child that a client render cannot mount.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyseFile, createAnalyseSharedContext } from "../src/analyse/index.ts";
import { emitModuleMocks } from "../src/scaffold-tests/mocks.ts";
import type { ComponentInfo } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures/rsc");

async function infoFor(fixture: string): Promise<ComponentInfo> {
  const trees = await analyseFile(
    { entry: path.join(FIXTURES, fixture), depth: 1, includeChildren: false, roots: "exported" },
    createAnalyseSharedContext(),
  );
  const first = trees[0];
  if (!first) throw new Error(`${fixture} produced no component`);
  return first.entry;
}

describe("annotation values fill placeholder fields of a usage-shaped dep", () => {
  test("a literal-union field takes the annotation's member", async () => {
    // Usage reads `job.status` only into a lookup — no comparison, no legal
    // value. The annotation's `"open" | "closed"` names one, and the fixture
    // takes it: the child indexing a Record by this field crashes on the
    // "flawless-status" placeholder.
    const info = await infoFor("EnumFillPage.tsx");
    const mocks = emitModuleMocks(info, "rsc").statements.join("\n");
    expect(mocks).toContain('status: "open"');
  });

  test("a generic-string annotation does NOT replace the name-seeded default", async () => {
    // resolveTypeNodeValue seeds plain strings as another "flawless-" value;
    // swapping one placeholder for a worse-named one gains nothing, and the
    // name-seeded synthesis reads better in a failure.
    const info = await infoFor("EnumFillPage.tsx");
    const mocks = emitModuleMocks(info, "rsc").statements.join("\n");
    expect(mocks).toContain('note: "flawless-note"');
  });

  test("usage testimony still outranks the annotation", async () => {
    // The polarity/equals rounds' values win over fill: a field the source
    // compares keeps the compared value. GuardPolarityPage's status carries
    // equals "active" from its guard, and the annotation channel must not
    // disturb it.
    const info = await infoFor("GuardPolarityPage.tsx");
    const mocks = emitModuleMocks(info, "rsc").statements.join("\n");
    expect(mocks).toContain('status: "active"');
  });
});

describe("async server children are stubbed, sync children stay real", () => {
  test("the async child's module mocks to null-rendering stubs", async () => {
    const info = await infoFor("AsyncParentPage.tsx");
    const mi = (info.moduleImports ?? []).find((m) => m.specifier === "./AsyncChild.tsx");
    expect(mi?.asyncComponents).toEqual(["AsyncChild"]);
    const mocks = emitModuleMocks(info, "rsc").statements.join("\n");
    expect(mocks).toContain("AsyncChild: () => null");
  });

  test("the sync child is not mocked at all", async () => {
    const info = await infoFor("AsyncParentPage.tsx");
    const mi = (info.moduleImports ?? []).find((m) => m.specifier === "./SyncChild.tsx");
    expect(mi?.asyncComponents).toBeUndefined();
    const mocks = emitModuleMocks(info, "rsc").statements.join("\n");
    expect(mocks).not.toContain("SyncChild");
  });
});
