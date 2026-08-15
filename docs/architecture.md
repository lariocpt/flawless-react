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
Next.js projects — make every child tree come back empty. Bare package
specifiers deliberately resolve to `undefined`: `node_modules` is never walked.

### extractProps.ts

Walks the resolved `InterfaceDeclaration` or `TypeAliasDeclaration`, or an inline type literal on the first parameter. Same-file types resolve directly; an imported `Props` type is chased **two hops** through `resolveModule` (`MAX_HOPS` in `extractProps.ts`, and still no type checker). Every member's declaration site is recorded in `propPositions` so findings can point at the prop rather than line 1. For each `PropertySignature`, the type node is mapped:

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
a project-local module through `resolveModule` — relative paths **and**
tsconfig aliases. It also handles member tags (`<UI.Badge/>`, resolved to the
`Badge` export of the namespace's module), namespace imports, and components
declared in the same file. Type-only imports and bare package specifiers are
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

## Phase 2 — scaffold

Implemented under [src/scaffold/](../src/scaffold/).

### templates.ts

A pure function: `renderSuite({ tree, outDir, variants, report }) → RenderedFile[]`. Each `RenderedFile` is `{ relPath, content, executable? }`. There is no file IO here; this keeps the templates trivially testable.

The flat list of components (root + recursed children, deduped) becomes:

- One **import line per component** in `host/main.tsx`, with the path expressed relative to the host directory.
- One entry in the `REGISTRY` object keyed by component name, so `window.__profile.mount(name, props)` can find them.
- One **spec file per component** at `tests/<Name>.profile.spec.ts`. Each spec bakes its defaults, variants, and hooks list in as literals — no shared fixture file, no implicit coupling.

The host page initialises `react-scan` once at module load, buffers any "unnecessary rerender" events into `scanEvents`, and exposes `mount` / `rerender` / `unmount` / `getRenderInfo` / `getScanEvents` on `window.__profile`. The driver API is deliberately small.

### index.ts (the writer)

Resolves `outDir`, refuses to overwrite unless `--force`, creates the dir tree with `fs/promises.mkdir({ recursive: true })`, and writes each `RenderedFile` with `Bun.write`. The `executable` flag flips a `chmod 0o755` on emitted scripts.

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
  that instead. Refreshed by `--force`; the fixtures file beside it is not.
- **Style adoption** — `scaffold/adoptStyle.ts` reformats everything written
  with the host project's own biome or prettier, and JSON merges preserve the
  file's existing indentation. Generation should read as an additive diff, not
  a reformat.

## Why two phases?

The split lets us:

- **Test analysis without producing files.** Most unit tests live in [tests/analyse.test.ts](../tests/analyse.test.ts) and operate on the `ComponentTree` directly.
- **Test rendering without touching disk.** `renderSuite` returns an array; [tests/scaffold.test.ts](../tests/scaffold.test.ts) asserts on the in-memory result before the integration tests round-trip through `Bun.write`.
- **Run what we emit, where parsing is not enough.** [tests/emittedSyntax.test.ts](../tests/emittedSyntax.test.ts) parses the emitted TypeScript, but its filter is `/\.tsx?$/` — the shell script, the node script, the crust pipes and the JSON are invisible to it. [tests/emittedExecution.test.ts](../tests/emittedExecution.test.ts) executes those instead: `load/env.sh` is sourced under bash *and* zsh from a cwd that cannot rescue it, `scripts/report.mjs` runs under a real node, and the baseline `assert` in `routes.pipes` is evaluated as the JavaScript crust treats it as. The `env.sh` bug that motivated this rendered, parsed, and ran under bash; only a different shell exposed it.
- **Swap either side independently.** A future SWC-based analyser only has to produce a `ComponentTree`; the scaffolder is unchanged. A future scaffolder that emits a Vitest suite instead of Playwright only consumes the tree.

## What's intentionally absent

- **No runtime.** The CLI never imports React or Playwright. It does not boot a server (the e2e task *emits* a config that boots the target's dev server; it does not run one itself).
- **No type checker.** The analyser runs `ts.createSourceFile`, not a full TypeScript program. Imported prop types are chased two hops at most; unions of non-literals and generics other than the ones tabled above land in `unresolvedProps`, and the type names that defeated it land in `unresolvedTypes`.
- **No code generation framework.** Templates are string concatenations. Easy to read, easy to diff against generated output, easy to grep.

The consequence is worth stating plainly: every rule that cannot be decided
syntactically **bails instead of guessing**. Hook-dependency findings skip
member-access deps and non-inline callbacks; memoisation findings skip children
with spread props or unknown identifiers. A clean report means "nothing this
analysis can prove", not "nothing wrong".

If a future feature needs real cross-file type resolution, the right path is a
lazily-created `ts.createProgram` inside `extractProps` for that one lookup —
not a heavier framework.
