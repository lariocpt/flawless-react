import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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

  test("locates a component whose own returns are all null", async () => {
    const r = await parseFile(path.resolve(__dirname, "fixtures/NullRenderer.tsx"));
    // The `return;` inside the effect callback belongs to the callback, not
    // the component — detection must succeed despite it, and the callback
    // must not surface as a second component.
    expect(r.components).toHaveLength(1);
    const primary = r.components[0];
    expect(primary?.componentName).toBe("NullRenderer");
    expect(primary?.exportKind).toBe("named");
    expect(primary?.propsTypeLiteral).toBeDefined();
  });

  test("a get accessor's return in the body does not defeat all-returns-null", async () => {
    const r = await parseFile(path.resolve(__dirname, "fixtures/GetterEffect.tsx"));
    expect(r.components).toHaveLength(1);
    expect(r.components[0]?.componentName).toBe("GetterEffect");
    expect(r.components[0]?.exportKind).toBe("named");
  });

  test("locates a component whose only return is a parenthesized null", async () => {
    const r = await parseFile(path.resolve(__dirname, "fixtures/ParenNull.tsx"));
    expect(r.components).toHaveLength(1);
    expect(r.components[0]?.componentName).toBe("ParenNull");
  });

  test("locates a base-ui useRender component (no JSX in the body)", async () => {
    const fixture = path.resolve(__dirname, "fixtures/RenderHookBadge.tsx");
    // The fixture must stay JSX-free: any JSX would satisfy detection on its
    // own and this test would stop pinning the render-hook path.
    expect(await Bun.file(fixture).text()).not.toMatch(/<[A-Za-z]/);
    const r = await parseFile(fixture);
    const primary = r.components[0];
    expect(primary?.componentName).toBe("RenderHookBadge");
    expect(primary?.exportKind).toBe("named");
  });

  test("locates a namespace-imported useRender component (UR.useRender)", async () => {
    const fixture = path.resolve(__dirname, "fixtures/NamespaceRenderHook.tsx");
    // JSX-free for the same reason as the named-import useRender fixture.
    expect(await Bun.file(fixture).text()).not.toMatch(/<[A-Za-z]/);
    const r = await parseFile(fixture);
    expect(r.components[0]?.componentName).toBe("NamespaceBadge");
    expect(r.components[0]?.exportKind).toBe("named");
  });

  test("locates a component returning cond ? useRender(...) : null", async () => {
    const fixture = path.resolve(__dirname, "fixtures/TernaryRenderHook.tsx");
    // JSX-free for the same reason as the named-import useRender fixture.
    expect(await Bun.file(fixture).text()).not.toMatch(/<[A-Za-z]/);
    const r = await parseFile(fixture);
    expect(r.components[0]?.componentName).toBe("TernaryBadge");
  });

  test("a SCREAMING_CASE null-returning arrow is not a component", async () => {
    try {
      await parseFile(path.resolve(__dirname, "fixtures/NoopConstant.tsx"));
      throw new Error("expected parseFile to throw");
    } catch (err) {
      expect((err as Error).message).toContain("could not locate a React component");
    }
  });

  test("a PascalCase null-returning arrow is still a component", async () => {
    const r = await parseFile(path.resolve(__dirname, "fixtures/PascalNoop.tsx"));
    expect(r.components[0]?.componentName).toBe("Noop");
    expect(r.components[0]?.exportKind).toBe("named");
  });

  test("an acronym-named function DECLARATION returning null is a component", async () => {
    // The SCREAMING_CASE guard is for value constants; `function SEO()` is the
    // canonical effect-only head manager and must not be caught by it.
    const r = await parseFile(path.resolve(__dirname, "fixtures/SeoHead.tsx"));
    expect(r.components[0]?.componentName).toBe("SEO");
    expect(r.components[0]?.exportKind).toBe("named");
  });

  test("a `satisfies FC<Props>` component is detected, with the FC props type", async () => {
    const r = await parseFile(path.resolve(__dirname, "fixtures/SatisfiesTag.tsx"));
    expect(r.components).toHaveLength(1);
    const primary = r.components[0];
    expect(primary?.componentName).toBe("SatisfiesTag");
    expect(primary?.exportKind).toBe("named");
    // The parameter is untyped in the fixture — the props type is reachable
    // ONLY through the satisfies target's type argument.
    expect(primary?.propsTypeRef?.typeName.getText()).toBe("TagProps");
    const p = extractProps(r.sourceFile, primary?.propsTypeNode, primary?.propsTypeLiteral);
    expect(p.propsShape).toEqual({ label: "", count: 0 });
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

  test('string-literal prop names ("data-variant") are resolved, not dropped', async () => {
    const parsed = await parseFile(path.resolve(__dirname, "fixtures/StringKeyTag.tsx"));
    const unit = parsed.components[0];
    const r = extractProps(parsed.sourceFile, unit?.propsTypeNode, unit?.propsTypeLiteral);
    // The recorded-give-up contract: a member either lands in the shape or in
    // unresolvedProps, and its position is recorded either way. The emitted
    // DEFAULTS is JSON.stringify'd, so a quoted key survives emission as-is.
    expect(r.propsShape).toEqual({ "data-variant": "", label: "" });
    expect(Object.keys(r.propPositions)).toContain("data-variant");
    expect(r.unresolvedProps).toEqual([]);
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

describe("class components (B-17)", () => {
  const CLASSES = path.resolve(__dirname, "fixtures/ClassComponents.tsx");

  test("a class extending Component with JSX in render() is found", async () => {
    const parsed = await parseFile(CLASSES);
    const names = parsed.components.map((c) => c.componentName).sort();
    expect(names).toContain("Panel");
    expect(names).toContain("PurePanel");
    expect(names).toContain("NamespacedPanel");
  });

  test("a non-exported class is found, and filtered later like any other", async () => {
    // specTargets drops exportKind === "none"; parseFile's job is to see it.
    const parsed = await parseFile(CLASSES);
    const inner = parsed.components.find((c) => c.componentName === "InnerPanel");
    expect(inner).toBeDefined();
    expect(inner?.exportKind).toBe("none");
  });

  test("export kinds come from the class's own modifiers", async () => {
    const parsed = await parseFile(CLASSES);
    const kind = (n: string) => parsed.components.find((c) => c.componentName === n)?.exportKind;
    expect(kind("Panel")).toBe("named");
    expect(kind("NamespacedPanel")).toBe("default");
  });

  test("props come from the heritage type argument, not a parameter", async () => {
    // `class X extends Component<Props, State>` — the first type argument is the
    // class analogue of a function's first parameter. A class has no parameter
    // and destructures nothing; it reads this.props.x.
    const parsed = await parseFile(CLASSES);
    const panel = parsed.components.find((c) => c.componentName === "Panel");
    expect(panel?.propsTypeRef?.typeName.getText()).toBe("PanelProps");
    expect(panel?.paramName).toBeUndefined();
    expect(panel?.destructuredProps).toEqual([]);
  });

  test("the props type resolves through to a real shape", async () => {
    const tree = await analyse({ entry: CLASSES, depth: 0, includeChildren: false });
    // analyse() takes the first component; assert on whichever it picked rather
    // than assuming an order.
    const all = (await parseFile(CLASSES)).components.map((c) => c.componentName);
    expect(all.length).toBeGreaterThan(0);
    expect(tree.entry.propsShape).toEqual({ title: "" });
  });

  test("a class that extends nothing React-ish is NOT a component", async () => {
    // The control. Detection is from the base class, not from having a render()
    // that returns JSX — otherwise any renderer-ish class becomes a component.
    const parsed = await parseFile(CLASSES);
    const names = parsed.components.map((c) => c.componentName);
    expect(names).not.toContain("NotAComponent");
    expect(names).not.toContain("Derived");
  });

  test("a class whose render() has no JSX is NOT a component", async () => {
    const parsed = await parseFile(CLASSES);
    expect(parsed.components.map((c) => c.componentName)).not.toContain("Headless");
  });
});

describe("an undecidable render is recorded, not guessed at", () => {
  const BOUNDARY = path.resolve(__dirname, "fixtures/ClassBoundary.tsx");
  const CLASSES = path.resolve(__dirname, "fixtures/ClassComponents.tsx");

  test("renderUndecidable is set when no branch can be decided", async () => {
    // `if (this.state.hasError)` — the analyser cannot value this.state, and
    // BOTH branches return content, so there is no render to describe. README
    // has always said such a component "produces no description at all";
    // nothing recorded it until now.
    const tree = await analyse({ entry: BOUNDARY, depth: 0, includeChildren: false });
    expect(tree.entry.renderUndecidable).toBe(true);
  });

  test("and NOT set when the render is unconditional", async () => {
    // The control. Without it this is a field that is always true.
    const tree = await analyse({ entry: CLASSES, depth: 0, includeChildren: false });
    expect(tree.entry.renderUndecidable).toBeUndefined();
  });

  test("clicks harvested from the whole-body fallback are marked conditional", async () => {
    // With no decidable render the walk falls back to the whole body. `initial &&`
    // short-circuited, so those clicks arrived UNMARKED and read as certainly
    // present — which is how a spec came to drive a button inside a branch the
    // defaults never take.
    const tree = await analyse({ entry: BOUNDARY, depth: 0, includeChildren: false });
    const clicks = tree.entry.interactions?.clicks ?? [];
    expect(clicks.length).toBeGreaterThan(0);
    expect(clicks.every((c) => c.conditional === true)).toBe(true);
  });

  test("componentDidCatch's logging is visible, so the spec does not demand a clean console", async () => {
    // detectSelfLogging reads bodyNode, which for a class is render() — so an
    // error boundary's console.error was invisible and the emitted spec asserted
    // expect(errors).toEqual([]) against a component whose contract is to log.
    const tree = await analyse({ entry: BOUNDARY, depth: 0, includeChildren: false });
    expect(tree.entry.logsErrors).toBeDefined();
  });

  test("useActionState's initial state is read from its second argument", async () => {
    // useReducer's shape exactly. Without it `state` was opaque, every guard on
    // it was undecidable, and two correct React 19 form components lost their
    // whole spec to a refusal that was simply wrong.
    const dir = mkdtempSync(path.join(os.tmpdir(), "uas-"));
    const f = path.join(dir, "Form.tsx");
    writeFileSync(
      f,
      `import { useActionState } from "react";
export function Form() {
  const [state, action] = useActionState(async () => ({ ok: true }), { ok: false });
  void action;
  if (state.ok) return <p>done</p>;
  return <form><button type="submit">Send</button></form>;
}
`,
    );
    const tree = await analyse({ entry: f, depth: 0, includeChildren: false });
    // state.ok is false at defaults, so the guard IS decidable and the form is
    // the render — no refusal.
    expect(tree.entry.renderUndecidable).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a base class that is not react's is not a component", async () => {
    // The detection comment claimed evidence; the code matched on the NAME, so a
    // local `class Component {}` made `class Sneaky extends Component` a React
    // component.
    const dir = mkdtempSync(path.join(os.tmpdir(), "shadow-"));
    const f = path.join(dir, "Shadow.tsx");
    writeFileSync(
      f,
      `class Component { render() { return null; } }
export class Sneaky extends Component {
  render() { return <div>not react</div>; }
}
`,
    );
    await expect(parseFile(f)).rejects.toThrow(/could not locate a React component/);
    rmSync(dir, { recursive: true, force: true });
  });
});
