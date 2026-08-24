---
name: flawless-unit-browser
description: Work with flawless-react's generated unit and browser specs — what they assert, the provider wrapper and its write-once fixtures, the mock allowlist, answering test.skip and TODO(flawless) markers, hand-hardening colocated specs, and registering new components in the browser host. Use when a generated unit/browser spec is red, when filling TODOs after a run, or when a component's browser spec reports "unknown component".
---

# flawless unit + browser specs

The `unit-browser` task writes Vitest + Testing Library specs from static
analysis; when `perf-harness` is also selected it adds Playwright browser specs
that mount through the profiling host. Everything asserted was derived — the
specs describe the render at the props they pass, never the last `return` in
the body.

## The provider wrapper and its fixtures

Unit specs mount inside `flawless/provider.tsx`, derived from the layout's JSX
chain around `{children}`. That file is regenerated; the values you supply live
in `flawless/provider.fixtures.ts`, which is written once and never again —
not even with `--force`.

The single highest-value hardening move: fill `initialState` (or whatever the
layout passed) with a REAL seeded shape instead of the emitted empty cast.
Mirror the app's seed data so every unit spec mounts the way the app actually
renders — authenticated, themed, populated:

```ts
initialState: {
  user: { id: "…", email: "trustee@demo.local", name: "…", /* seed persona */ },
  status: "authenticated",
} satisfies ComponentProps<typeof StoreProvider>["initialState"],
```

Pin any timestamp in the fixture — `Date.now()` in a fixture makes specs
nondeterministic.

## The mock allowlist, and the cn caveat

Client specs mock only `next/navigation`, `next/headers`, `server-only`,
`next/link`, `next/font/*`, and `"use server"` modules. Do not widen it by
hand: mocking a UI component replaces the element the interaction tests click.

One known generator wart: specs for components whose file imports `cn` from a
utils module may carry `vi.mock("@/lib/utils", () => ({ cn: vi.fn(async () =>
({})) }))` — an async stub for a sync function. If the spec actually renders
the component, replace it with a sync join so classes stay legible:

```ts
vi.mock("@/lib/utils", () => ({
  cn: vi.fn((...args: unknown[]) => args.filter(Boolean).join(" ")),
}));
```

## Answering skips and TODOs

`test.skip` with a named reason is intended output — never "fix" it by deleting
the assertion or hand-writing one. Give the component what the reason asks for
(a `data-testid`, a fixture) or extend the generator. `TODO(flawless)` markers
cluster into three kinds, each with a known answer:

| TODO kind | The answer |
| --- | --- |
| "some return shapes could not be inferred" | Give the mocked data-dep a realistic resolved value. If every consumer of the handle is itself mocked (a `getDb` whose queries are all mocked above), an opaque `{}` IS the right fixture — replace the TODO with a comment saying so. |
| "wrap renderTarget() in the matching Root" | Mount the compound part inside its Root the way call sites do: `render(<AlertDialog><AlertDialogTrigger>Delete</AlertDialogTrigger></AlertDialog>)`, then assert its content. Dialog-family parts need the content wrapper too (`<Dialog open><DialogContent>…`). |
| "server action stubbed — give it a realistic return value" | Copy the action's real return literal (`{ ok: true }` / `{ error: "…" }`) into the stub. |

When you fill a fixture, also tighten the assertion: a mocked building named
`"flawless-name"` must actually reach the DOM
(`expect(screen.getByText("flawless-name")).toBeInTheDocument()`), or the spec
passes while rendering an empty state — the vacuous pass this tool exists to
prevent.

## Placement and survival

Colocated specs (`--colocate`, `<file>.flawless.test.tsx` beside the source)
are kept on re-runs and OVERWRITTEN by `--force` — the tool cannot tell a
hand-hardened spec from an untouched one, so after any `--force` diff the
colocated specs and `git checkout` the ones you hardened. Specs inside the out
dir are rewritten on any re-run; never hand-harden those.

Run them with `bun run flawless:unit` (the emitted vitest config selects both
`src/**/*.flawless.test.*` and `flawless/unit/**`). A project script that is a
bare `bun test` will collect colocated specs under the wrong runner — scope it
to `bun test tests`.

## Browser specs and the host registry

Browser specs mount through `flawless/host/` and exist only when both
`unit-browser` and `perf-harness` ran. The mount tables (`REGISTRY`,
`FN_PROPS`, `WRAP_IN`) live in `host/registry.ts`, which **regenerates on
every run** — a newly analysed component arrives via a plain no-force re-run,
nothing to hand-edit. The write-once `host/main.tsx` is only the wrapper
(polyfills, provider, MSW, the profiling machinery); components you register
by hand go in its spreads — `ALL` for the component (`const ALL = {
...REGISTRY, MyComponent: MyComponent as unknown as Component }` — the cast
is required: strict tsconfig rejects a props-typed component in a
Record<string, Component>), plus `ALL_FN_PROPS`/`ALL_WRAP_IN` entries when it
needs function-prop stubs or a wrapper chain —
which every lookup goes through and which survives regeneration.

`unknown component: <Name>` on a current suite means the re-run has not
happened yet — re-run the tool. On a pre-split suite (a `main.tsx` with no
`from "./registry"` import) it needs the one-time migration the run's warning
names: delete `host/main.tsx` and re-run (provider wiring regenerates from
`--provider`), or port the hand wiring into a wrapper that imports
`./registry`. No flag rewrites `main.tsx` — write-once is absolute, `--force`
included. (This was findings ledger FR-016, fixed by the registry split.)

## Never

- Never delete a reasoned `test.skip` or replace it with a hollow assertion.
- Never mock `cn`/`clsx` away entirely (classes vanish) or mock UI components.
- Never hand-harden a spec inside the out dir — colocate it first.
- Never trust a green run whose fixtures are empty casts: fill, then assert
  the fixture content reaches the DOM.
