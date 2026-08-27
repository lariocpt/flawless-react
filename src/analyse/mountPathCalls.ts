import ts from "typescript";

/**
 * The imported functions this component calls ON MOUNT, unconditionally.
 *
 * The loaded-state test mocks one function to return a row and asserts the row
 * appears. That is only a fair test if mounting the component actually CALLS
 * that function — and for eleven of the dogfood app's screens it did not, so the
 * test failed for a reason that was neither the app's nor the tool's:
 *
 *   reportJob                 a mutation, called from a submit handler
 *   listBuildingInvitations   inside `if (isTrustee) { … }`
 *   listTicketUpdatesMobile   behind a guard on the loaded parent record
 *
 * An earlier note in this repo blamed "an external store the harness does not
 * reach". That was a guess, and it was wrong. The cause is visible in the AST:
 * the emitter was choosing any imported function whose return type contains a
 * collection, with no evidence that mounting reaches it.
 *
 * "Mount path" means: reachable from a `useEffect` / `useLayoutEffect` /
 * `useFocusEffect` callback, or evaluated directly in the component body — and
 * NOT inside a branch, a catch, or a JSX event handler.
 *
 * Reachability is a fixpoint over LOCAL functions, not a fixed number of hops,
 * because the real screens are two deep and a one-hop rule found none of them:
 *
 *   const init = useCallback(async () => { … listAshaMessages(…) … }, [id]);
 *   useFocusEffect(useCallback(() => { init(); }, [init]));
 *
 * It never leaves the file. A call into an imported helper is not followed, so a
 * loader hidden behind one is missed — and a miss costs a skip, while a wrong
 * answer costs a red test on a healthy component. It errs toward the skip.
 */
export function mountPathCalls(sf: ts.SourceFile): Set<string> {
  // Every unconditional call in the file, with the local name whose body holds
  // it. Collected once; the fixpoint below only re-reads this list.
  const sites: { callee: string; owner: string | undefined; underEffect: boolean }[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && !isConditional(n)) {
      sites.push({
        callee: n.expression.text,
        owner: owningLocalName(n),
        underEffect: underEffectHook(n) || inComponentBody(n),
      });
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);

  // Seed with what an effect hook evaluates directly, then keep adding the
  // bodies of local functions those calls name, until nothing new appears.
  // Bounded by the number of distinct local names, so it always terminates.
  const reached = new Set<string>();
  for (const s of sites) {
    if (s.underEffect) reached.add(s.callee);
  }
  for (;;) {
    const before = reached.size;
    for (const s of sites) {
      if (s.owner !== undefined && reached.has(s.owner)) reached.add(s.callee);
    }
    if (reached.size === before) break;
  }
  return reached;
}

/**
 * The local name whose body contains this call — `init` for a call inside
 * `const init = useCallback(async () => { … })`, or inside `function init()`.
 *
 * The useCallback wrapper is transparent on purpose: it is how every one of the
 * dogfood app's loaders is written, and treating it as an opaque function put
 * every loader out of reach.
 */
function owningLocalName(n: ts.Node): string | undefined {
  const fn = enclosingFunction(n);
  if (!fn) return undefined;
  let up: ts.Node | undefined = fn.parent;
  // Through useCallback/useMemo and any other single-argument wrapper call.
  while (up && ts.isCallExpression(up)) up = up.parent;
  if (up && ts.isVariableDeclaration(up) && ts.isIdentifier(up.name)) return up.name.text;
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  return undefined;
}

function isEffectHook(e: ts.Expression): boolean {
  const name = ts.isIdentifier(e)
    ? e.text
    : ts.isPropertyAccessExpression(e)
      ? e.name.text
      : undefined;
  return name === "useEffect" || name === "useLayoutEffect" || name === "useFocusEffect";
}

/**
 * Whether this call runs on an unconditional mount.
 *
 * Walks to the source file rather than stopping at the first function, because
 * the enclosing chain is the whole question: a call inside a `useCallback`
 * inside a `useFocusEffect` is on the mount path, and the same call inside an
 * `onPress={…}` is not.
 */
function isConditional(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  for (;;) {
    const parent: ts.Node | undefined = node.parent;
    if (!parent) return false;
    // A branch anywhere above disqualifies it — the mock returns a row, the
    // guard is false, and nothing renders. That is `if (isTrustee)`, exactly.
    if (ts.isIfStatement(parent) && parent.expression !== node) return true;
    if (ts.isConditionalExpression(parent) && parent.condition !== node) return true;
    if (ts.isCatchClause(parent)) return true;
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
      parent.right === node
    ) {
      return true;
    }
    // A JSX attribute value is an event handler, not a mount.
    if (ts.isJsxAttribute(parent) || ts.isJsxExpression(parent)) return true;
    node = parent;
  }
}

function underEffectHook(call: ts.CallExpression): boolean {
  let node: ts.Node | undefined = call.parent;
  while (node) {
    if (ts.isCallExpression(node) && isEffectHook(node.expression)) return true;
    node = node.parent;
  }
  return false;
}

/**
 * The call sits directly in a top-level function's body.
 *
 * "Top-level" meaning the nearest enclosing function is not itself inside
 * another function — i.e. it is the component, not a callback within it. A bare
 * `hasEnclosingFunction` check would be false for every call in a component,
 * since the component IS a function, making the clause unreachable.
 */
function inComponentBody(n: ts.Node): boolean {
  const nearest = enclosingFunction(n);
  if (!nearest) return true;
  return enclosingFunction(nearest) === undefined;
}

function enclosingFunction(n: ts.Node): ts.Node | undefined {
  let node: ts.Node | undefined = n.parent;
  while (node) {
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return node;
    }
    node = node.parent;
  }
  return undefined;
}

/**
 * The imported functions whose returned collection is RENDERED as a list.
 *
 * The mount-path filter answers "is this function called?". This answers the
 * other half — "does what it returns reach the screen?" — and without it the
 * loaded-state test picked `getMeWithMemberships` on five screens. That call is
 * on the mount path, its return type does contain a collection (`memberships`),
 * and every one of the five uses it to decide a permission flag:
 *
 *   const isTrustee = me.memberships.some((m) => TRUSTEE_ROLES.includes(m.role));
 *
 * A mock returning a row changes a boolean. Nothing renders, and the test failed
 * looking for text no screen was ever going to show.
 *
 * The chain, entirely within the file: a call's result is destructured to a
 * local, the local is passed to a `useState` setter, and that setter's state
 * variable is mapped in JSX or handed to a list as `data`. Anything else is not
 * claimed.
 *
 * Returns the ROW FIELDS each qualifying function's list renders as text, not
 * just the function names, because the witness has to come from the row that
 * maps THIS collection. Taken file-wide it picked `label` for a screen whose
 * invoice row renders `invoice_number` and `due_date` — the field is rendered
 * somewhere in the file, by a different element, over different data.
 */
export function collectionRenderingCalls(sf: ts.SourceFile): Map<string, Set<string>> {
  const stateOfSetter = new Map<string, string>();
  /** state variable → the fields its row renders as text. */
  const renderedLists = new Map<string, Set<string>>();
  const boundFrom = new Map<string, string>();

  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) {
      // const [items, setItems] = useState(…)
      if (
        n.name &&
        ts.isArrayBindingPattern(n.name) &&
        n.initializer &&
        ts.isCallExpression(n.initializer) &&
        calleeName(n.initializer.expression) === "useState"
      ) {
        const [a, b] = n.name.elements;
        if (
          a &&
          ts.isBindingElement(a) &&
          ts.isIdentifier(a.name) &&
          b &&
          ts.isBindingElement(b) &&
          ts.isIdentifier(b.name)
        ) {
          stateOfSetter.set(b.name.text, a.name.text);
        }
      } else {
        recordBindings(n, boundFrom);
      }
    }
    // items.map(…) — only inside JSX, so a `.map` used to compute a value is
    // not mistaken for a render.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "map" &&
      ts.isIdentifier(n.expression.expression) &&
      insideJsx(n)
    ) {
      renderedLists.set(n.expression.expression.text, rowTextFields(n));
    }
    // <FlatList data={items} /> and its SectionList peer.
    if (
      ts.isJsxAttribute(n) &&
      ts.isIdentifier(n.name) &&
      (n.name.text === "data" || n.name.text === "sections") &&
      n.initializer &&
      ts.isJsxExpression(n.initializer) &&
      n.initializer.expression &&
      ts.isIdentifier(n.initializer.expression)
    ) {
      // A FlatList renders through renderItem, whose text fields this does not
      // read — an empty set, so the caller falls back to its own evidence
      // rather than being handed a wrong answer.
      const name = n.initializer.expression.text;
      if (!renderedLists.has(name)) renderedLists.set(name, new Set<string>());
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);

  const out = new Map<string, Set<string>>();
  const walkSetters = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const state = stateOfSetter.get(n.expression.text);
      const arg = n.arguments[0];
      const fields = state === undefined ? undefined : renderedLists.get(state);
      if (fields !== undefined && arg && ts.isIdentifier(arg)) {
        const origin = boundFrom.get(arg.text);
        if (origin !== undefined) out.set(origin, fields);
      }
    }
    ts.forEachChild(n, walkSetters);
  };
  walkSetters(sf);
  return out;
}

/**
 * The row's own text fields: `inv` members that a `.map((inv) => …)` callback
 * renders as JSX CHILDREN.
 *
 * Children only, and only where the access is the whole child expression or a
 * span of a template literal that is. `key={inv.id}` and
 * `onPress={() => router.push(`…${inv.id}`)}` are attribute values — a witness
 * taken from either would be a string the screen never displays.
 */
function rowTextFields(map: ts.CallExpression): Set<string> {
  const out = new Set<string>();
  const cb = map.arguments[0];
  if (!cb || (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))) return out;
  const p = cb.parameters[0];
  if (!p || !ts.isIdentifier(p.name)) return out;
  const row = p.name.text;

  const record = (e: ts.Expression): void => {
    if (
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === row
    ) {
      out.add(e.name.text);
    }
  };
  const walk = (n: ts.Node): void => {
    if (
      ts.isJsxExpression(n) &&
      n.expression &&
      n.parent &&
      (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
    ) {
      const e = n.expression;
      record(e);
      if (ts.isTemplateExpression(e)) {
        for (const span of e.templateSpans) record(span.expression);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(cb.body);
  return out;
}

/**
 * Locals bound from a call's result, mapped to the function that produced it.
 *
 * Two shapes, both of which the dogfood app uses:
 *   const { items } = await listBuildings(id);
 *   const [{ poll: p }, { items: cs }] = await Promise.all([getPoll(…), listPollComments(…)]);
 *
 * The Promise.all form is positional — binding element i comes from array
 * element i — which is why it is matched by index rather than by name.
 */
function recordBindings(decl: ts.VariableDeclaration, out: Map<string, string>): void {
  const init = decl.initializer;
  if (!init) return;
  const inner = ts.isAwaitExpression(init) ? init.expression : init;
  if (!ts.isCallExpression(inner)) return;

  if (calleeName(inner.expression) === "Promise.all") {
    const arr = inner.arguments[0];
    if (!arr || !ts.isArrayLiteralExpression(arr)) return;
    if (!ts.isArrayBindingPattern(decl.name)) return;
    decl.name.elements.forEach((el, i) => {
      const producer = arr.elements[i];
      if (!producer || !ts.isCallExpression(producer)) return;
      const fn = calleeName(producer.expression);
      if (!fn || !ts.isBindingElement(el)) return;
      for (const name of bindingNames(el.name)) out.set(name, fn);
    });
    return;
  }
  const fn = calleeName(inner.expression);
  if (!fn) return;
  for (const name of bindingNames(decl.name)) out.set(name, fn);
}

function bindingNames(n: ts.BindingName): string[] {
  if (ts.isIdentifier(n)) return [n.text];
  const out: string[] = [];
  for (const el of n.elements) {
    if (ts.isBindingElement(el)) out.push(...bindingNames(el.name));
  }
  return out;
}

function calleeName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    return `${e.expression.text}.${e.name.text}`;
  }
  return undefined;
}

function insideJsx(n: ts.Node): boolean {
  let node: ts.Node | undefined = n.parent;
  while (node) {
    if (ts.isJsxExpression(node)) return true;
    node = node.parent;
  }
  return false;
}
