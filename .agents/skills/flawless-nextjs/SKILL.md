---
name: flawless-nextjs
description: Work with flawless-react's `--nextjs` mode — the app-router resolver, the derived `flawless/provider.tsx` and why a provider layer gets dropped, the signed-out auth stub and the layers it makes dangerous, module stubs and their precedence, the React 17/18/19 pins (Testing Library `^12.1.5`, `repairRtlPin`), the package.json merge with `pnpm.ignoredBuiltDependencies`, `.env` loading for the suite and the host, and where gitignore entries land. Use when a Next app's generated suite is red at import or mount, when a provider is missing from the wrap, when `Cannot read properties of null (reading 'useState')` appears, or when `pnpm run dev` dies after an install. For fixtures from a spec see flawless-api-fixtures; for route e2e see flawless-e2e.
---

# flawless Next.js mode

`--nextjs [path]` is the mode that makes the output a **suite inside your app**
rather than a folder of files: it finds the app root, resolves an entry glob, writes
under `<root>/flawless/`, merges devDeps and `flawless:*` scripts into your
`package.json`, and appends gitignore entries.

```bash
cd apps/web
bunx @lariocpt/flawless-react "src/app/dashboard/page.tsx" --nextjs . --tasks unit-browser,e2e
```

The path is optional — with no value the current directory is the app root, and in
`--nextjs` mode the entry glob itself is auto-detected from the router when you give
none. Monorepos work because the root is resolved, not assumed: `apps/web` is the
root, the suite lives at `apps/web/flawless/`, and the scripts land in
`apps/web/package.json`.

## The provider wrapper, and its honest drops

App-router `layout.tsx` is usually an **async server component** importing
`next/font` or `next/headers` — nothing in that file can run under jsdom. So the tool
derives `flawless/provider.tsx` from the JSX chain that actually encloses
`{children}`, keeping only `"use client"` components and literal attributes.

**Every drop is named where you will read it**: a dropped attribute becomes a
`TODO(flawless)` comment beside the wrapper; a dropped provider layer becomes a block
at the top of the file with the reason and the fix. Do not read `provider.tsx` as
"the app's providers" — read it as "the providers that could be mounted", and read
its header.

**A layer whose module directly imports an auth library is skipped rather than
mounted.** The list is `@clerk/nextjs`, `@clerk/clerk-react`, `next-auth`,
`@supabase/auth-helpers-nextjs`, `@supabase/auth-helpers-react`, `@supabase/ssr`,
matched by package or subpath (`next-auth/react`, `@clerk/nextjs/server`). The reason
is the stub the unit and browser planes install for those same libraries: a **signed
snapshot** — `isLoaded: true`, `isSignedIn: false`, `userId: null`, `user: null`,
`status: "unauthenticated"`, behind a Proxy whose method-shaped keys (`sign*`, `set*`,
`get*`, `reload*`, `redirect*`, `create*`) resolve to another signed snapshot and
`*List` keys to `[]`, everything else `undefined`. Mount a provider that gates its
children on a session against that and it renders **nothing**, and every spec inherits
the blank screen — while the stub already satisfies the context reads that
auth-consuming components make on their own.

So the failure to expect is one **below** the dropped layer, and it is the drop, not
the component: `Could not find Convex client`, `could not find … in the context`. The
fix is not editing `provider.tsx`, because `--force` regenerates it. Two real options:

- put the values you supply (a seeded auth state, a theme, a router) in
  **`provider.fixtures.ts`**, which is never regenerated under any flag;
- or pass **`--provider <file>`**, which also buys you a context the derived wrapper
  could not produce.

One subtlety in the resolver worth knowing when a provider you expected is missing: a
namespace alias (`const ToastProvider = ToastPrimitives.Provider`) counts **only if
that file exports the name**, and the first exported candidate wins. And a file that
renders `<Component />` with no `{children}` inside it is never a usable provider —
it wraps nothing.

## Module stubs, and what they must not touch

Client specs mock an **allowlist only**: `next/navigation`, `next/headers`,
`server-only`, `next/link`, `next/font/*`, and any `"use server"` module. Mocking a
`cn` helper would strip every className off the markup the assertions read; mocking a
UI component would replace the element an interaction test clicks.

Rules the shim table follows:

- **A named stub outranks a pattern stub** — an explicit entry for a module wins over
  a family match, so adding one never silently shadows a narrower decision elsewhere.
- `next/script` gets an inert in-place stand-in: it renders **nothing** without
  Next's router context (it injects its tag through a side effect), which otherwise
  looks like a broken component. `next/head` is deliberately **not** stubbed.
- `LIBRARY_SHIMS` covers the third-party packages whose context the mount needs
  (react-query, react-router, react-hook-form and react-intl are in it). The
  requirement is detected from what the component **mounts**: the hooks it calls
  — through project wrappers, across files — and the library's **components** it
  renders, because `<FormattedMessage>` calls no hook and throws for the missing
  provider all the same. A component handed through a prop counts as rendered
  (`as={Link}`, `component={Link}`, `slots={{ root: Link }}`, `render`), since no
  JSX tag ever names it; an HTML tag string (`as="a"`) and the app's own
  components do not. One library can also be installed under two module names,
  and both count.
  A shim fixes the mount, not the component: an API misuse the analyser cannot
  see stays a red spec, and an honest one.
- **One library can need two wraps, and its older install can be unable to have
  the newer one.** react-router is that case: `MemoryRouter` serves
  `useNavigate` / `useLocation` / `<Outlet>`, while the data hooks
  (`useLoaderData`, `useFetcher`, `useMatches` …) invariant out under it and get
  `createMemoryRouter` + `RouterProvider` instead. Tags split the same way, and
  each was probed alone under both wraps rather than read off the docs: `<Form>`
  throws `useSubmit` and `<ScrollRestoration>` throws `useMatches` under
  `MemoryRouter`, while `<Link>` and `<Outlet>` mount there and stay. A component
  needing both gets the data wrap alone (`supersedes`: the data router serves the
  navigation surface too, so nesting only shadows) — whether it reached them
  directly, through its own hooks, or through a tag. It is offered only when the
  react-router that actually resolves is **≥ 6.4**, the release that added
  `createMemoryRouter` — an import the installed library never exported takes down
  every spec that reads the file, so on 5.x those hooks keep failing with the
  message the library writes. And because `RouterProvider` renders a real error
  *page* when the mount throws, the wrap's `errorElement` **rethrows**: a crashing
  component fails its own spec with its own error.
- **A Feature-Sliced barrel declares nothing, so both walks follow the
  hand-off.** `entities/rates/index.ts` is `export * from './model'` and that
  model index is `export { useRateQuery } from './queries'`, so neither the hook a
  component imports nor the library it calls three files away is named by any
  import the component makes. A JSX child tag is the same problem: `<CreateApiKeyModal>`
  imported from `'../index'` left the child edge at the barrel, so what the modal
  needs was inherited by nobody and the parent's spec mounted bare. The named hop
  is exact, so it goes first; `export *` only says "ask the target", so it is
  consulted when no named hop carries the name; a hop whose module does not
  resolve ends that hop rather than the search; and a cycle costs one visit.
  `export * as ns from`, `export type { T } from` and a file's own
  `export { localName }` are NOT hand-offs of the target's name, while a name
  imported and handed back out with a module-less `export { … }` is.
- `server-only` is handled by an emitted `server-only-stub.ts` at the suite root,
  because the real package throws on import by design.

## React 17 / 18 / 19

The app's React major (`detectAppReact`, read from the root `package.json`) is the
single switch for the whole suite.

- **≥18** mounts through `createRoot`; **<18** falls back to legacy `ReactDOM.render`,
  document roots render with `renderToStaticMarkup`, and promise-valued props are not
  passed at all.
- The suite's `react` / `react-dom` are **pinned to the version the app has installed, exactly** —
  `detectAppReact` reads `node_modules/react` before the declared range, because a caret is a
  floor and `^19.2.0` installs whatever is newest. Where the sources resolve a different copy than
  that walk finds, `appReactPin` reads the pin off the copy the emitted `react` aliases anchor on:
  the pin and the alias must name one physical copy or the plane renders with two Reacts.
  Two React copies is the classic red-suite
  cause, with signature `Cannot read properties of null (reading 'useState')`; a pair that
  merely drifts is just as fatal — one patch off dies at load on `Incompatible React
  versions`, one major off on `Cannot read properties of undefined (reading
  'ReactCurrentOwner')`. The next run rewrites a stale or loose pin it finds in an existing
  suite manifest (`repairReactPin`).
- Testing Library follows the app: React ≤17 gets `@testing-library/react@^12.1.5`
  with `@testing-library/dom@^8.20.1`, because 13/14 peer-require React ^18 and 14
  hard-requires the `react-dom/client` entry that does not exist in 17. A stale 13+
  range left behind by an older run is repaired by the next one (`repairRtlPin`) —
  so an upgraded-app suite that suddenly installs RTL 12 did the right thing.

## What the `package.json` merge does

`devDependencies` for the harness (`@playwright/test`, `msw`, `react-scan`, Vitest and
friends) and the plane scripts — `flawless:unit`, `flawless:browser`, `flawless:perf`,
`flawless:e2e`, `flawless:load`. JSON is merged, not rewritten: your file's existing
indentation and key order survive, because generation should produce a clean
`git diff`, not a reformat.

**pnpm ≥10 needs one more thing, and the merge records it:** the deps the tool
introduces go into `pnpm.ignoredBuiltDependencies`. Without that record pnpm errors on
an unapproved build-script decision, and `ERR_PNPM_IGNORED_BUILDS` kills the app's own
`pnpm run dev` before Next boots — a test-tooling install that breaks the dev server
is the worst possible first impression.

## Environment loading

Two different orders, because the two consumers are different runtimes.

- **The Vitest config** reads `.env.test.local`, `.env.test`, `.env.local`, `.env`,
  `.env.example` — first value wins, real environment variables beat all of them.
  `.env.example` is last on purpose: template repos ship only the example, and its
  placeholders exist to satisfy module-scope construction (`new URL(process.env.DATABASE_URL)`
  at import time), not to be correct.
- **The perf/browser host bundle** reads Next's own development precedence: `.env`,
  `.env.local`, `.env.development`, `.env.development.local`, later wins — the same
  values the app would see in `next dev`.

## gitignore

Entries are appended in **every** mode, not only under `--nextjs`: the suite's own
scratch directories (`test-results/`, `heaps/`) and the credential file the emitted
global-setup writes (`e2e/.auth.json`). Outside Next mode the destination is a small
search — git root, then the nearest `package.json`, then the out dir's parent — which
matters because until that ordering was fixed a plain run ignored nothing it
generated.

## Spec-derived API fixtures are a separate concern

`--nextjs` probes `http://localhost:3000/api/docs` for a live OpenAPI document with a
short timeout. Whether that probe helps, hurts or should be turned off
(`--swagger-url=off`) is in flawless-api-fixtures.

## Never

- Never hand-edit `flawless/provider.tsx` to add a provider: `--force` erases it.
  Use `--provider` or `provider.fixtures.ts`.
- Never mock a project module (a `cn`, a UI primitive) to make a spec green — the
  assertions stop referring to the real render.
- Never treat a provider drop's `TODO(flawless)` as a passing state when the specs
  below it fail on a missing context: that is the same drop, still open.
