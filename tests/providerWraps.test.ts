import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyseFile } from "../src/analyse/index.ts";
import { deriveContextProviderWraps, providerKey } from "../src/analyse/providerWraps.ts";
import { SourceFileCache } from "../src/analyse/sourceCache.ts";
import type { ComponentTree, ProviderRef } from "../src/types.ts";

/**
 * The kiranism dogfood made these three failure classes concrete: Sidebar-
 * family components mounted with "useSidebar must be used within a
 * SidebarProvider" (hook evidence, and the layout that supplies it is a route
 * file no entry imports), cmdk parts throwing on an undefined store
 * (namespace compound), and AppSidebar failing through a CHILD that calls the
 * hook (transitive requirement). The fixtures below mirror those shapes.
 */

const FILES: Record<string, string> = {
  // The shadcn shape: provider, hook, and consumers co-located in one file.
  "sidebar.tsx": `
import * as React from 'react';
interface SidebarContextState { state: string; toggle: () => void }
const SidebarContext = React.createContext<SidebarContextState | null>(null);
export function useSidebar(): SidebarContextState {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used within a SidebarProvider');
  return ctx;
}
export function SidebarProvider({ children }: { children?: React.ReactNode }) {
  const [state, setState] = React.useState('closed');
  const toggle = () => setState((s) => (s === 'open' ? 'closed' : 'open'));
  return <SidebarContext.Provider value={{ state, toggle }}>{children}</SidebarContext.Provider>;
}
export function Sidebar({ children }: { children?: React.ReactNode }) {
  const { state } = useSidebar();
  return <aside data-state={state}>{children}</aside>;
}
export function SidebarTrigger() {
  const { toggle } = useSidebar();
  return <button onClick={toggle}>toggle</button>;
}
`,
  // Consumer of the hook via an ALIASED cross-file import, plus AppSidebar:
  // never calls the hook itself, renders <Sidebar> which does.
  "chrome.tsx": `
import { Sidebar } from './sidebar';
import { useSidebar as useSb } from './sidebar';
export function AppSidebar() {
  return <Sidebar>hi</Sidebar>;
}
export function AliasUser() {
  const { state } = useSb();
  return <div>{state}</div>;
}
`,
  // cmdk shape: third-party namespace, one component renders it bare, the
  // rest render members of it. "cmdk" is not installed — namespace derivation
  // never resolves it, only reads the import as written.
  "cmd.tsx": `
import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
export function Command(props: Record<string, unknown>) {
  return <CommandPrimitive {...props} />;
}
export function CommandInput() {
  return <div className="wrap"><CommandPrimitive.Input /></div>;
}
export function CommandList() {
  return <CommandPrimitive.List />;
}
`,
  // base-ui shape: the provider is a <N.Provider> renderer; a component that
  // mounts its own provider (Toaster) must NOT get a second one nested.
  "toast.tsx": `
import { Toast as ToastPrimitive } from '@base-ui/react/toast';
export function ToastProvider(props: Record<string, unknown>) {
  return <ToastPrimitive.Provider {...props} />;
}
export function Toast() {
  return <ToastPrimitive.Root />;
}
export function Toaster() {
  return <ToastProvider><ToastPrimitive.Viewport /></ToastProvider>;
}
`,
  // A bare external icon with no member siblings is a leaf, not a provider
  // namespace — the pairing requirement keeps icon imports out.
  "icons.tsx": `
import { IconX } from '@tabler/icons-react';
export function Closer() {
  return <IconX />;
}
`,
};

async function derive(): Promise<Map<string, ProviderRef[]>> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "provwraps-"));
  try {
    const entries: string[] = [];
    for (const [name, content] of Object.entries(FILES)) {
      const file = path.join(dir, name);
      writeFileSync(file, content);
      entries.push(file);
    }
    const trees: ComponentTree[] = [];
    for (const entry of entries) {
      trees.push(
        ...(await analyseFile(
          { entry, depth: 3, includeChildren: true, roots: "exported" },
          { cache: new SourceFileCache() },
        )),
      );
    }
    return await deriveContextProviderWraps(trees, new SourceFileCache());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const names = (refs: ProviderRef[] | undefined): string[] => (refs ?? []).map((r) => r.componentName);

describe("deriveContextProviderWraps", () => {
  test("same-file hook call finds the co-located provider", async () => {
    const wraps = await derive();
    const trigger = [...wraps.keys()].find((k) => k.endsWith("::SidebarTrigger"));
    expect(trigger).toBeDefined();
    const refs = wraps.get(trigger!);
    expect(names(refs)).toEqual(["SidebarProvider"]);
    expect(refs![0]!.filePath.endsWith("sidebar.tsx")).toBe(true);
    expect(refs![0]!.exportKind).toBe("named");
  });

  test("cross-file call resolves through the import, alias included", async () => {
    const wraps = await derive();
    const alias = [...wraps.keys()].find((k) => k.endsWith("::AliasUser"));
    expect(names(wraps.get(alias!))).toEqual(["SidebarProvider"]);
  });

  test("transitive: the ancestor inherits what its child requires", async () => {
    const wraps = await derive();
    const app = [...wraps.keys()].find((k) => k.endsWith("::AppSidebar"));
    expect(names(wraps.get(app!))).toEqual(["SidebarProvider"]);
  });

  test("cmdk shape: bare renderer wraps the member consumers", async () => {
    const wraps = await derive();
    const input = [...wraps.keys()].find((k) => k.endsWith("::CommandInput"));
    expect(names(wraps.get(input!))).toEqual(["Command"]);
    const list = [...wraps.keys()].find((k) => k.endsWith("::CommandList"));
    expect(names(wraps.get(list!))).toEqual(["Command"]);
    // The provider itself never gets wrapped in itself.
    expect([...wraps.keys()].some((k) => k.endsWith("::Command") && !k.endsWith("Input"))).toBe(
      false,
    );
  });

  test("base-ui shape: the N.Provider renderer wins, self-providers stay bare", async () => {
    const wraps = await derive();
    const toast = [...wraps.keys()].find((k) => k.endsWith("::Toast"));
    expect(names(wraps.get(toast!))).toEqual(["ToastProvider"]);
    // Toaster renders <ToastProvider> itself — nesting a second provider can
    // actively break it (the kiranism Toaster passes because it is NOT
    // wrapped), and the provider component itself is never wrapped.
    expect([...wraps.keys()].some((k) => k.endsWith("::Toaster"))).toBe(false);
    expect([...wraps.keys()].some((k) => k.endsWith("::ToastProvider"))).toBe(false);
  });

  test("bare icon imports are leaves, not providers", async () => {
    const wraps = await derive();
    expect([...wraps.keys()].some((k) => k.endsWith("::Closer"))).toBe(false);
  });

  test("providerKey matches the map keys the hostRegistry consumes", async () => {
    const wraps = await derive();
    const sidebar = [...wraps.keys()].find((k) => k.endsWith("::SidebarTrigger"))!;
    expect(sidebar.endsWith(providerKey({ filePath: "", componentName: "SidebarTrigger" }))).toBe(
      true,
    );
  });
});
