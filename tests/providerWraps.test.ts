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
  // radix namespace shape: no <N.Provider> renderer exists anywhere — the
  // <N.Root> renderer IS the compound's provider (chanhdai's dialog.tsx).
  "dialog.tsx": `
import { Dialog as DialogPrimitive } from 'radix-ui';
export function Dialog(props: Record<string, unknown>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}
export function DialogTrigger(props: Record<string, unknown>) {
  return <DialogPrimitive.Trigger {...props} />;
}
export function DialogPortal(props: Record<string, unknown>) {
  return <DialogPrimitive.Portal {...props} />;
}
`,
  // A provider that requires props beyond children cannot MOUNT BARE: the
  // wrap supplies undefined and the consumer's context check throws right
  // back out. A destructuring default rescues the same shape.
  "chart.tsx": `
import * as React from 'react';
interface ChartContextValue { series: number[] }
const ChartContext = React.createContext<ChartContextValue | null>(null);
export function ChartProvider({ children, value }: { children: React.ReactNode; value: ChartContextValue }) {
  return <ChartContext.Provider value={value}>{children}</ChartContext.Provider>;
}
export function useChart(): ChartContextValue {
  const c = React.useContext(ChartContext);
  if (!c) throw new Error('useChart must be used within a ChartProvider');
  return c;
}
export function XAxis() {
  const ctx = useChart();
  return <g data-len={ctx.series.length} />;
}
const TileContext = React.createContext<string[]>([]);
export function TiledProvider({ children, tiles = [] }: { children?: React.ReactNode; tiles: string[] }) {
  return <TileContext.Provider value={tiles}>{children}</TileContext.Provider>;
}
export { TiledProvider as TiledPublic };
export function useTiled(): string[] {
  return React.useContext(TileContext);
}
export function TileGrid() {
  const tiles = useTiled();
  return <div>{tiles.length}</div>;
}
`,
  // The provider breaks the useX → XProvider name convention (chanhdai's
  // useCollapsible ← CollapsibleWithContext): only the context object both
  // sides mention can pair them. AccPanel reaches it through a second local
  // hook, so the pairing must close over local hook calls.
  "accordion.tsx": `
import * as React from 'react';
type AccCtx = { idx: number };
const AccContext = React.createContext<AccCtx | null>(null);
export function AccordionRoot({ children }: { children?: React.ReactNode }) {
  const [idx] = React.useState(0);
  return <AccContext.Provider value={{ idx }}>{children}</AccContext.Provider>;
}
const useAccIndex = (): AccCtx => {
  const ctx = React.useContext(AccContext);
  if (!ctx) throw new Error('useAccIndex must be used within AccordionRoot');
  return ctx;
};
const useAccAnimation = () => {
  const { idx } = useAccIndex();
  return idx;
};
export function AccPanel() {
  const idx = useAccAnimation();
  return <div>{idx}</div>;
}
export function AccBadge() {
  const ctx = useAccIndex();
  return <span>{ctx.idx}</span>;
}
`,
  // The nakama shape, split across three files: the context object lives on
  // its own, the provider renders the IMPORTED object, and the hook reads it
  // from a third file — no naming convention reaches across, only the
  // context object's (module, name) pairs hook with provider.
  "auth-context-shared.ts": `
import { createContext } from 'react';
export const AuthContext = createContext<string | null>(null);
`,
  "auth-context.tsx": `
import * as React from 'react';
import { AuthContext } from './auth-context-shared';
export function AuthProvider({ children }: { children?: React.ReactNode }) {
  return <AuthContext.Provider value='lario'>{children}</AuthContext.Provider>;
}
`,
  "use-auth.ts": `
import { useContext } from 'react';
import { AuthContext } from './auth-context-shared';
export function useAuth(): string {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
`,
  "auth-consumer.tsx": `
import { useAuth } from './use-auth';
export function WhoAmI() {
  return <span>{useAuth()}</span>;
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
      // Context/hook modules carry no component — a real run's glob skips them
      // with a note; here they only need to exist on disk for imports.
      const own = await analyseFile(
        { entry, depth: 3, includeChildren: true, roots: "exported" },
        { cache: new SourceFileCache() },
      ).catch(() => []);
      trees.push(...own);
    }
    return await deriveContextProviderWraps(trees, new SourceFileCache());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const names = (refs: ProviderRef[] | undefined): string[] =>
  (refs ?? []).map((r) => r.componentName);

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

  test("radix namespace: the N.Root renderer IS the provider", async () => {
    // chanhdai's dialog parts threw "DialogPortal must be used within Dialog"
    // — the file renders <DialogPrimitive.Root> nowhere near the .Provider
    // shape, so only the Root-as-provider reading derives the wrap.
    const wraps = await derive();
    const portal = [...wraps.keys()].find((k) => k.endsWith("::DialogPortal"));
    expect(names(wraps.get(portal!))).toEqual(["Dialog"]);
    const trigger = [...wraps.keys()].find((k) => k.endsWith("::DialogTrigger"));
    expect(names(wraps.get(trigger!))).toEqual(["Dialog"]);
    // The Root renderer provides its own context; it never gets wrapped.
    expect([...wraps.keys()].some((k) => k.endsWith("::Dialog"))).toBe(false);
  });

  test("a provider that cannot mount bare is no provider", async () => {
    const wraps = await derive();
    // <ChartProvider> mounted with no value provides undefined — the wrap
    // would only relocate the consumer's context throw, so no wrap at all.
    expect([...wraps.keys()].some((k) => k.endsWith("::XAxis"))).toBe(false);
    // The destructuring default genuinely rescues the identical shape.
    const grid = [...wraps.keys()].find((k) => k.endsWith("::TileGrid"));
    expect(names(wraps.get(grid!))).toEqual(["TiledProvider"]);
  });

  test("provider refs carry the re-export alias", async () => {
    // chanhdai's collapsible: CollapsibleWithContext leaves its module as
    // `Collapsible`. A wrap importing the internal name renders undefined.
    const wraps = await derive();
    const grid = [...wraps.keys()].find((k) => k.endsWith("::TileGrid"));
    const ref = wraps.get(grid!)?.[0];
    expect(ref?.componentName).toBe("TiledProvider");
    expect(ref?.exportedAs).toBe("TiledPublic");
  });

  test("the context object pairs hook and provider when the name misses", async () => {
    const wraps = await derive();
    const panel = [...wraps.keys()].find((k) => k.endsWith("::AccPanel"));
    expect(names(wraps.get(panel!))).toEqual(["AccordionRoot"]);
    const badge = [...wraps.keys()].find((k) => k.endsWith("::AccBadge"));
    expect(names(wraps.get(badge!))).toEqual(["AccordionRoot"]);
    // The supplier itself is never wrapped by its own context.
    expect([...wraps.keys()].some((k) => k.endsWith("::AccordionRoot"))).toBe(false);
  });

  test("the context object pairs hook and provider across separate files", async () => {
    // nakama's useAuth: hook in use-auth.ts, AuthProvider renders
    // <AuthContext.Provider> in auth-context.tsx, both mention the AuthContext
    // object from auth-context-shared. The naming convention misses inside the
    // hook's module; only the resolved (module, name) of the context joins them.
    const wraps = await derive();
    const who = [...wraps.keys()].find((k) => k.endsWith("::WhoAmI"));
    expect(names(wraps.get(who!))).toEqual(["AuthProvider"]);
    expect(wraps.get(who!)?.[0]?.filePath.endsWith("auth-context.tsx")).toBe(true);
    // The provider itself is not wrapped by its own context.
    expect([...wraps.keys()].some((k) => k.endsWith("::AuthProvider"))).toBe(false);
  });

  test("providerKey matches the map keys the hostRegistry consumes", async () => {
    const wraps = await derive();
    const sidebar = [...wraps.keys()].find((k) => k.endsWith("::SidebarTrigger"))!;
    expect(sidebar.endsWith(providerKey({ filePath: "", componentName: "SidebarTrigger" }))).toBe(
      true,
    );
  });
});
