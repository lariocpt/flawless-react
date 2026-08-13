import { describe, expect, test } from "bun:test";
import path from "node:path";
import { type ExtractedProps, extractProps } from "../src/analyse/extractProps.ts";
import { parseFile } from "../src/analyse/parseFile.ts";
import { ModuleResolver } from "../src/analyse/resolveModule.ts";
import { SourceFileCache } from "../src/analyse/sourceCache.ts";

/**
 * End-to-end props resolution over the shapes shadcn/base-ui actually ship:
 * `HostProps & VariantProps<typeof x>`, `ComponentProps<"div"> & { … }`,
 * `interface P extends ComponentProps<"button">`, and cross-file
 * `ComponentProps<typeof Card>`.
 *
 * The bail cases matter as much as the happy paths: a wrong inference here
 * becomes a failing assertion in someone else's generated spec.
 */

const SHADCN = path.resolve(__dirname, "fixtures/shadcn");

const resolver = new ModuleResolver();
const cache = new SourceFileCache();

async function propsOf(file: string, componentName: string): Promise<ExtractedProps> {
  const abs = path.join(SHADCN, file);
  const parsed = await parseFile(abs);
  const unit = parsed.components.find((c) => c.componentName === componentName);
  if (!unit) {
    const got = parsed.components.map((c) => c.componentName).join(", ");
    throw new Error(`${file}: no component named ${componentName} (found: ${got})`);
  }
  return extractProps(
    parsed.sourceFile,
    unit.propsTypeNode,
    unit.propsTypeLiteral,
    parsed.imports,
    abs,
    resolver,
    cache,
  );
}

describe("extractProps: intersections", () => {
  test("button: an unresolvable operand does not poison the intersection", async () => {
    const r = await propsOf("button.tsx", "Button");
    // `ButtonPrimitive.Props` is a namespaced type from an uninstalled package:
    // unknowable syntactically. The cva operand beside it is fully knowable, and
    // giving up on the whole type would cost every shadcn button its variants.
    expect(r.propsShape).toEqual({ variant: "default", size: "default" });
    expect(r.unresolvedTypes).toEqual(["ButtonPrimitive.Props"]);
    // The abandoned operand named no props, so nothing is owed to unresolvedProps.
    expect(r.unresolvedProps).toEqual([]);
    expect(r.variantOptions).toEqual({
      variant: ["default", "outline", "ghost"],
      size: ["default", "sm", "icon-xs"],
    });
    expect(r.hostElement).toBeUndefined();
  });

  test("button: a string-literal option name survives into the variants", async () => {
    const r = await propsOf("button.tsx", "Button");
    expect(r.variantOptions.size).toContain("icon-xs");
    expect(r.variants.map((v) => v.size)).toContain("icon-xs");
    expect(r.variants.every((v) => v.variant !== undefined && v.size !== undefined)).toBe(true);
  });

  test("card Card: host table and inline literal merge into one shape", async () => {
    const r = await propsOf("card.tsx", "Card");
    expect(r.propsShape).toEqual({ className: "", id: "", size: "default" });
    expect(r.variantOptions.size).toEqual(["default", "sm"]);
    expect(r.hostElement).toBe("div");
    expect(r.acceptsChildren).toBe(true);
    expect(r.unresolvedTypes).toEqual([]);
    expect(r.unresolvedProps).toEqual([]);
    expect(r.variants).toEqual([
      { className: "", id: "", size: "default" },
      { className: "", id: "", size: "sm" },
    ]);
  });

  test("narrow-input SearchInput: the literal operand beats the host table", async () => {
    const r = await propsOf("narrow-input.tsx", "SearchInput");
    // The author narrowed `type` at the declaration site; the curated DOM table
    // is the weakest claim in the room, so its default AND its option list go.
    expect(r.propsShape.type).toBe("search");
    expect("type" in r.variantOptions).toBe(false);
    expect(r.variants).toEqual([]);
    // Everything the host contributed that was not overridden still stands.
    expect(r.propsShape).toEqual({
      className: "",
      id: "",
      type: "search",
      defaultValue: "",
      disabled: false,
    });
    expect(r.hostElement).toBe("input");
    expect(r.acceptsChildren).toBe(false);
  });

  test("card CardHeader: a bare ComponentProps<'div'> is exactly className + id", async () => {
    const r = await propsOf("card.tsx", "CardHeader");
    expect(r.propsShape).toEqual({ className: "", id: "" });
    expect(r.hostElement).toBe("div");
    expect(r.acceptsChildren).toBe(true);
    expect(r.variants).toEqual([]);
    expect(r.unresolvedTypes).toEqual([]);
  });

  test("card CardTitle: a second unexported-then-re-exported component resolves too", async () => {
    const r = await propsOf("card.tsx", "CardTitle");
    expect(r.propsShape).toEqual({ className: "", id: "" });
    expect(r.hostElement).toBe("div");
  });

  test("input Input: host input props, and `value` is deliberately absent", async () => {
    const r = await propsOf("input.tsx", "Input");
    expect(r.propsShape).toEqual({
      className: "",
      id: "",
      type: "text",
      defaultValue: "",
      disabled: false,
    });
    // A `value` without an `onChange` makes React warn about a controlled input
    // and turns userEvent.type into a silent no-op — defaultValue instead.
    expect("value" in r.propsShape).toBe(false);
    expect("checked" in r.propsShape).toBe(false);
    expect(r.variantOptions.type).toEqual(["text", "email", "password", "number"]);
    expect(r.variants).toHaveLength(4);
    expect(r.acceptsChildren).toBe(false);
    expect(r.hostElement).toBe("input");
  });
});

describe("extractProps: interface heritage", () => {
  test("extends-iface: own members resolve; the base is recorded, not merged", async () => {
    const r = await propsOf("extends-iface.tsx", "LabelledButton");
    expect(r.propsShape.label).toBe("");
    expect(r.propsShape.size).toBe("sm");
    expect(r.variantOptions.size).toEqual(["sm", "lg"]);
    // Own members outrank the base: `type?: "submit"` replaces the host default
    // and takes its option list with it.
    expect(r.propsShape.type).toBe("submit");
    expect("type" in r.variantOptions).toBe(false);

    // KNOWN GAP (reported, not fixed here — this file owns tests only):
    // resolveTypeDecl hands the heritage clause's ExpressionWithTypeArguments to
    // resolveTypeNode, which dispatches on ts.isTypeReferenceNode — a different
    // SyntaxKind — so the base falls into the catch-all instead of merging.
    // The skipped test below is the expectation to flip to once that is fixed.
    expect(r.unresolvedTypes).toEqual(['React.ComponentProps<"button">']);
    expect("className" in r.propsShape).toBe(false);
    expect(r.hostElement).toBeUndefined();
  });

  test.skip("extends-iface: base merged under own members", async () => {
    const r = await propsOf("extends-iface.tsx", "LabelledButton");
    expect(r.unresolvedTypes).toEqual([]);
    expect(r.hostElement).toBe("button");
    expect(r.acceptsChildren).toBe(true);
    expect(r.propsShape.className).toBe("");
    expect(r.propsShape.disabled).toBe(false);
    expect(r.propsShape.label).toBe("");
    expect(r.propsShape.type).toBe("submit");
    expect("type" in r.variantOptions).toBe(false);
    expect(r.variantOptions.size).toEqual(["sm", "lg"]);
  });
});

describe("extractProps: cva variant tables", () => {
  test("aliased-cva Badge: an aliased cva resolves, booleans stay booleans", async () => {
    const r = await propsOf("aliased-cva.tsx", "Badge");
    expect(r.propsShape).toEqual({ tone: "neutral", pill: false });
    expect(r.variantOptions.pill).toEqual([true, false]);
    expect(r.variantOptions.tone).toEqual(["neutral", "danger"]);
    expect(r.unresolvedTypes).toEqual([]);
    expect(r.variants.map((v) => v.pill)).toEqual([false, false, true, false]);
  });

  test("partial-cva Alert: a key with spread options is dropped, siblings kept", async () => {
    const r = await propsOf("partial-cva.tsx", "Alert");
    expect(r.propsShape).toEqual({ density: "comfy" });
    expect("tone" in r.propsShape).toBe(false);
    expect(r.variantOptions).toEqual({ density: ["comfy", "tight"] });
  });
});

/**
 * Each of these has a genuine-looking props type that the analyser must refuse.
 * Guessing any of them produces a variant or a prop the component does not have.
 */
const BAILS: Array<{ file: string; component: string; recorded: string; why: string }> = [
  {
    file: "bad-cva.tsx",
    component: "Chip",
    recorded: "VariantProps",
    why: "the cva config is an identifier, so the option set is not in this file",
  },
  {
    file: "slots-tv.tsx",
    component: "Dialog",
    recorded: "VariantProps",
    why: "a tv() slots config changes both the option shape and the prop semantics",
  },
  {
    file: "fake-cp.tsx",
    component: "FakeCard",
    recorded: "ComponentProps",
    why: "ComponentProps comes from a project-local module, not react",
  },
  {
    file: "fake-variantprops.tsx",
    component: "Toast",
    recorded: "VariantProps",
    why: "VariantProps comes from a project-local module, so the cva table beside it proves nothing",
  },
];

describe("extractProps: bails", () => {
  for (const bail of BAILS) {
    test(`${bail.file}: ${bail.why}`, async () => {
      const r = await propsOf(bail.file, bail.component);
      expect(r.propsShape).toEqual({});
      expect(r.variants).toEqual([]);
      expect(r.variantOptions).toEqual({});
      expect(r.unresolvedTypes).toEqual([bail.recorded]);
      // The bail is a *type* we gave up on, never a prop name — the two arrays
      // used to be one, and every consumer read it as prop names.
      expect(r.unresolvedProps).toEqual([]);
      expect(r.hostElement).toBeUndefined();
      expect(r.acceptsChildren).toBe(false);
    });
  }
});

describe("extractProps: cross-file ComponentProps<typeof X>", () => {
  test("delegate Panel: inherits Card's shape, options and host element", async () => {
    const r = await propsOf("delegate.tsx", "Panel");
    expect(r.propsShape).toEqual({ className: "", id: "", size: "default" });
    expect(r.variantOptions.size).toEqual(["default", "sm"]);
    expect(r.hostElement).toBe("div");
    expect(r.acceptsChildren).toBe(true);
    expect(r.unresolvedTypes).toEqual([]);
    // Declaration sites point at card.tsx, which is the proof the hop happened.
    expect(r.propPositions.size?.file.endsWith("shadcn/card.tsx")).toBe(true);
    expect(r.propPositions.className?.file.endsWith("shadcn/card.tsx")).toBe(true);
  });

  test("delegate Panel: without a resolver the hop is refused, not guessed", async () => {
    const abs = path.join(SHADCN, "delegate.tsx");
    const parsed = await parseFile(abs);
    const unit = parsed.components[0];
    if (!unit) throw new Error("delegate.tsx did not parse");
    const r = extractProps(
      parsed.sourceFile,
      unit.propsTypeNode,
      unit.propsTypeLiteral,
      parsed.imports,
      abs,
    );
    expect(r.propsShape).toEqual({});
    expect(r.unresolvedTypes).toEqual(["React.ComponentProps"]);
    expect(r.hostElement).toBeUndefined();
  });
});
