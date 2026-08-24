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

Historical wart, fixed in FR-027 but still present in suites generated before
it: specs whose file imports `cn` from a utils module may carry
`vi.mock("@/lib/utils", () => ({ cn: vi.fn(async () => ({})) }))` — an async
stub for a sync function. A regeneration emits the sync form; to fix an old
spec in place, replace it with a sync join so classes stay legible:

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
| "some return shapes could not be inferred" | The tool already tried the dep's own declaration (a `Promise<T>` annotation, or a single-fetch body joined to the OpenAPI example — those fixtures carry an `/* inferred from … */` comment and no TODO), so this marker means BOTH usage and declaration came up empty: a computed return, a generic, a dotted callee like `db.query.findMany`, an unannotated client factory (`getDb`), a `cache()`-wrapped export the function mapper cannot unwrap, or an annotation whose type — even one resolved through a workspace package's barrel, which works since B-8 — has a schema construct zod inference deliberately bails on (`.transform`, a union, a record, a date — `z.infer` enums and objects DO resolve since B-9, so a surviving marker means the schema left the supported subset). Give the mocked data-dep a realistic resolved value. If every consumer of the handle is itself mocked (a `getDb` whose queries are all mocked above), an opaque `{}` IS the right fixture — replace the TODO with a comment saying so. |
| "wrap renderTarget() in the matching Root" | The tool now does this itself when the part's OWN file exports the family (a Root-rendering sibling + a Content sibling) and the family is open-state (dialog and friends), so this TODO only appears for rootless files, cross-file families, or value-driven families (accordion/tabs). Mount the part inside its Root the way call sites do: `render(<AlertDialog><AlertDialogTrigger>Delete</AlertDialogTrigger></AlertDialog>)`, then assert its content — dialog-family parts need the content wrapper too (`<Dialog open><DialogContent>…`), and portal content is read off `baseElement`. |
| "server action stubbed — give it a realistic return value" | The tool now does this itself when the action returns a single literal (redirect/notFound exits discounted), so this TODO only appears when inference bailed: computed returns, two distinct shapes, or an unresolved sibling export. Read the action, pick the shape the component actually consumes, and write it into the stub. |

When you fill a fixture, also tighten the assertion: a mocked building named
`"flawless-name"` must actually reach the DOM
(`expect(screen.getByText("flawless-name")).toBeInTheDocument()`), or the spec
passes while rendering an empty state — the vacuous pass this tool exists to
prevent.

## Placement and survival

Colocated specs (`--colocate`, `<file>.flawless.test.tsx` beside the source)
are kept on re-runs, and their first line is a provenance stamp —
`// @flawless-generated sha256:<hex16> flawless-react@<version>`, hashing the
rest of the file. `--force` rewrites a spec only while that stamp still
matches; the moment you hand-harden one, the mismatch protects it (kept and
listed in the summary as hand-edited). Leave the stamp line alone when
editing: deleting it does not make the file regenerable, it just reclassifies
it as pre-stamp — the body edit already marks the file as yours, and the
delete-the-whole-file escape hatch is how you hand a spec back to the tool.
Specs inside the out dir are rewritten on any re-run; never hand-harden those.

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
- Never delete a colocated spec's stamp line casually — that demotes the file
  to pre-stamp; edit the body and let the stamp mismatch protect it.
- Never trust a green run whose fixtures are empty casts: fill, then assert
  the fixture content reaches the DOM.
