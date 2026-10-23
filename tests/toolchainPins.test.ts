// The toolchain the GATE runs on has to be pinned, or the gate drifts under you.
//
// Builds #70 through #73 of this repo's pipeline all failed with tests passing
// and `0 fail`, on this:
//
//   biome.json:2:14 deserialize
//     The configuration schema version does not match the CLI version 2.5.10
//     Expected: 2.5.10   Found: 2.5.1
//
// package.json asked for `@biomejs/biome: "^2.3.13"`. The developer machine had
// resolved 2.5.1 months ago and kept it; CI resolved fresh every time and got
// whatever biome had published that week. `biome.json` names ONE schema version,
// so the two drift apart the moment upstream ships a minor — and the pipeline
// goes red on a commit that changed nothing about linting.
//
// It stayed red for four builds, which is why the Expo waves were merged to main
// and never published: the last artifact on the apps plane was from `e383338`,
// long behind.
//
// The Jenkinsfile says `bun install --frozen-lockfile` in both stages. That was
// a statement of intent with nothing behind it — `bun.lock` was in .gitignore
// from the initial commit, so there was no lockfile in the checkout to freeze
// and every CI build re-resolved from scratch.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

describe("the lint gate's toolchain is pinned", () => {
  test("biome.json's $schema names the exact version package.json installs", () => {
    // The pair biome itself compares. A mismatch is an ERROR-level diagnostic,
    // not a warning, so it fails `biome ci` outright.
    const schema = read("biome.json").match(/biomejs\.dev\/schemas\/([0-9]+\.[0-9]+\.[0-9]+)\//);
    expect(schema).not.toBeNull();

    const pkg = JSON.parse(read("package.json")) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const pin = pkg.devDependencies?.["@biomejs/biome"] ?? pkg.dependencies?.["@biomejs/biome"];
    expect(pin).toBeDefined();
    expect(`biome.json says ${schema?.[1]}, package.json says ${pin}`).toBe(
      `biome.json says ${schema?.[1]}, package.json says ${schema?.[1]}`,
    );
  });

  test("the biome pin is EXACT — a range is what let CI drift", () => {
    const pkg = JSON.parse(read("package.json")) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const pin = pkg.devDependencies?.["@biomejs/biome"] ?? pkg.dependencies?.["@biomejs/biome"];
    // ^, ~, x, *, >=, || — anything that can resolve to more than one version.
    // Upgrading biome is a deliberate act: bump both this and biome.json's
    // $schema together, and this test proves you did.
    expect(`pin=${pin}`).toMatch(/^pin=[0-9]+\.[0-9]+\.[0-9]+$/);
  });

  test("bun.lock is committed, so --frozen-lockfile has something to freeze", () => {
    // The Jenkinsfile runs `bun install --frozen-lockfile` in the Test stage and
    // again in Compile. With no lockfile in the checkout that flag is a no-op
    // that reads like a guarantee.
    expect(existsSync(path.join(ROOT, "bun.lock"))).toBe(true);
    expect(
      read(".gitignore")
        .split(/\r?\n/)
        .map((l) => l.trim()),
    ).not.toContain("bun.lock");
  });

  test("the lockfile actually carries the pinned biome", () => {
    // Committing the file is not enough — it has to be the CURRENT one. A stale
    // lockfile plus --frozen-lockfile fails the install instead of drifting,
    // which is louder, but still a red build for a reason nobody changed.
    const lock = read("bun.lock");
    const pkg = JSON.parse(read("package.json")) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const pin = pkg.dependencies?.["@biomejs/biome"] ?? pkg.devDependencies?.["@biomejs/biome"];
    expect(lock).toContain(`@biomejs/biome@${pin}`);
  });
});

describe("prose counts that name a number in the source", () => {
  test("every '<N> Biome rules' claim equals the rule set's real size", () => {
    // README, three skills and the probes doc all said 28. The set has 29, and
    // has since noLabelWithoutControl was added — wrong the day each was
    // written. A count in prose is a claim about code, so it is checked like one.
    const scan = readFileSync(path.join(ROOT, "src/tasks/a11yScan.ts"), "utf8");
    const body = scan.slice(scan.indexOf("a11y: {"), scan.indexOf("};", scan.indexOf("a11y: {")));
    const actual = (body.match(/^\s+(no|use)[A-Za-z]+: "/gm) ?? []).length;
    expect(actual).toBeGreaterThan(0);

    const files = [
      "README.md",
      "docs/archive/2026-08-expo-probes.md",
      ".agents/skills/flawless-react/SKILL.md",
      ".agents/skills/flawless-expo/SKILL.md",
      ".agents/skills/flawless-findings/SKILL.md",
    ];
    const wrong: string[] = [];
    for (const rel of files) {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      // "All 29 rules", "Biome's 29 rules", "All 29 of `a11yScan.ts`'s rules".
      for (const m of text.matchAll(/(\d+)\s+(?:Biome\s+)?(?:rules|of\s+`a11yScan)/g)) {
        if (Number(m[1]) !== actual) wrong.push(`${rel}: says ${m[1]}, set has ${actual}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
