import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCore } from "../src/core.ts";
import { suitePackageJson } from "../src/scaffold-tests/index.ts";

/**
 * The guard-exit residue fixes, by EXECUTING the emitted fixtures: a page
 * guarded by `!== routeParam` and by a membership lookup against another dep
 * must actually RENDER under the emitted mocks. The emitted RSC spec cannot
 * prove that on its own — a guard exit is a declared pass there — so the
 * probe here mounts the page with the emitted vi.mock statements verbatim and
 * asserts the page's content, then corrupts each unified value in turn and
 * expects the guard to fire again. Throw guards, not notFound(): the effect
 * classifier treats them identically, and the temp app has no next to import.
 */

const PAGE = `import { getCurrentUser, getInvoiceById, listMembershipsForBuilding } from "./data";

export default async function InvoiceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  const invoice = await getInvoiceById(id);
  if (!invoice || invoice.building_id !== id) throw new Error("not found: invoice");
  if (invoice.kind === "deleted") throw new Error("not found: deleted");
  const members = await listMembershipsForBuilding(id);
  const mine = members.find((m) => m.user_id === user.id);
  if (!mine || mine.status !== "active") throw new Error("not found: membership");
  return (
    <main>
      <h1>Invoice detail</h1>
      <p>{mine.label}</p>
      <span>{user.name}</span>
    </main>
  );
}
`;

const DATA = `export interface AppUser {
  id: string;
  name: string;
}

export interface Invoice {
  building_id: string;
  kind: string;
}

export interface Row {
  user_id: string;
  status: string;
  label: string;
}

export async function getCurrentUser(): Promise<AppUser> {
  throw new Error("the real data layer must never run under jsdom");
}

export async function getInvoiceById(id: string): Promise<Invoice | undefined> {
  throw new Error("the real data layer must never run under jsdom: " + id);
}

export async function listMembershipsForBuilding(id: string): Promise<Row[]> {
  throw new Error("the real data layer must never run under jsdom: " + id);
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

describe("guard-polarity and cross-dep fixtures, executed", () => {
  test("the emitted mocks render the page; corrupting either unified value re-fires the guard", async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "flawless-guard-exec-"));
    const app = path.join(tmpRoot, "app");
    mkdirSync(path.join(app, "src"), { recursive: true });
    writeFileSync(
      path.join(app, "tsconfig.json"),
      `${JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }, null, 2)}\n`,
    );
    writeFileSync(path.join(app, "src", "InvoiceDetail.tsx"), PAGE);
    writeFileSync(path.join(app, "src", "data.ts"), DATA);
    const outDir = path.join(app, "flawless");

    const result = await runCore({
      pattern: path.join(app, "src", "InvoiceDetail.tsx"),
      outDir,
      taskIds: ["unit-browser"],
      force: true,
      log: false,
      inlineSummary: false,
    });
    expect(result.exitCode).toBe(0);

    // Emission: both comparisons resolved into the fixture — the !== guard's
    // pass side from the route param, the lookup field from the other dep —
    // and the ===-guard value is NOT there.
    const spec = readFileSync(path.join(outDir, "unit", "InvoiceDetail.test.tsx"), "utf8");
    expect(spec).toContain('building_id: "flawless-id"');
    expect(spec).toContain('user_id: "flawless-id"');
    expect(spec).toContain('status: "active"');
    expect(spec).not.toContain('"deleted"');

    // The probe: the emitted vi.mock statements verbatim, a real mount, and
    // assertions the emitter does not make — the page's own content.
    const mockLines = spec
      .split("\n")
      .filter((l) => l.startsWith("vi.mock("))
      .join("\n");
    expect(mockLines).toContain("src/data");
    const probe = `import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type * as React from "react";
${mockLines}
import InvoiceDetail from "../../src/InvoiceDetail";

test("the emitted fixtures take the page past every guard", async () => {
  const ui: React.ReactNode = await InvoiceDetail({
    params: Promise.resolve({ id: "flawless-id" }),
  } as never);
  render(<>{ui}</>);
  expect(screen.getByText("Invoice detail")).toBeInTheDocument();
  expect(screen.getByText("flawless-label")).toBeInTheDocument();
  expect(screen.getByText("flawless-name")).toBeInTheDocument();
});
`;
    const probePath = path.join(outDir, "unit", "GuardProbe.test.tsx");
    writeFileSync(probePath, probe);

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
      throw new Error(
        `could not install the suite's runners (needs registry access):\n${installErr}`,
      );
    }
    const vitestBin = path.join(app, "node_modules", ".bin", "vitest");
    if (!existsSync(vitestBin)) throw new Error(`vitest did not install at ${vitestBin}`);
    const vitest = async (specFile: string): Promise<{ code: number; output: string }> => {
      const run = Bun.spawn([vitestBin, "run", specFile], {
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

    const green = await vitest("unit/GuardProbe.test.tsx");
    if (green.code !== 0) console.error(green.output);
    expect(green.code).toBe(0);

    // Mutation 1: un-unify the membership status — the find-result guard must
    // fire again, proving the "active" in the fixture is load-bearing.
    writeFileSync(probePath, probe.replace('status: "active"', 'status: "flawless-status"'));
    const staleStatus = await vitest("unit/GuardProbe.test.tsx");
    expect(staleStatus.code).not.toBe(0);
    expect(staleStatus.output).toContain("not found: membership");

    // Mutation 2: un-unify the cross-dep user id — the lookup must miss again.
    writeFileSync(probePath, probe.replace('user_id: "flawless-id"', 'user_id: "someone-else"'));
    const staleUser = await vitest("unit/GuardProbe.test.tsx");
    expect(staleUser.code).not.toBe(0);
    expect(staleUser.output).toContain("not found: membership");
  }, 120_000);
});
