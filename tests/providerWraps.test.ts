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
  // ton-console's shape: the provider's OWN body calls the library hook, so the
  // provider is not mountable bare in a spec — its requirements are owed by
  // whoever mounts it, and they must nest OUTSIDE the provider.
  "project-context.tsx": `
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
export function useProject(): string {
  return 'p';
}
export function ProjectProvider({ children }: { children?: React.ReactNode }) {
  const { data = '' } = useQuery({ queryKey: ['project'], queryFn: () => Promise.resolve('p') });
  return <span>{data}{children}</span>;
}
`,
  "project-user.tsx": `
import { useProject } from './project-context';
export function ProjectUser() {
  return <span>{useProject()}</span>;
}
`,
  // The ordering half: AppProvider (A) calls useZeta, so its requirement is
  // ZetaProvider (Z). A letter sort puts A first — nesting ZetaProvider INSIDE
  // AppProvider — and AppProvider's body dies of the missing Zeta context.
  "zeta-context.tsx": `
import * as React from 'react';
const ZetaContext = React.createContext<number | null>(null);
export function useZeta(): number {
  const v = React.useContext(ZetaContext);
  if (v === null) throw new Error('useZeta must be used within ZetaProvider');
  return v;
}
export function ZetaProvider({ children }: { children?: React.ReactNode }) {
  return <ZetaContext.Provider value={7}>{children}</ZetaContext.Provider>;
}
`,
  "app-context.tsx": `
import * as React from 'react';
import { useZeta } from './zeta-context';
export function useApp(): number {
  return 1;
}
export function AppProvider({ children }: { children?: React.ReactNode }) {
  return <span>{useZeta()}{children}</span>;
}
`,
  "app-user.tsx": `
import { useApp } from './app-context';
export function AppUser() {
  return <span>{useApp()}</span>;
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
  // The layout shape: <Outlet /> is a tag, so the walk always saw it — the
  // shim's component list simply did not name it. tonkeeper/ton-console's
  // Layout and LayoutSolid both render it, and both died at mount with the
  // same missing-RouterContext error a bare <Link> gives.
  "layout.tsx": `
import { Outlet } from 'react-router-dom';
import { Flex } from '@chakra-ui/react';
export function Layout() {
  return <Flex direction="column"><Outlet /></Flex>;
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
    // A tag the walk always saw but the shim's list never named: <Outlet /> is
    // as router-gated as <Link>, and a layout that renders one crashed.
    expect(names(refsof(shimmed, "::Layout"))).toEqual(["FlawlessRouterProvider"]);
    // Without shims the derivation is unchanged: the hook pairs with nothing.
    const bare = await derive();
    expect([...bare.keys()].some((k) => k.endsWith("::PostList"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::SettingsForm"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::DialogShell"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::Palette"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::Greeting"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::Crumb"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::Cta"))).toBe(false);
    expect([...bare.keys()].some((k) => k.endsWith("::Layout"))).toBe(false);
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

  test("a wrapped provider owes its own requirements to its wrapper", async () => {
    // ton-console: ApplyQueryParams mounts ProjectProvider (its child calls
    // useProject), and ProjectProvider's body calls useQuery — so the wrapper's
    // spec needs the QueryClientProvider that ProjectProvider's own spec has.
    let shimmed = new Map<string, ProviderRef[]>();
    await derive(
      (c) => libraryProviderShimsFor([c.info.filePath]),
      (_dir, w) => {
        shimmed = w;
      },
    );
    expect(names(refsof(shimmed, "::ProjectProvider"))).toEqual(["FlawlessQueryClientProvider"]);
    // The wrapper owes both: the provider it calls for, and what that provider
    // itself needs. Order is pinned too: the shim OUTSIDE, because
    // ProjectProvider's body runs between the provider's own open and close.
    expect(names(refsof(shimmed, "::ProjectUser"))).toEqual([
      "FlawlessQueryClientProvider",
      "ProjectProvider",
    ]);
  });

  test("a requirement nests outside its provider, not in letter order", async () => {
    // AppProvider (A) requires ZetaProvider (Z). Alphabetical would open A
    // first and Zeta second — nesting Zeta INSIDE AppProvider — and
    // AppProvider's own body would die of the missing Zeta context at mount.
    const wraps = await derive();
    expect(names(refsof(wraps, "::AppProvider"))).toEqual(["ZetaProvider"]);
    expect(names(refsof(wraps, "::AppUser"))).toEqual(["ZetaProvider", "AppProvider"]);
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

describe("the app's own wrapper for a bare-module hook", () => {
  // saleor/saleor-dashboard's `useTheme`, measured: the hook comes from an
  // installed package (`@saleor/macaw-ui-next` — node_modules, never parsed),
  // and the provider the mount needs is the APP's own exported wrapper, which
  // renders the library's provider imported from that very module. The context
  // object lives in the library, so the context join above has no key to join
  // on; the pairing the project files can supply is the convention name plus
  // the same-module binding the wrapper renders.
  async function deriveTheme(files: Record<string, string>): Promise<Map<string, ProviderRef[]>> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "provwraps-bareconv-"));
    try {
      const cache = new SourceFileCache();
      const trees: ComponentTree[] = [];
      // Every file on disk before any analysis: resolution of a sibling import
      // needs the sibling to exist, and a write-then-analyse loop would resolve
      // against whatever had been written so far.
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(dir, name), content);
      }
      for (const name of Object.keys(files)) {
        const file = path.join(dir, name);
        trees.push(
          ...(await analyseFile(
            { entry: file, depth: 3, includeChildren: true, roots: "exported" },
            { cache, resolver: new ModuleResolver() },
          ).catch(() => [])),
        );
      }
      return await deriveContextProviderWraps(trees, cache);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const WIDGET = `
import * as React from 'react';
import { useTheme } from '@acme/uikit';
export function Widget() {
  const { theme } = useTheme();
  return <span>{String(theme)}</span>;
}
`;

  test("a bare-module hook asks for the app's convention-named wrapper", async () => {
    const wraps = await deriveTheme({
      "widget.tsx": WIDGET,
      "theme-provider.tsx": `
import * as React from 'react';
import { ThemeProvider as KitThemeProvider } from '@acme/uikit';
export function ThemeProvider({ children }: { children?: React.ReactNode }) {
  return <KitThemeProvider>{children}</KitThemeProvider>;
}
`,
    });
    const refs = refsof(wraps, "::Widget");
    expect(names(refs)).toEqual(["ThemeProvider"]);
    expect(refs[0]?.filePath.endsWith("theme-provider.tsx")).toBe(true);
    expect(refs[0]?.exportKind).toBe("named");
  });

  test("a same-named wrapper built from a DIFFERENT module does not catch the hook", async () => {
    const wraps = await deriveTheme({
      "widget.tsx": WIDGET,
      "theme-provider.tsx": `
import * as React from 'react';
import { ThemeProvider as OtherProvider } from '@other/kit';
export function ThemeProvider({ children }: { children?: React.ReactNode }) {
  return <OtherProvider>{children}</OtherProvider>;
}
`,
    });
    expect([...wraps.keys()].some((k) => k.endsWith("::Widget"))).toBe(false);
  });

  test("importing from the hook's module without rendering a binding is not a supplier", async () => {
    const wraps = await deriveTheme({
      "widget.tsx": WIDGET,
      "theme-provider.tsx": `
import * as React from 'react';
import { useTheme as kitUseTheme } from '@acme/uikit';
export function ThemeProvider({ children }: { children?: React.ReactNode }) {
  const theme = kitUseTheme();
  return <span>{String(theme)}</span>;
}
`,
    });
    expect([...wraps.keys()].some((k) => k.endsWith("::Widget"))).toBe(false);
  });

  test("a project wrapper that calls a bare-module hook still asks for the app's wrapper", async () => {
    // saleor's `SaleorLogo`: the component's own import resolves (
    // `@dashboard/theme` → the app's theme module), so the outer bare-module
    // fallback cannot fire — but the wrapper's body calls the library hook
    // under an alias (`useTheme as useMacawTheme` from `@saleor/macaw-ui-
    // next`), and the walk must ask for the convention provider at that bare
    // module, keyed by the MODULE-side name.
    const wraps = await deriveTheme({
      "widget.tsx": `
import * as React from 'react';
import { useTheme } from './theme';
export function Widget() {
  const { theme } = useTheme();
  return <span>{String(theme)}</span>;
}
`,
      "theme.ts": `
import { useTheme as useKitTheme } from '@acme/uikit';
export const useTheme = () => {
  const { theme } = useKitTheme();
  return { theme };
};
`,
      "theme-provider.tsx": `
import * as React from 'react';
import { ThemeProvider as KitThemeProvider } from '@acme/uikit';
export function ThemeProvider({ children }: { children?: React.ReactNode }) {
  return <KitThemeProvider>{children}</KitThemeProvider>;
}
`,
    });
    const refs = refsof(wraps, "::Widget");
    expect(names(refs)).toEqual(["ThemeProvider"]);
    expect(refs[0]?.filePath.endsWith("theme-provider.tsx")).toBe(true);
  });

  test("a wrapper whose bare-module call names no convention provider stays unwrapped", async () => {
    // The wrapper's library hook comes from a module the app's ThemeProvider
    // does not render: the same-named component must not catch it.
    const wraps = await deriveTheme({
      "widget.tsx": `
import * as React from 'react';
import { useTheme } from './theme';
export function Widget() {
  const { theme } = useTheme();
  return <span>{String(theme)}</span>;
}
`,
      "theme.ts": `
import { useTheme as useKitTheme } from '@other/kit';
export const useTheme = () => {
  const { theme } = useKitTheme();
  return { theme };
};
`,
      "theme-provider.tsx": `
import * as React from 'react';
import { ThemeProvider as KitThemeProvider } from '@acme/uikit';
export function ThemeProvider({ children }: { children?: React.ReactNode }) {
  return <KitThemeProvider>{children}</KitThemeProvider>;
}
`,
    });
    expect([...wraps.keys()].some((k) => k.endsWith("::Widget"))).toBe(false);
  });
});

describe("the data router wrap", () => {
  // code-forge-io/react-router-devtools and remix-run/remix-store, measured: the
  // components under test ARE route modules, and their `useLoaderData` /
  // `useFetcher` / `useMatches` calls invariant out under MemoryRouter — 110 and
  // 28 spec failures of "`…` must be used within a data router". No wrap short
  // of a data router can mount them. The other half of the finding is the gate:
  // `createMemoryRouter` is 6.4-and-later, and a wrap importing a name the
  // installed library never exported takes down every spec that reads the file.
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A package root carrying `installed` as name → version (undefined version
   *  is a package.json that names none), with `files` written into it. */
  async function deriveRouter(
    installed: Record<string, string | undefined>,
    files: Record<string, string>,
  ): Promise<Map<string, ProviderRef[]>> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "provwraps-router-"));
    dirs.push(dir);
    for (const [name, version] of Object.entries(installed)) {
      const pkg = path.join(dir, "node_modules", name);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, version }));
    }
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
  }

  /** The component that is a route module: data off the router, nothing else. */
  const ROUTE_VIEW = {
    "route-view.tsx": `
import { useLoaderData } from 'react-router';
export function RouteView() {
  const d = useLoaderData() as { title?: string } | undefined;
  return <div>{d?.title}</div>;
}
`,
  };

  /** Where a generated shim's own file lives, so resolution walks up the way
   *  the real import does: `<pkg>/.flawless/`, then `<pkg>/node_modules`. */
  function shimFileIn(installed: Record<string, string | undefined>): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "provwraps-dataimport-"));
    dirs.push(root);
    for (const [name, version] of Object.entries(installed)) {
      const pkg = path.join(root, "node_modules", name);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, version }));
    }
    return path.join(root, ".flawless", "flawless-data-router.tsx");
  }

  test("a data-router hook gets the data router", async () => {
    const wraps = await deriveRouter({ "react-router": "7.9.3" }, ROUTE_VIEW);
    const refs = refsof(wraps, "::RouteView");
    expect(names(refs)).toEqual(["FlawlessDataRouterProvider"]);
    expect(refs[0]?.filePath.endsWith(".flawless/flawless-data-router.tsx")).toBe(true);
  });

  test("useMatches asks for the data router too", async () => {
    // It sat in the MemoryRouter shim's hook list, where the library has never
    // served it: v6.4 introduced useMatches with the data router, and 7 specs
    // of react-router-devtools named it in the same error the others did.
    const wraps = await deriveRouter(
      { "react-router": "7.9.3", "react-router-dom": "7.9.3" },
      {
        "tabs.tsx": `
import { useMatches } from 'react-router-dom';
export function Tabs() {
  return <div>{useMatches().length}</div>;
}
`,
      },
    );
    expect(names(refsof(wraps, "::Tabs"))).toEqual(["FlawlessDataRouterProvider"]);
  });

  test("the data router supersedes the MemoryRouter wrap", async () => {
    // The data router serves useNavigate as well, so the pair would only be a
    // shadowed context on the stack: one provider, and it is the capable one.
    const wraps = await deriveRouter(
      { "react-router": "7.9.3" },
      {
        "route-both.tsx": `
import { useLoaderData, useNavigate } from 'react-router';
export function RouteBoth() {
  const d = useLoaderData() as string | undefined;
  const nav = useNavigate();
  return <button onClick={() => nav('/x')}>{d}</button>;
}
`,
      },
    );
    expect(names(refsof(wraps, "::RouteBoth"))).toEqual(["FlawlessDataRouterProvider"]);
  });

  test("a navigation-only component keeps MemoryRouter", async () => {
    // The wrap that nakama was measured with must not move for want of the new
    // one: useNavigate is served by MemoryRouter, and switching it would change
    // the error boundary underneath a suite that passes today.
    const wraps = await deriveRouter(
      { "react-router": "7.9.3" },
      {
        "palette.tsx": `
import { useNavigate } from 'react-router';
export function Palette() {
  const nav = useNavigate();
  return <button onClick={() => nav('/x')}>go</button>;
}
`,
      },
    );
    expect(names(refsof(wraps, "::Palette"))).toEqual(["FlawlessRouterProvider"]);
  });

  test("a project hook reaching a data hook picks the data router, not MemoryRouter", async () => {
    // VersionDropdown of code-forge-io/react-router-devtools: it imports
    // useNavigate itself and reaches useRouteLoaderData only through
    // useCurrentVersion in docs/app/utils/version-resolvers.ts. Both router
    // shims are the same module, and the wrapper case used to ask only "is this
    // a shimmed module?" — so the table's first entry won, MemoryRouter was
    // wrapped, and the spec still died naming useRouteLoaderData (14 of them in
    // that app, 10 more in remix-store).
    const wraps = await deriveRouter(
      { "react-router": "7.9.3", "react-router-dom": "7.9.3" },
      {
        "version-resolvers.ts": `
import { useRouteLoaderData } from 'react-router';
export function useCurrentVersion() {
  return (useRouteLoaderData('root') as { version?: string } | undefined)?.version;
}
`,
        "versions-dropdown.tsx": `
import { useNavigate } from 'react-router';
import { useCurrentVersion } from './version-resolvers';
export function VersionDropdown() {
  const navigate = useNavigate();
  const version = useCurrentVersion();
  return <button onClick={() => navigate('/x')}>{version}</button>;
}
`,
      },
    );
    expect(names(refsof(wraps, "::VersionDropdown"))).toEqual(["FlawlessDataRouterProvider"]);
  });

  test("a project hook reaching only navigation hooks keeps MemoryRouter", async () => {
    // The mirror case: the wrapper must not drag a component onto the data
    // router because its module imports the router at all. nakama-shaped
    // components mount under MemoryRouter today and stay there.
    const wraps = await deriveRouter(
      { "react-router": "7.9.3", "react-router-dom": "7.9.3" },
      {
        "use-go-home.ts": `
import { useNavigate } from 'react-router';
export function useGoHome() {
  const navigate = useNavigate();
  return () => navigate('/');
}
`,
        "back-button.tsx": `
import { useGoHome } from './use-go-home';
export function BackButton() {
  const goHome = useGoHome();
  return <button onClick={goHome}>home</button>;
}
`,
      },
    );
    expect(names(refsof(wraps, "::BackButton"))).toEqual(["FlawlessRouterProvider"]);
  });

  test("a router component only the data router serves asks for the data wrap", async () => {
    // unit/Welcome.test.tsx of code-forge-io/react-router-devtools: the file
    // renders <Form> and names no data hook at all, so only the component
    // ladder can ask for the wrap. Each tag probed alone under both wraps:
    // <Form> throws useSubmit and <ScrollRestoration> throws useMatches under
    // MemoryRouter, while <Link>/<Outlet> mount and stay on the memory wrap.
    const wraps = await deriveRouter(
      { "react-router": "7.9.3", "react-router-dom": "7.9.3" },
      {
        "welcome.tsx": `
import { Form } from 'react-router';
export function Welcome() {
  return <Form><button type="submit">go</button></Form>;
}
`,
        "shell.tsx": `
import { ScrollRestoration } from 'react-router';
export function Shell() {
  return <div><ScrollRestoration /></div>;
}
`,
      },
    );
    expect(names(refsof(wraps, "::Welcome"))).toEqual(["FlawlessDataRouterProvider"]);
    expect(names(refsof(wraps, "::Shell"))).toEqual(["FlawlessDataRouterProvider"]);
  });

  test("the component ladder supersedes MemoryRouter rather than nesting it", async () => {
    // A banner rendering <Link> and <Form> fires both ladders. Two providers
    // would only shadow: the inner MemoryRouter answers the navigation hooks
    // and the mount dies on the form anyway.
    const wraps = await deriveRouter(
      { "react-router": "7.9.3", "react-router-dom": "7.9.3" },
      {
        "banner.tsx": `
import { Form, Link } from 'react-router';
export function Banner() {
  return (
    <div>
      <Link to="/a">a</Link>
      <Form><button type="submit">go</button></Form>
    </div>
  );
}
`,
      },
    );
    expect(names(refsof(wraps, "::Banner"))).toEqual(["FlawlessDataRouterProvider"]);
  });

  test("a library too old for the data APIs is not offered the wrap by a tag either", async () => {
    // The capability gate covers the component ladder: emitting a file whose
    // createMemoryRouter import cannot resolve takes down every spec that
    // reads it, which is worse than the failure it prevents.
    const wraps = await deriveRouter(
      { "react-router": "5.3.4", "react-router-dom": "5.3.4" },
      {
        "welcome.tsx": `
import { Form } from 'react-router-dom';
export function Welcome() {
  return <Form><button type="submit">go</button></Form>;
}
`,
      },
    );
    expect([...wraps.keys()].some((k) => k.endsWith("::Welcome"))).toBe(false);
  });

  test("the tag ladder only fires on the router's own binding", async () => {
    // "Form", "Link" and "Outlet" are the most overused component names in
    // React. The ladder reads the import binding, not the tag, so a project
    // form and an antd form ask for no router at all — otherwise the shim
    // would wrap half the corpus on a coincidence of spelling.
    const wraps = await deriveRouter(
      { "react-router": "7.9.3", "react-router-dom": "7.9.3" },
      {
        "form.tsx": `
export function Form({ children }: { children?: React.ReactNode }) {
  return <form>{children}</form>;
}
`,
        "checkout.tsx": `
import { Form } from './form';
import { Form as AntForm, Link } from 'antd';
export function Checkout() {
  return (
    <div>
      <Form><button type="submit">go</button></Form>
      <AntForm />
      <Link>docs</Link>
    </div>
  );
}
`,
      },
    );
    expect([...wraps.keys()].some((k) => k.endsWith("::Checkout"))).toBe(false);
  });

  test("a library older than the data APIs is not offered the wrap", async () => {
    // saleor-dashboard's pair is react-router-dom/react-router at 5.3.4: no
    // createMemoryRouter exists there, so the file would not even import. The
    // data-hook caller then asks for nothing (the library's own error stays the
    // signal) while the navigation caller keeps the wrap that works for it.
    const old = await deriveRouter(
      { "react-router": "5.3.4", "react-router-dom": "5.3.4" },
      {
        ...ROUTE_VIEW,
        "palette.tsx": `
import { useNavigate } from 'react-router-dom';
export function Palette() {
  const nav = useNavigate();
  return <button onClick={() => nav('/x')}>go</button>;
}
`,
      },
    );
    expect([...old.keys()].some((k) => k.endsWith("::RouteView"))).toBe(false);
    expect(names(refsof(old, "::Palette"))).toEqual(["FlawlessRouterProvider"]);
    // The boundary itself: 6.4.0 is where createMemoryRouter shipped.
    const before = await deriveRouter({ "react-router": "6.3.1" }, ROUTE_VIEW);
    expect([...before.keys()].some((k) => k.endsWith("::RouteView"))).toBe(false);
    const at = await deriveRouter({ "react-router": "6.4.0" }, ROUTE_VIEW);
    expect(names(refsof(at, "::RouteView"))).toEqual(["FlawlessDataRouterProvider"]);
  });

  test("a version the tool cannot read does not refuse the wrap", async () => {
    // Refusing here would trade a capable library for an unreadable
    // package.json, and the suite would lose wraps it needs. The failure mode
    // of accepting is the library's own missing export, loudly, for one file.
    const wraps = await deriveRouter({ "react-router": undefined }, ROUTE_VIEW);
    expect(names(refsof(wraps, "::RouteView"))).toEqual(["FlawlessDataRouterProvider"]);
  });

  test("the generated wrap rethrows instead of rendering an error page", () => {
    const src = libraryShimSource(
      "react-router-dom",
      "FlawlessDataRouterProvider",
      shimFileIn({ "react-router": "7.9.3" }),
    );
    expect(src).toContain(
      'import { createMemoryRouter, RouterProvider, useRouteError } from "react-router";',
    );
    expect(src).toContain("function FlawlessRouteError(): never {");
    expect(src).toContain("throw useRouteError();");
    expect(src).toContain("errorElement: <FlawlessRouteError />");
    expect(src).toContain("export function FlawlessDataRouterProvider(");
    // Not merely added: the unresolvable alias is gone, as for the memory wrap.
    expect(src).not.toContain("react-router-dom");
  });
});

describe("a hook behind a re-export barrel", () => {
  // A Feature-Sliced app (tonkeeper/ton-console) hands hooks along instead of
  // exporting them: a component imports the slice's index, the index is
  // `export * from './model'`, and the model index is
  // `export { useRateQuery } from './queries'`. The walk could only follow an
  // import binding the file itself has, and `imports.get("useRateQuery")` is
  // null in a file whose whole body is a star — so the chain stopped at the
  // first barrel and 87 specs of that one app mounted with no provider and
  // died of `No QueryClient set`.
  async function deriveBarrel(files: Record<string, string>): Promise<Map<string, ProviderRef[]>> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "provwraps-barrel-"));
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

  const SLICE = {
    "queries.ts": `
import { useQuery } from '@tanstack/react-query';
export function useRateQuery() { return useQuery({ queryKey: ['rate'], queryFn: () => 1 }); }
`,
    // The two hand-off forms a real slice uses, in one file, plus a star into
    // a module that does not exist on disk: a dead star must end a hop, not
    // the walk.
    "model.ts": `
export { useRateQuery, useRateQuery as useCurrentRate } from './queries';
export * from './interfaces';
`,
    "index.ts": `
export * from './model';
export * from './ui';
`,
    "rate.tsx": `
import { useRateQuery } from './index';
export function CurrencyRate() {
  const q = useRateQuery();
  return <div>{String(q)}</div>;
}
`,
    "label.tsx": `
import { useCurrentRate } from './index';
export function RateLabel() {
  const q = useCurrentRate();
  return <span>{String(q)}</span>;
}
`,
    "stranger.tsx": `
import { useNobody } from './index';
export function Stranger() {
  const q = useNobody();
  return <div>{String(q)}</div>;
}
`,
  };

  test("the star hop and the named hop together reach the library", async () => {
    const wraps = await deriveBarrel(SLICE);
    expect(names(refsof(wraps, "::CurrencyRate"))).toEqual(["FlawlessQueryClientProvider"]);
  });

  test("a named re-export's alias is followed under the module's own name", async () => {
    // `export { useRateQuery as useCurrentRate }`: the component knows only the
    // alias, and the far end only answers for the name it declares.
    const wraps = await deriveBarrel(SLICE);
    expect(names(refsof(wraps, "::RateLabel"))).toEqual(["FlawlessQueryClientProvider"]);
  });

  test("a name no module declares asks for nothing", async () => {
    // The star hop fans out, so precision has to come from the far end: a
    // library is recorded only where the hook is DECLARED. An unresolvable name
    // still mounts bare rather than picking up whatever a slice calls.
    const wraps = await deriveBarrel(SLICE);
    expect([...wraps.keys()].some((k) => k.endsWith("::Stranger"))).toBe(false);
  });
});

describe("a dynamic element rendered from a project hook", () => {
  // code-forge-io/react-router-devtools' ContentPanel: `const { Component }
  // = useTabs()` and `{Component && <Component />}`, where useTabs selects
  // from a registry of `{ id, component: () => <PageTab /> }`. The tag is
  // dynamic, so no render edge exists and PageTab's data router never reaches
  // the spec that mounts it — "useMatches must be used within a data router"
  // at PageTab.tsx. The rule owes the registry's values like rendered
  // children; the slice below is that shape in miniature, with one entry
  // arrow-wrapped and one a plain identifier.
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  async function deriveDyn(files: Record<string, string>): Promise<Map<string, ProviderRef[]>> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "provwraps-dyn-"));
    dirs.push(dir);
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
    return await deriveContextProviderWraps(trees, cache);
  }

  const SLICE = {
    "needs.tsx": `
import * as React from 'react';
const NeedsContext = React.createContext<{ tick: number } | null>(null);
export function useNeeds() {
  const ctx = React.useContext(NeedsContext);
  if (!ctx) throw new Error('useNeeds must be used within a NeedsProvider');
  return ctx;
}
export function NeedsProvider({ children }: { children?: React.ReactNode }) {
  return <NeedsContext.Provider value={{ tick: 1 }}>{children}</NeedsContext.Provider>;
}
`,
    "alpha.tsx": `
import { useNeeds } from './needs';
export function Alpha() {
  const { tick } = useNeeds();
  return <div>{tick}</div>;
}
`,
    "beta.tsx": `
export function Beta() {
  return <div>beta</div>;
}
`,
    "registry.tsx": `
import { Alpha } from './alpha';
import { Beta } from './beta';
export const registry = [
  { id: 'a', component: () => <Alpha /> },
  { id: 'b', component: Beta },
] as const;
`,
    "pick.ts": `
import { registry } from './registry';
export const usePick = () => {
  const tab = registry.find((t) => t.id === 'a');
  return { Component: tab?.component };
};
`,
    "panel.tsx": `
import { usePick } from './pick';
export function Panel() {
  const { Component } = usePick();
  return <div>{Component && <Component />}</div>;
}
export function Picker() {
  const pick = usePick();
  return <div>{pick.Component ? 'one' : 'none'}</div>;
}
`,
  };

  test("a rendered hook value owes the registry's components", async () => {
    const wraps = await deriveDyn(SLICE);
    const refs = refsof(wraps, "::Panel");
    // Alpha is the registry value that needs NeedsProvider; Beta is the value
    // that needs nothing, so the owed set is exactly Alpha's requirement.
    expect(names(refs)).toEqual(["NeedsProvider"]);
    expect(refs[0]?.filePath.endsWith("needs.tsx")).toBe(true);
  });

  test("a hook value only read, never rendered, owes nothing", async () => {
    // The inertness pin: Picker calls usePick but never renders Component —
    // a member read is not a tag — so the synthetic edge does not fire and
    // Panel's requirement does not leak into a sibling that merely reads it.
    const wraps = await deriveDyn(SLICE);
    expect([...wraps.keys()].some((k) => k.endsWith("::Picker"))).toBe(false);
  });
});
