import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * Defect #4 end to end, by EXECUTING the emitted specs (Chunk 4 of
 * DOGFOOD-0.3.1-FIX-PLAN.md).
 *
 * Three claims, each with a guard-the-guard:
 *  - a SYNC component's `const toasts = useToasts(); toasts.map(...)` emits
 *    a SYNC array mock — and the spec that used to die with
 *    "toasts.map is not a function" now passes;
 *  - a genuinely awaited dep keeps its async mock (no regression), and its
 *    spec passes too;
 *  - one module imported by two components gets ONE factory covering BOTH
 *    names — a mocked module serves every importer in the render.
 */

const TOASTS = `export interface Toast { id: number; text: string }
// A top-level call keeps this module off the pure-module exemption — the
// fixture's selectors.ts is impure the same way (it imports the provider),
// and a pure module is correctly left REAL with no mock at all.
function makeToastList(): Toast[] {
  return [];
}
const toastList = makeToastList();
export function useToasts() {
  return toastList;
}

export function useNotes() {
  return [];
}
`;

const INBOX = `"use client";
import { useToasts } from "./lib/toasts";

export function InboxList() {
  const toasts = useToasts();
  return (
    <ul>
      {toasts.map((t) => (
        <li key={t.id}>{t.text}</li>
      ))}
    </ul>
  );
}
`;

const NOTES = `"use client";
import { useNotes } from "./lib/toasts";

export function NotesList() {
  const notes = useNotes();
  return <div>{notes.length}</div>;
}
`;

const FEED = `import { InboxList } from "./Inbox";
import { NotesList } from "./Notes";

export default async function Feed() {
  return (
    <main>
      <h1>Feed</h1>
      <InboxList />
      <NotesList />
    </main>
  );
}
`;

const REMOTE = `export async function loadRemote() {
  throw new Error("the real remote must never run under jsdom");
}
`;

const REPORT_PANEL = `import { loadRemote } from "./remote";

export default async function ReportPanel() {
  const rows = await loadRemote();
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.name}>{r.name}</li>
      ))}
    </ul>
  );
}
`;

function suitePins(): string[] {
  const pkg = JSON.parse(suitePackageJson("/x/flawless", false)) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  return [
    "react",
    "react-dom",
    "vitest",
    "jsdom",
    "@testing-library/react",
    "@testing-library/user-event",
    "@testing-library/jest-dom",
  ].map((name) => {
    const range = all[name];
    if (range === undefined) throw new Error(`the emitted suite no longer pins ${name}`);
    return `${name}@${range}`;
  });
}

let tmpRoot: string | undefined;

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("sync-hook mocks, executed", () => {
  test("the hook spec passes with a sync array fixture; the awaited dep keeps async", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-hook-exec-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src", "lib"), { recursive: true });
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(app, "src", "lib", "toasts.ts"), TOASTS);
    writeFileSync(path.join(app, "src", "Inbox.tsx"), INBOX);
    writeFileSync(path.join(app, "src", "Notes.tsx"), NOTES);
    writeFileSync(path.join(app, "src", "Feed.tsx"), FEED);
    writeFileSync(path.join(app, "src", "remote.ts"), REMOTE);
    writeFileSync(path.join(app, "src", "ReportPanel.tsx"), REPORT_PANEL);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "*.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // Emission: the sync hook call site produced a SYNC array fixture — the
    // shape comes from the `.map` use site in a component that records no
    // awaited deps at all (mockDeps channel). One element, not []: the
    // documented mockLiteral contract — an empty array lets a mapped render
    // pass while witnessing nothing.
    const feed = readFileSync(path.join(outDir, "unit", "Feed.test.tsx"), "utf8");
    expect(feed).toMatch(/useToasts: vi\.fn\(\(\) => \(?\[\{/);
    expect(feed).not.toMatch(/useToasts: vi\.fn\(async/);
    // One module, two importers (Inbox's useToasts, Notes' useNotes): the
    // factory replaces the whole module, so it must carry BOTH names or the
    // second importer dies on a missing export.
    expect(feed).toContain("useNotes: vi.fn(");
    expect(feed).not.toMatch(/useNotes: vi\.fn\(async/);
    // The genuinely awaited dep keeps its async mock — no regression.
    const panel = readFileSync(path.join(outDir, "unit", "ReportPanel.test.tsx"), "utf8");
    expect(panel).toMatch(/loadRemote: vi\.fn\(async \(\) => \(?\[/);

    const install = Bun.spawn(["bun", "add", "-d", ...suitePins()], {
      cwd: app,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [installErr, installCode] = await Promise.all([
      new Response(install.stderr).text(),
      install.exited,
    ]);
    if (installCode !== 0) {
      throw new Error(`could not install the suite's runners:\n${installErr}`);
    }
    const vitestBin = path.join(app, "node_modules", ".bin", "vitest");
    if (!existsSync(vitestBin)) throw new Error("vitest did not install");
    const vitest = async (spec: string): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn([vitestBin, "run", spec], {
        cwd: outDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(run.stdout).text(),
        new Response(run.stderr).text(),
        run.exited,
      ]);
      return { code, output: out + err };
    };

    // The render that used to die with "toasts.map is not a function".
    const feedRun = await vitest("unit/Feed.test.tsx");
    if (feedRun.code !== 0) console.error(feedRun.output);
    expect(feedRun.code).toBe(0);
    // Guard-the-guard: the awaited-dep spec really executes the component —
    // loadRemote's real body throws, so a green run proves the async mock held.
    const panelRun = await vitest("unit/ReportPanel.test.tsx");
    if (panelRun.code !== 0) console.error(panelRun.output);
    expect(panelRun.code).toBe(0);
  }, 240_000);
});
