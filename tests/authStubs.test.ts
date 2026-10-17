import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectAuthStubs, isAuthLibSpecifier } from "../src/analyse/authShims.ts";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-authshim-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("isAuthLibSpecifier", () => {
  test("Supabase's auth layer is provider-bound; its SDK is not", () => {
    // `auth-helpers-*` is the tutorial stack and `@supabase/ssr` its
    // replacement. Both need their provider mounted, and the client
    // constructor refuses outright without the env pair no repo commits.
    // `@supabase/supabase-js` stays unstubbed on purpose: it is the SDK, and a
    // stubbed `from().select()` chain would turn a named failure into undefined
    // results quietly flowing through an assertion.
    expect(isAuthLibSpecifier("@supabase/auth-helpers-react")).toBe(true);
    expect(isAuthLibSpecifier("@supabase/auth-helpers-nextjs")).toBe(true);
    expect(isAuthLibSpecifier("@supabase/ssr")).toBe(true);
    expect(isAuthLibSpecifier("@supabase/ssr/react")).toBe(true);
    expect(isAuthLibSpecifier("@supabase/supabase-js")).toBe(false);
    // The libraries this shipped for before, unchanged.
    expect(isAuthLibSpecifier("next-auth/react")).toBe(true);
    expect(isAuthLibSpecifier("@clerk/nextjs/server")).toBe(true);
  });
});

describe("collectAuthStubs", () => {
  test("reads the provider file the analysis never visits", () => {
    // talkformai's pages/_app.tsx: mounted by every spec, analysed by none of
    // them, and the ONLY file importing these two names. Collecting from
    // components alone left the shim unable to bind them, so the real module
    // ran and its constructor threw — 17 spec files, 26 tests, zero reached an
    // assertion.
    const app = path.join(tmpDir(), "_app.tsx");
    writeFileSync(
      app,
      `import { createPagesBrowserClient } from "@supabase/auth-helpers-nextjs";
import { SessionContextProvider as Session } from "@supabase/auth-helpers-react";
import type { Session as TSess } from "@supabase/auth-helpers-react";

export default function App({ Component, pageProps }: any) {
  const [client] = useState(() => createPagesBrowserClient());
  return (
    <Session supabaseClient={client} initialSession={pageProps.initialSession}>
      <Component />
    </Session>
  );
}
`,
    );
    const stubs = collectAuthStubs([], [app]);
    expect([...stubs.keys()]).toEqual([
      "@supabase/auth-helpers-nextjs",
      "@supabase/auth-helpers-react",
    ]);
    expect(stubs.get("@supabase/auth-helpers-nextjs")?.names).toEqual(["createPagesBrowserClient"]);
    // The module-side export name, not the local alias — that is what the
    // generated shim has to bind. And the type-only clause contributes nothing:
    // it erases, so a binding for it would be a name the module never has.
    expect(stubs.get("@supabase/auth-helpers-react")?.names).toEqual(["SessionContextProvider"]);
  });

  test("component imports still win, and an unreadable file adds nothing", () => {
    const dir = tmpDir();
    const app = path.join(dir, "_app.tsx");
    writeFileSync(
      app,
      `import { useSession, signOut } from "next-auth/react";\nexport default function App(p: any) { useSession(); return p.children; }\n`,
    );
    const stubs = collectAuthStubs(
      [
        {
          moduleImports: [
            {
              specifier: "next-auth/react",
              names: ["useSession"],
              importedNames: ["useSession"],
            },
          ],
        },
      ],
      [app, path.join(dir, "does-not-exist.tsx")],
    );
    // Merged, sorted, deduplicated — one stub module per specifier.
    expect(stubs.get("next-auth/react")?.names).toEqual(["signOut", "useSession"]);
  });
});
