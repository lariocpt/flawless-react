/**
 * Provider-bound auth libraries — the ones that THROW when a component renders
 * without their provider mounted. `@clerk/nextjs` refuses on a missing
 * publishableKey before anything else runs; its hooks refuse outside
 * ClerkProvider; next-auth's useSession refuses outside SessionProvider. A
 * browser host bundles every analysed component into ONE module graph (the
 * kiranism dogfood run: Accordion's profile spec died on "Missing
 * publishableKey" because AppSidebar's Clerk import poisoned the shared
 * bundle), and jsdom units mount components bare, with no app layout to
 * supply the provider.
 *
 * Neither plane can meaningfully run a real auth handshake, so the whole
 * library is replaced with a signed-out stub — same philosophy as the global
 * next/navigation mock in setup.ts. The stub is generated from the export
 * names the analysis actually saw imported, because ESM named imports have to
 * bind: a catch-all default export cannot satisfy `import { useUser }`.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";

/** Package names matched exactly or by subpath ("next-auth/react", "@clerk/nextjs/server"). */
const AUTH_LIB_PREFIXES = [
  "@clerk/nextjs",
  "@clerk/clerk-react",
  "next-auth",
  // The Supabase auth layer, in both its generations: `auth-helpers-*` is the
  // tutorial stack (talkformai's pages/_app builds a client in a useState
  // initializer, so with no env file the CONSTRUCTOR throws before a single
  // spec runs — 17 files, 26 tests, all dead on
  // "either NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY env
  // variables or supabaseUrl and supabaseKey are required!"), and `@supabase/ssr`
  // is its replacement. Both are provider-bound: the session context they
  // supply is exactly what a unit mount cannot have. `@supabase/supabase-js`
  // itself stays unstubbed — it is the SDK rather than the provider, and a
  // stubbed `from().select()` chain would turn a named failure into undefined
  // results quietly flowing through an assertion.
  "@supabase/auth-helpers-nextjs",
  "@supabase/auth-helpers-react",
  "@supabase/ssr",
];

export function isAuthLibSpecifier(specifier: string): boolean {
  return AUTH_LIB_PREFIXES.some((p) => specifier === p || specifier.startsWith(`${p}/`));
}

export interface AuthStub {
  /** Module-side export names to bind (the "cn" of `import { cn as cx }`), sorted, no "default". */
  names: string[];
  hasDefault: boolean;
}

/** The part of ModuleImportInfo the collector reads, so a raw file can feed it too. */
interface AuthImportEvidence {
  specifier: string;
  names: readonly string[];
  importedNames?: readonly string[];
  isTypeOnly?: boolean;
}

/**
 * Import declarations of a file the analysis never visits. The app resolver is
 * mounted by every spec without being an analysed component, so its auth
 * imports would stay unstubbed while its module graph runs for real:
 * talkformai's pages/_app.tsx is the only file importing
 * `createPagesBrowserClient` / `SessionContextProvider`, and with no env file in
 * the repo the real client threw from its constructor — 17 spec files, 26
 * tests, none of them reaching an assertion. The import table is all the
 * collector needs; the shim binds the names.
 */
function fileImportEvidence(file: string): AuthImportEvidence[] {
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX,
    );
  } catch {
    return [];
  }
  const out: AuthImportEvidence[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const names: string[] = [];
    const importedNames: string[] = [];
    if (clause.name) {
      names.push(clause.name.text);
      importedNames.push("default");
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        names.push(el.name.text);
        importedNames.push(el.propertyName?.text ?? el.name.text);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      names.push(bindings.name.text);
      importedNames.push(bindings.name.text);
    }
    if (names.length === 0) continue;
    out.push({ specifier: stmt.moduleSpecifier.text, names, importedNames });
  }
  return out;
}

/**
 * Specifier → the export names any analysed file imports from it. Collect from
 * EVERY analysed component, not just the mountable ones: an excluded component
 * is still imported transitively by a hosted neighbour, and one unstubbed
 * throw poisons the whole bundle. Namespace imports are indistinguishable
 * here (the analyser records the local name as the module-side name); a repo
 * that does `import * as clerk from "@clerk/nextjs"` will see undefined
 * members and the dogfood failure will name the specifier.
 */
export function collectAuthStubs(
  infos: Iterable<{ moduleImports?: readonly AuthImportEvidence[] }>,
  extraFiles: readonly string[] = [],
): Map<string, AuthStub> {
  const acc = new Map<string, { names: Set<string>; hasDefault: boolean }>();
  const absorb = (mi: AuthImportEvidence): void => {
    if (mi.isTypeOnly || !isAuthLibSpecifier(mi.specifier)) return;
    let entry = acc.get(mi.specifier);
    if (!entry) {
      entry = { names: new Set(), hasDefault: false };
      acc.set(mi.specifier, entry);
    }
    const e = entry;
    mi.names.forEach((local, i) => {
      const moduleSide = mi.importedNames?.[i] ?? local;
      if (moduleSide === "default") e.hasDefault = true;
      else e.names.add(moduleSide);
    });
  };
  for (const info of infos) for (const mi of info.moduleImports ?? []) absorb(mi);
  for (const file of extraFiles) for (const mi of fileImportEvidence(file)) absorb(mi);
  return new Map(
    [...acc.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([spec, e]) => [spec, { names: [...e.names].sort(), hasDefault: e.hasDefault }]),
  );
}

/**
 * A signed-out snapshot: everything falsy-but-present so `user?.firstName`
 * renders nothing instead of throwing. Unknown property reads follow shape
 * heuristics — verb names get an async no-op (awaiting undefined throws),
 * `*List` gets an empty array (mapping undefined throws) — and otherwise
 * undefined. Regenerated per call so no test can mutate another's view.
 */
const SNAPSHOT = `const __snap = () => new Proxy({ isLoaded: true, isLoading: false, isSignedIn: false, userId: null, sessionId: null, orgId: null, orgRole: null, user: null, organization: null, session: null, data: null, status: "unauthenticated" }, { get: (t, k) => k in t ? t[k] : typeof k === "string" && (/^(sign|set|get|reload|redirect|create)/i.test(k) || k === "auth" || k === "currentUser") ? async () => __snap() : typeof k === "string" && k.endsWith("List") ? [] : undefined });`;

/** Render children — for providers (hooks need their subtree mounted) and unknown widgets (empty is safe). */
const AS_CHILD = `const __asChild = (props) => (props && props.children !== undefined ? props.children : null);`;

/**
 * Per-export stub expression. The signed-out state decides the three named
 * conditionals; hooks get the snapshot; the known async API surface gets an
 * awaited snapshot (components `await auth()` and destructure it); providers
 * must mount children; unknown widgets render children too — no children,
 * nothing renders, which is the honest signed-out picture for a UserButton.
 */
function stubExpr(name: string): string {
  if (name === "Show") return "(props) => (props && props.when ? props.children : null)";
  // Signed-out means SignedIn renders nothing and SignedOut renders its
  // children; `<Show when>` is the generic conditional.
  if (name === "SignedIn") return "() => null";
  if (name === "SignedOut") return "__asChild";
  // Hooks return the snapshot, not a renderable — destructuring a component
  // stub (`const { userId } = useAuth()`) would hand back a function.
  if (/^use[A-Z]/.test(name)) return "() => __snap()";
  // Known async API surface: components `await auth()` and destructure it.
  if (
    /^(signIn|signUp|signOut|reload|redirect|setActive|setSession|getSession|getServerSession|getAuth|getCurrentUser|currentUser|createOrganization)$/.test(
      name,
    ) ||
    name === "auth" ||
    name === "clerkClient"
  ) {
    return "async () => __snap()";
  }
  // Providers must mount children or nothing under them renders; unknown
  // names are treated the same way — a widget with no children renders null.
  return "__asChild";
}

function preamble(specifier: string): string {
  return [
    `// flawlessly-generated signed-out stub for "${specifier}": the real library throws`,
    "// without its provider/keys, which neither the perf host nor a bare unit mount",
    "// can supply. Export names come from the analysis of this repo's components.",
    SNAPSHOT,
    AS_CHILD,
  ].join("\n");
}

/** ESM source for the perf-harness host bundle (Bun plugin onLoad body). */
export function authShimEsm(specifier: string, stub: AuthStub): string {
  const lines = [preamble(specifier)];
  for (const n of stub.names) lines.push(`export const ${n} = ${stubExpr(n)};`);
  if (stub.hasDefault) lines.push(`export default __asChild;`);
  return lines.join("\n");
}

/** A vi.mock block for the unit plane's setup.ts (factory-local: vitest hoists the call). */
export function authShimVitestBlock(specifier: string, stub: AuthStub): string {
  const exports = stub.names.map((n) => `${JSON.stringify(n)}: ${stubExpr(n)}`);
  if (stub.hasDefault) exports.push(`default: __asChild`);
  return `
vi.mock(${JSON.stringify(specifier)}, () => {
${preamble(specifier)
  .split("\n")
  .map((l) => `  ${l}`)
  .join("\n")}
  return { ${exports.join(", ")} };
});`;
}
