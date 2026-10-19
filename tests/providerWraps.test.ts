import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyseFile } from "../src/analyse/index.ts";
import {
  deriveContextProviderWraps,
  type LibraryProviderShim,
  libraryProviderShimsFor,
  libraryShimSource,
  providerKey,
  referencedLibraryShims,
} from "../src/analyse/providerWraps.ts";
import { ModuleResolver } from "../src/analyse/resolveModule.ts";
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
  // invoify's toast.tsx: the provider is not a component at all but an ALIAS of
  // the namespace member (`const ToastProvider = ToastPrimitives.Provider`,
  // re-exported in a list). Toast renders ToastPrimitives.Root, so a file full
  // of members looked unwrappable while exporting exactly the provider that
  // wraps them — every Toast/Toaster spec died on "must be used within
  // ToastProvider". An alias the file does not export is no wrap either: an
  // import is the only way the generated mount reaches it, so ToastAction's
  // HIDDEN alias must not be offered for Alert's members.
  "shadcn-toast.tsx": `
import * as ToastPrimitives from '@radix-ui/react-toast';
const ToastProvider = ToastPrimitives.Provider;
export function Toast(props: Record<string, unknown>) {
  return <ToastPrimitives.Root {...props} />;
}
export function ToastViewport() {
  return <ToastPrimitives.Viewport />;
}
const HIDDEN = ToastPrimitives.Provider;
export function ToastAction() {
  return <ToastPrimitives.Action />;
}
export { ToastProvider, ToastAction };
`,
  "alert.tsx": `
import * as AlertPrimitives from '@radix-ui/react-alert-dialog';
const UNEXPORTED = AlertPrimitives.Provider;
export function Alert(props: Record<string, unknown>) {
  return <AlertPrimitives.Root {...props} />;
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
  // The library-context shape (nakama): the hook comes from node_modules,
  // so NOTHING in the project pairs with it — only the shim table can
  // synthesise the provider these hooks demand at mount.
  "post-list.tsx": `
import { useQuery } from '@tanstack/react-query';
export function PostList() {
  const { data = [] } = useQuery({ queryKey: ['posts'], queryFn: () => fetch('/api/posts').then((r) => r.json()) });
  return <ul>{data.length}</ul>;
}
export function PostPage() {
  return <PostList />;
}
`,
  // The TelegramAllowedUsersDialog shape: the component never names the
  // library hook at all — a project wrapper hook calls it internally.
  "use-save-settings.ts": `
import { useMutation } from '@tanstack/react-query';
export function useSaveSettings() {
  return useMutation({ mutationFn: (v: string) => fetch('/api/s').then((r) => r.json()) });
}
`,
  "settings-form.tsx": `
import { useSaveSettings } from './use-save-settings';
export function SettingsForm() {
  const save = useSaveSettings();
  return <button onClick={() => save.mutate('x')}>Save</button>;
}
`,
  // Two levels deep (the McpServerDialog shape): component → local hook →
  // imported hook in a third file → the library.
  "detail-queries.ts": `
import { useQuery } from '@tanstack/react-query';
export function useDetailQuery(id: string) {
  return useQuery({ queryKey: ['d', id], queryFn: () => fetch('/api/d').then((r) => r.json()) });
}
`,
  "use-dialog-state.ts": `
import { useState } from 'react';
import { useDetailQuery } from './detail-queries';
export function useDialogState() {
  const [open, setOpen] = useState(false);
  const detail = useDetailQuery('x');
  return { open, setOpen, detail };
}
`,
  "dialog-shell.tsx": `
import { useDialogState } from './use-dialog-state';
export function DialogShell() {
  const s = useDialogState();
  return <div onClick={() => s.setOpen(true)}>{s.open ? 'open' : 'closed'}</div>;
}
`,
  // The nakama SPA shape: the router context belongs to router-dom itself,
  // and CommandPalette-style components die at mount without it.
  "palette.tsx": `
import { useNavigate } from 'react-router-dom';
export function Palette() {
  const nav = useNavigate();
  return <button onClick={() => nav('/x')}>go</button>;
}
`,
  // saleor's react-intl shape: the component renders the library's COMPONENT
  // and calls no hook of the library at all — the hook walk cannot see it, and
  // "[React Intl] Could not find required `intl` object" is what the mount
  // says. Aliased on the way in, because that is how half of saleor writes it.
  "greeting.tsx": `
import { FormattedMessage as Msg } from 'react-intl';
export function Greeting() {
  return <p><Msg id="hi" defaultMessage="Hi" /></p>;
}
`,
  // react-router's core is re-exported through react-router-dom (v5, v6) and
  // became the only home in v7, so the same <Link> arrives under either name —
  // and rendering it needs the router exactly like calling useNavigate does.
  "crumb.tsx": `
import { Link } from 'react-router';
export function Crumb() {
  return <Link to="/x">x</Link>;
}
`,
  // Chakra's (and styled-components') polymorphic `as` is a render that no JSX
  // tag names: <Button as={Link}> mounts react-router-dom's Link and dies at
  // the missing router exactly like a bare <Link> would. tonkeeper/ton-console:
  // 7 files write it, and every spec of those components failed with
  // `Cannot destructure property 'basename' of useContext(...) as it is null`.
  "cta.tsx": `
import { Link } from 'react-router-dom';
import { Button } from '@chakra-ui/react';
export function Cta() {
  return <Button as={Link} to="/x">x</Button>;
}
`,
  // MUI's slot maps put the component one level inside an object literal.
  "mui-anchor.tsx": `
import { Link } from 'react-router-dom';
import { Typography } from '@mui/material';
export function Anchor() {
  return <Typography slots={{ root: Link }}>x</Typography>;
}
`,
  // The negatives. `as="a"` names an HTML tag and `as={Card}` names a project
  // component: neither is a provider-gated library import, so neither may ask
  // for a provider it has no business needing.
  "plain.tsx": `
import { Button } from '@chakra-ui/react';
const Card = () => <div />;
export function Plain() {
  return <Button as="a" href="/x">x</Button>;
}
export function Composed() {
  return <Button as={Card}>x</Button>;
}
`,
};

async function derive(
  shims?: (c: { info: { filePath: string } }) => LibraryProviderShim[],
  inspect?: (dir: string, wraps: Map<string, ProviderRef[]>) => void,
): Promise<Map<string, ProviderRef[]>> {
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
        { cache: new SourceFileCache(), resolver: new ModuleResolver() },
      ).catch(() => []);
      trees.push(...own);
    }
    const wraps = await deriveContextProviderWraps(trees, new SourceFileCache(), shims);
    inspect?.(dir, wraps);
    return wraps;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const names = (refs: ProviderRef[] | undefined): string[] =>
  (refs ?? []).map((r) => r.componentName);

/** The wrap entry for the component whose key ends with `suffix`, loudly:
 *  a missing key is the finding, not something to `!` past into undefined. */
const refsof = (wraps: Map<string, ProviderRef[]>, suffix: string): ProviderRef[] => {
  const key = [...wraps.keys()].find((k) => k.endsWith(suffix));
  if (key === undefined) throw new Error(`no wrap key ending in "${suffix}"`);
  const refs = wraps.get(key);
  if (refs === undefined) throw new Error(`wrap key "${key}" has no refs`);
  return refs;
};

describe("deriveContextProviderWraps", () => {
  test("same-file hook call finds the co-located provider", async () => {
    const wraps = await derive();
    const refs = refsof(wraps, "::SidebarTrigger");
    expect(names(refs)).toEqual(["SidebarProvider"]);
    expect(refs[0]?.filePath.endsWith("sidebar.tsx")).toBe(true);
    expect(refs[0]?.exportKind).toBe("named");
  });

  test("cross-file call resolves through the import, alias included", async () => {
    const wraps = await derive();
    expect(names(refsof(wraps, "::AliasUser"))).toEqual(["SidebarProvider"]);
  });

  test("transitive: the ancestor inherits what its child requires", async () => {
    const wraps = await derive();
    expect(names(refsof(wraps, "::AppSidebar"))).toEqual(["SidebarProvider"]);
  });

  test("cmdk shape: bare renderer wraps the member consumers", async () => {
    const wraps = await derive();
    expect(names(refsof(wraps, "::CommandInput"))).toEqual(["Command"]);
    expect(names(refsof(wraps, "::CommandList"))).toEqual(["Command"]);
    // The provider itself never gets wrapped in itself.
    expect([...wraps.keys()].some((k) => k.endsWith("::Command") && !k.endsWith("Input"))).toBe(
      false,
    );
  });

  test("base-ui shape: the N.Provider renderer wins, self-providers stay bare", async () => {
    const wraps = await derive();
    expect(names(refsof(wraps, "::Toast"))).toEqual(["ToastProvider"]);
    // Toaster renders <ToastProvider> itself — nesting a second provider can
    // actively break it (the kiranism Toaster passes because it is NOT
    // wrapped), and the provider component itself is never wrapped.
    expect([...wraps.keys()].some((k) => k.endsWith("::Toaster"))).toBe(false);
    expect([...wraps.keys()].some((k) => k.endsWith("::ToastProvider"))).toBe(false);
  });

  test("an exported alias of N.Provider wraps the members", async () => {
    // invoify's toast.tsx: `const ToastProvider = ToastPrimitives.Provider` is
    // the provider, and it is not a component, so no unit renders it. Toast
    // renders <ToastPrimitives.Root>, which CONSUMES that context — so every
    // member of the file, Root included, needs the alias mounted around it.
    const wraps = await derive();
    expect(names(refsof(wraps, "::Toast"))).toEqual(["ToastProvider"]);
    expect(names(refsof(wraps, "::ToastViewport"))).toEqual(["ToastProvider"]);
    expect(names(refsof(wraps, "::ToastAction"))).toEqual(["ToastProvider"]);
    // The alias supplies its own context; wrapping it in itself is a loop.
    expect([...wraps.keys()].some((k) => k.endsWith("::ToastProvider"))).toBe(false);
    // An alias the file never exports is unreachable from a generated mount,
    // so Alert gets no wrap rather than an import of a module-private name.
    expect([...wraps.keys()].some((k) => k.endsWith("::Alert"))).toBe(false);
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
    expect(names(refsof(wraps, "::DialogPortal"))).toEqual(["Dialog"]);
    expect(names(refsof(wraps, "::DialogTrigger"))).toEqual(["Dialog"]);
    // The Root renderer provides its own context; it never gets wrapped.
    expect([...wraps.keys()].some((k) => k.endsWith("::Dialog"))).toBe(false);
  });

  test("a provider that cannot mount bare is no provider", async () => {
    const wraps = await derive();
    // <ChartProvider> mounted with no value provides undefined — the wrap
    // would only relocate the consumer's context throw, so no wrap at all.
    expect([...wraps.keys()].some((k) => k.endsWith("::XAxis"))).toBe(false);
    // The destructuring default genuinely rescues the identical shape.
    expect(names(refsof(wraps, "::TileGrid"))).toEqual(["TiledProvider"]);
  });

  test("provider refs carry the re-export alias", async () => {
    // chanhdai's collapsible: CollapsibleWithContext leaves its module as
    // `Collapsible`. A wrap importing the internal name renders undefined.
    const wraps = await derive();
    const ref = refsof(wraps, "::TileGrid")[0];
    expect(ref?.componentName).toBe("TiledProvider");
    expect(ref?.exportedAs).toBe("TiledPublic");
  });

  test("the context object pairs hook and provider when the name misses", async () => {
    const wraps = await derive();
    expect(names(refsof(wraps, "::AccPanel"))).toEqual(["AccordionRoot"]);
    expect(names(refsof(wraps, "::AccBadge"))).toEqual(["AccordionRoot"]);
    // The supplier itself is never wrapped by its own context.
    expect([...wraps.keys()].some((k) => k.endsWith("::AccordionRoot"))).toBe(false);
  });

  test("the context object pairs hook and provider across separate files", async () => {
    // nakama's useAuth: hook in use-auth.ts, AuthProvider renders
    // <AuthContext.Provider> in auth-context.tsx, both mention the AuthContext
    // object from auth-context-shared. The naming convention misses inside the
    // hook's module; only the resolved (module, name) of the context joins them.
    const wraps = await derive();
    const refs = refsof(wraps, "::WhoAmI");
    expect(names(refs)).toEqual(["AuthProvider"]);
    expect(refs[0]?.filePath.endsWith("auth-context.tsx")).toBe(true);
    // The provider itself is not wrapped by its own context.
    expect([...wraps.keys()].some((k) => k.endsWith("::AuthProvider"))).toBe(false);
  });

  test("library-context hooks wrap with the generated shim", async () => {
    // "No QueryClient set, use QueryClientProvider to set one" — the mount
    // throws because no project component pairs with a node_modules hook.
    // The derivation synthesises the provider at the importing package's
    // root (here the tmp dir: no package.json above it), and the transitive
    // closure carries it to ancestors like PostPage.
    let tmp = "";
    let shimmed = new Map<string, ProviderRef[]>();
    await derive(
      (c) => libraryProviderShimsFor([c.info.filePath]),
      (dir, wraps) => {
        tmp = dir;
        shimmed = wraps;
      },
    );
    const listRefs = refsof(shimmed, "::PostList");
    expect(names(listRefs)).toEqual(["FlawlessQueryClientProvider"]);
    expect(listRefs[0]?.filePath).toBe(path.join(tmp, ".flawless", "flawless-query-client.tsx"));
    expect(names(refsof(shimmed, "::PostPage"))).toEqual(["FlawlessQueryClientProvider"]);
    // The wrapper shape: SettingsForm never mentions the library — its
    // project hook calls useMutation internally.
    expect(names(refsof(shimmed, "::SettingsForm"))).toEqual(["FlawlessQueryClientProvider"]);
    // Two levels across files: DialogShell → useDialogState → useDetailQuery
    // → useQuery (the McpServerDialog chain).
    expect(names(refsof(shimmed, "::DialogShell"))).toEqual(["FlawlessQueryClientProvider"]);
    // The router family: the MemoryRouter shim, second table entry.
    const paletteRefs = refsof(shimmed, "::Palette");
    expect(names(paletteRefs)).toEqual(["FlawlessRouterProvider"]);
    expect(paletteRefs[0]?.filePath.endsWith("flawless-router.tsx")).toBe(true);
    // The library COMPONENT: rendered, never called, aliased on the way in, and
    // the mount throws for it exactly as it does for a hook (saleor-dashboard).
    const intlRefs = refsof(shimmed, "::Greeting");
    expect(names(intlRefs)).toEqual(["FlawlessIntlProvider"]);
    expect(intlRefs[0]?.filePath.endsWith("flawless-intl.tsx")).toBe(true);
    // The alias module, arriving as a rendered component rather than a call:
    // the same router wrap, because it is the same provider.
    expect(names(refsof(shimmed, "::Crumb"))).toEqual(["FlawlessRouterProvider"]);
    // A component handed through a prop is rendered too: `as={Link}` and a
    // `slots={{ root: Link }}` map mount the library's component, so they owe
    // the same provider even though no tag names it.
    expect(names(refsof(shimmed, "::Cta"))).toEqual(["FlawlessRouterProvider"]);
    expect(names(refsof(shimmed, "::Anchor"))).toEqual(["FlawlessRouterProvider"]);
    // Without shims the derivation is unchanged: the hook pairs with nothing.
    const bare = await derive();
    expect([...bare.keys()].some((k) => k.endsWith("::PostList"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::SettingsForm"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::DialogShell"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::Palette"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::Greeting"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::Crumb"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::Cta"))).toBe(false);
    // And the negatives never ask, shimmed or not: an HTML tag name in `as`,
    // and a project component, are not provider-gated library imports.
    for (const map of [shimmed, bare]) {
      expect([...map.keys()].some((k) => k.endsWith("::Plain"))).toBe(false);
      expect([...map.keys()].some((k) => k.endsWith("::Composed"))).toBe(false);
    }
    // And the shim modules are claimed for writing only when a map references
    // them — one per (library, package): query, router and intl, same tmp root.
    expect(referencedLibraryShims(shimmed, [path.join(tmp, "post-list.tsx")])).toHaveLength(3);
    expect(referencedLibraryShims(bare, [path.join(tmp, "post-list.tsx")])).toHaveLength(0);
  });

  test("providerKey matches the map keys the hostRegistry consumes", async () => {
    const wraps = await derive();
    const sidebar = [...wraps.keys()].find((k) => k.endsWith("::SidebarTrigger"));
    if (sidebar === undefined) throw new Error("no wrap key ending in ::SidebarTrigger");
    expect(sidebar.endsWith(providerKey({ filePath: "", componentName: "SidebarTrigger" }))).toBe(
      true,
    );
  });
});

describe("the library a generated shim imports from", () => {
  // The shim file is written at the IMPORTING package's root, so the bare
  // import inside it resolves through that package — and the canonical name is
  // what most apps import, not what every app has. remix-run/remix-store is the
  // measurement: react-router@7.18.2 installed, react-router-dom absent from
  // both node_modules and package.json, and the generated flawless-router.tsx
  // died with `Failed to resolve import "react-router-dom"`. That is not one
  // skipped wrap: every spec that imports the shim fails to load, router or not.
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A package root with `installed` copied in, and the shim's own path in it. */
  function shimFileIn(installed: string[]): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "provwraps-shimimport-"));
    dirs.push(root);
    for (const name of installed) {
      mkdirSync(path.join(root, "node_modules", name), { recursive: true });
      writeFileSync(
        path.join(root, "node_modules", name, "package.json"),
        JSON.stringify({ name, version: "7.0.0" }),
      );
    }
    // The shim lives one level down, so resolving it walks up the way the real
    // import does: `<pkg>/.flawless/`, then `<pkg>/node_modules`.
    return path.join(root, ".flawless", "flawless-router.tsx");
  }

  test("an app that has only the alias module imports the alias", () => {
    const src = libraryShimSource(
      "react-router-dom",
      "FlawlessRouterProvider",
      shimFileIn(["react-router"]),
    );
    expect(src).toContain('import { MemoryRouter } from "react-router";');
    // Not merely added: the unresolvable name is gone, which is the whole point.
    expect(src).not.toContain("react-router-dom");
  });

  test("an app that has both keeps the canonical name", () => {
    // saleor-dashboard carries react-router-dom AND react-router at 5.3.4, and
    // 146 of its files import the former — the fix must not move that app.
    const src = libraryShimSource(
      "react-router-dom",
      "FlawlessRouterProvider",
      shimFileIn(["react-router", "react-router-dom"]),
    );
    expect(src).toContain('import { MemoryRouter } from "react-router-dom";');
  });

  test("an app with neither keeps the canonical name, loud failure and all", () => {
    // Nothing resolves: the shim's import is then exactly as broken as the
    // library's absence is, and an unresolvable import is the honest signal.
    const src = libraryShimSource("react-router-dom", "FlawlessRouterProvider", shimFileIn([]));
    expect(src).toContain('import { MemoryRouter } from "react-router-dom";');
  });

  test("a shim with no alias module is untouched by the substitution", () => {
    // The placeholder is only in the router's imports today; the others name
    // their one package and must render exactly as they did.
    const src = libraryShimSource(
      "@tanstack/react-query",
      "FlawlessQueryClientProvider",
      shimFileIn([]),
    );
    expect(src).toContain(
      'import { QueryClient, QueryClientProvider } from "@tanstack/react-query";',
    );
    expect(src).not.toContain("{{module}}");
  });
});

describe("react-hook-form's context", () => {
  // Found on invoify. Kept out of the shared FILES above on purpose: that
  // fixture set is counted by the library-shim test ("query and router, same
  // tmp root" == 2), and a third shim in the same package root would move it.
  async function deriveRhf(files: Record<string, string>): Promise<Map<string, ProviderRef[]>> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "provwraps-rhf-"));
    try {
      const cache = new SourceFileCache();
      const trees: ComponentTree[] = [];
      for (const [name, content] of Object.entries(files)) {
        const file = path.join(dir, name);
        writeFileSync(file, content);
        trees.push(
          ...(await analyseFile(
            { entry: file, depth: 3, includeChildren: true, roots: "exported" },
            { cache, resolver: new ModuleResolver() },
          ).catch(() => [])),
        );
      }
      return await deriveContextProviderWraps(trees, cache, (c) =>
        libraryProviderShimsFor([c.info.filePath]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a component that reads the form through context gets a form", async () => {
    // useFormContext() hands back null with no FormProvider above the mount
    // and the library dereferences it, so a field component of this shape has
    // no mountable default. Note the reach: TotalBadge never names a library
    // hook, it calls the file's own useCurrentTotal, which calls one.
    const wraps = await deriveRhf({
      "totals.tsx": `
import { useFormContext, useWatch } from 'react-hook-form';
export function useCurrentTotal(): number {
  return Number(useFormContext().getValues('total') ?? 0);
}
export function TotalBadge() {
  const total = useCurrentTotal();
  const live = useWatch({ name: 'total' });
  return <span>{String(live ?? total)}</span>;
}
`,
    });
    const refs = refsof(wraps, "::TotalBadge");
    expect(names(refs)).toEqual(["FlawlessFormProvider"]);
    expect(refs[0]?.filePath.endsWith(".flawless/flawless-form.tsx")).toBe(true);
  });

  test("React's own useFormState does not ask for a form", async () => {
    // The name collides across two libraries. The gate matches the IMPORTED
    // MODULE as well as the name, so a component that took useFormState from
    // "react" is not wrapped in a form provider it never asked for.
    const wraps = await deriveRhf({
      "search-form.tsx": `
import { useFormState } from 'react';
export function SearchForm() {
  const [state, dispatch] = useFormState(async (prev: string, form: FormData) => form.get('q') as string, '');
  return <form action={dispatch}><span>{state}</span></form>;
}
`,
    });
    expect([...wraps.keys()].some((k) => k.endsWith("::SearchForm"))).toBe(false);
  });
});
