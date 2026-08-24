import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { extractServerActionReturns } from "../src/analyse/serverActionReturns.ts";
import { exportedNames } from "../src/analyse/sourceCache.ts";

/**
 * The bail policy is literalToValue's: a return value is recorded only when it
 * is literal-derivable from the action module's own source. Everything dynamic
 * stays a TODO — a wrong-but-plausible fixture is worse than an honest {} stub,
 * because the spec would go green against data the action can never produce.
 */

function returnsOf(source: string): Record<string, unknown> {
  const sf = ts.createSourceFile(
    "actions.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  return extractServerActionReturns(sf);
}

describe("extractServerActionReturns", () => {
  test("a single literal object return is recorded", () => {
    expect(
      returnsOf(`"use server";
export async function save() {
  return { ok: true, message: "saved", count: 2 };
}`),
    ).toEqual({ save: { ok: true, message: "saved", count: 2 } });
  });

  test("redirect()/notFound() are exits, not return values", () => {
    expect(
      returnsOf(`"use server";
import { redirect, notFound } from "next/navigation";
export async function save(id: string) {
  if (!id) redirect("/login");
  if (id === "gone") return notFound();
  if (id === "moved") { return redirect("/moved"); }
  return { ok: true };
}`),
    ).toEqual({ save: { ok: true } });
  });

  test("an action that only exits records nothing", () => {
    expect(
      returnsOf(`"use server";
import { redirect } from "next/navigation";
export async function bounce() {
  redirect("/home");
}`),
    ).toEqual({});
  });

  test("two DISTINCT non-exit values bail; identical duplicates do not", () => {
    expect(
      returnsOf(`"use server";
export async function twoShapes(x: boolean) {
  if (x) return { ok: true };
  return { ok: true, error: "nope" };
}
export async function sameTwice(x: boolean) {
  if (x) return { ok: false };
  return { ok: false };
}`),
    ).toEqual({ sameTwice: { ok: false } });
  });

  test("a computed return bails the whole name, even beside a literal one", () => {
    // One resolvable value is only trustworthy when it is the ONLY value: a
    // literal happy path next to a computed error path is two shapes, and
    // mocking just the literal would hide the one the component crashes on.
    expect(
      returnsOf(`"use server";
export async function compute() {
  return buildResult();
}
export async function mixed(x: boolean) {
  if (x) return buildResult();
  return { ok: true };
}`),
    ).toEqual({});
  });

  test("a bare `return;` is a value the mock cannot express, so it bails", () => {
    expect(
      returnsOf(`"use server";
export async function maybe(x: boolean) {
  if (x) return;
  return { ok: true };
}`),
    ).toEqual({});
  });

  test("arrow exports resolve, concise and block bodies alike", () => {
    expect(
      returnsOf(`"use server";
export const concise = async () => ({ kind: "concise" });
export const block = async () => { return { kind: "block" }; };`),
    ).toEqual({ concise: { kind: "concise" }, block: { kind: "block" } });
  });

  test("a nested function's returns belong to it, not to the action", () => {
    // Block-bodied on purpose: a concise arrow holds no ReturnStatement node,
    // so it cannot tell ownReturns from a naive all-descendants walk — the
    // mutation the adversarial review proved this test used to miss.
    expect(
      returnsOf(`"use server";
export async function outer() {
  const helper = () => {
    return { nested: "junk" };
  };
  void helper;
  return { ok: 1 };
}`),
    ).toEqual({ outer: { ok: 1 } });
  });

  test("exit calls need next/navigation provenance — a shadowing local bails", () => {
    // extractGuards learned this first: a project-local redirect() that
    // RETURNS something would have its value silently discounted, and the
    // recorded literal would disagree with what the action really returns.
    expect(
      returnsOf(`"use server";
function redirect(url: string) {
  return { redirected: url };
}
export async function go(x: boolean) {
  if (x) return redirect("/a");
  return { ok: true };
}`),
    ).toEqual({});
  });

  test("a redirect imported from anywhere but next/navigation is a value, so it bails", () => {
    expect(
      returnsOf(`"use server";
import { redirect } from "./my-nav";
export async function go(x: boolean) {
  if (x) return redirect("/a");
  return { ok: true };
}`),
    ).toEqual({});
  });

  test("an ALIASED next/navigation exit is still an exit", () => {
    expect(
      returnsOf(`"use server";
import { redirect as bounce } from "next/navigation";
export async function go(x: boolean) {
  if (x) return bounce("/a");
  return { ok: true };
}`),
    ).toEqual({ go: { ok: true } });
  });

  test("a namespaced next/navigation exit is still an exit", () => {
    expect(
      returnsOf(`"use server";
import * as nav from "next/navigation";
export async function go(x: boolean) {
  if (x) return nav.redirect("/a");
  return { ok: true };
}`),
    ).toEqual({ go: { ok: true } });
  });

  test("a generator's return is the generator's, not the caller's value", () => {
    // gen() returns an AsyncGenerator object, never a promise of the literal.
    expect(
      returnsOf(`"use server";
export async function* gen() {
  yield 1;
  return { done: true };
}`),
    ).toEqual({});
  });

  test("export clauses record under the exported name, not the local one", () => {
    expect(
      returnsOf(`"use server";
async function doSave() {
  return { n: 1 };
}
export { doSave as save };`),
    ).toEqual({ save: { n: 1 } });
  });

  test("re-exports from another file are not chased", () => {
    expect(returnsOf(`"use server";\nexport { save } from "./other";`)).toEqual({});
  });

  test("string, number, negative, array and null literals all resolve", () => {
    expect(
      returnsOf(`"use server";
export async function s() { return "done"; }
export async function n() { return 42; }
export async function neg() { return -1; }
export async function arr() { return [1, "two", { three: 3 }]; }
export async function nil() { return null; }`),
    ).toEqual({ s: "done", n: 42, neg: -1, arr: [1, "two", { three: 3 }], nil: null });
  });

  test('a default-exported action records under "default"', () => {
    expect(
      returnsOf(`"use server";
export default async function submit() {
  return { ok: true };
}`),
    ).toEqual({ default: { ok: true } });
  });

  test('exportedNames agrees: `export default async function name()` exports "default"', () => {
    // The module's export surface is {default}, not {doSave} — recording the
    // function's own name made the retire rule unreachable for this shape and
    // handed the host stub a named export the module never had, so a real
    // default import failed to bind against the stub.
    const sf = ts.createSourceFile(
      "actions.ts",
      `"use server";\nexport default async function doSave() { return { ok: 1 }; }`,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS,
    );
    expect(exportedNames(sf)).toEqual(["default"]);
    expect(extractServerActionReturns(sf)).toEqual({ default: { ok: 1 } });
  });

  test("template literals resolve only without substitutions", () => {
    expect(
      returnsOf(`"use server";
export async function plain() { return \`fixed\`; }
export async function dynamic(x: string) { return \`got \${x}\`; }`),
    ).toEqual({ plain: "fixed" });
  });
});
