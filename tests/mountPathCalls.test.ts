// The two questions the loaded-state test has to answer before it is fair:
// does mounting CALL this function, and does what it returns reach the screen?
//
// Both were answered "yes, always" until dogfood round 5, and eleven of the
// dogfood app's thirty-one screens failed on it. The failures were blamed in a
// comment on "an external store the harness does not reach"; that was a guess,
// and every real cause turned out to be visible right here in the AST.
import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  collectionRenderingCalls,
  componentNode,
  mountPathCalls,
  referencedNames,
} from "../src/analyse/mountPathCalls.ts";

const parse = (src: string): ts.SourceFile =>
  ts.createSourceFile("s.tsx", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);

const mount = (src: string): string[] => [...mountPathCalls(parse(src))].sort();
const rendered = (src: string): string[] => [...collectionRenderingCalls(parse(src)).keys()].sort();
const rowFields = (src: string, fn: string): string[] =>
  [...(collectionRenderingCalls(parse(src)).get(fn) ?? [])].sort();

describe("mountPathCalls", () => {
  test("a call inside a useEffect callback is on the mount path", () => {
    expect(mount(`function S(){ useEffect(() => { load(); }, []); }`)).toContain("load");
  });

  test("useFocusEffect counts — it is how every screen in the dogfood app loads", () => {
    expect(mount(`function S(){ useFocusEffect(useCallback(() => { load(); }, [])); }`)).toContain(
      "load",
    );
  });

  test("two hops: useFocusEffect → local useCallback → the api call", () => {
    // The exact shape of app/buildings/[id]/asha.tsx. A one-hop rule found none
    // of the real loaders, which is why this is a fixpoint.
    const calls = mount(`
      function S(){
        const init = useCallback(async () => { const { items } = await listMessages(id); }, [id]);
        useFocusEffect(useCallback(() => { init(); }, [init]));
      }`);
    expect(calls).toContain("listMessages");
  });

  test("a call from an event handler is NOT on the mount path", () => {
    // reportJob: a mutation the emitter was mocking as though mounting ran it.
    const calls = mount(`
      function S(){
        async function submit(){ const { job } = await reportJob(id, data); }
        return <Pressable onPress={submit} />;
      }`);
    expect(calls).not.toContain("reportJob");
  });

  test("a call inside a JSX attribute is NOT on the mount path", () => {
    expect(mount(`function S(){ return <Pressable onPress={() => remove(id)} />; }`)).not.toContain(
      "remove",
    );
  });

  test("a call behind an if is NOT on the mount path", () => {
    // listBuildingInvitations, behind `if (isTrustee)`.
    const calls = mount(`
      function S(){
        useEffect(() => {
          if (isTrustee) { const { items } = await listInvitations(id); }
        }, []);
      }`);
    expect(calls).not.toContain("listInvitations");
  });

  test("a call in a catch block is NOT on the mount path", () => {
    const calls = mount(`
      function S(){ useEffect(() => { try { a(); } catch (e) { reportError(e); } }, []); }`);
    expect(calls).toContain("a");
    expect(calls).not.toContain("reportError");
  });

  test("a call behind && is NOT on the mount path", () => {
    expect(mount(`function S(){ useEffect(() => { id && load(id); }, []); }`)).not.toContain(
      "load",
    );
  });

  test("a call in the component body IS a mount", () => {
    expect(mount(`function S(){ const x = compute(); return <View />; }`)).toContain("compute");
  });

  test("a call inside an unrelated nested function is not a mount", () => {
    expect(mount(`function S(){ const fmt = (v) => humanise(v); return <View />; }`)).not.toContain(
      "humanise",
    );
  });
});

describe("collectionRenderingCalls", () => {
  const LIST = `
    function S(){
      const [items, setItems] = useState([]);
      const load = useCallback(async () => {
        const { items: xs } = await listThings(id);
        setItems(xs);
      }, [id]);
      useFocusEffect(useCallback(() => { load(); }, [load]));
      return <View>{items.map((it) => (<Text key={it.id}>{it.title}</Text>))}</View>;
    }`;

  test("a collection whose state variable is mapped in JSX qualifies", () => {
    expect(rendered(LIST)).toContain("listThings");
  });

  test("the row's fields come from the map callback, not the file", () => {
    // `label` is rendered elsewhere in the real finance screen and was chosen as
    // the witness for an invoice row that renders invoice_number and due_date.
    expect(rowFields(LIST, "listThings")).toEqual(["title"]);
  });

  test("an attribute value is not a rendered field", () => {
    // `key={it.id}` and an onPress reading it.id must not become the witness —
    // it is a string the screen never displays.
    expect(rowFields(LIST, "listThings")).not.toContain("id");
  });

  test("a collection read for a boolean does NOT qualify", () => {
    // getMeWithMemberships on five real screens: on the mount path, returns a
    // collection, and decides a permission flag. Mocking it changes a boolean.
    const src = `
      function S(){
        const [me, setMe] = useState(null);
        useEffect(() => { const m = await getMe(); setMe(m); }, []);
        const isTrustee = me?.memberships.some((x) => ROLES.includes(x.role));
        return <View>{isTrustee ? <Admin /> : null}</View>;
      }`;
    expect(rendered(src)).not.toContain("getMe");
  });

  test("Promise.all binds positionally, and each producer is tracked", () => {
    const src = `
      function S(){
        const [comments, setComments] = useState([]);
        useEffect(() => {
          const [{ poll: p }, { items: cs }] = await Promise.all([getPoll(id), listComments(id)]);
          setComments(cs);
        }, []);
        return <View>{comments.map((c) => (<Text key={c.id}>{c.body}</Text>))}</View>;
      }`;
    expect(rendered(src)).toEqual(["listComments"]);
    expect(rowFields(src, "listComments")).toEqual(["body"]);
  });

  test("a template literal child counts as rendered text", () => {
    const src = `
      function S(){
        const [rows, setRows] = useState([]);
        useEffect(() => { const { items } = await listRows(); setRows(items); }, []);
        return <View>{rows.map((r) => (<Text>{\`Due \${r.due_date}\`}</Text>))}</View>;
      }`;
    expect(rowFields(src, "listRows")).toEqual(["due_date"]);
  });

  test("a .map outside JSX is not a render", () => {
    const src = `
      function S(){
        const [rows, setRows] = useState([]);
        useEffect(() => { const { items } = await listRows(); setRows(items); }, []);
        const ids = rows.map((r) => r.id);
        return <View><Text>{ids.length}</Text></View>;
      }`;
    expect(rendered(src)).not.toContain("listRows");
  });

  test("a FlatList data= binding qualifies, with no row fields claimed", () => {
    // renderItem is not read here, so the caller falls back to its own evidence
    // rather than being handed a wrong witness.
    const src = `
      function S(){
        const [rows, setRows] = useState([]);
        useEffect(() => { const { items } = await listRows(); setRows(items); }, []);
        return <FlatList data={rows} renderItem={({ item }) => <Text>{item.title}</Text>} />;
      }`;
    expect(rendered(src)).toEqual(["listRows"]);
    expect(rowFields(src, "listRows")).toEqual([]);
  });
});

describe("the classifiers are scoped to a component, not to its file", () => {
  const TWINS = `
    import { listItems } from "../lib/api";
    export function Loader() {
      const [rows, setRows] = useState([]);
      useEffect(() => { const { items } = await listItems(); setRows(items); }, []);
      return <View>{rows.map((r) => (<Text key={r.id}>{r.name}</Text>))}</View>;
    }
    export function Bystander() {
      return <View><Text>nothing here</Text></View>;
    }`;

  test("componentNode finds a function declaration by name", () => {
    const sf = parse(TWINS);
    const node = componentNode(sf, "Bystander");
    expect(node).not.toBe(sf);
    expect(ts.isFunctionDeclaration(node)).toBe(true);
  });

  test("the loader's own subtree still yields its evidence", () => {
    const sf = parse(TWINS);
    const scope = componentNode(sf, "Loader");
    expect([...mountPathCalls(scope)]).toContain("listItems");
    expect([...collectionRenderingCalls(scope).keys()]).toContain("listItems");
  });

  test("the sibling's subtree yields NOTHING — the defect this fixes", () => {
    // File-scoped, both of these came back holding listItems, and the emitter
    // then told Bystander why its sibling's dependency did not qualify.
    const sf = parse(TWINS);
    const scope = componentNode(sf, "Bystander");
    expect([...mountPathCalls(scope)]).toEqual([]);
    expect([...collectionRenderingCalls(scope).keys()]).toEqual([]);
  });

  test("referencedNames keeps a component's own names apart from the file's", () => {
    const sf = parse(TWINS);
    expect(referencedNames(componentNode(sf, "Loader")).has("listItems")).toBe(true);
    expect(referencedNames(componentNode(sf, "Bystander")).has("listItems")).toBe(false);
  });

  test("an unlocatable name falls back to the file rather than claiming nothing", () => {
    const sf = parse(TWINS);
    expect(componentNode(sf, "NoSuchComponent")).toBe(sf);
  });
});
