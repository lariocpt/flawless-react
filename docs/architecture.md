# Architecture

`flawless-react` is structured as a task registry. The CLI ([src/cli.ts](../src/cli.ts)) parses args (or prompts for them), expands the positional glob into entry files, analyses each into a `ComponentTree`, then dispatches the selected tasks against a shared `RunContext`. Each task in [src/tasks/](../src/tasks/) is self-contained; they share the analyse output and write their own slice of the output dir (`tests/`, `unit/`, `browser/`, `reports/`).

```text
                 entry.tsx
                     │
                     ▼
        ┌─────────────────────────┐
        │        analyse/         │   TypeScript compiler API
        │  parseFile  ─►  imports │
        │       │                 │
        │       ▼                 │
        │  extractProps           │   → propsShape + variants + unresolvedProps
        │  extractHooks           │   → ["useState", "useEffect", …]
        │  walkChildren           │   → recursive ComponentTree (cycle-guarded)
        └────────────┬────────────┘
                     │
                     ▼
                ComponentTree
                     │
                     ▼
        ┌─────────────────────────┐
        │        scaffold/        │
        │  templates ─► RenderedFile[]
        │  index    ─► Bun.write   │
        └────────────┬────────────┘
                     │
                     ▼
              <outDir>/ on disk
```

## Phase 1 — analyse

Implemented under [src/analyse/](../src/analyse/). One file per responsibility — small enough to swap out individually if you later want to use a different parser (e.g. SWC).

### parseFile.ts

Reads the entry file and runs `ts.createSourceFile(…, ScriptKind.TSX)`. Two recognisers run in order:

1. **`tryReactFCDecl`** — matches `const X: React.FC<Props> = (props) => …` (and the `FunctionComponent` alias, and the `FC<Props>` direct import). Captures `componentName`, the body node, and the props `TypeReferenceNode`.
2. **`tryDefaultExportFn`** — matches `export default function X(props: Props) { … }`.

If neither matches, the function throws with a descriptive message. We keep the recogniser deliberately small so the rules stay legible.

The function also returns an `imports` map of `local-name → module specifier` so child resolution can look up where a JSX tag came from.

### extractProps.ts

Walks the resolved `InterfaceDeclaration` or `TypeAliasDeclaration` (same-file only — imported types are not chased). For each `PropertySignature`, the type node is mapped:

| Source type | Default | Variants |
| --- | --- | --- |
| `string` / `number` / `boolean` / `null` | `""` / `0` / `false` / `null` | — |
| `T[]` | `[]` | — |
| inline `{ a: string; … }` | recurse | — |
| `"a"` / `42` / `true` (literal) | that literal | — |
| `"a" \| "b" \| "c"` (union of literals) | first literal | all literals → variant rows |
| anything else | — | added to `unresolvedProps` |

The variant matrix is **pairwise**, not cartesian: for each union prop, we generate one row per literal with all other props at their defaults. This keeps `--variants` honest as a row count.

### extractHooks.ts

Visits the component body's descendants once. Any `CallExpression` whose callee identifier matches `/^use[A-Z]/` is collected — both bare `useState()` and namespaced `React.useState()` forms. The result is deduplicated and sorted.

The list is **informational** — it appears in the generated spec's output but does not (yet) drive different rerender strategies. Hook-aware rerender drivers (e.g. specifically calling a `useState` setter) are a sensible future enhancement.

### walkChildren.ts

Walks the JSX in the component body, collects `JsxOpeningElement` and `JsxSelfClosingElement` tag names that:

1. Start with an uppercase letter (components, not DOM elements), and
2. Resolve to a *locally-imported* module — i.e. their import specifier starts with `./`, `../`, or `/`.

Bare specifiers (`react`, `lodash`, etc.) are ignored. The resolver tries `<path>`, then `<path>.tsx`, `<path>.ts`, `<path>/index.tsx`, `<path>/index.ts` so that `./Foo`, `./Foo.tsx`, and `./Foo/index.tsx` all work.

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
};
```

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

## Why two phases?

The split lets us:

- **Test analysis without producing files.** Most unit tests live in [tests/analyse.test.ts](../tests/analyse.test.ts) and operate on the `ComponentTree` directly.
- **Test rendering without touching disk.** `renderSuite` returns an array; [tests/scaffold.test.ts](../tests/scaffold.test.ts) asserts on the in-memory result before the integration tests round-trip through `Bun.write`.
- **Swap either side independently.** A future SWC-based analyser only has to produce a `ComponentTree`; the scaffolder is unchanged. A future scaffolder that emits a Vitest suite instead of Playwright only consumes the tree.

## What's intentionally absent

- **No runtime.** The CLI never imports React or Playwright. It does not boot a server. It only reads and writes files.
- **No type checker.** The analyser runs `ts.createSourceFile`, not the full TypeScript program. Imported types are not resolved across files. Trading off accuracy for speed and zero project-config requirements.
- **No code generation framework.** Templates are string concatenations. Easy to read, easy to diff against generated output, easy to grep.

If a future feature needs cross-file type resolution (e.g. resolving a `Props` type imported from a sibling file), the right path is to create a `ts.createProgram` lazily in `extractProps` for that one resolution, not to bring in a heavier framework.
