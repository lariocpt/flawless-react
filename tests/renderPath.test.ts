import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  emptyEnv,
  evaluate,
  initialRenderExpression,
  makeEnv,
  type RenderEnv,
  reachability,
} from "../src/analyse/renderPath.ts";
import type { PropValue, StateInfo } from "../src/types.ts";

function envOf(props: Record<string, PropValue> = {}, opaque: string[] = []): RenderEnv {
  const env = emptyEnv();
  for (const [k, v] of Object.entries(props)) env.props.set(k, v);
  for (const n of opaque) env.opaque.add(n);
  return env;
}

/** Parse `expr` as a standalone expression and evaluate it against `env`. */
function evalSrc(expr: string, env: RenderEnv = emptyEnv()): PropValue | undefined {
  const sf = ts.createSourceFile("t.ts", `const _ = (${expr});`, ts.ScriptTarget.ES2022, true);
  const stmt = sf.statements[0] as ts.VariableStatement;
  const init = stmt.declarationList.declarations[0]?.initializer;
  if (!init) throw new Error("no expression");
  return evaluate(init, env);
}

/** Parse a component body and return its initial-render expression source. */
function initialOf(src: string, env: RenderEnv = emptyEnv()) {
  const sf = ts.createSourceFile("t.tsx", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const fn = sf.statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("no function");
  const got = initialRenderExpression(fn, env);
  return got && { text: got.expr.getText(sf).replace(/\s+/g, " "), guarded: got.guarded };
}

describe("evaluate", () => {
  test("literals and identifiers", () => {
    expect(evalSrc(`"hi"`)).toBe("hi");
    expect(evalSrc("42")).toBe(42);
    expect(evalSrc("-7")).toBe(-7);
    expect(evalSrc("false")).toBe(false);
    expect(evalSrc("null")).toBe(null);
    expect(evalSrc("open", envOf({ open: true }))).toBe(true);
  });

  test("an opaque name is unknown, not falsy", () => {
    // The distinction matters: treating an unresolved prop as falsy would make
    // every guard decidable and every answer a guess.
    expect(evalSrc("status", envOf({}, ["status"]))).toBeUndefined();
    expect(evalSrc("!status", envOf({}, ["status"]))).toBeUndefined();
    expect(evalSrc("missing")).toBeUndefined();
  });

  test("negation, comparison and length", () => {
    expect(evalSrc("!open", envOf({ open: false }))).toBe(true);
    expect(evalSrc("weight > 1", envOf({ weight: 0 }))).toBe(false);
    expect(evalSrc("weight >= 2", envOf({ weight: 2 }))).toBe(true);
    expect(evalSrc("items.length === 0", envOf({ items: [] }))).toBe(true);
    expect(evalSrc("name.length", envOf({ name: "abc" }))).toBe(3);
  });

  test("ordering on non-numbers is unknown rather than coerced", () => {
    expect(evalSrc(`a > b`, envOf({ a: "x", b: "y" }))).toBeUndefined();
  });

  test("=== and !== on objects are undecidable, and !== does not invert unknown", () => {
    const env = envOf({ a: { x: 1 }, b: { x: 1 } });
    expect(evalSrc("a === b", env)).toBeUndefined();
    // `!undefined` is true — returning it would turn "cannot tell" into a
    // confident "not equal".
    expect(evalSrc("a !== b", env)).toBeUndefined();
  });

  test("short-circuit operators resolve from the left operand alone", () => {
    expect(evalSrc("open && other", envOf({ open: false }, ["other"]))).toBe(false);
    expect(evalSrc("open || other", envOf({ open: true }, ["other"]))).toBe(true);
    expect(evalSrc("value ?? 5", envOf({ value: null }))).toBe(5);
    // …but an unknown left operand poisons the whole expression.
    expect(evalSrc("open && other", envOf({ other: true }, ["open"]))).toBeUndefined();
  });

  test("empty arrays and objects are truthy, as in JS", () => {
    expect(evalSrc("items ? 1 : 2", envOf({ items: [] }))).toBeUndefined();
    expect(evalSrc("!items", envOf({ items: [] }))).toBe(false);
  });

  test("anything outside the closed set is unknown", () => {
    expect(evalSrc("fetchUser()")).toBeUndefined();
    expect(evalSrc("a + b", envOf({ a: 1, b: 2 }))).toBeUndefined();
    expect(evalSrc("`x${y}`", envOf({ y: "z" }))).toBeUndefined();
  });
});

describe("initialRenderExpression", () => {
  const GATED = `
    function C({ open }) {
      if (!open) return <button>Trigger</button>;
      return <form>Expanded</form>;
    }`;

  test("a decidable guard wins over the tail return", () => {
    expect(initialOf(GATED, envOf({ open: false }))).toEqual({
      text: "<button>Trigger</button>",
      guarded: false,
    });
  });

  test("the same body with the guard false falls through to the tail", () => {
    expect(initialOf(GATED, envOf({ open: true }))).toEqual({
      text: "<form>Expanded</form>",
      guarded: false,
    });
  });

  test("an undecidable guard returning null still describes the tail, flagged", () => {
    // This is the asymmetry: bailing here would delete assertions from every
    // component that guards on an unresolvable prop and passes today.
    expect(
      initialOf(
        `function C({ greeting }) {
           if (!greeting) return null;
           return <p>Hi there</p>;
         }`,
        envOf({}, ["greeting"]),
      ),
    ).toEqual({ text: "<p>Hi there</p>", guarded: true });
  });

  test("an undecidable guard returning content has no honest answer", () => {
    expect(
      initialOf(
        `function C() {
           const toasts = useStore();
           if (toasts.length === 0) return <p>Nothing</p>;
           return <ul>Something</ul>;
         }`,
        emptyEnv(),
      ),
    ).toBeUndefined();
  });

  test("local consts are folded in and can decide a guard below them", () => {
    expect(
      initialOf(
        `function C({ weight }) {
           const boosted = weight > 1;
           if (boosted) return <p>Boosted</p>;
           return <p>Plain</p>;
         }`,
        envOf({ weight: 0 }),
      ),
    ).toEqual({ text: "<p>Plain</p>", guarded: false });
  });

  test("a concise arrow body is the render expression", () => {
    const sf = ts.createSourceFile(
      "t.tsx",
      "const C = () => <p>Hi</p>;",
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX,
    );
    const decl = (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0];
    const arrow = decl?.initializer as ts.ArrowFunction;
    expect(initialRenderExpression(arrow, emptyEnv())?.expr.getText(sf)).toBe("<p>Hi</p>");
  });
});

describe("reachability", () => {
  function parse(src: string) {
    const sf = ts.createSourceFile("t.tsx", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    const fn = sf.statements.find(ts.isFunctionDeclaration);
    if (!fn) throw new Error("no function");
    return { sf, fn };
  }

  /** Verdict for the first JSX element whose text contains `needle`. */
  function verdictFor(src: string, needle: string, env: RenderEnv) {
    const { sf, fn } = parse(src);
    const root = initialRenderExpression(fn, env);
    if (!root) throw new Error("no initial render");
    let found: ts.Node | undefined;
    const visit = (n: ts.Node): void => {
      // The element's OWN tag must carry the needle — matching whole subtree
      // text would find the outer <div>, which is the root and trivially "yes".
      if (!found && ts.isJsxSelfClosingElement(n) && n.getText(sf).includes(needle)) found = n;
      if (!found && ts.isJsxElement(n) && n.openingElement.getText(sf).includes(needle)) found = n;
      ts.forEachChild(n, visit);
    };
    visit(root.expr);
    if (!found) throw new Error(`no node containing ${needle}`);
    // root.scope, not env: the locals folded during the walk live there.
    return reachability(found, root.expr, root.scope);
  }

  const SRC = `
    function C({ weight, rows }) {
      const boosted = weight > 1;
      return (
        <div>
          <span id="always" />
          {boosted ? <textarea id="boost" /> : null}
          {rows.map((r) => <li id="row" key={r} />)}
        </div>
      );
    }`;

  test("an unconditional node is reached", () => {
    expect(verdictFor(SRC, 'id="always"', envOf({ weight: 0, rows: [] }))).toBe("yes");
  });

  test("a node behind a decidably-false condition is not reached", () => {
    expect(verdictFor(SRC, 'id="boost"', envOf({ weight: 0, rows: [] }))).toBe("no");
  });

  test("the same node is reached when the condition holds", () => {
    expect(verdictFor(SRC, 'id="boost"', envOf({ weight: 5, rows: [] }))).toBe("yes");
  });

  test("a .map row is never decidable — the row count is not knowable", () => {
    expect(verdictFor(SRC, 'id="row"', envOf({ weight: 0, rows: [] }))).toBe("unknown");
  });

  test("an undecidable condition yields unknown, not no", () => {
    expect(verdictFor(SRC, 'id="boost"', envOf({ rows: [] }, ["weight"]))).toBe("unknown");
  });
});

describe("makeEnv", () => {
  function refState(varName = "box"): StateInfo {
    return {
      kind: "useRef",
      varName,
      typeKind: "object",
      pos: { file: "t.tsx", line: 1, column: 1 },
      setterCalls: [],
      flowsToJsx: [],
      setterCalledInEffect: false,
    };
  }

  test("a useRef variable is the ref object — always truthy, never its init arg", () => {
    const env = makeEnv({}, [], [refState()]);
    // `useRef(null)` still hands back a truthy { current } object, so a
    // condition reading the ref identifier itself decides against the "empty"
    // branch. The old binding to the init arg resolved `!box` to true.
    expect(evalSrc("!box", env)).toBe(false);
    expect(evalSrc("box && 'on'", env)).toBe("on");
  });

  test("ref.current is unknown, not the init arg and not an invented {current}", () => {
    const env = makeEnv({}, [], [refState()]);
    // .current can be reassigned before the JSX runs — its value at render is
    // not knowable, and answering with the init arg (or a {current: …} shape)
    // would make `ref.current === null` a confident answer.
    expect(evalSrc("box.current", env)).toBeUndefined();
    expect(evalSrc("box.current === null", env)).toBeUndefined();
  });

  test("useState bindings keep their initial values", () => {
    const env = makeEnv(
      {},
      [],
      [
        refState(),
        {
          kind: "useState",
          varName: "open",
          setterName: "setOpen",
          initialValue: false,
          typeKind: "boolean",
          pos: { file: "t.tsx", line: 2, column: 1 },
          setterCalls: [],
          flowsToJsx: [],
          setterCalledInEffect: false,
        },
      ],
    );
    expect(evalSrc("open", env)).toBe(false);
    expect(evalSrc("!open", env)).toBe(true);
  });
});
