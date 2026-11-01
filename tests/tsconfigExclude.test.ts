import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addExcludeEntry, ensureSuiteExcluded } from "../src/tsconfigJson.ts";

/**
 * Chunk 2 (DOGFOOD-0.3.1-FIX-PLAN.md, defect #2): the generator writes files
 * into the project and must not break the project's own type-check. The merge
 * lives in src/tsconfigJson.ts; these are the plan's cases (a)–(g) plus the
 * boundary answers the design question needs: no tsconfig at all, a suite
 * outside every include, and the monorepo choice of WHICH config is edited.
 */

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "flawless-tsconfig-"));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  // The suite dir itself must exist for the merge to consider the project.
  mkdirSync(path.join(root, "flawless"), { recursive: true });
  return root;
}

function read(root: string, ...rel: string[]): string {
  return readFileSync(path.join(root, ...rel), "utf8");
}

// ---------------------------------------------------------------------------
// addExcludeEntry — the text-level merge
// ---------------------------------------------------------------------------

test("(a) exclude: [node_modules] gains the entry with the file's formatting preserved", () => {
  const source = `{
	"compilerOptions": {
		"strict": true
	},
	"include": ["**/*.ts", "**/*.tsx"],
	"exclude": ["node_modules"]
}
`;
  const { text, changed } = addExcludeEntry(source, "flawless");
  expect(changed).toBe(true);
  expect(text).toContain('"exclude": ["node_modules", "flawless"]');
  // Nothing else moved: tabs, key order, every other byte.
  expect(text).toBe(
    source.replace('"exclude": ["node_modules"]', '"exclude": ["node_modules", "flawless"]'),
  );
});

test("(b) already present → byte-identical", () => {
  const source = `{
  "exclude": ["node_modules", "flawless"]
}
`;
  const { text, changed } = addExcludeEntry(source, "flawless");
  expect(changed).toBe(false);
  expect(text).toBe(source);
});

test("(c) no exclude key → key added, everything else untouched", () => {
  const source = `{
  "compilerOptions": {
    "strict": true
  },
  "include": ["src"]
}
`;
  const { text, changed } = addExcludeEntry(source, "flawless");
  expect(changed).toBe(true);
  expect(text).toContain('"exclude": ["flawless"]');
  expect(text).toContain('"include": ["src"]');
  expect(text).toContain('"strict": true');
});

test("(c2) no exclude key, trailing comma → no double comma", () => {
  const source = `{
  "include": ["src"],
}
`;
  const { text, changed } = addExcludeEntry(source, "flawless");
  expect(changed).toBe(true);
  expect(text).toContain('"include": ["src"],\n  "exclude": ["flawless"]');
});

test("(c3) empty object → valid file with the key", () => {
  const { text, changed } = addExcludeEntry("{}", "flawless");
  expect(changed).toBe(true);
  expect(JSON.parse(text)).toEqual({ exclude: ["flawless"] });
});

test("(d) JSONC with comments → comments survive", () => {
  const source = `{
  // the app's own compiler settings
  "compilerOptions": {
    "jsx": "preserve", // Next's own
  },
  "exclude": [
    "node_modules", // deps are not ours
  ]
}
`;
  const { text, changed } = addExcludeEntry(source, "flawless");
  expect(changed).toBe(true);
  expect(text).toContain("// the app's own compiler settings");
  expect(text).toContain("// Next's own");
  expect(text).toContain("// deps are not ours");
  // Multi-line array: the entry joins on its own line at the last entry's
  // indent. A trailing line comment on the last entry keeps its bytes but
  // ends up trailing the new entry — the alternative (inserting before the
  // comment's line) would need to model comment attachment for a shape that
  // is rare in the wild; the file stays valid and every byte survives.
  expect(text).toContain('"node_modules",\n    "flawless", // deps are not ours');
  expect(JSON.parse(text.replace(/\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")).exclude).toEqual([
    "node_modules",
    "flawless",
  ]);
});

test("comments and strings cannot fake the exclude key", () => {
  const source = `{
  "compilerOptions": {
    "outDir": "exclude" // not the key
  },
  /* "exclude": ["trap"] */
  "include": ["src"]
}
`;
  const { text, changed } = addExcludeEntry(source, "flawless");
  expect(changed).toBe(true);
  // The added key is the top-level one: strip the comments and the parsed
  // exclude is exactly the new entry — the string value and the commented
  // fake never became the array.
  const stripped = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(JSON.parse(stripped).exclude).toEqual(["flawless"]);
  expect(text).toContain('/* "exclude": ["trap"] */');
  expect(text).toContain('"outDir": "exclude" // not the key');
});

test("an exclude that is not an array is left alone", () => {
  const source = `{
  "exclude": "node_modules"
}
`;
  const { text, changed } = addExcludeEntry(source, "flawless");
  expect(changed).toBe(false);
  expect(text).toBe(source);
});

// ---------------------------------------------------------------------------
// ensureSuiteExcluded — which config gets the edit, and when none does
// ---------------------------------------------------------------------------

test("(e) a second run reports kept and writes nothing — byte-identical", () => {
  const root = project({
    "package.json": `{ "name": "app" }`,
    "tsconfig.json": `{
  "exclude": ["node_modules"]
}
`,
  });
  const first = ensureSuiteExcluded(path.join(root, "flawless"));
  expect(first?.status).toBe("added");
  expect(first?.entry).toBe("flawless");
  const after = read(root, "tsconfig.json");
  const second = ensureSuiteExcluded(path.join(root, "flawless"));
  expect(second?.status).toBe("kept");
  expect(read(root, "tsconfig.json")).toBe(after);
});

test("(f) extends already excluding → kept, no duplicate in the child", () => {
  const root = project({
    "package.json": `{ "name": "app" }`,
    "tsconfig.base.json": `{
  "exclude": ["flawless"]
}
`,
    "tsconfig.json": `{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "strict": true }
}
`,
  });
  const edit = ensureSuiteExcluded(path.join(root, "flawless"));
  expect(edit?.status).toBe("kept");
  // The child file was not touched at all — the effective exclude already
  // covers the suite, and a second entry would be a duplicate a reviewer
  // rightly objects to.
  expect(read(root, "tsconfig.json")).not.toContain("exclude");
});

test("(f2) inherited exclude patterns anchor to the declaring config's dir", () => {
  // apps/web extends ../../tsconfig.base.json; the base's exclude names
  // `flawless` relative to the REPO ROOT, so apps/web/flawless is NOT
  // covered and the app's own config must get the entry.
  const root = mkdtempSync(path.join(os.tmpdir(), "flawless-tsconfig-anchor-"));
  tmpDirs.push(root);
  mkdirSync(path.join(root, "apps", "web", "flawless"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), `{ "name": "mono" }`);
  writeFileSync(path.join(root, "tsconfig.base.json"), `{ "exclude": ["flawless"] }\n`);
  writeFileSync(
    path.join(root, "apps", "web", "tsconfig.json"),
    `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "strict": true }
}
`,
  );
  const edit = ensureSuiteExcluded(path.join(root, "apps", "web", "flawless"));
  expect(edit?.status).toBe("added");
  expect(edit?.file).toBe(path.join(root, "apps", "web", "tsconfig.json"));
  expect(read(root, "apps", "web", "tsconfig.json")).toContain('"exclude": ["flawless"]');
});

test("(g) monorepo: the config beside the suite is edited, the sibling untouched", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "flawless-tsconfig-mono-"));
  tmpDirs.push(root);
  mkdirSync(path.join(root, "apps", "web", "flawless"), { recursive: true });
  mkdirSync(path.join(root, "apps", "mobile"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), `{ "name": "mono" }`);
  const web = `{
  "compilerOptions": { "jsx": "preserve" },
  "exclude": ["node_modules"]
}
`;
  const mobile = `{
  "compilerOptions": { "jsx": "react-native" },
  "exclude": ["node_modules"]
}
`;
  writeFileSync(path.join(root, "apps", "web", "tsconfig.json"), web);
  writeFileSync(path.join(root, "apps", "mobile", "tsconfig.json"), mobile);
  const edit = ensureSuiteExcluded(path.join(root, "apps", "web", "flawless"));
  expect(edit?.file).toBe(path.join(root, "apps", "web", "tsconfig.json"));
  expect(edit?.entry).toBe("flawless");
  expect(read(root, "apps", "web", "tsconfig.json")).toContain(
    '"exclude": ["node_modules", "flawless"]',
  );
  // The mobile app's program never sees the web suite — its config must not
  // gain a phantom entry.
  expect(read(root, "apps", "mobile", "tsconfig.json")).toBe(mobile);
});

test("no tsconfig at all → no edit, nothing created", () => {
  const root = project({ "package.json": `{ "name": "app" }` });
  expect(ensureSuiteExcluded(path.join(root, "flawless"))).toBeUndefined();
  expect(readFileSync(path.join(root, "package.json"), "utf8")).toBe(`{ "name": "app" }`);
  // No tsconfig.json was conjured into the project.
  expect(() => readFileSync(path.join(root, "tsconfig.json"), "utf8")).toThrow();
});

test("suite outside the config's include → no edit (the entry would be noise)", () => {
  const root = project({
    "package.json": `{ "name": "app" }`,
    "tsconfig.json": `{
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
`,
  });
  expect(ensureSuiteExcluded(path.join(root, "flawless"))).toBeUndefined();
  expect(read(root, "tsconfig.json")).not.toContain("flawless");
});

test("a higher config whose include does reach the suite gets the relative entry", () => {
  // apps/web has no tsconfig; the repo-root one (default include = everything)
  // is the program that breaks, so it is the one edited — with the entry
  // spelled from its own dir.
  const root = mkdtempSync(path.join(os.tmpdir(), "flawless-tsconfig-up-"));
  tmpDirs.push(root);
  mkdirSync(path.join(root, "apps", "web", "flawless"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), `{ "name": "mono" }`);
  writeFileSync(path.join(root, "tsconfig.json"), `{ "exclude": ["node_modules"] }\n`);
  const edit = ensureSuiteExcluded(path.join(root, "apps", "web", "flawless"));
  expect(edit?.file).toBe(path.join(root, "tsconfig.json"));
  expect(edit?.entry).toBe("apps/web/flawless");
  expect(read(root, "tsconfig.json")).toContain('"node_modules", "apps/web/flawless"');
});

test("an unparseable tsconfig is never rewritten", () => {
  const root = project({
    "package.json": `{ "name": "app" }`,
    "tsconfig.json": `{ this is not json at all`,
  });
  expect(ensureSuiteExcluded(path.join(root, "flawless"))).toBeUndefined();
  expect(read(root, "tsconfig.json")).toBe(`{ this is not json at all`);
});

test("a missing suite dir means there is nothing to exclude", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "flawless-tsconfig-nosuite-"));
  tmpDirs.push(root);
  writeFileSync(path.join(root, "package.json"), `{ "name": "app" }`);
  writeFileSync(path.join(root, "tsconfig.json"), `{ "exclude": ["node_modules"] }\n`);
  expect(ensureSuiteExcluded(path.join(root, "flawless"))).toBeUndefined();
  expect(read(root, "tsconfig.json")).toBe(`{ "exclude": ["node_modules"] }\n`);
});
