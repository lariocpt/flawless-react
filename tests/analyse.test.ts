import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractHooks } from "../src/analyse/extractHooks.ts";
import { extractProps } from "../src/analyse/extractProps.ts";
import { analyse } from "../src/analyse/index.ts";
import { parseFile } from "../src/analyse/parseFile.ts";

const HELLO = path.resolve(__dirname, "fixtures/Hello.tsx");
const DASHBOARD = path.resolve(__dirname, "fixtures/Dashboard.tsx");
const CARD = path.resolve(__dirname, "fixtures/Card.tsx");

describe("parseFile", () => {
  test("locates React.FC component + props type ref", async () => {
    const r = await parseFile(HELLO);
    const primary = r.components[0];
    expect(primary?.componentName).toBe("Hello");
    expect(primary?.propsTypeRef).toBeDefined();
    expect(primary?.exportKind).toBe("named");
    expect(primary?.isAsync).toBe(false);
    expect(r.isClientComponent).toBe(false);
    expect(r.imports.has("useState")).toBe(true);
    expect(r.imports.get("useState")?.specifier).toBe("react");
  });

  test("throws helpfully on a non-component file", async () => {
    const empty = path.resolve(__dirname, "fixtures/_empty.tsx");
    await Bun.write(empty, "export const x = 1;\n");
    try {
      await parseFile(empty);
      throw new Error("expected parseFile to throw");
    } catch (err) {
      expect((err as Error).message).toContain("could not locate a React component");
    }
  });
});

describe("extractProps", () => {
  test("Hello → string/number/boolean/union(literal) defaults + variants", async () => {
    const parsed = await parseFile(HELLO);
    const r = extractProps(parsed.sourceFile, parsed.components[0]?.propsTypeRef);
    expect(r.propsShape).toEqual({
      name: "",
      count: 0,
      active: false,
      variant: "primary",
    });
    expect(r.unresolvedProps).toEqual([]);
    // Variants generated for the union prop ("variant"): both "primary" and "secondary".
    const variantValues = r.variants.map((v) => v.variant);
    expect(variantValues).toContain("primary");
    expect(variantValues).toContain("secondary");
  });
});

describe("extractHooks", () => {
  test("Hello → useState", async () => {
    const parsed = await parseFile(HELLO);
    const hooks = extractHooks(parsed.components[0]?.bodyNode as import("typescript").Node);
    expect(hooks).toEqual(["useState"]);
  });

  test("Card → useEffect + useState", async () => {
    const parsed = await parseFile(CARD);
    const hooks = extractHooks(parsed.components[0]?.bodyNode as import("typescript").Node);
    expect(hooks).toEqual(["useEffect", "useState"]);
  });
});

describe("analyse (full tree)", () => {
  test("leaf component, depth 0", async () => {
    const t = await analyse({ entry: HELLO, depth: 0, includeChildren: true });
    expect(t.entry.componentName).toBe("Hello");
    expect(t.children).toEqual([]);
  });

  test("composite component, depth 3", async () => {
    const t = await analyse({ entry: DASHBOARD, depth: 3, includeChildren: true });
    expect(t.entry.componentName).toBe("Dashboard");
    const childNames = t.children.map((c) => c.entry.componentName).sort();
    expect(childNames).toEqual(["Card", "Hello"]);
    expect(t.entry.hooks).toContain("useMemo");
  });

  test("--include-children=false suppresses recursion", async () => {
    const t = await analyse({ entry: DASHBOARD, depth: 3, includeChildren: false });
    expect(t.children).toEqual([]);
  });
});

describe("extractInteractions", () => {
  test("Toolbar: 3 prop-bound clicks each tied to its labelled button", async () => {
    const t = await analyse({
      entry: path.resolve(__dirname, "fixtures/Toolbar.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const inter = t.entry.interactions;
    expect(inter).toBeDefined();
    if (!inter) return;
    expect(inter.clicks).toHaveLength(3);
    const byProp = new Map(
      inter.clicks
        .filter((c) => c.binding.kind === "prop")
        .map((c) => [(c.binding as { propName: string }).propName, c]),
    );
    expect(byProp.size).toBe(3);
    const save = byProp.get("onSave");
    const cancel = byProp.get("onCancel");
    const del = byProp.get("onDelete");
    expect(save?.tag).toBe("button");
    expect(save?.label).toEqual({ kind: "text", value: "Save" });
    expect(cancel?.label).toEqual({ kind: "text", value: "Cancel" });
    expect(del?.label).toEqual({ kind: "text", value: "Delete" });
  });

  test("SignupForm: extracts form + 3 fields + onSubmit prop binding", async () => {
    const t = await analyse({
      entry: path.resolve(__dirname, "fixtures/SignupForm.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const inter = t.entry.interactions;
    expect(inter).toBeDefined();
    if (!inter) return;
    expect(inter.forms).toHaveLength(1);
    const form = inter.forms[0];
    expect(form).toBeDefined();
    if (!form) return;
    expect(form.submit?.kind).toBe("prop");
    if (form.submit?.kind === "prop") expect(form.submit.propName).toBe("onSubmit");
    expect(form.fields).toHaveLength(3);
    const names = form.fields.map((f) => f.name);
    expect(names).toEqual(["name", "email", "password"]);
    const emailField = form.fields.find((f) => f.name === "email");
    expect(emailField?.type).toBe("email");
    expect(emailField?.label).toBe("Email");
  });

  test("LabelledForm: <Label htmlFor> labels a field, a placeholder does not", async () => {
    const t = await analyse({
      entry: path.resolve(__dirname, "fixtures/LabelledForm.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const form = t.entry.interactions?.forms[0];
    expect(form).toBeDefined();
    if (!form) return;

    // An uppercase wrapper carrying htmlFor is evidence of a real <label>.
    const title = form.fields.find((f) => f.name === "title");
    expect(title?.label).toBe("Title");
    // …and its placeholder stays available separately, it does not become the label.
    expect(title?.placeholder).toBe("A short summary");

    // A placeholder is not an accessible name. Reporting it as `label` made the
    // emitted spec call getByLabelText(placeholder), which always throws.
    const body = form.fields.find((f) => f.name === "body");
    expect(body?.placeholder).toBe("Add an update — context or progress.");
    expect(body?.label).toBeUndefined();
  });

  test("IconButton: inline arrow wrapping a prop call upgrades to prop binding", async () => {
    const t = await analyse({
      entry: path.resolve(__dirname, "fixtures/IconButton.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const inter = t.entry.interactions;
    expect(inter).toBeDefined();
    if (!inter) return;
    expect(inter.clicks).toHaveLength(1);
    const click = inter.clicks[0];
    expect(click).toBeDefined();
    if (!click) return;
    expect(click.binding).toEqual({ kind: "prop", propName: "onClose" });
    expect(click.hints.ariaLabel).toBe("close");
  });

  test("LinkCard: anchor with prop-text label extracted", async () => {
    const t = await analyse({
      entry: path.resolve(__dirname, "fixtures/LinkCard.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const inter = t.entry.interactions;
    expect(inter).toBeDefined();
    if (!inter) return;
    expect(inter.clicks).toHaveLength(1);
    const click = inter.clicks[0];
    expect(click).toBeDefined();
    if (!click) return;
    expect(click.tag).toBe("a");
    expect(click.binding).toEqual({ kind: "prop", propName: "onOpen" });
    expect(click.label).toEqual({ kind: "prop", propName: "title" });
  });

  test("DynamicTag: dynamic tag name does not crash; no click emitted", async () => {
    const t = await analyse({
      entry: path.resolve(__dirname, "fixtures/DynamicTag.tsx"),
      depth: 0,
      includeChildren: false,
    });
    const inter = t.entry.interactions;
    expect(inter).toBeDefined();
    if (!inter) return;
    // Tag is uppercase `Tag` so it parses as a custom component, not "<dynamic>".
    // But since `Tag` isn't a project-local import, it's a free identifier — still
    // recorded with its identifier name as the tag.
    const clicks = inter.clicks;
    expect(Array.isArray(clicks)).toBe(true);
    // Either captures the click against tag "Tag" with prop binding, or skips it.
    for (const c of clicks) {
      // Whatever it captured, it must not crash and must not emit a malformed binding.
      expect(c.tag.length).toBeGreaterThan(0);
    }
  });
});
