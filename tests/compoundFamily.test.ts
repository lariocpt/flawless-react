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

  test("Sub-family parts are never wrapped — they need a <Sub> ancestor Root+Content cannot give", async () => {
    // Confirmed against real @radix-ui/react-dropdown-menu in review:
    // SubTrigger/SubContent wrapped in <Root open><Content> are RED with
    // "must be used within MenuSub". They were honest skips before B-2 and
    // must stay skips.
    const dir = tmpProject();
    const file = path.join(dir, "src", "dropdown-menu.tsx");
    writeFileSync(
      file,
      `import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import type * as React from "react";

export function DropdownMenu(props: Record<string, unknown>) {
  return <MenuPrimitive.Root {...props} />;
}

export function DropdownMenuContent({ children }: { children?: React.ReactNode }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Content>{children}</MenuPrimitive.Content>
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({ children }: { children?: React.ReactNode }) {
  return <MenuPrimitive.Item>{children}</MenuPrimitive.Item>;
}

export function DropdownMenuSub(props: Record<string, unknown>) {
  return <MenuPrimitive.Sub {...props} />;
}

export function DropdownMenuSubTrigger({ children }: { children?: React.ReactNode }) {
  return <MenuPrimitive.SubTrigger>{children}</MenuPrimitive.SubTrigger>;
}

export function DropdownMenuSubContent({ children }: { children?: React.ReactNode }) {
  return <MenuPrimitive.SubContent>{children}</MenuPrimitive.SubContent>;
}
`,
    );
    const trees = await analyseFile({
      entry: file,
      depth: 0,
      includeChildren: false,
      roots: "exported",
    });
    const infos = new Map(trees.map((t) => [t.entry.componentName, t.entry]));
    // The plain parts still wrap.
    expect(infos.get("DropdownMenuItem")?.compoundFamily).toMatchObject({
      root: "DropdownMenu",
      content: "DropdownMenuContent",
    });
    // The Sub family does not.
    expect(infos.get("DropdownMenuSub")?.compoundFamily).toBeUndefined();
    expect(infos.get("DropdownMenuSubTrigger")?.compoundFamily).toBeUndefined();
    expect(infos.get("DropdownMenuSubContent")?.compoundFamily).toBeUndefined();
  });

  test("a DEFAULT-exported Root sibling gives no family — the emitters import by name", async () => {
    // A named import of a default-only export is TS2305, and in the host
    // registry it takes the WHOLE bundle down, not just this part.
    const dir = tmpProject();
    const file = path.join(dir, "src", "defroot.tsx");
    writeFileSync(
      file,
      `import * as DialogPrimitive from "@radix-ui/react-dialog";
import type * as React from "react";

export default function Dialog(props: Record<string, unknown>) {
  return <DialogPrimitive.Root {...props} />;
}

export function DialogContent({ children }: { children?: React.ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Content>{children}</DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ children }: { children?: React.ReactNode }) {
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
    const infos = new Map(trees.map((t) => [t.entry.componentName, t.entry]));
    expect(infos.get("DialogHeader")?.compoundFamily).toBeUndefined();
  });

  test("a part spanning TWO unrooted packages gets no family — one wrap cannot fix both", async () => {
    const dir = tmpProject();
    const file = path.join(dir, "src", "mixed.tsx");
    writeFileSync(
      file,
      `import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type * as React from "react";

export function Dialog(props: Record<string, unknown>) {
  return <DialogPrimitive.Root {...props} />;
}

export function DialogContent({ children }: { children?: React.ReactNode }) {
  return <DialogPrimitive.Content>{children}</DialogPrimitive.Content>;
}

export function MixedPart({ children }: { children?: React.ReactNode }) {
  return (
    <div>
      <DialogPrimitive.Title>{children}</DialogPrimitive.Title>
      <PopoverPrimitive.Anchor />
    </div>
  );
}
`,
    );
    const trees = await analyseFile({
      entry: file,
      depth: 0,
      includeChildren: false,
      roots: "exported",
    });
    const infos = new Map(trees.map((t) => [t.entry.componentName, t.entry]));
    expect(infos.get("MixedPart")?.compoundFamily).toBeUndefined();
  });

  test("a self-rooted package does not decide the family, and the unit is never its own root", async () => {
    // SelfRooted supplies its own popover Root; only the bare dialog Title is
    // unrooted — and this file exports no dialog Root, so there is no family.
    const dir = tmpProject();
    const file = path.join(dir, "src", "selfrooted.tsx");
    writeFileSync(
      file,
      `import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type * as React from "react";

export function SelfRooted({ children }: { children?: React.ReactNode }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger>open</PopoverPrimitive.Trigger>
      <DialogPrimitive.Title>{children}</DialogPrimitive.Title>
    </PopoverPrimitive.Root>
  );
}
`,
    );
    const trees = await analyseFile({
      entry: file,
      depth: 0,
      includeChildren: false,
      roots: "exported",
    });
    expect(trees[0]?.entry.compoundFamily).toBeUndefined();
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
    // Portal content lands outside the container — baseElement sees it. The
    // full assertion LINE, not the word: the mutation review found the word
    // alone satisfied by a comment while the assertion read container.
    expect(spec).toContain('expect(baseElement.textContent).toContain("flawless-slot")');
    expect(spec).not.toContain("is exported as a component");
    expect(spec).not.toContain("TODO(flawless)");
  });

  test("the assertion reads BOTH portal surfaces — screen as well as baseElement", () => {
    // baseElement alone is one witness of a portal. screen is the query the
    // rest of the emitted suite uses, and it is bound to document.body, so a
    // part that renders through a portal is visible to it while a part that
    // renders nowhere is visible to neither. Asserting both is what the B-2
    // spec asked for; only baseElement shipped.
    const spec = specFor(part("DialogHeader", FAMILY));
    expect(spec).toContain('import { render, screen } from "@testing-library/react"');
    expect(spec).toContain('expect(screen.getByText("flawless-slot")).toBeInTheDocument()');
  });

  test("a part that takes no children still asserts the mount produced DOM", () => {
    // The whole assertion for a childless part used to be
    // `expect(() => render(...)).not.toThrow()`, which a part rendering null
    // inside a working Root satisfies just as well as a real one. Counting
    // elements under baseElement catches that: render() always appends its own
    // container div, so >1 means the part (or its portal) actually rendered.
    const spec = specFor(part("DialogOverlay", FAMILY, { acceptsChildren: false }));
    expect(spec).not.toContain("not.toThrow()");
    expect(spec).toContain('expect(baseElement.querySelectorAll("*").length).toBeGreaterThan(1)');
  });

  test("a childless trigger mounts under a Root that contributes no DOM of its own", () => {
    // Where the count assertion actually bites. A Root is a context provider
    // and renders nothing, so a trigger that rendered null leaves the document
    // at just render()'s own container div and the spec goes red. Wrapping in
    // a Content sibling — the "other" shape — would supply that DOM instead,
    // which is why this shape is pinned separately.
    const spec = specFor(
      part("DialogTrigger", { ...FAMILY, part: "trigger" }, { acceptsChildren: false }),
    );
    expect(spec).toContain("<Dialog>");
    expect(spec).not.toContain("<DialogContent>");
    expect(spec).toContain('expect(baseElement.querySelectorAll("*").length).toBeGreaterThan(1)');
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

  test("DEFAULTS come from synthesiseDefaults, not raw propsShape", () => {
    // The client and browser specs learned this the hard way (ProfileForm):
    // a prop known only through member reads is {} in propsShape, and the
    // part crashes mapping over undefined. Same synthesis here.
    const spec = specFor(
      part("DialogHeader", FAMILY, {
        unresolvedProps: ["items"],
        propUsage: [{ propName: "items", member: "map" }] as never,
      }),
    );
    expect(spec).toContain('"items":[]');
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
    // No COMPOUND_WRAP table. It was emitted as a reader's aid, but nothing
    // imports it — main.tsx pulls REGISTRY, FN_PROPS and WRAP_IN only — so it
    // was dead code in every generated suite, and the composed REGISTRY entry
    // below already shows a reader which wrapper the part mounted inside.
    expect(registry).not.toContain("COMPOUND_WRAP");
    // Aliased imports: the Root may itself be a registry entry imported under
    // its own name from the same module — unaliased would collide.
    expect(registry).toContain("Dialog as DialogHeader__Root");
    expect(registry).toContain("DialogContent as DialogHeader__Content");
    expect(registry).toContain("createElement(DialogHeader__Root");
    expect(registry).toContain("{ open: true }");
    expect(registry).toContain("createElement(DialogHeader__Content");
    // The part mounts through its wrapped entry, so it must be IN the registry.
    expect(registry).toMatch(/"DialogHeader":/);

    // "main.tsx stays untouched" is half this test's title, and it asserted
    // nothing about main.tsx. The composition lives entirely in the
    // regenerated registry, so the write-once host keeps its three spreads and
    // gains no compound-specific import or table.
    const main = files.find((f) => f.relPath === "host/main.tsx")?.content ?? "";
    expect(main).not.toBe("");
    expect(main).toContain(
      'import { type Component, FN_PROPS, REGISTRY, WRAP_IN } from "./registry"',
    );
    expect(main).not.toContain("COMPOUND_WRAP");
    expect(main).not.toContain("DialogHeader");
  });
});
