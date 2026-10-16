import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { findDisclosures } from "../src/analyse/extractDisclosures.ts";
import { analyse } from "../src/analyse/index.ts";

/** Parse a snippet and hand back its first JSX element (findDisclosures root). */
function firstJsx(source: string): ts.Node {
  const sf = ts.createSourceFile("t.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let root: ts.Node | undefined;
  const find = (n: ts.Node): void => {
    if (root) return;
    if (ts.isJsxElement(n)) {
      root = n;
      return;
    }
    ts.forEachChild(n, find);
  };
  ts.forEachChild(sf, find);
  return root as ts.Node;
}

async function analysed(source: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "flawless-gate-"));
  const file = path.join(dir, "Widget.tsx");
  writeFileSync(file, source);
  return (await analyse({ entry: file, depth: 0, includeChildren: false })).entry;
}

const PRELUDE = `import type { ReactNode } from "react";
const Dialog = ({ children }: any) => children;
const Trigger = ({ children }: any) => children;
const Content = ({ children }: any) => children;
`;

const TRIGGER_CHILDREN = `${PRELUDE}export const Widget = ({ children }: { children: ReactNode }) => (
  <Dialog>
    <Trigger asChild>{children}</Trigger>
    <Content><button>Cancel</button><button>Confirm</button></Content>
  </Dialog>
);
`;

describe("disclosure gated by a {children} trigger (ConfirmModal)", () => {
  test("the fixture child text is the click handle", () => {
    const ds = findDisclosures(firstJsx(TRIGGER_CHILDREN));
    expect(ds.length).toBe(1);
    expect(ds[0]?.trigger).toEqual({ kind: "children" });
    expect((ds[0]?.gated as Set<ts.Node>).size > 0).toBe(true);
  });

  test("gated copy stays OUT of the static-text assertions", async () => {
    const info = await analysed(TRIGGER_CHILDREN);
    expect(info.staticText).toEqual([]);
  });

  test("an always-open root does not gate", async () => {
    const open = TRIGGER_CHILDREN.replace("<Dialog>", "<Dialog defaultOpen>");
    expect(findDisclosures(firstJsx(open)).length).toBe(0);
    // Without a disclosure the content copy is assertable again.
    const info = await analysed(open);
    expect(info.staticText).toContain("Cancel");
  });

  test("a literal-text trigger still wins over the children handle", () => {
    const lit = TRIGGER_CHILDREN.replace(
      "<Trigger asChild>{children}</Trigger>",
      "<Trigger>Open menu</Trigger>",
    );
    const ds = findDisclosures(firstJsx(lit));
    expect(ds[0]?.trigger).toEqual({ kind: "text", value: "Open menu" });
  });
});

describe("forms inside a gated dialog record their gate", () => {
  test("form under the Content gets gatedBy children", async () => {
    const info = await analysed(`${PRELUDE}const onSubmit = () => {};
export const Rename = ({ children }: { children: ReactNode }) => (
  <Dialog>
    <Trigger asChild>{children}</Trigger>
    <Content>
      <form onSubmit={onSubmit}>
        <button type="submit">Save</button>
      </form>
    </Content>
  </Dialog>
);
`);
    const form = info.interactions?.forms?.[0];
    expect(form?.gatedBy).toEqual({ kind: "children" });
  });
});
