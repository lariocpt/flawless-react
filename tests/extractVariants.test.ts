import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractVariantDefs, type VariantDefinition } from "../src/analyse/extractVariants.ts";
import { parseFile } from "../src/analyse/parseFile.ts";

const SHADCN = path.resolve(__dirname, "fixtures/shadcn");

async function defsOf(file: string): Promise<Map<string, VariantDefinition>> {
  const parsed = await parseFile(path.join(SHADCN, file));
  return extractVariantDefs(parsed.sourceFile, parsed.imports);
}

function def(defs: Map<string, VariantDefinition>, name: string): VariantDefinition {
  const found = defs.get(name);
  if (!found) throw new Error(`no cva/tv definition named ${name}: got [${[...defs.keys()]}]`);
  return found;
}

describe("extractVariantDefs", () => {
  test("button.tsx: full cva table, defaults and key positions", async () => {
    const defs = await defsOf("button.tsx");
    expect([...defs.keys()]).toEqual(["buttonVariants"]);

    const buttonVariants = def(defs, "buttonVariants");
    expect(buttonVariants.name).toBe("buttonVariants");
    expect(buttonVariants.factory).toBe("cva");
    expect(buttonVariants.options).toEqual({
      variant: ["default", "outline", "ghost"],
      size: ["default", "sm", "icon-xs"],
    });
    expect(buttonVariants.defaults).toEqual({ variant: "default", size: "default" });

    expect(buttonVariants.pos.line).toBe(7);
    expect(buttonVariants.pos.file.endsWith("shadcn/button.tsx")).toBe(true);
    expect(buttonVariants.keyPositions.variant?.line).toBe(11);
    expect(buttonVariants.keyPositions.size?.line).toBe(16);
  });

  test("button.tsx: a string-literal option name is a real option", async () => {
    // `"icon-xs"` is a StringLiteral PropertyName, not an Identifier — dropping
    // it would silently shrink the option set of every shadcn size scale.
    const size = def(await defsOf("button.tsx"), "buttonVariants").options.size;
    expect(size).toEqual(["default", "sm", "icon-xs"]);
  });

  test("aliased-cva.tsx: `cva as classes` resolves, and true/false becomes a boolean", async () => {
    const defs = await defsOf("aliased-cva.tsx");
    const badge = def(defs, "badgeVariants");
    expect(badge.factory).toBe("cva");
    expect(badge.options).toEqual({
      tone: ["neutral", "danger"],
      pill: [true, false],
    });
    // `pill: false` is a legitimate default; a truthiness check would drop it.
    expect(badge.defaults).toEqual({ tone: "neutral", pill: false });
  });

  test("fake-variantprops.tsx: provenance is checked on cva itself, not on the caller", async () => {
    // `VariantProps` here comes from a project-local module, which is what makes
    // extractProps refuse the component — but the cva() call is genuine, so the
    // table is still readable. The two rules must not be entangled.
    const toast = def(await defsOf("fake-variantprops.tsx"), "toastVariants");
    expect(toast.options).toEqual({ tone: ["info", "error"] });
    expect(toast.defaults).toEqual({ tone: "info" });
  });

  test("partial-cva.tsx: a spread-poisoned key is dropped, its siblings survive", async () => {
    const alert = def(await defsOf("partial-cva.tsx"), "alertVariants");
    // `tone: { ...SHARED_TONES, error }` — the full option set is not knowable
    // from this file, and a partial list would generate variants that miss cases.
    expect(alert.options).toEqual({ density: ["comfy", "tight"] });
    expect("tone" in alert.options).toBe(false);
    // A default for a dropped key would name a prop that has no option list.
    expect(alert.defaults).toEqual({ density: "comfy" });
    expect(alert.keyPositions.density?.line).toBe(10);
  });
});

describe("extractVariantDefs bails", () => {
  test("bad-cva.tsx: a config passed by reference is not read", async () => {
    // The identifier could be re-exported, spread or built at runtime; reading
    // the const it happens to point at in this file would be a guess.
    expect([...(await defsOf("bad-cva.tsx")).keys()]).toEqual([]);
  });

  test("slots-tv.tsx: a tv() slots config is refused whole", async () => {
    // With slots, an option value is a per-slot class map and the prop semantics
    // change; half-reading it would produce variants that do not exist.
    expect([...(await defsOf("slots-tv.tsx")).keys()]).toEqual([]);
  });

  test("card.tsx: a file with no cva/tv call yields nothing", async () => {
    expect([...(await defsOf("card.tsx")).keys()]).toEqual([]);
  });
});
