import ts from "typescript";
import { mockValue } from "../scaffold-tests/mockValues.ts";
import { withRouteParams } from "../scaffold-tests/registry.ts";
import type {
  DataDepInfo,
  GuardInfo,
  ModuleImportInfo,
  PredicateInversionInfo,
  PredicateRefusal,
  PredicateSiteInfo,
  PropsShape,
  PropValue,
} from "../types.ts";
import { posOf } from "./pos.ts";
import { bodyStatements } from "./refs.ts";
import {
  evaluate,
  initialRenderExpression,
  makeEnv,
  type RenderEnv,
  reachability,
  truthy,
  unwrap,
} from "./renderPath.ts";

/**
 * B-19: which predicates can a spec INVERT, and what provably changes when it
 * does. A generated page spec's fixtures make every predicate true, so
 * `userIsTrustee ? A : B` only ever renders A — and no fixture fix can reach
 * B, because reaching it means a second mount with the predicate flipped.
 *
 * Everything here is decided by EVALUATING conditions against the same values
 * the spec will actually mock with (mockValue is mockLiteral's value mirror),
 * once with the defaults and once with a single flip applied. A site counts
 * only when both evaluations settle AND disagree — the certification that
 * makes the second mount's assertions claims about the component rather than
 * hopes. Four flip kinds, each backed by evidence the analyser already holds:
 *
 *   dep-bool   the dep's own `: boolean` KEYWORD annotation admits false
 *   dep-null   a nullable-annotated dep behind the page's only truthy guard
 *   dep-empty  a usage-proven array dep flipped to []
 *   prop       a prop (or destructured awaited-prop field) the DEFAULTS decide
 *
 * Refusals are named, never silent (the renderUndecidable rule).
 */

const MAX_CONTROLS = 3;

interface ExtractArgs {
  bodyNode: ts.Node;
  sourceFile: ts.SourceFile;
  dataDeps: DataDepInfo[];
  guards: GuardInfo[];
  moduleImports: ModuleImportInfo[];
  propsShape: PropsShape;
  unresolvedProps: string[];
  staticText: string[];
}

export function extractPredicates(args: ExtractArgs): {
  inversions: PredicateInversionInfo[];
  refusals: PredicateRefusal[];
} {
  const { bodyNode, sourceFile, dataDeps, guards, staticText } = args;
  const none = { inversions: [], refusals: [] };

  const props = withRouteParams(args.propsShape);
  const env = makeEnv(props, args.unresolvedProps, []);
  const aliasPaths = foldAwaitedPropAliases(bodyNode, props, env);
  foldDepValues(args, props, env);

  const render = initialRenderExpression(bodyNode, env);
  if (!render) return none;

  const jsxSites = collectJsxSites(render.expr);
  const bodySites = collectBodySites(bodyNode);
  const guardVars = guardTaintedVars(bodyNode, guards, sourceFile);
  const callCounts = countCallSites(bodyNode, sourceFile);

  const inversions: PredicateInversionInfo[] = [];
  const refusals: PredicateRefusal[] = [];

  const certify = (control: PredicateInversionInfo, flipVar: string): void => {
    const flipped = flipEnv(env, flipVar, control.flip);
    const sites: PredicateSiteInfo[] = [];
    for (const site of jsxSites) {
      const s = certifyJsxSite(site, env, flipped, render.expr, sourceFile);
      if (s) sites.push(s);
    }
    for (const site of bodySites) {
      const s = certifyBodySite(site, env, flipped, args.moduleImports, sourceFile);
      if (s) sites.push(s);
    }
    if (sites.length === 0) {
      refusals.push({ varName: control.varName, reason: "invisible", pos: control.pos });
      return;
    }
    if (!assertable(sites)) {
      refusals.push({ varName: control.varName, reason: "unwitnessed", pos: control.pos });
      return;
    }
    inversions.push({ ...control, sites });
  };

  // --- dep-backed controls --------------------------------------------------
  for (const dep of dataDeps) {
    if (dep.varName === undefined || dep.specifier === undefined) continue;
    if (dep.callee !== dep.calleeRoot) continue;
    const kind = depControlKind(dep, args.moduleImports);
    if (!kind) continue;
    const pos = dep.pos;
    const varName = dep.varName;
    if ((callCounts.get(dep.calleeRoot) ?? 0) !== 1) {
      refusals.push({ varName, reason: "multi-call", pos });
      continue;
    }
    if (kind === "dep-null") {
      // The one flip that must UN-fire a guard: only certifiable when that
      // guard is the page's only one (another guard could still exit the
      // flipped mount) and the page carries unconditional text to witness.
      const g = guards[0];
      if (
        guards.length !== 1 ||
        !g ||
        g.conditionKind !== "truthy" ||
        g.depVars.length !== 1 ||
        g.depVars[0] !== varName ||
        staticText.length === 0
      ) {
        continue;
      }
      inversions.push({
        kind,
        varName,
        calleeRoot: dep.calleeRoot,
        specifier: dep.specifier,
        awaited: dep.awaited,
        flip: null,
        sites: [],
        pos,
      });
      continue;
    }
    // A control whose var also decides an exit guard is emitGuardTests'
    // territory: that false side EXITS, and inverting it here would assert
    // absences over a mount that rendered nothing.
    if (guardVars.has(varName)) {
      refusals.push({ varName, reason: "guard-entangled", pos });
      continue;
    }
    const baseline = env.state.get(varName);
    if (kind === "dep-bool") {
      if (baseline === undefined || !truthy(baseline)) continue;
      certify(
        {
          kind,
          varName,
          calleeRoot: dep.calleeRoot,
          specifier: dep.specifier,
          awaited: dep.awaited,
          flip: false,
          sites: [],
          pos,
        },
        varName,
      );
      continue;
    }
    // dep-empty: only a fixture that IS non-empty has an empty side to show.
    if (!Array.isArray(baseline) || baseline.length === 0) continue;
    certify(
      {
        kind,
        varName,
        calleeRoot: dep.calleeRoot,
        specifier: dep.specifier,
        awaited: dep.awaited,
        flip: [],
        sites: [],
        pos,
      },
      varName,
    );
  }

  // --- prop controls --------------------------------------------------------
  for (const { control, local } of propControls(jsxSites, env, aliasPaths, sourceFile)) {
    certify(control, local);
  }

  // Rank by how much each flip moves, keep the cap honest: what falls off is
  // a named refusal, not a silent drop.
  inversions.sort((a, b) => b.sites.length - a.sites.length || a.pos.line - b.pos.line);
  for (const dropped of inversions.splice(MAX_CONTROLS)) {
    refusals.push({ varName: dropped.varName, reason: "capped", pos: dropped.pos });
  }
  return { inversions, refusals };
}

// ---------------------------------------------------------------------------
// Environment: the values the spec will actually mock with
// ---------------------------------------------------------------------------

/**
 * `const { error } = await searchParams` — fold each destructured field of an
 * awaited PROP into the env with the value DEFAULTS carries there, and record
 * the path so a prop flip knows what to override in buildProps.
 */
function foldAwaitedPropAliases(
  bodyNode: ts.Node,
  props: PropsShape,
  env: RenderEnv,
): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  for (const stmt of bodyStatements(bodyNode)) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isObjectBindingPattern(decl.name)) continue;
      const init = ts.isAwaitExpression(decl.initializer)
        ? decl.initializer.expression
        : decl.initializer;
      if (!ts.isIdentifier(init)) continue;
      const root = init.text;
      const rootValue = (props as Record<string, PropValue>)[root];
      if (rootValue === undefined) continue;
      for (const el of decl.name.elements) {
        if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
        const key =
          el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
        const local = el.name.text;
        paths.set(local, [root, key]);
        const v =
          rootValue !== null && typeof rootValue === "object" && !Array.isArray(rootValue)
            ? (rootValue as Record<string, PropValue>)[key]
            : undefined;
        if (v !== undefined) env.state.set(local, v);
        else env.opaque.add(local);
      }
    }
  }
  return paths;
}

/** Dep var → the PropValue its emitted mock resolves to, folded into env. */
function foldDepValues(args: ExtractArgs, props: PropsShape, env: RenderEnv): void {
  for (const dep of args.dataDeps) {
    if (dep.varName === undefined) continue;
    if (dep.uncertain || dep.shape.kind === "unknown") {
      // The emitted mock is the annotation value, or {} — an OpenAPI join is
      // emit-only knowledge, and {} keeps the same truthiness while making
      // its field reads undecidable, which safely skips those sites.
      env.state.set(dep.varName, dep.inferredReturn?.value ?? {});
      continue;
    }
    let v = mockValue(dep.shape, dep.calleeRoot, props);
    const fill = importedReturnFor(args.moduleImports, dep)?.value;
    v = overlayFill(v, fill);
    env.state.set(dep.varName, v);
  }
}

/** The importedReturns entry for this dep's callee, resolved by module-side name. */
function importedReturnFor(
  moduleImports: ModuleImportInfo[],
  dep: DataDepInfo,
):
  | { value: PropValue; sync: boolean; booleanAnnotated?: true; nullableAnnotated?: true }
  | undefined {
  for (const mi of moduleImports) {
    if (dep.specifier !== undefined && mi.specifier !== dep.specifier) continue;
    const i = mi.names.indexOf(dep.calleeRoot);
    if (i < 0) continue;
    const moduleName = mi.importedNames?.[i] ?? dep.calleeRoot;
    const entry = mi.importedReturns?.[moduleName];
    if (entry) return entry;
  }
  return undefined;
}

/**
 * The same placeholder-holes-only overlay the emitter applies (mockValues'
 * fieldLiteral fill rule) — the env must hold the values the mount will see.
 */
function overlayFill(v: PropValue, fill: PropValue | undefined): PropValue {
  if (fill === undefined || fill === null) return v;
  if (Array.isArray(v)) {
    const el = Array.isArray(fill) ? fill[0] : undefined;
    return el === undefined ? v : v.map((x) => overlayFill(x, el));
  }
  if (v !== null && typeof v === "object") {
    if (fill === null || typeof fill !== "object" || Array.isArray(fill)) return v;
    const out: Record<string, PropValue> = { ...(v as Record<string, PropValue>) };
    for (const [k, cur] of Object.entries(out)) {
      const f = (fill as Record<string, PropValue>)[k];
      if (f === undefined) continue;
      if (typeof cur === "string" && cur.startsWith("flawless-")) {
        if (typeof f === "string" && !f.startsWith("flawless-")) out[k] = f;
        continue;
      }
      out[k] = overlayFill(cur, f);
    }
    return out;
  }
  return v;
}

function flipEnv(env: RenderEnv, varName: string, flip: PropValue | undefined): RenderEnv {
  const out: RenderEnv = {
    props: new Map(env.props),
    state: new Map(env.state),
    opaque: new Set(env.opaque),
  };
  out.opaque.delete(varName);
  // A flip to `undefined` (an omitted prop) is modelled as null: evaluate has
  // no way to distinguish a stored undefined from "unknown", and null carries
  // the same falsiness through every condition shape this certifies.
  out.state.set(varName, flip === undefined ? null : flip);
  return out;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function depControlKind(
  dep: DataDepInfo,
  moduleImports: ModuleImportInfo[],
): "dep-bool" | "dep-null" | "dep-empty" | undefined {
  const entry = importedReturnFor(moduleImports, dep);
  const booleanAnnotated = dep.inferredReturn?.booleanAnnotated ?? entry?.booleanAnnotated;
  if (booleanAnnotated) return "dep-bool";
  const nullableAnnotated = dep.inferredReturn?.nullableAnnotated ?? entry?.nullableAnnotated;
  if (nullableAnnotated) return "dep-null";
  if (dep.awaited && dep.shape.kind === "array" && dep.shape.element) return "dep-empty";
  return undefined;
}

/**
 * Sites whose condition the DEFAULTS alone decide, flipped by overriding one
 * prop (or destructured awaited-prop field). Candidates per condition: every
 * literal it strictly compares the name against, plus absence.
 */
function propControls(
  sites: JsxSite[],
  env: RenderEnv,
  aliasPaths: Map<string, string[]>,
  sourceFile: ts.SourceFile,
): { control: PredicateInversionInfo; local: string }[] {
  const out = new Map<string, { control: PredicateInversionInfo; local: string }>();
  for (const site of sites) {
    const names = identifierLeaves(site.condition);
    if (names.length !== 1) continue;
    const name = names[0] as string;
    const isProp = env.props.has(name);
    const isAlias = aliasPaths.has(name);
    if (!isProp && !isAlias) continue;
    if (evaluate(site.condition, env) === undefined) continue;
    const path = isAlias ? (aliasPaths.get(name) as string[]) : [name];
    // Every literal the condition compares the name against, absence, and a
    // truthy string — the last is what flips a bare `token ?` whose default
    // is empty.
    const candidates: (PropValue | undefined)[] = [
      ...comparedLiterals(site.condition, name),
      undefined,
      `flawless-${path[path.length - 1]}`,
    ];
    for (const flip of candidates) {
      const key = `${path.join(".")}=${JSON.stringify(flip ?? null)}`;
      if (out.has(key)) break;
      const flipped = flipEnv(env, name, flip);
      const before = evaluate(site.condition, env);
      const after = evaluate(site.condition, flipped);
      if (before === undefined || after === undefined) continue;
      if (truthy(before) === truthy(after)) continue;
      out.set(key, {
        control: {
          kind: "prop",
          varName: path.join("."),
          propPath: path,
          ...(flip !== undefined ? { flip } : {}),
          sites: [],
          pos: posOf(site.pos, sourceFile),
        },
        local: name,
      });
      break;
    }
  }
  return [...out.values()];
}

function identifierLeaves(expr: ts.Expression): string[] {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text !== "undefined") {
      const parent = n.parent;
      // A property NAME is not a reference; the access root is.
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === n) return;
      out.add(n.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return [...out];
}

function comparedLiterals(expr: ts.Expression, name: string): PropValue[] {
  const out: PropValue[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      for (const [side, other] of [
        [n.left, n.right],
        [n.right, n.left],
      ] as const) {
        const s = unwrap(side);
        const referencesName =
          (ts.isIdentifier(s) && s.text === name) ||
          (ts.isPropertyAccessExpression(s) &&
            ts.isIdentifier(s.expression) &&
            s.expression.text === name);
        if (!referencesName) continue;
        const o = unwrap(other);
        if (ts.isStringLiteral(o)) out.push(o.text);
        else if (ts.isNumericLiteral(o)) out.push(Number(o.text));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return out;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

interface JsxSite {
  kind: "ternary" | "and";
  condition: ts.Expression;
  whenTrue?: ts.Expression;
  whenFalse?: ts.Expression;
  node: ts.Node;
  pos: ts.Node;
}

/**
 * Render-position conditionals: ternaries and `&&` in JSX-child position.
 * Attribute values are out (a claim about what a CHILD renders needs evidence
 * this analyser does not hold), and so is anything inside a callback — a row
 * env is not the mount env.
 */
function collectJsxSites(root: ts.Expression): JsxSite[] {
  const out: JsxSite[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isJsxAttribute(n)) return;
    if (ts.isConditionalExpression(n) && inJsxChildPosition(n)) {
      out.push({
        kind: "ternary",
        condition: n.condition,
        whenTrue: n.whenTrue,
        whenFalse: n.whenFalse,
        node: n,
        pos: n,
      });
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      inJsxChildPosition(n)
    ) {
      out.push({ kind: "and", condition: n.left, whenTrue: n.right, node: n, pos: n });
      // The right side may nest further sites; the condition side may not.
      visit(n.right);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** `{ … }` directly under a JsxElement/Fragment — text position, not an attr. */
function inJsxChildPosition(n: ts.Node): boolean {
  let cur: ts.Node | undefined = n.parent;
  while (cur) {
    if (ts.isParenthesizedExpression(cur) || ts.isConditionalExpression(cur)) {
      cur = cur.parent;
      continue;
    }
    if (
      ts.isBinaryExpression(cur) &&
      (cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        cur.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      cur = cur.parent;
      continue;
    }
    if (ts.isJsxExpression(cur)) {
      const holder = cur.parent;
      return holder !== undefined && (ts.isJsxElement(holder) || ts.isJsxFragment(holder));
    }
    // The whole returned expression is a legal site holder too.
    return ts.isReturnStatement(cur) || ts.isArrowFunction(cur);
  }
  return false;
}

interface BodySite {
  condition: ts.Expression;
  whenTrue: ts.Expression;
  whenFalse: ts.Expression;
  pos: ts.Node;
}

/** Data-selection ternaries in top-level initializers: `c ? f(…) : g(…)`. */
function collectBodySites(bodyNode: ts.Node): BodySite[] {
  const out: BodySite[] = [];
  for (const stmt of bodyStatements(bodyNode)) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      const visit = (n: ts.Node): void => {
        if (ts.isFunctionLike(n)) return;
        if (ts.isConditionalExpression(n)) {
          out.push({
            condition: n.condition,
            whenTrue: n.whenTrue,
            whenFalse: n.whenFalse,
            pos: n,
          });
        }
        ts.forEachChild(n, visit);
      };
      visit(decl.initializer);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Certification: does THIS flip move THIS site, and what witnesses it
// ---------------------------------------------------------------------------

function certifyJsxSite(
  site: JsxSite,
  env: RenderEnv,
  flipped: RenderEnv,
  root: ts.Expression,
  sourceFile: ts.SourceFile,
): PredicateSiteInfo | undefined {
  const before = evaluate(site.condition, env);
  const after = evaluate(site.condition, flipped);
  if (before === undefined || after === undefined) return undefined;
  if (truthy(before) === truthy(after)) return undefined;

  const trueWitness = site.whenTrue ? harvestWitness(site.whenTrue, sourceFile) : undefined;
  const falseWitness = site.whenFalse ? harvestWitness(site.whenFalse, sourceFile) : undefined;
  // A pair where one witness contains the other cannot support absence
  // assertions — asserting "All invoices" absent while "My invoices" renders
  // is fine, but "invoices" vs "My invoices" is not.
  const pair =
    trueWitness !== undefined &&
    falseWitness !== undefined &&
    (trueWitness.includes(falseWitness) || falseWitness.includes(trueWitness))
      ? {}
      : { trueWitness, falseWitness };

  const reachableAtDefaults = reachability(site.node, root, env) === "yes";
  const reachableWhenFlipped = reachability(site.node, root, flipped) === "yes";
  if (!reachableAtDefaults && !reachableWhenFlipped) return undefined;
  return {
    baselineSide: truthy(before),
    ...(pair.trueWitness !== undefined ? { trueWitness: pair.trueWitness } : {}),
    ...(pair.falseWitness !== undefined ? { falseWitness: pair.falseWitness } : {}),
    reachableAtDefaults,
    reachableWhenFlipped,
    pos: posOf(site.pos, sourceFile),
  };
}

function certifyBodySite(
  site: BodySite,
  env: RenderEnv,
  flipped: RenderEnv,
  moduleImports: ModuleImportInfo[],
  sourceFile: ts.SourceFile,
): PredicateSiteInfo | undefined {
  const before = evaluate(site.condition, env);
  const after = evaluate(site.condition, flipped);
  if (before === undefined || after === undefined) return undefined;
  if (truthy(before) === truthy(after)) return undefined;

  const trueCallee = mockedCallee(site.whenTrue, moduleImports);
  const falseCallee = mockedCallee(site.whenFalse, moduleImports);
  if (trueCallee === undefined && falseCallee === undefined) return undefined;
  return {
    baselineSide: truthy(before),
    ...(trueCallee !== undefined ? { trueCallee } : {}),
    ...(falseCallee !== undefined ? { falseCallee } : {}),
    reachableAtDefaults: true,
    reachableWhenFlipped: true,
    pos: posOf(site.pos, sourceFile),
  };
}

/** The arm is a single call of a mocked import — a countable witness. */
function mockedCallee(arm: ts.Expression, moduleImports: ModuleImportInfo[]): string | undefined {
  const node = unwrap(arm);
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return undefined;
  const name = node.expression.text;
  const imported = moduleImports.some(
    (mi) => !mi.isTypeOnly && mi.kind === "value" && mi.names.includes(name),
  );
  return imported ? name : undefined;
}

/**
 * The longest text-position literal unconditional WITHIN the arm: JsxText, a
 * string in JSX-child expression position, or the arm itself being a bare
 * string. Nested conditionals and callbacks are someone else's site.
 */
function harvestWitness(arm: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  const node = unwrap(arm);
  const found: string[] = [];
  const note = (raw: string): void => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (text.length >= 3 && /\w/.test(text)) found.push(text);
  };
  if (ts.isStringLiteral(node)) note(node.text);
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isConditionalExpression(n)) return;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return;
    }
    if (ts.isJsxAttribute(n)) return;
    if (ts.isJsxText(n)) {
      note(n.text);
      return;
    }
    if (
      ts.isStringLiteral(n) &&
      n.parent &&
      ts.isJsxExpression(n.parent) &&
      n.parent.parent &&
      (ts.isJsxElement(n.parent.parent) || ts.isJsxFragment(n.parent.parent))
    ) {
      note(n.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  void sourceFile;
  if (found.length === 0) return undefined;
  return found.reduce((a, b) => (b.length > a.length ? b : a));
}

/** At least one leg can make a POSITIVE claim — pure absence is B-26's form. */
function assertable(sites: PredicateSiteInfo[]): boolean {
  return sites.some((s) => {
    if (s.trueCallee !== undefined || s.falseCallee !== undefined) return true;
    const flippedWitness = s.baselineSide ? s.falseWitness : s.trueWitness;
    const baselineWitness = s.baselineSide ? s.trueWitness : s.falseWitness;
    if (flippedWitness !== undefined && s.reachableWhenFlipped) return true;
    // Absence-only is allowed when the SAME witness is proven present in leg
    // one — the pair structure keeps it falsifiable.
    return baselineWitness !== undefined && s.reachableAtDefaults && s.reachableWhenFlipped;
  });
}

/**
 * Every variable whose VALUE can decide an exit guard — the direct condition
 * identifiers, closed backward through top-level initializers: with
 * `const mine = members.find(…)` and a guard on `mine`, flipping `members`
 * changes the guard's outcome just as surely, and an inverted mount that
 * guard-exits asserts absences over nothing. Guard if-statements are matched
 * by the position GuardInfo recorded.
 */
function guardTaintedVars(
  bodyNode: ts.Node,
  guards: GuardInfo[],
  sourceFile: ts.SourceFile,
): Set<string> {
  const guardPositions = new Set(guards.map((g) => `${g.pos.line}:${g.pos.column}`));
  const tainted = new Set<string>();
  const initializers = new Map<string, ts.Expression>();
  for (const stmt of bodyStatements(bodyNode)) {
    if (ts.isIfStatement(stmt)) {
      const p = posOf(stmt, sourceFile);
      if (guardPositions.has(`${p.line}:${p.column}`)) {
        for (const id of identifierLeaves(stmt.expression)) tainted.add(id);
      }
      continue;
    }
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (decl.initializer && ts.isIdentifier(decl.name)) {
        initializers.set(decl.name.text, decl.initializer);
      }
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, init] of initializers) {
      if (!tainted.has(name)) continue;
      for (const id of identifierLeaves(init)) {
        if (!tainted.has(id)) {
          tainted.add(id);
          grew = true;
        }
      }
    }
  }
  return tainted;
}

/** Call sites per bare-identifier callee, across the whole body. */
function countCallSites(bodyNode: ts.Node, sourceFile: ts.SourceFile): Map<string, number> {
  void sourceFile;
  const out = new Map<string, number>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      out.set(n.expression.text, (out.get(n.expression.text) ?? 0) + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(bodyNode);
  return out;
}
