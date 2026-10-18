import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPureLocalModule } from "../src/analyse/pureModule.ts";

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** The verdict is about one file's text, so a temp file is the whole fixture. */
function check(source: string): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-pure-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "module.ts");
  writeFileSync(file, source);
  return isPureLocalModule(file);
}

describe("isPureLocalModule", () => {
  test("imports nothing and calls nothing at import time", () => {
    expect(
      check(`export function splitCode(c: string): string[] {
  return c.split("-");
}`),
    ).toBe(true);
  });

  test("`import type` keeps the module pure", () => {
    expect(
      check(`import type { Order } from "./types";
export function total(o: Order) {
  return o.n * 2;
}`),
    ).toBe(true);
  });

  test("inline `type` specifiers are type-only too", () => {
    // `NamedImports` has no isTypeOnly of its own, so reading it off the list
    // returned undefined and the module counted as importing something live:
    // its real code was replaced by a mock returning {} for every binding.
    expect(
      check(`import { type Order } from "./types";
export function label(o: Order) {
  return "#" + o.id;
}`),
    ).toBe(true);
  });

  test("a mixed named import is live", () => {
    expect(
      check(`import { type Order, loadOrder } from "./db";
export function one() {
  return loadOrder(1);
}`),
    ).toBe(false);
  });

  test("an unnamed import is live", () => {
    expect(
      check(`import { loadOrder } from "./db";
export function one() {
  return loadOrder(1);
}`),
    ).toBe(false);
  });

  test("async, await or a top-level call makes it impure", () => {
    expect(
      check(`export async function one() {
  return 1;
}`),
    ).toBe(false);
    expect(
      check(`const seed = JSON.parse("{}");
export function label() {
  return seed;
}`),
    ).toBe(false);
  });

  test("a use-server module is never pure", () => {
    expect(
      check(`"use server";
export function one() {
  return 1;
}`),
    ).toBe(false);
  });

  test("a path that cannot be read is not pure", () => {
    expect(isPureLocalModule(path.join(os.tmpdir(), "flawless-does-not-exist", "x.ts"))).toBe(
      false,
    );
  });
});
