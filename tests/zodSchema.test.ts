import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { resolveTypeNodeValue } from "../src/analyse/extractProps.ts";
import { analyse } from "../src/analyse/index.ts";

// B-9: z.infer<typeof schema> aliases resolve by reading the zod schema's
// own AST — syntax only, zod is never installed or executed. Round-6
// evidence: 44 of 83 aliases on the dogfood corpus are pure z.enum sitting
// as MEMBERS of nearly every shared interface, so bail-on-any-hole vetoed
// whole fixtures even after B-8 landed on the right declaration.

const ZOD_IMPORT = `import { z } from "zod";\n`;

function fixtureOf(source: string, expr: string): unknown {
  const sf = ts.createSourceFile(
    "/proj/lib.ts",
    `${source}\ntype __T = ${expr};`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let node: ts.TypeNode | undefined;
  for (const stmt of sf.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === "__T") node = stmt.type;
  }
  if (!node) throw new Error("fixture did not parse");
  return resolveTypeNodeValue(node, sf, "/proj/lib.ts", undefined, undefined);
}

describe("zod enum aliases", () => {
  test("z.enum alias resolves to its FIRST literal — the union-of-literals rule", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const RoleSchema = z.enum(["host", "cohost", "guest"]);
type Role = z.infer<typeof RoleSchema>;`,
        "{ role: Role }",
      ),
    ).toEqual({ role: "host" });
  });

  test("const and type under the SAME name in one file — the dominant idiom", () => {
    // fixtureReference seeds `${file}::RsvpStatus` for the TYPE before the
    // schema lookup starts; an un-namespaced visited key false-bails this.
    expect(
      fixtureOf(
        `${ZOD_IMPORT}export const RsvpStatus = z.enum(["invited", "accepted"]);
export type RsvpStatus = z.infer<typeof RsvpStatus>;`,
        "{ status: RsvpStatus }",
      ),
    ).toEqual({ status: "invited" });
  });

  test("a multi-line enum array and a wrapped alias both parse — AST, not regex", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}export const MeetingParticipantRoleSchema = z.enum([
  "chair",
  "secretary",
  "attendee",
]);
export type MeetingParticipantRole = z.infer<
  typeof MeetingParticipantRoleSchema
>;`,
        "{ role: MeetingParticipantRole }",
      ),
    ).toEqual({ role: "chair" });
  });

  test("z.enum of a const array REFERENCE bails — a partial member list would fabricate a union", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const ROLES = ["a", "b"] as const;
const S = z.enum(ROLES);
type T = z.infer<typeof S>;`,
        "{ v: T }",
      ),
    ).toBeUndefined();
  });
});

describe("zod object schemas", () => {
  test("z.object of primitives resolves with per-field seeding", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Please enter a valid email."),
  password: z.string().min(8),
  attempts: z.number(),
  remember: z.boolean(),
});
type LoginInput = z.infer<typeof LoginSchema>;`,
        "LoginInput",
      ),
    ).toEqual({
      email: "flawless-email",
      password: "flawless-password",
      attempts: 1,
      remember: true,
    });
  });

  test(".optional()/.nullable()/.nullish() members are included — richer beats sparser", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const S = z.object({
  a: z.string().optional(),
  b: z.number().nullable(),
  c: z.boolean().nullish(),
});
type T = z.infer<typeof S>;`,
        "T",
      ),
    ).toEqual({ a: "flawless-a", b: 1, c: true });
  });

  test(".default(<static literal>) uses the declared default; a function arg falls back to the inner value", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const S = z.object({
  kind: z.string().default("cheque"),
  days: z.number().int().min(0).max(60).default(14),
  label: z.string().default(() => "computed"),
});
type T = z.infer<typeof S>;`,
        "T",
      ),
    ).toEqual({ kind: "cheque", days: 14, label: "flawless-label" });
  });

  test("z.coerce.number()/.boolean() resolve to the OUTPUT type's house value, multi-line chains included", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const S = z.object({
  estimate: z.coerce
    .number()
    .int()
    .min(1)
    .max(480)
    .optional()
    .nullable(),
  isVirtual: z.coerce.boolean().optional().default(false),
});
type T = z.infer<typeof S>;`,
        "T",
      ),
    ).toEqual({ estimate: 1, isVirtual: false });
  });

  test("z.coerce.date() bails, and a date member bails the WHOLE object — no silent holes", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const S = z.object({
  title: z.string(),
  scheduledStart: z.coerce.date(),
});
type T = z.infer<typeof S>;`,
        "T",
      ),
    ).toBeUndefined();
    expect(
      fixtureOf(`${ZOD_IMPORT}const S = z.date();\ntype T = z.infer<typeof S>;`, "{ d: T }"),
    ).toBeUndefined();
  });

  test("inline z.enum inside an object, and schema-const references as fields", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const ConsentStatusSchema = z.enum(["pending", "granted"]);
const S = z.object({
  decision: z.enum(["granted", "declined"]),
  consent: ConsentStatusSchema.optional(),
  status: ConsentStatusSchema,
});
type T = z.infer<typeof S>;`,
        "T",
      ),
    ).toEqual({ decision: "granted", consent: "pending", status: "pending" });
  });

  test("z.array of a schema ref yields ONE element; .min on the array is ignored — the type admits one", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const RoleSchema = z.enum(["chair", "proxy"]);
const S = z.object({
  roles: z.array(RoleSchema),
  options: z.array(z.object({ label: z.string() })).min(2).max(20),
});
type T = z.infer<typeof S>;`,
        "T",
      ),
    ).toEqual({ roles: ["chair"], options: [{ label: "flawless-label" }] });
  });

  test("shorthand / spread / computed members bail the object", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const inner = z.string();
const S = z.object({ ...({} as object), a: z.string() });
type T = z.infer<typeof S>;`,
        "T",
      ),
    ).toBeUndefined();
  });
});

describe("zod bail policy", () => {
  test(".transform/.refine/.catch bail — the output type diverges or semantics change", () => {
    for (const chain of [
      `z.string().transform((s) => s.length)`,
      `z.string().refine((s) => s.length > 2)`,
      `z.string().catch("x")`,
    ]) {
      expect(
        fixtureOf(`${ZOD_IMPORT}const S = ${chain};\ntype T = z.infer<typeof S>;`, "{ v: T }"),
      ).toBeUndefined();
    }
  });

  test("z.union / z.nativeEnum / z.record / typeof ns.Schema bail — zero evidence, never invent", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const S = z.union([z.string(), z.number()]);\ntype T = z.infer<typeof S>;`,
        "{ v: T }",
      ),
    ).toBeUndefined();
    expect(
      fixtureOf(
        `${ZOD_IMPORT}enum E { A = "a" }\nconst S = z.nativeEnum(E);\ntype T = z.infer<typeof S>;`,
        "{ v: T }",
      ),
    ).toBeUndefined();
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const S = z.record(z.string());\ntype T = z.infer<typeof S>;`,
        "{ v: T }",
      ),
    ).toBeUndefined();
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const schemas = { S: z.string() };\ntype T = z.infer<typeof schemas.S>;`,
        "{ v: T }",
      ),
    ).toBeUndefined();
  });

  test("type-invariant string refinements are ignored — the fixture is type-legal, not format-conscious", () => {
    // Inline z.infer seeds with the member name; through an alias the seed
    // is the ALIAS name — the pre-existing fixtureDecl rule (`type Note =
    // string` has always yielded flawless-Note). Cosmetic either way: any
    // string inhabits the type, refinements notwithstanding.
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const S = z.string().email().min(20).uuid().regex(/x/);`,
        "{ token: z.infer<typeof S> }",
      ),
    ).toEqual({ token: "flawless-token" });
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const S = z.string().email().min(20).uuid().regex(/x/);
type Token = z.infer<typeof S>;`,
        "{ token: Token }",
      ),
    ).toEqual({ token: "flawless-Token" });
  });

  test("z.literal preserves the literal exactly; non-JSON literals bail", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const S = z.literal("fixed");\ntype T = z.infer<typeof S>;`,
        "{ v: T }",
      ),
    ).toEqual({ v: "fixed" });
    expect(
      fixtureOf(`${ZOD_IMPORT}const S = z.literal(42);\ntype T = z.infer<typeof S>;`, "{ v: T }"),
    ).toEqual({ v: 42 });
    expect(
      fixtureOf(`${ZOD_IMPORT}const S = z.literal(1n);\ntype T = z.infer<typeof S>;`, "{ v: T }"),
    ).toBeUndefined();
  });
});

describe("zod composition", () => {
  test("z.input resolves like z.infer — every supported value is legal for both", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const S = z.object({ body: z.string(), kind: z.string().default("note") });
type T = z.input<typeof S>;`,
        "T",
      ),
    ).toEqual({ body: "flawless-body", kind: "note" });
  });

  test("a NON-exported module-local schema referenced by an exported one resolves", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const PasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .regex(/[a-zA-Z]/, "letters");
export const SignupSchema = z.object({
  name: z.string().trim().min(2),
  password: PasswordSchema,
});
export type SignupInput = z.infer<typeof SignupSchema>;`,
        "SignupInput",
      ),
    ).toEqual({ name: "flawless-name", password: "flawless-password" });
  });

  test("two consts referencing each other terminate", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const A: any = z.object({ b: B });
const B: any = z.object({ a: A });
type T = z.infer<typeof A>;`,
        "T",
      ),
    ).toBeUndefined();
  });

  test(".partial() keeps every value; .extend merges with the extension winning", () => {
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const Base = z.object({ name: z.string(), city: z.string() });
const Update = Base.partial();
type T = z.infer<typeof Update>;`,
        "T",
      ),
    ).toEqual({ name: "flawless-name", city: "flawless-city" });
    expect(
      fixtureOf(
        `${ZOD_IMPORT}const Address = z.object({ city: z.string(), zip: z.string() });
const S = z
  .object({ name: z.string(), city: z.literal("base") })
  .extend(Address.shape);
type T = z.infer<typeof S>;`,
        "T",
      ),
    ).toEqual({ name: "flawless-name", city: "flawless-city", zip: "flawless-zip" });
  });
});

describe("zod provenance", () => {
  const CASES: Array<{ name: string; header: string; alias: string; resolves: boolean }> = [
    { name: "named import", header: `import { z } from "zod";`, alias: "z", resolves: true },
    {
      name: "aliased import",
      header: `import { z as zed } from "zod";`,
      alias: "zed",
      resolves: true,
    },
    { name: "namespace import", header: `import * as z from "zod";`, alias: "z", resolves: true },
    { name: "zod/v4 specifier", header: `import { z } from "zod/v4";`, alias: "z", resolves: true },
    {
      name: "not-zod package",
      header: `import { z } from "not-zod";`,
      alias: "z",
      resolves: false,
    },
    {
      name: "zod-form-data",
      header: `import { z } from "zod-form-data";`,
      alias: "z",
      resolves: false,
    },
  ];
  for (const c of CASES) {
    test(`${c.name} ${c.resolves ? "resolves" : "bails"}`, () => {
      const out = fixtureOf(
        `${c.header}
const S = ${c.alias}.enum(["ok"]);
type T = ${c.alias}.infer<typeof S>;`,
        "{ v: T }",
      );
      if (c.resolves) expect(out).toEqual({ v: "ok" });
      else expect(out).toBeUndefined();
    });
  }

  test("a local const z with no zod import bails — no ambient z", () => {
    expect(
      fixtureOf(
        `const z = { enum: (x: string[]) => x, infer: null } as any;
const S = z.enum(["ok"]);
type T = { v: string };`,
        "T extends { v: string } ? { fromLocal: true } : never",
      ),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Props paths, through the real analyser on a tmp project.

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tmpProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-zod-"));
  tmpDirs.push(dir);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  return dir;
}

async function analysedComponent(schemas: string, component: string) {
  const dir = tmpProject();
  writeFileSync(path.join(dir, "src", "schemas.ts"), schemas);
  const entry = path.join(dir, "src", "Form.tsx");
  writeFileSync(entry, component);
  const tree = await analyse({ entry, depth: 0, includeChildren: false });
  return tree.entry;
}

const FORM_SCHEMAS = `import { z } from "zod";

export const MeetingTypeSchema = z.enum(["agm", "committee", "adhoc"]);
export type MeetingType = z.infer<typeof MeetingTypeSchema>;

export const MeetingCreateSchema = z.object({
  title: z.string().trim().min(2).max(200),
  type: MeetingTypeSchema,
  isVirtual: z.coerce.boolean().optional().default(false),
});
export type MeetingCreateInput = z.infer<typeof MeetingCreateSchema>;

export const OnlyEnum = z.enum(["a", "b"]);
export type OnlyEnumT = z.infer<typeof OnlyEnum>;
`;

describe("zod through the props paths", () => {
  test("props typed AS a z.infer alias resolve to a shape with enum variants (path a)", async () => {
    const info = await analysedComponent(
      FORM_SCHEMAS,
      `import type { MeetingCreateInput } from "./schemas";

export function Form(props: MeetingCreateInput) {
  return <div>{props.title}</div>;
}
`,
    );
    expect(info.propsShape).toEqual({ title: "flawless-title", type: "agm", isVirtual: false });
    expect(info.variantOptions?.type).toEqual(["agm", "committee", "adhoc"]);
    expect(info.unresolvedTypes).toEqual([]);
  });

  test("props typed AS an ENUM alias stay a bail — props must be object-shaped (control)", async () => {
    const info = await analysedComponent(
      FORM_SCHEMAS,
      `import type { OnlyEnumT } from "./schemas";

export function Form(props: OnlyEnumT) {
  return <div />;
}
`,
    );
    expect(info.propsShape).toEqual({});
    expect(info.unresolvedTypes).toContain("z.infer");
  });

  test("an interface MEMBER typed as an enum alias resolves to first literal + options (path b)", async () => {
    const info = await analysedComponent(
      FORM_SCHEMAS,
      `import type { MeetingType } from "./schemas";

interface Props {
  status: MeetingType;
  title: string;
}

export function Form(props: Props) {
  return <div>{props.title}</div>;
}
`,
    );
    expect(info.propsShape).toEqual({ status: "agm", title: "" });
    expect(info.variantOptions?.status).toEqual(["agm", "committee", "adhoc"]);
    expect(info.unresolvedProps).toEqual([]);
  });

  test("a NON-zod named member alias still lands in unresolvedProps (control — mapType untouched)", async () => {
    const info = await analysedComponent(
      `export type Weird = Map<string, number>;\n`,
      `import type { Weird } from "./schemas";

interface Props {
  w: Weird;
  title: string;
}

export function Form(props: Props) {
  return <div>{props.title}</div>;
}
`,
    );
    expect(info.propsShape).toEqual({ title: "" });
    expect(info.unresolvedProps).toContain("w");
  });
});
