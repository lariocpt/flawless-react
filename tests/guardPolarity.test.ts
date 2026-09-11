// The guard-exit residue: comparison polarity inside `if (…) notFound()`, and
// a lookup field compared against another dep. Both shapes kept detail pages
// guard-exiting after the equals/equalsProp round — the fixture could satisfy
// a literal or a prop, but not "the other side of this comparison".
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { extractDataDeps } from "../src/analyse/extractDataDeps.ts";
import { parseFile } from "../src/analyse/parseFile.ts";
import { mockLiteral } from "../src/scaffold-tests/mockValues.ts";
import type { DataDepInfo, MockField, MockShape } from "../src/types.ts";

const FIXTURES = path.resolve(__dirname, "fixtures/rsc");

async function loadDeps(fixture: string): Promise<DataDepInfo[]> {
  const parsed = await parseFile(path.join(FIXTURES, fixture));
  const unit = parsed.components[0];
  if (!unit) throw new Error(`${fixture} did not parse into a component`);
  return extractDataDeps(unit.bodyNode, parsed.sourceFile, parsed.imports);
}

function byVar(deps: DataDepInfo[], varName: string): DataDepInfo {
  const found = deps.find((d) => d.varName === varName);
  if (!found) throw new Error(`no data dep for ${varName}`);
  return found;
}

function objectField(shape: MockShape, name: string): MockField {
  if (shape.kind !== "object") throw new Error(`expected object shape, got ${shape.kind}`);
  const f = shape.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
}

function elementField(shape: MockShape, name: string): MockField {
  if (shape.kind !== "array" || shape.element?.kind !== "object") {
    throw new Error(`expected array-of-object shape, got ${shape.kind}`);
  }
  const f = shape.element.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no element field ${name}`);
  return f;
}

describe("comparison polarity in a guard condition", () => {
  test("a !== guard captures the one value that PASSES", async () => {
    // `if (!invoice || invoice.building_id !== id) notFound()` — the page
    // renders only when the field IS the route param, so that is what the
    // fixture must hold. equalsProp, not equals: the emitter reads it out of
    // the same props fixture the spec's DEFAULTS carries.
    const deps = await loadDeps("GuardPolarityPage.tsx");
    const bid = objectField(byVar(deps, "invoice").shape, "building_id");
    expect(bid.equalsProp).toEqual(["params", "id"]);
    expect(bid.equals).toBeUndefined();
  });

  test("a === guard captures NOTHING — that value fires the exit", async () => {
    // `if (invoice.kind === "deleted") notFound()` — capturing "deleted" would
    // re-create the green-test-over-an-empty-render failure the equals note
    // exists to prevent.
    const deps = await loadDeps("GuardPolarityPage.tsx");
    const kind = objectField(byVar(deps, "invoice").shape, "kind");
    expect(kind.equals).toBeUndefined();
    expect(kind.equalsProp).toBeUndefined();
  });

  test("a !== in render position still captures nothing", async () => {
    // `invoice.status !== "paid" ? <b>Due</b> : null` — outside a guard, !==
    // still only says what the value must NOT be.
    const deps = await loadDeps("GuardPolarityPage.tsx");
    const status = objectField(byVar(deps, "invoice").shape, "status");
    expect(status.equals).toBeUndefined();
  });

  test("a === inside a find() callback keeps its render-position polarity", async () => {
    // The callback boundary ends guard context: `members.find((m) => m.status
    // === "active")` under `if (!…) notFound()` still means the row the page
    // is LOOKING FOR — the polarity round must not regress the equals round.
    const deps = await loadDeps("MembershipGuardPage.tsx");
    const status = elementField(byVar(deps, "memberships").shape, "status");
    expect(status.equals).toBe("active");
  });
});

describe("a field compared against another dep's field", () => {
  test("the comparison is recorded by dep name and field", async () => {
    // `members.find((m) => m.user_id === user.id)` — neither a literal nor a
    // prop; the note names the other dep so the emitter can unify the two.
    const deps = await loadDeps("GuardPolarityPage.tsx");
    const uid = elementField(byVar(deps, "members").shape, "user_id");
    expect(uid.equalsDep).toEqual({ var: "user", field: "id" });
    expect(uid.equals).toBeUndefined();
  });

  test("mockLiteral resolves the note against the other dep's fixture", async () => {
    const deps = await loadDeps("GuardPolarityPage.tsx");
    const lit = mockLiteral(byVar(deps, "members").shape, "members", undefined, (dep, field) =>
      dep === "user" && field === "id" ? '"flawless-id"' : undefined,
    );
    expect(lit).toContain('user_id: "flawless-id"');
  });

  test("without a resolver the field keeps its synthesised default", async () => {
    // The crash-on-undefined rule holds: an unresolvable note is dropped, not
    // emitted as `undefined`.
    const deps = await loadDeps("GuardPolarityPage.tsx");
    const lit = mockLiteral(byVar(deps, "members").shape, "members");
    expect(lit).toContain('user_id: "flawless-user_id"');
  });
});

describe("a dep assigned inside a top-level try", () => {
  test("the assignment is a dep, and guard polarity reaches its fields", async () => {
    // `let ticket; try { ticket = await getTicketDetail(…) } catch …` — the
    // try body always runs, so the dep is as real as a const; the `!== id`
    // guard on it then lands its equalsProp exactly like the const case.
    const deps = await loadDeps("TryAssignPage.tsx");
    const ticket = byVar(deps, "ticket");
    expect(ticket.calleeRoot).toBe("getTicketDetail");
    expect(ticket.awaited).toBe(true);
    const bid = objectField(ticket.shape, "building_id");
    expect(bid.equalsProp).toEqual(["params", "id"]);
  });

  test("reduce() is array evidence", async () => {
    // `options.reduce(…)` used to classify the field as an object, mock it
    // {}, and crash the page on `.reduce is not a function` — into the skip
    // escape, so nobody saw it.
    const deps = await loadDeps("TryAssignPage.tsx");
    expect(byVar(deps, "options").shape.kind).toBe("array");
  });
});

describe("fields read off a find() result", () => {
  test("a guard comparison on the result reaches the element fixture", async () => {
    // `const myMembership = members.find(…); if (!myMembership ||
    // myMembership.status !== "active") notFound()` — the result IS one
    // element, so the guard's pass side lands on the row.
    const deps = await loadDeps("GuardPolarityPage.tsx");
    const status = elementField(byVar(deps, "members").shape, "status");
    expect(status.equals).toBe("active");
  });

  test("a render read on the result becomes an element field", async () => {
    // `{myMembership.label}` — the round-6 B-20 shape: the field only ever
    // reachable through the find result used to keep no note at all.
    const deps = await loadDeps("GuardPolarityPage.tsx");
    const label = elementField(byVar(deps, "members").shape, "label");
    expect(label.rendersAsText).toBe(true);
  });
});
