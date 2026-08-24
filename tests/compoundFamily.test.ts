import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyseFile } from "../src/analyse/index.ts";
import { renderSuite } from "../src/scaffold/templates.ts";
import { hostEligibility } from "../src/scaffold-tests/registry.ts";
import { renderUnitBrowser } from "../src/scaffold-tests/templates.ts";
import type { ComponentInfo, ComponentTree } from "../src/types.ts";

/**
 * B-2: a compound part (DialogHeader, SelectItem …) throws outside its Root,
 * so its spec used to be a typeof assertion plus a TODO. When the part's OWN
 * file also exports the family — a sibling rendering <X.Root> and a Content
 * sibling — the wrapper is mechanical: Trigger mounts inside a closed Root,
 * everything else inside <Root open><Content>…</Content></Root>. Only
 * open-state families (dialog and friends) are wrapped in v1; value-driven
 * families (accordion, tabs) stay out — a wrong wrapper is worse than an
 * honest skip.
 */

const tmpDirs: string[] = [];

function tmpProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-compound-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const DIALOG_TSX = `import * as DialogPrimitive from "@radix-ui/react-dialog";
import type * as React from "react";

export function Dialog(props: Record<string, unknown>) {
  return <DialogPrimitive.Root {...props} />;
}

export function DialogTrigger(props: Record<string, unknown>) {
  return <DialogPrimitive.Trigger {...props} />;
}

export function DialogContent({ children, ...props }: { children?: React.ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay />
      <DialogPrimitive.Content {...props}>{children}</DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ children }: { children?: React.ReactNode }) {
  return <DialogPrimitive.Title>{children}</DialogPrimitive.Title>;
}
`;

async function analysedDialog(): Promise<Map<string, ComponentInfo>> {
  const dir = tmpProject();
  const file = path.join(dir, "src", "dialog.tsx");
  writeFileSync(file, DIALOG_TSX);
  const trees = await analyseFile({
    entry: file,
    depth: 0,
    includeChildren: false,
    roots: "exported",
  });
  return new Map(trees.map((t) => [t.entry.componentName, t.entry]));
}

describe("compoundFamily derivation from the part's own file", () => {
  test("parts learn their Root and Content siblings and their own role", async () => {
    const infos = await analysedDialog();
    expect(infos.get("DialogHeader")?.compoundFamily).toEqual({
      root: "Dialog",
      content: "DialogContent",
      part: "other",
      specifier: "@radix-ui/react-dialog",
    });
    expect(infos.get("DialogTrigger")?.compoundFamily).toMatchObject({ part: "trigger" });
    expect(infos.get("DialogContent")?.compoundFamily).toMatchObject({ part: "content" });
  });

  test("the Root sibling itself is not a part and carries no family", async () => {
    const infos = await analysedDialog();
    expect(infos.get("Dialog")?.renderMode).not.toBe("compound-part");
    expect(infos.get("Dialog")?.compoundFamily).toBeUndefined();
  });

  test("without an exported Root sibling there is no family — cross-file chasing is v2", async () => {
    const dir = tmpProject();
    const file = path.join(dir, "src", "parts.tsx");
    writeFileSync(
      file,
      `import * as DialogPrimitive from "@radix-ui/react-dialog";

export function LoneHeader({ children }: { children?: unknown }) {
  return <DialogPrimitive.Title>{children}</DialogPrimitive.Title>;
}
`,
    );
    const trees = await analyseFile({
      entry: file,
      depth: 0,
      includeChildren: false,
      roots: "exported",
    });
    const info = trees[0]?.entry;
    expect(info?.renderMode).toBe("compound-part");
    expect(info?.compoundFamily).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Emit side
// ---------------------------------------------------------------------------

function part(
  name: string,
  family: ComponentInfo["compoundFamily"],
  extra: Partial<ComponentInfo> = {},
): ComponentTree {
  return {
    entry: {
      componentName: name,
      filePath: "/proj/src/dialog.tsx",
      importSpecifier: "./dialog.tsx",
      propsShape: {},
      variants: [],
      hooks: [],
      unresolvedProps: [],
      exportKind: "named",
      renderMode: "compound-part",
      renderNotes: ["renders a compound part that needs its Root"],
      acceptsChildren: true,
      ...(family ? { compoundFamily: family } : {}),
      ...extra,
    },
    children: [],
  };
}

const FAMILY: NonNullable<ComponentInfo["compoundFamily"]> = {
  root: "Dialog",
  content: "DialogContent",
  part: "other",
  specifier: "@radix-ui/react-dialog",
};

function specFor(tree: ComponentTree): string {
  const files = renderUnitBrowser({
    trees: [tree],
    outDir: "/proj/flawless",
    variants: 1,
    browserSpecs: false,
  });
  return (
    files.find((f) => f.relPath === `unit/${tree.entry.componentName}.test.tsx`)?.content ?? ""
  );
}

describe("compound part specs mount inside their family", () => {
  test("an 'other' part renders inside <Root open><Content> with a portal-aware assertion", () => {
    const spec = specFor(part("DialogHeader", FAMILY));
    expect(spec).toMatch(/import \{ Dialog, DialogContent \} from "[^"]*dialog"/);
    expect(spec).toContain("<Dialog open>");
    expect(spec).toContain("<DialogContent>");
    // Portal content lands outside the container — baseElement sees it.
    expect(spec).toContain("baseElement");
    expect(spec).toContain("flawless-slot");
    expect(spec).not.toContain("is exported as a component");
    expect(spec).not.toContain("TODO(flawless)");
  });

  test("a trigger mounts inside a CLOSED Root — it is the part that shows closed", () => {
    const spec = specFor(part("DialogTrigger", { ...FAMILY, part: "trigger" }));
    expect(spec).toContain("<Dialog>");
    expect(spec).not.toContain("<Dialog open>");
    expect(spec).not.toContain("<DialogContent>");
    expect(spec).not.toContain("is exported as a component");
  });

  test("the content part needs no second wrapper — it IS the content", () => {
    const spec = specFor(part("DialogContent", { ...FAMILY, part: "content" }));
    expect(spec).toContain("<Dialog open>");
    // The part renders as itself directly under the open Root.
    expect(spec).toContain("<DialogContent");
    expect(spec.match(/<DialogContent/g)?.length).toBe(1);
  });

  test("a value-driven family (accordion) stays an honest skip in v1", () => {
    const spec = specFor(
      part("AccordionItem", {
        root: "Accordion",
        content: "AccordionContent",
        part: "other",
        specifier: "@radix-ui/react-accordion",
      }),
    );
    expect(spec).toContain("is exported as a component");
    expect(spec).toContain("TODO(flawless)");
  });

  test("an 'other' part without a Content sibling stays an honest skip", () => {
    const spec = specFor(part("DialogHeader", { ...FAMILY, content: undefined }));
    expect(spec).toContain("is exported as a component");
  });

  test("no family at all keeps today's behavior", () => {
    const spec = specFor(part("LoneHeader", undefined));
    expect(spec).toContain("is exported as a component");
    expect(spec).toContain("TODO(flawless)");
  });
});

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

describe("the host wraps family parts instead of excluding them", () => {
  test("hostEligibility flips for a wrappable part and only for it", () => {
    const wrapped = part("DialogHeader", FAMILY).entry;
    expect(hostEligibility(wrapped).eligible).toBe(true);
    const bare = part("LoneHeader", undefined).entry;
    expect(hostEligibility(bare).eligible).toBe(false);
    const valueFamily = part("AccordionItem", {
      root: "Accordion",
      part: "other",
      specifier: "@radix-ui/react-accordion",
    }).entry;
    expect(hostEligibility(valueFamily).eligible).toBe(false);
  });

  test("the regenerated registry composes the wrapper — main.tsx stays untouched", () => {
    const files = renderSuite({
      tree: part("DialogHeader", FAMILY),
      outDir: "/proj/flawless",
      variants: 1,
      report: false,
    });
    const registry = files.find((f) => f.relPath === "host/registry.ts")?.content ?? "";
    expect(registry).toContain("COMPOUND_WRAP");
    // Aliased imports: the Root may itself be a registry entry imported under
    // its own name from the same module — unaliased would collide.
    expect(registry).toContain("Dialog as DialogHeader__Root");
    expect(registry).toContain("DialogContent as DialogHeader__Content");
    expect(registry).toContain("createElement(DialogHeader__Root");
    expect(registry).toContain("{ open: true }");
    expect(registry).toContain("createElement(DialogHeader__Content");
    // The part mounts through its wrapped entry, so it must be IN the registry.
    expect(registry).toMatch(/"DialogHeader":/);
  });
});
