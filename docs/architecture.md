# Architecture

`flawless-react` is structured as a task registry. The CLI ([src/cli.ts](../src/cli.ts)) parses args (or prompts for them), expands the positional glob into entry files, analyses each into a `ComponentTree`, then dispatches the selected tasks against a shared `RunContext`. Each task in [src/tasks/](../src/tasks/) is self-contained; they share the analyse output and write their own slice of the output dir (`profile/`, `unit/`, `browser/`, `e2e/`, `load/`, `reports/`).

```text
                 entry.tsx (or glob)
                     │
                     ▼
        ┌──────────────────────────────────────────┐
        │                analyse/                  │  TypeScript compiler API
        │  parseFile      ─► every component in    │  (createSourceFile only)
        │                    the file + imports    │
        │  resolveModule  ─► tsconfig paths/extends│
        │  extractProps   ─► defaults + variants   │
        │  extractState   ─► useState/Reducer/Ref  │
        │  extractHooks(Details) ─► deps, effects  │
        │  extractPropUsage / extractChildAttrs    │
        │  extractInteractions / extractFetchCalls │
        │  walkChildren   ─► recursive tree        │
        └────────────────────┬─────────────────────┘
                             │
                             ▼
                       ComponentTree
                             │
              ┌──────────────┼───────────────┐
              ▼              ▼               ▼
        scaffold/      scaffold-tests/    tasks/*
        (perf host)    (unit + browser)   (perf-static, a11y,
              │              │             react-rules, e2e, load)
              └──────────────┴───────────────┘
                             │
                             ▼
              <outDir>/ on disk  ─►  adoptStyle (host formatter)
```

## Phase 1 — analyse

Implemented under [src/analyse/](../src/analyse/). One file per responsibility — small enough to swap out individually if you later want to use a different parser (e.g. SWC).

### parseFile.ts

Reads the entry file and runs `ts.createSourceFile(…, ScriptKind.TSX)`, then
returns a `ParsedFile`: **every** component declared in that file (primary
first), the import bindings, and the module-level imports classified as
`component` vs `value`.

Recognised shapes: `const X: React.FC<Props> = …`, exported function
declarations, JSX-returning arrows without an FC annotation, anonymous
`export default (…) => …` (named after the file), and `memo()` / `forwardRef()`
wrappers (unwrapped, with the wrapper recorded). Each unit carries
`exportKind` (default/named/none), `isAsync` (server component) and the file's
`"use client"` flag, which is what lets the scaffolder emit the right import
form and switch to an RSC template.

Props come from the FC type argument, a first-param type reference, or an
inline type literal. `Promise<T>` props (Next.js 15 `params`) are synthesised
unwrapped and listed in `promiseProps` so specs can re-wrap them.

### resolveModule.ts

Module resolution for the analyser: relative specifiers, plus tsconfig `paths`
aliases with full `extends` chains (arrays, bare `@tsconfig/*` specifiers,
cycle-guarded) and `baseUrl`. Without this, `@/`-style imports — the norm in
Next.js projects — make every child tree come back empty. After a
paths/baseUrl miss (or with no tsconfig at all), a bare specifier is tried
against the monorepo's **workspace map**: the nearest `package.json` with a
`workspaces` field (or `pnpm-workspace.yaml`) names the member packages, and
a matching `@scope/pkg` or `@scope/pkg/subpath` resolves into that package's
**source** tree (`src/` probed first) — never its `exports`/`main`/`types`
dist mappings, which are routinely stale and have no function bodies to read.
Only literal dirs and single-star globs (`packages/*`) are honoured; anything
fancier is skipped, because `undefined` is the bail-safe direction. Bare
THIRD-PARTY specifiers still deliberately resolve to `undefined`:
`node_modules` is never walked, even when a glob names it.

### extractProps.ts

Walks the resolved `InterfaceDeclaration` or `TypeAliasDeclaration`, or an inline type literal on the first parameter. Same-file types resolve directly; an imported `Props` type is chased **two hops** through `resolveModule` (`MAX_HOPS` in `extractProps.ts`, and still no type checker). When the resolved module is a barrel that only *re-exports* the name (`export * from`, `export { A as B } from`), the chase to the declaring file rides `findExportedDecl` in `sourceCache.ts` — a visited-set-bounded walk that does **not** consume the hop budget, or component → barrel → types file would exhaust it before a single member resolved. Every member's declaration site is recorded in `propPositions` so findings can point at the prop rather than line 1. For each `PropertySignature`, the type node is mapped:

| Source type | Default | Variants |
| --- | --- | --- |
| `string` / `number` / `boolean` / `null` | `""` / `0` / `false` / `null` | — |
| `T[]` | `[]` | — |
| inline `{ a: string; … }` | recurse | — |
| `"a"` / `42` / `true` (literal) | that literal | — |
| `"a" \| "b" \| "c"` (union of literals) | first literal | all literals → variant rows |
| `A & B` (intersection) | merged left-to-right | union of both sides' variants |
| `ComponentProps<"div">` and friends | curated host-element table | — |
| `ComponentProps<typeof LocalX>` | resolved through X, one import hop | inherited |
| `VariantProps<typeof xVariants>` | cva `defaultVariants`, else first option | every option per key |
| `z.infer<typeof Schema>` alias | schema read syntactically: `z.object` → shape, `z.enum` → first literal, declared `.default`s honoured | enum fields → variant rows |
| anything else | — | prop name → `unresolvedProps`, type name → `unresolvedTypes` |

An intersection operand that resolves to nothing contributes only its
`unresolvedTypes` entry, so `ButtonPrimitive.Props & VariantProps<typeof
buttonVariants>` still yields the cva half rather than being dropped whole.
Conflicts resolve `literal > variant > interface > component > host`, ties to the
right-most operand.

The host-element table (`hostProps.ts`) is curated rather than a DOM model, and
three of its omissions are deliberate: `value`/`checked` are never synthesised
(React's controlled-input warning makes `userEvent.type` a silent no-op),
`placeholder`/`name`/`required` are never synthesised (`getByPlaceholderText("")`
throws), and `type` is always a real literal rather than `""`.

A prop the type layer cannot resolve gets one more chance: if the body uses it to
index a same-file object literal with literal keys — the
`const STATUS_LABEL: Record<JobStatus, string> = { requested: … }` pattern —
those keys ARE the union, and the first becomes the default
(`resolveIndexKeys.ts`). A spread inside that literal gives up, because a partial
key list would produce a default that is not in the union at all.

The variant matrix is **pairwise**, not cartesian: for each union prop, we generate one row per literal with all other props at their defaults. This keeps `--variants` honest as a row count.

### extractHooks.ts

`extractHooks` collects every `CallExpression` whose callee matches
`/^use[A-Z]/` (bare and `React.`-namespaced), deduplicated and sorted — the
original informational list.

`extractHookDetails` is the analytical one: per call site it records position,
argument shapes, the dependency array as raw source text (plus a
`depsHasComplex` flag), whether a deps-taking hook is missing its array, which
component-scope identifiers the callback reads, and for effects whether they
`fetch` / set timers / add listeners and whether they return a cleanup. This is
what `perf-static` turns into missing/extraneous-dependency findings — and why
those rules bail loudly rather than guess whenever deps contain member access,
spreads, or a non-inline callback.

### extractState.ts, extractPropUsage.ts, extractChildAttrs.ts, extractFetchCalls.ts

- **State** — `useState` / `useReducer` / `useRef` bindings: variable and setter
  names, literal initial values, inferred type kind, every setter call site
  classified by context (`handler` / `effect` / `callback` / `render`, with a
  `guarded` flag), and how the value reaches JSX (as a child or an attribute).
  This drives initial-state and interaction→state tests, and the
  `set-state-in-render` rule.
- **Prop usage** — every reference to a prop, classified in fixed precedence
  (`hook-dep`, `jsx-attr` / `passed-to-child`, `jsx-child`, `call`, `hook-arg`,
  `member-access`, `conditional`, `other`) with positions.
- **Child attrs** — the value shape of every attribute passed to a component
  child (identifier, member, object/array literal, arrow…), which is how
  unstable-prop and missing-memo findings get their evidence.
- **Fetch calls** — `fetch()` URLs as `:hole` templates with method and an
  in-effect flag, so the scaffolder can write MSW-backed loading/error/empty
  specs against the paths the component really calls.

All of these share `refs.ts`, which builds a `ComponentScope` (prop names and
aliases, state vars, setters, refs, memo results, derived locals) and resolves
identifier references while excluding non-reference positions. It is purely
syntactic: shadowing inside nested closures is a known, documented limit.

### extractLogging.ts

Whether the component reports errors itself — `console.error` / `console.warn`,
or `.error()` / `.warn()` on an **imported** binding. That qualification is what
keeps it from becoming a name guess: an imported `logger` is a module pulled in
for the purpose, while a local's `.error()` may reach no console at all.

It exists because a Next.js `error.tsx` boundary logs what it caught, and the
browser spec asserted "mounts without console errors" — failing the component
for honouring its contract. Where this fires, the spec drops that one assertion,
names the call it saw, and keeps the uncaught-exception and rendered-output
assertions, which are still true claims.

### htmlContentModel.ts

Three lookups that are facts about HTML rather than inferences about the app:

- **Required ancestors** — `<tbody>` belongs in a `<table>`, `<td>` in
  `table > tbody > tr`, `<option>` in a `<select>`. The browser host nests a
  component's mount through that chain; without it React logs a nesting warning
  the harness itself provoked, and seven table primitives failed for it.
- **Fillable tags** — only `input`, `textarea` and `select` hold a value. A
  change handler on a `<form>` is React's event delegation, and driving it
  literally emitted `locator("form").fill("x")`, which Playwright rejects.
- **Fill kind** — from `tag` + `type`: text, toggle (checkbox/radio), select, or
  skip (hidden, file, range, colour, image, submit…). Typing into a checkbox
  does nothing; typing into sixteen that share a name cannot even be addressed.

### walkChildren.ts

Walks the JSX in the component body and collects uppercase tags that resolve to
a project-local module through `resolveModule` — relative paths, tsconfig
aliases, **and** the repo's own workspace packages. It also handles member tags
(`<UI.Badge/>`, resolved to the `Badge` export of the namespace's module),
namespace imports, and components declared in the same file. Type-only imports
and bare third-party specifiers (anything the workspace map does not name) are
skipped.

### index.ts (the orchestrator)

Recursively analyses each discovered child up to `--depth`, cycle-guarded by absolute path. If a child file can't be parsed (no recognisable component), it's skipped silently — composite trees often pull in non-component utilities. Other parse errors propagate.

Output:

```ts
type ComponentTree = { entry: ComponentInfo; children: ComponentTree[] };
type ComponentInfo = {
  componentName: string;
  filePath: string;
  importSpecifier: string;
  propsShape: PropsShape;
  variants: PropsShape[];
  hooks: string[];
  unresolvedProps: string[];
  interactions?: InteractionInfo;
  // Added by the analyser rework; all optional so downstream consumers that
  // predate them keep compiling.
  pos?: SourcePosition;
  exportKind?: "default" | "named" | "none";
  isAsync?: boolean;            // async server component
  isClientComponent?: boolean;  // file carries "use client"
  wrappers?: Array<"memo" | "forwardRef">;
  localTag?: string;            // tag the parent used, under import aliasing
  propUsage?: PropUsage[];
  propPositions?: Record<string, SourcePosition>;
  promiseProps?: string[];
  state?: StateInfo[];
  hookDetails?: HookDetail[];
  childAttrs?: ChildAttrInfo[];
  fetchCalls?: FetchCallInfo[];
  moduleImports?: ModuleImportInfo[];
};
```

`ComponentTree` is the stable seam. Everything downstream — the perf harness,
the unit/browser scaffolder, and every task — consumes it and nothing else.

## The platform seam

Two element vocabularies, decided **per file** rather than per run.

`src/analyse/nativeDialect.ts` reads a file's own imports: anything from `react-native`, `react-native-*`, `@react-native*/`, `expo`, `expo-*`, `@expo/`, `@react-navigation/` or `nativewind` makes the file **native**; everything else is **dom**, which is what every file analysed before this existed was.

Per-file, not per-run, for three reasons in ascending cost of getting it wrong. The evidence is already in `parsed.imports` before any extractor runs, so a flag would ask the operator to assert something the tool can read. A flag cannot express a monorepo, where `apps/web` and `apps/mobile` under one sweep have different answers. And "an Expo app also targets web" argues *against* a run-level axis rather than for one: under Expo web the source is byte-identical — still `<View>`, still imported from `react-native` — and only the runtime differs, so there is nothing for a source-level platform switch to select.

The invariant that makes it safe: **a file with host elements to classify always carries the import that proves the dialect**, because a React Native host element is only reachable through an import. There are no ambient capitalised intrinsics.

### `hostTag.ts` — one predicate, five call sites

`/^[a-z][a-z0-9-]*$/` used to decide what a host element was, written out in `extractRootTag`, `extractRenderMode`, `extractFlows`, `extractChildAttrs` and `selectors.ts`. It now lives once, as a `HostTagResolver`:

- lowercase → a DOM intrinsic. Byte-identical to the old test.
- Capitalised → a host element **iff this file imports that name from a specifier in the closed native table**.
- anything else → `undefined`, meaning "this is a component" — exactly the state every uppercase tag was already in.

Never a guess from the name: `<IconButton>` is not a button, and shadcn's `<ButtonPrimitive>` still answers `undefined` on the web path. It reports the **module-side** name, so `import { View as Box }` gives `"View"` — the same refusal `extractRootTag` already makes for `<UI.Badge/>`, applied in the other direction, and what makes `rootTag` comparable across files.

Every extractor takes the resolver as a **trailing optional parameter defaulting to the DOM rule**, and a DOM file gets `domOnlyResolver` *itself* rather than a wrapper — so the web path is unchanged by construction rather than by inspection.

### The native tables

[src/analyse/nativeProps.ts](../src/analyse/nativeProps.ts) is the peer of `hostProps.ts`, keyed by **specifier then export name** — which is what stops a local component called `View` becoming a host element. Its `BASE` is empty, and that is the honest answer: React Native has no universal prop whose synthesised default is both valid and useful, and `className` belongs to NativeWind rather than to RN.

Four invariants, each pinned by a test that names the false result it prevents:

1. **Never synthesise `value`** (except `Switch`, which has no `defaultValue`). `<TextInput value={x}/>` with no `onChangeText` is React Native's controlled-input trap: the field is frozen and `fireEvent.changeText` is a **silent no-op that still passes** — worse than the DOM version, where React at least warns.
2. **Never synthesise a locator prop.** `placeholder`, `testID`, `accessibilityLabel`, `accessibilityHint` and `nativeID` *are* the entire @testing-library/react-native locator surface.
3. **Never synthesise a role.** RNTL resolves role from `accessibilityRole` alone, so an invented one makes `getByRole` pass on a fiction.
4. **Read `editable` with inverted polarity** — `editable={false}` is React Native's disabled state: the hint must record the field as disabled *always*, a bare or `editable={true}` field as not disabled, an undecidable `editable={expr}` as conditional. The value lands on `hints.disabled`, the field `postDispatch` names as the one DOM and native "have drifted before" — the 2026-09 review (FR-054) found it inverted at the `analyse()` surface, honest in no emitted output but a lie waiting for a custom reporter.

`NATIVE_TAG_TO_ROLE` has **exactly one row** — RN's own `<Button>`, the only element whose source sets a role unconditionally — and a test asserts the count. RNTL's `getRole()` reads the explicit prop, else `"text"` for `Text`, else `"none"`; there is no `Pressable → button` mapping anywhere in the library, so a fuller table would emit queries that match nothing.

[src/analyse/nativeContentModel.ts](../src/analyse/nativeContentModel.ts) is deliberately nearly empty, and that is the finding rather than an omission: React Native has no required-ancestor chains, so none are declared. It encodes the one hard runtime invariant that does exist — **a raw string must be inside `<Text>`**, which throws — plus the fill model and the hooks that demand a provider. `SafeAreaView` is *absent* from that last list and a test says so: v5 renders a native view and reads no context, so listing it would encode a required-ancestor fact that is simply false.

### What changes downstream

`EVENT_PATTERN` gains a native sibling (`onPress`, `onChangeText`, `onValueChange`, …); `collectHints` reads `testID`/`accessibilityLabel`/`accessibilityRole`/`accessibilityHint` and deliberately never populates `name` or `type`, which is what makes `selectors.ts`'s DOM-only branches inert on native data; and `extractLabel` **descends** — in the DOM the copy is inside the handler element, in React Native it is always one level down inside a `<Text>`. Descending is not a guess: RNTL's `getTextContent` recurses the subtree, and `fireEvent.press` walks *up* to the nearest press responder, so a descendant `<Text>` is the canonical handle.

`classNameFlow` is forced **false** on native. NativeWind compiles `className` into a `style` through babel at build time, and the string reaches neither the jest-expo tree nor the react-native-web DOM — so the assertion is both unfalsifiable and unsatisfiable.

### The native a11y census

For a native-dialect file, `extractInteractions` runs a **second walk** — over the whole source file, with no reachability pruning — and retains one `NativeA11yElement` per resolved native host element on `InteractionInfo.a11yElements`. The two walks answer different questions on purpose: the clicks harvest decides what a spec can *drive*, where a phantom element costs a wrong click, so it prunes branches the initial render never takes; the census decides what a screen reader *encounters*, and the back button inside an error branch still needs its role. Same-file sibling components are included (each component carries the file's whole census; the task dedupes by position), which matters because the dogfood idiom keeps row components beside their screens.

### The API-endpoint harvest (load, native)

For a native-dialect file, `harvestApiEndpoints` ([src/analyse/harvestApiEndpoints.ts](../src/analyse/harvestApiEndpoints.ts)) retains on `ComponentInfo.apiCalls` the GET/mutation endpoints the screen reaches through the app's own fetch wrapper — the load harvest, and the reason `--expo --tasks load` has anything to test. A React Native screen never writes `fetch()` (`extractFetchCalls` finds 0 on the whole dogfood app); it calls a named api function whose body calls a module-local wrapper with a literal path, two hops away. This reads exactly that chain: the screen must *call* an imported name; the name resolves through barrels (`findExportedDecl`) to a function whose body calls a **proven** fetch wrapper — one whose single `fetch()` addresses its own parameter, trusted structurally and never by name — with a string-literal/template path. Anything less certain (a store-mediated call, a non-literal URL, a wrapper two modules deep) is dropped: a missing endpoint costs a pipe, a wrong one measures a URL the app never sends. Native-only, so the web load path (which reads `fetchCalls` directly) is byte-identical. The harvested template is **cut at the first `?`** — a query's values are runtime state the pipe cannot carry, so the base path is the load target: a path parameter before an inline query (`/things/${id}?tab=${t}`) used to leave a dangling `?tab=` in the emitted target (2026-09 review, FR-058).

The `a11y` task judges that census at task time — the perf-static shape, harvest-at-analysis / judge-at-task, because `RunContext` does not carry the parse. Six `a11y/*` rules ([src/tasks/a11yNative.ts](../src/tasks/a11yNative.ts)), every one built to stand down rather than guess: a dynamic `accessibilityLabel={t("back")}` is recorded as *presence* and never flagged, `unnamed-control` fires only on provably-textless elements (icon-only or childless), never on dynamic children, which do announce at runtime, and an icon that is the root of its JSX island — a render prop like `tabBarIcon` — is exempt, because the container receiving it is invisible to the file (React Navigation's tab button announces the tab title over exactly that shape; caught live on the dogfood app, where it was the analyser's only false-positive class). The aggregate and summary always carry the denominator — elements examined, rules applied — so a native zero can never again read as coverage, which is the vacuous green (`docs/archive/2026-08-expo-probes.md`, P6) this wave exists to kill. The role unions (`VALID_ACCESSIBILITY_ROLES`, `VALID_ROLES` in nativeProps.ts) are closed copies of RN 0.81.5's own, size-pinned, because RN widens both with `| string` and tsc therefore never catches a typo'd role.

## Phase 2 — scaffold

Implemented under [src/scaffold/](../src/scaffold/).

### templates.ts

A pure function: `renderSuite({ tree, outDir, variants, report }) → RenderedFile[]`. Each `RenderedFile` is `{ relPath, content, executable? }`. There is no file IO here; this keeps the templates trivially testable.

The flat list of components (root + recursed children, deduped) becomes:

- One **import line per component** in `host/registry.ts`, with the path expressed relative to the host directory.
- One entry in its `REGISTRY` object keyed by component name, so `window.__profile.mount(name, props)` can find them. The tables (`REGISTRY`, `FN_PROPS`, `WRAP_IN`) live in `host/registry.ts`, which is **regenerated on every run** — the write-once `host/main.tsx` wrapper imports them and spreads `REGISTRY` into its `ALL` map, the one place hand registrations survive regeneration (FR-016).
- One **spec file per component** at `profile/<Name>.profile.spec.ts` (never `tests/` — a project script reading `bun test tests` would collect them, see generated-suite.md). Each spec bakes its defaults, variants, and hooks list in as literals — no shared fixture file, no implicit coupling.

The host page initialises `react-scan` once at module load, buffers any "unnecessary rerender" events into `scanEvents`, and exposes `mount` / `rerender` / `unmount` / `getRenderInfo` / `getScanEvents` on `window.__profile`. The driver API is deliberately small.

### index.ts (the writer)

Resolves `outDir` and decides the run's lifecycle status off the suite's own `playwright.config.ts` marker: absent → `generated`; present → `refreshed` (every derived file rewritten, `writeOnce` files kept); present with `keepExisting` (changed-mode) → `kept`, nothing written, the marker's generated-by banner parsed so the caller can name the version that wrote the suite. Creates the dir tree with `fs/promises.mkdir({ recursive: true })` and writes each `RenderedFile` with `Bun.write`; the `executable` flag flips a `chmod 0o755` on emitted scripts.

## Phase 2b — scaffold-tests

[src/scaffold-tests/](../src/scaffold-tests/) is the unit/browser side, and the
same pure-render/write split applies: `renderUnitBrowser(opts) → RenderedFile[]`,
written by `scaffoldUnitBrowser`. A `RenderedFile` may carry an `absPath`
(colocated specs land next to their source instead of under `outDir`) and
`skipIfExists` (hand-hardened colocated specs survive regeneration without
`--force`).

What the analysis buys the templates:

| analysis field | what it emits |
| --- | --- |
| `exportKind` | `import X from` vs `import { X }` |
| `isAsync` | RSC template (`await Component(props)`), no browser spec |
| `moduleImports` (kind `value`) | `vi.mock` stubs for an RSC's data dependencies |
| `promiseProps` | props re-wrapped in `Promise.resolve` |
| `state` | initial-state witnesses, handler→setter interaction tests |
| `fetchCalls` (in-effect) | MSW `server.use` describe blocks: success / loading / error / empty |
| `interactions` | targeted click/form tests with handler-isolation assertions |

## Tasks

[src/tasks/](../src/tasks/) holds one module per `TaskId`, each a
`{ id, label, description, needsTree, run(ctx) }` object registered in
`tasks/index.ts`. Adding a task means touching that registry, the `TaskId`
union in `types.ts`, `VALID_TASK_IDS` + help text in `cli.ts`, and the counts
record in `reporters/findings.ts`.

`RunContext` carries the trees, the output dir, the resolved provider, the
Next.js context and the full list of selected task ids — the last one so a task
can honour a cross-task dependency (`unit-browser` skips browser specs when
`perf-harness` is not part of the run, because those specs drive its host).

## Phase 3 — core and the CLI

[src/core.ts](../src/core.ts) holds `runCore(opts) → CoreResult`: Next.js
detection, spec enrichment, provider substitution, task dispatch, mock
emission, package/gitignore merging, style adoption. It never calls
`process.exit` and throws `UsageError` for bad input.

[src/cli.ts](../src/cli.ts) is a thin shell over it (argument parsing, the
interactive menu, exit codes), and [src/index.ts](../src/index.ts) exposes
`runFlawless` plus the analysis primitives as the public programmatic API.

Two behaviours worth knowing because they affect the *target* repo rather than
the output dir:

- **Provider substitution** — when the auto-detected app resolver is an async
  server layout, `nextjs/providerWrapper.ts` derives a client-safe
  `flawless/provider.tsx` from the `{children}`-enclosing JSX chain and uses
  that instead. A pages-router `_app.tsx` is the same problem wearing a
  different hat: it renders `<Component />` rather than `{children}`, so the
  chain is anchored on `<Component />` — mounting `_app` itself would wrap
  nothing. Providers from a library the harness stubs to signed out are dropped
  with `auth` as their reason, and a component that reads a library context
  nobody supplies gets a generated provider from `analyse/providerWraps.ts`.
  Refreshed by `--force`; the fixtures file beside it is not.
- **Context provider wraps** — `analyse/providerWraps.ts` feeds both mount
  planes the providers they cannot see: route layouts import the app's context
  providers, and route files are not analysed entries. Each mount opens with a
  derived nest built from four evidence classes (hook call, namespace
  compound, transitive requirement, and a dynamic render — an uppercase tag the
  body binds from a project hook's return, which owes every component that
  hook's values can name: the hook body's own JSX plus one import hop into each
  value identifier's top-level definition, depth 2 inside a definition, 16
  components, merged into the render-edge worklist before the closure so the
  closure treats it as the render it is), following the re-export table through
  barrels — though the dynamic hop itself ends at a barrel that only re-exports,
  since a re-export table declares nothing to walk. A hook arriving from a bare
  module has no context object to join
  on, so it pairs by convention instead — an exported `XProvider` rendering a
  binding from `useX`'s own module, three conjuncts or nothing. Library
  contexts the app cannot supply get generated shims (query client, router —
  the data-router wrap supersedes the `MemoryRouter` one — forms, intl). The
  wrap list is closed under requirements and ordered outermost-first; the
  user's `--provider` rides outside the whole nest.
- **Style adoption** — `scaffold/adoptStyle.ts` reformats everything written
  with the host project's own biome or prettier, and JSON merges preserve the
  file's existing indentation. Generation should read as an additive diff, not
  a reformat.

## The docs are part of the deliverable

Everything this project claims about itself — `README.md`, `docs/*.md`, the
skills under `.agents/skills`, and the separate website repo — is checked
against the code, not trusted. `.claude/skills` is a per-skill symlink into that
same corpus for agents that look only there, so the lint walks one root and every
agent reads the same bytes.

That is new, and it is new because nothing had ever checked it. No test in
`tests/` opened a prose file, and a single reading pass in round 8 turned up a
skill documenting a `throw` the tool never emits, a wrong exit-code table, a
`--ci` field list two fields stale, and a JSDoc contradicting itself two lines
later. The first run of the guard found three more, plus the code defect
underneath one of them (FR-048).

- [tests/docsLint.test.ts](../tests/docsLint.test.ts) parses every documented
  `flawless-react …` invocation through the real `parseArgs`, and checks the
  flag inventory, the task ids, the `--ci` blob's field set, the documented exit
  codes, the environment variables and the emitted artefact paths. The last
  four are checked against a **real run** over `tests/fixtures/nextapp`, not
  against a reading of the source.
- [tests/skillsDocs.test.ts](../tests/skillsDocs.test.ts) covers what is
  specific to a skill: frontmatter, and the siblings it cross-references.
- The corpus ships **inside** the deliverable: [src/skills/data.ts](../src/skills/data.ts)
  imports every `SKILL.md` as text, so `flawless-react skills install` works from a
  published install on a machine with no checkout of this repo. Two consequences are
  tested rather than remembered — the embedded bytes equal the tracked files, and
  `package.json`'s `files` still covers `.agents/skills` plus the postinstall script,
  because a publish that drops either ships a CLI whose only new command cannot run.
- Both carry a "the lint can actually fail" block. A guard that cannot redden is
  worse than no guard, because it reads as coverage.

The flag list lives in [src/cliFlags.ts](../src/cliFlags.ts) as data. `--help`
renders from it, so help can never omit a flag, and `flawless-react --flags`
prints it for consumers that cannot import it. That last one is the bridge to
the website repo: it has hand-copied examples and a table headed "every flag
flawless-react accepts", it cannot import `parseArgs`, but its CI can run the
published binary — `--check '<line>'` parses without executing (no file opened,
nothing spawned), and `--flags` is what catches a flag the table simply omits,
which `--check` never can. Four real flags went undocumented exactly that way.

If you change the CLI or an emitted path, these go red before a user does.

## Why two phases?

The split lets us:

- **Test analysis without producing files.** Most unit tests live in [tests/analyse.test.ts](../tests/analyse.test.ts) and operate on the `ComponentTree` directly.
- **Test rendering without touching disk.** `renderSuite` returns an array; [tests/scaffold.test.ts](../tests/scaffold.test.ts) asserts on the in-memory result before the integration tests round-trip through `Bun.write`.
- **Run what we emit, where parsing is not enough.** [tests/emittedSyntax.test.ts](../tests/emittedSyntax.test.ts) parses the emitted TypeScript, but its filter is `/\.tsx?$/` — the shell script, the node script, the crust pipes and the JSON are invisible to it. [tests/emittedExecution.test.ts](../tests/emittedExecution.test.ts) executes those instead: `load/env.sh` is sourced under bash *and* zsh from a cwd that cannot rescue it, `scripts/report.mjs` runs under a real node, and the baseline `assert` in `routes.pipes` is evaluated as the JavaScript crust treats it as. The `env.sh` bug that motivated this rendered, parsed, and ran under bash; only a different shell exposed it.
- **Swap either side independently.** A future SWC-based analyser only has to produce a `ComponentTree`; the scaffolder is unchanged. A future scaffolder that emits a Vitest suite instead of Playwright only consumes the tree.

## What's intentionally absent

- **No runtime.** The CLI never imports React or Playwright. It does not boot a server (the e2e task *emits* a config that boots the target's dev server; it does not run one itself).
- **No type checker.** The analyser runs `ts.createSourceFile`, not a full TypeScript program. Imported prop types are chased two hops at most; unions of non-literals and generics other than the ones tabled above land in `unresolvedProps`, and the type names that defeated it land in `unresolvedTypes`. Zod schemas are read as **syntax**, never executed — `z.infer` resolves for the object/enum/primitive/array/coerce subset (type-invariant refinements ignored), and `.transform`, unions, records and dates bail rather than guess.
- **No code generation framework.** Templates are string concatenations. Easy to read, easy to diff against generated output, easy to grep.

The consequence is worth stating plainly: every rule that cannot be decided
syntactically **bails instead of guessing**. Hook-dependency findings skip
member-access deps and non-inline callbacks; memoisation findings skip children
with spread props or unknown identifiers. A clean report means "nothing this
analysis can prove", not "nothing wrong".

If a future feature needs real cross-file type resolution, the right path is a
lazily-created `ts.createProgram` inside `extractProps` for that one lookup —
not a heavier framework.
