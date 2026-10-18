// The shipped prose, checked against the code it describes.
//
// Until this file existed, nothing in tests/ opened README.md, docs/** or
// .agents/skills/**. The greps that looked like they did were about the READMEs
// the tool WRITES into flawless/e2e/ and flawless/load/. So every claim this
// project makes about itself was unguarded, and round 8 found what that costs
// in a single reading pass: a skill documenting a throw the tool never emits, a
// wrong exit-code table, a --ci field list two fields stale.
//
// The sibling project crust solved this with tests/docs-lint.test.ts; this is
// that harness, retargeted. Parsing is pure — parseArgs opens no file and spawns
// nothing — so an example naming ./src/Dashboard.tsx checks clean here.
//
// What this file does NOT check, deliberately:
//   * `bun run <script>` names. Prose carries three kinds — this repo's, the
//     GENERATED suite's, and the dogfood app's — and only an allowlist could
//     separate them, which would rot faster than the claims it guarded.
//   * Free-prose flags belonging to other tools. Those are enumerated in
//     FOREIGN_FLAGS below, which fails loudly when a new one appears rather
//     than waving unknown flags through.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkLines } from "../src/cli.ts";
import { FLAG_NAMES, FLAGS, MAINTENANCE_FLAGS } from "../src/cliFlags.ts";
import { SKILL_FLAGS } from "../src/skills/spec.ts";
import { ALL_TASK_IDS } from "../src/tasks/index.ts";
import {
  commandLines,
  proseFiles,
  REPO_ROOT,
  readProse,
  websiteProseFiles,
} from "./helpers/docs.ts";

// Corpus for every "named in prose" inventory: this repo's shipped prose plus
// the sibling website checkout when present (see websiteProseFiles).
const corpus = (): string[] => [...proseFiles(), ...websiteProseFiles()];

// ---------------------------------------------------------------------------
// A — every documented invocation parses
// ---------------------------------------------------------------------------

// Minimums are canaries. Without them a broken extractor makes this file pass
// by checking nothing at all, which is the failure mode the whole suite exists
// to refuse. Set just under today's real counts.
const MIN_INVOCATIONS: Record<string, number> = {
  "README.md": 10,
  "docs/extending.md": 1,
  ".agents/skills/flawless-react/SKILL.md": 2,
  ".agents/skills/flawless-regen/SKILL.md": 1,
  ".agents/skills/flawless-nextjs/SKILL.md": 1,
  ".agents/skills/flawless-perf-harness/SKILL.md": 1,
  ".agents/skills/flawless-perf-static/SKILL.md": 1,
  ".agents/skills/flawless-a11y/SKILL.md": 1,
  ".agents/skills/flawless-react-rules/SKILL.md": 1,
  ".agents/skills/flawless-findings/SKILL.md": 1,
  ".agents/skills/flawless-e2e/SKILL.md": 1,
  ".agents/skills/flawless-load/SKILL.md": 1,
  ".agents/skills/flawless-api-fixtures/SKILL.md": 1,
};

describe("documented invocations parse against the live CLI", () => {
  test.each([...proseFiles(), ...websiteProseFiles()])("%s", async (rel) => {
    const report = checkLines(commandLines(await readProse(rel)).join("\n"));
    expect(report.problems.map((p) => `${p.line}\n    ${p.problem}`).join("\n")).toBe("");
    expect(report.checked).toBeGreaterThanOrEqual(MIN_INVOCATIONS[rel] ?? 0);
  });

  // The website corpus is optional input (see websiteProseFiles), so its
  // canary is conditional — but when the checkout is here, 66+ invocations
  // live in its 27 pages and a fall to 40 means the extractor broke.
  test("the website corpus contributes real invocations when present", async () => {
    const files = websiteProseFiles();
    if (files.length === 0) return;
    let total = 0;
    for (const rel of files)
      total += checkLines(commandLines(await readProse(rel)).join("\n")).checked;
    expect(total).toBeGreaterThanOrEqual(40);
  });

  test("the corpus as a whole is not empty", async () => {
    let total = 0;
    for (const rel of proseFiles()) {
      total += checkLines(commandLines(await readProse(rel)).join("\n")).checked;
    }
    expect(total).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// B — the flag inventory and the prose agree, in both directions
// ---------------------------------------------------------------------------

/**
 * Flags the docs mention that belong to OTHER tools.
 *
 * Listed rather than pattern-matched: an unlisted unknown flag is either a
 * flawless flag that no longer exists or a new foreign one, and both deserve a
 * human look. The cost of the list is one line when a doc starts mentioning a
 * new tool; the cost of not having it is that `--forse` reads as prose.
 */
const FOREIGN_FLAGS: Record<string, string> = {
  "--compile": "bun build",
  "--config": "playwright/vitest",
  "--env-file": "node/bun runtime",
  // Not a tool at all: the reference's "every flag that takes a value accepts
  // both `--flag value` and `--flag=value`" sentence, where --flag is a
  // metavariable standing in for whatever flag is being described.
  "--flag": "documentation placeholder",
  "--grep": "playwright/vitest",
  "--headed": "playwright test",
  "--localstorage-file": "playwright",
  "--no-errors-on-unmatched": "biome check",
  "--porcelain": "git status",
  "--preload": "bun test",
  "--port": "crust mock-server",
  "--project": "playwright test",
  "--proxy": "crust mock-server",
  "--root": "vitest run",
  "--swagger": "crust mock-server",
  "--registry": "bun add",
  "--timeout": "crust load pipe",
  "--web": "expo start",
  "--with-deps": "playwright install",
};

/** Inline `code` spans, with fenced blocks removed (those are checked by A). */
function inlineCode(markdown: string): string[] {
  const prose = markdown.replace(/```[a-z]*\n[\s\S]*?```/g, "");
  return [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
}

describe("flag inventory", () => {
  test("every flag named in prose is real, or a listed foreign flag", async () => {
    // All three surfaces: the run options, the parse-only maintenance flags that
    // deliberately sit outside them (see MAINTENANCE_FLAGS' comment), and the
    // flags of the `skills` subcommand — a prose mention of `--select` is a
    // promise about `skills install`, not about a run.
    const known = new Set([
      ...FLAG_NAMES,
      ...MAINTENANCE_FLAGS.map((f) => f.name),
      ...SKILL_FLAGS.map((f) => f.name),
    ]);
    const unknown = new Set<string>();
    for (const rel of corpus()) {
      for (const span of inlineCode(await readProse(rel))) {
        for (const flag of span.match(/--[a-z][a-z-]*[a-z]/g) ?? []) {
          if (!known.has(flag) && FOREIGN_FLAGS[flag] === undefined)
            unknown.add(`${flag} (${rel})`);
        }
      }
    }
    expect([...unknown].join("\n")).toBe("");
  });

  // The direction that actually bit: the website's CLI page called itself
  // "every flag flawless-react accepts" while --roots, --exclude and
  // --no-default-excludes went unmentioned for a whole release. A reference
  // table that silently omits a flag is worse than no table.
  test("README's CLI reference documents every flag", async () => {
    // The TABLE, not the whole file: a flag mentioned once in a paragraph is
    // not documented in the reference, and the reference is what a reader
    // scans to find out what exists.
    const rows = (await readProse("README.md"))
      .split("\n")
      .filter((l) => l.startsWith("| `-"))
      .join("\n");
    const missing = FLAG_NAMES.filter((f) => !new RegExp(`(?<![\\w-])${f}(?![\\w-])`).test(rows));
    expect(missing.join(", ")).toBe("");
  });

  test("the help text and the inventory cannot drift apart", () => {
    // Every long flag literal parseArgs branches on must be in FLAGS. This is
    // the direction a round-trip cannot cover: a flag added to the parser and
    // not to the table would simply never be documented, and nothing else looks.
    const src = Bun.file(path.join(REPO_ROOT, "src", "cli.ts"));
    return src.text().then((text) => {
      const branched = new Set<string>();
      for (const m of text.matchAll(
        /a === "(--[a-z][a-z-]*)"|a\.startsWith\("(--[a-z][a-z-]*)=/g,
      )) {
        branched.add((m[1] ?? m[2]) as string);
      }
      const inventory = [...FLAG_NAMES, ...MAINTENANCE_FLAGS.map((f) => f.name)];
      expect([...branched].filter((f) => !inventory.includes(f)).join(", ")).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// C — task ids
// ---------------------------------------------------------------------------

describe("task ids", () => {
  test("every task id named in prose exists", async () => {
    const real = new Set<string>(ALL_TASK_IDS);
    const bad = new Set<string>();
    for (const rel of corpus()) {
      for (const span of inlineCode(await readProse(rel))) {
        // Only spans that ARE a bare id, so prose about "perf" or a filename
        // containing a task name is not read as a claim about the registry.
        const s = span.trim();
        if (/^[a-z][a-z-]{3,}$/.test(s) && s.includes("-") && looksLikeTaskId(s) && !real.has(s)) {
          bad.add(`${s} (${rel})`);
        }
      }
    }
    expect([...bad].join("\n")).toBe("");
  });

  test("all seven task ids are documented in the README", async () => {
    const readme = await readProse("README.md");
    expect(ALL_TASK_IDS.filter((id) => !readme.includes(id)).join(", ")).toBe("");
  });
});

/** A transposition of a real id — `static-perf` for `perf-static` — is the shape worth catching. */
function looksLikeTaskId(s: string): boolean {
  const words = new Set(ALL_TASK_IDS.flatMap((id) => id.split("-")));
  const parts = s.split("-");
  return parts.length > 1 && parts.every((p) => words.has(p));
}

// ---------------------------------------------------------------------------
// D, E, G — checked against a real run, not against a reading of the source
// ---------------------------------------------------------------------------

let blobKeys: string[] = [];
let emitted: string[] = [];
/** Every emitted file's contents, concatenated — for run-time artefact claims. */
let emittedText = "";

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flawless-docslint-"));
  const app = path.join(dir, "app");
  await Bun.$`cp -r ${path.join(REPO_ROOT, "tests/fixtures/nextapp")} ${app}`.quiet();
  const proc = Bun.spawn(
    [
      "bun",
      path.join(REPO_ROOT, "src/bin.ts"),
      path.join(app, "src/app/**/page.tsx"),
      "--nextjs",
      app,
      "--ci",
      "--tasks",
      ALL_TASK_IDS.join(","),
      "--no-inline-summary",
    ],
    { stdout: "pipe", stderr: "pipe", cwd: dir },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  // A dead harness is not a result: if the run failed, every check below would
  // report a vacuous pass on an empty artefact list.
  if (code !== 0)
    throw new Error(`fixture run exited ${code}: ${await new Response(proc.stderr).text()}`);
  const blob = JSON.parse(out) as Record<string, unknown>;
  blobKeys = Object.keys(blob);
  const found = await Bun.$`find ${path.join(app, "flawless")} -type f`.quiet().text();
  emitted = found
    .trim()
    .split("\n")
    .map((f) => path.relative(path.join(app, "flawless"), f));
  if (emitted.length < 20) throw new Error(`fixture run emitted only ${emitted.length} files`);
  emittedText =
    await Bun.$`grep -rhoE "[A-Za-z0-9_.-]+\.(json|ts|tsx|mts|sh|pipes|md|html)" ${path.join(app, "flawless")}`
      .quiet()
      .text();
});

describe("the --ci contract as documented", () => {
  test("every key a run emits is documented, and every required key is emitted", async () => {
    const readme = await readProse("README.md");
    // README.md states the shape as `{ exitCode, outDir, results, keptScripts,
    // testRun?, errors? }`. Read the field list back out of the doc rather than
    // restating it here, so the test cannot agree with a stale copy of itself.
    const m = /\{ (exitCode[^}]*) \}/.exec(readme);
    if (m === null) throw new Error("README.md no longer states the --ci blob shape");
    const fields = (m[1] as string).split(",").map((f) => f.trim());
    const documented = fields.map((f) => f.replace(/\?$/, ""));
    const required = fields.filter((f) => !f.endsWith("?"));
    expect(blobKeys.filter((k) => !documented.includes(k)).join(", ")).toBe("");
    expect(required.filter((k) => !blobKeys.includes(k)).join(", ")).toBe("");
  });
});

describe("exit codes as documented", () => {
  const run = async (args: string[]): Promise<number> => {
    const p = Bun.spawn(["bun", path.join(REPO_ROOT, "src/bin.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: REPO_ROOT,
    });
    await new Response(p.stdout).text();
    await new Response(p.stderr).text();
    return p.exited;
  };

  test("a usage error is 2, not 1", async () => {
    expect(await run(["x.tsx", "--nosuchflag"])).toBe(2);
    expect(await run(["--no-interactive"])).toBe(2);
    expect(await run(["x.tsx", "--tasks=static-perf"])).toBe(2);
  });

  test("--help and --version are 0", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(await run(["--version"])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F — environment variables
// ---------------------------------------------------------------------------

/** Env var prefixes whose members are named by the user's routes, not by this code. */
const DYNAMIC_FAMILIES = ["FLAWLESS_E2E_", "LOAD_"];

describe("environment variables named in prose exist in the code", () => {
  test("every FLAWLESS_/LOAD_/MOCK_/RPT_ name is referenced by src or tests", async () => {
    // src AND tests: FLAWLESS_CI_BROWSER gates the real-chromium executions and
    // lives only in tests/, but it is documented and is genuinely a knob.
    const haystack =
      await Bun.$`grep -rhoE "[A-Z][A-Z0-9_]{3,}" ${path.join(REPO_ROOT, "src")} ${path.join(REPO_ROOT, "tests")}`
        .quiet()
        .text();
    const known = new Set(haystack.split("\n"));
    const missing = new Set<string>();
    for (const rel of corpus()) {
      const text = await readProse(rel);
      for (const m of text.matchAll(
        /\b(FLAWLESS_[A-Z0-9_]+|LOAD_[A-Z0-9_]+|MOCK_[A-Z0-9_]+|RPT_[A-Z0-9_]+)\b/g,
      )) {
        const name = m[1] as string;
        if (known.has(name)) continue;
        // Two documented FAMILIES are built by string concatenation from the
        // user's own route params — `FLAWLESS_E2E_${name.toUpperCase()}` at
        // src/tasks/e2eRoutes.ts:588, and LOAD_<PARAM> in the emitted env.sh.
        // Their members cannot appear as literals here, so membership is as far
        // as this check can honestly go: FLAWLESS_E2E_BUILDINGID is real,
        // FLAWLESS_E2E_ANYTHING would be too, and only the prefix is guarded.
        if (DYNAMIC_FAMILIES.some((prefix) => name.startsWith(prefix))) continue;
        missing.add(`${name} (${rel})`);
      }
    }
    expect([...missing].join("\n")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// G — emitted artefact paths
// ---------------------------------------------------------------------------

/** Directories a real run writes. A prose path starting with one is a claim. */
const EMITTED_DIRS = ["host", "unit", "browser", "profile", "e2e", "load", "mocks", "reports"];

describe("emitted artefact paths named in prose are really emitted", () => {
  test("every claimed path matches a file the fixture run produced", () => {
    const actual = new Set(emitted);
    const matches = (claim: string): boolean => {
      if (actual.has(claim)) return true;
      // <Component>, <Name>, <C>, <route> stand for whatever the analyser found.
      const rx = new RegExp(
        `^${claim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<[^>]+>/g, "[^/]+")}$`,
      );
      if (emitted.some((f) => rx.test(f))) return true;
      // Some documented artefacts are written when the SUITE runs, not when it
      // is generated — e2e/.auth.json is the storage state global-setup saves
      // after logging in. Those are real claims, and the honest check is that
      // an emitted file names them, not that a generate-only run produced them.
      const base = path.basename(claim);
      if (emittedText.includes(base)) return true;
      // last-<name>.json, baseline-<name>.json — run-time artefacts named by
      // placeholder. The skeleton (everything but the placeholder) must appear
      // in what the fixture run emitted; the placeholder stands for a pipe name
      // no generate-only run chose.
      if (/<[^>]+>/.test(base)) {
        const skel = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<[^>]+>/g, "[^/:]+");
        if (new RegExp(skel).test(emittedText)) return true;
      }
      // unit/InvoiceRow.test.tsx — the component name is the doc's own example;
      // the checkable claim is the family, so verify a sibling of the same kind
      // under the same plane.
      const fam = /^(unit|browser|profile)\/[^/]+(?:\.[^/]+)*\.(test\.tsx|spec\.ts)$/.exec(claim);
      if (fam && emitted.some((f) => f.startsWith(`${fam[1]}/`) && f.endsWith(`.${fam[2]}`)))
        return true;
      return false;
    };
    return (async () => {
      const bad = new Set<string>();
      for (const rel of corpus()) {
        for (const span of inlineCode(await readProse(rel))) {
          const claim = span.trim().replace(/^\.?\/?(flawless|<outDir>)\//, "");
          if (!EMITTED_DIRS.some((d) => claim.startsWith(`${d}/`))) continue;
          if (claim.endsWith("/")) continue; // a directory, not a file
          // `reports/*.json`, `unit/**` — a glob describes a family, and the
          // family's members are checked by their own concrete mentions.
          if (/[*?]/.test(claim)) continue;
          if (!matches(claim)) bad.add(`${claim} (${rel})`);
        }
      }
      expect([...bad].join("\n")).toBe("");
    })();
  });
});

// ---------------------------------------------------------------------------
// The lint can actually fail
// ---------------------------------------------------------------------------
//
// A probe that stays green is a coverage gap, not a pass. Each of these is a
// drift this file claims to catch, asserted against the checker directly.

describe("the lint can actually fail", () => {
  test("a stale task id is caught", () => {
    const r = checkLines("bunx flawless-react x.tsx --tasks static-perf");
    expect(r.checked).toBe(1);
    expect(r.problems[0]?.problem).toMatch(/unknown task id/);
  });

  test("a removed flag is caught", () => {
    expect(checkLines("flawless-react x.tsx --no-such-flag").problems[0]?.problem).toMatch(
      /unknown flag/,
    );
  });

  test("a closed-set value typo is caught", () => {
    expect(checkLines("flawless-react x.tsx --roots exported").problems).toHaveLength(0);
    expect(checkLines("flawless-react x.tsx --roots bogus").problems[0]?.problem).toMatch(
      /--roots/,
    );
    expect(checkLines("flawless-react x.tsx --heaps loads").problems[0]?.problem).toMatch(
      /--heaps/,
    );
  });

  test("a line that checks nothing is not a pass", () => {
    const r = checkLines("bun run test\nplaywright test --grep foo");
    expect(r.checked).toBe(0);
    expect(r.skipped).toBe(2);
  });

  test("quoting survives the trip from prose to argv", () => {
    expect(checkLines(`flawless-react x.tsx --props '{"a":1}'`).problems).toHaveLength(0);
    expect(checkLines(`flawless-react "src/**/*.tsx"`).problems).toHaveLength(0);
    // A prose comment is prose, not two stray positionals.
    expect(checkLines("flawless-react x.tsx   # generate the suite").problems).toHaveLength(0);
    // ...but a `#` inside quotes is data.
    expect(checkLines(`flawless-react x.tsx --props '{"t":"#a"}'`).problems).toHaveLength(0);
  });

  test("the extractor finds fenced commands, and skips synopses", () => {
    const md = [
      "```text",
      "flawless-react <entry.tsx> [options]",
      "```",
      "```bash",
      "# a comment",
      "bunx flawless-react ./A.tsx \\",
      "  --tasks a11y",
      "```",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(commandLines(md)).toEqual(["bunx flawless-react ./A.tsx --tasks a11y"]);
  });

  // Behavioural, not a source scrape: main() dispatches on literals, so the only
  // honest way to tie the documented maintenance surface to the code is to run
  // each one and see it answer rather than land on "unknown flag".
  test("every documented maintenance flag is actually dispatched", async () => {
    for (const f of MAINTENANCE_FLAGS) {
      const args = f.value === undefined ? [f.name] : [f.name, "flawless-react x.tsx"];
      const p = Bun.spawn(["bun", path.join(REPO_ROOT, "src/bin.ts"), ...args], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: REPO_ROOT,
      });
      const out = await new Response(p.stdout).text();
      const err = await new Response(p.stderr).text();
      expect(await p.exited).toBe(0);
      expect(err).not.toContain("unknown flag");
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test("every FLAGS entry is accepted by the parser it documents", () => {
    for (const f of FLAGS) {
      if (f.name === "--help" || f.name === "--version") continue;
      const argv =
        f.value === undefined ? ["x.tsx", f.name] : ["x.tsx", `${f.name}=${sampleFor(f.name)}`];
      expect(() => checkLines(`flawless-react ${argv.join(" ")}`)).not.toThrow();
      expect(checkLines(`flawless-react ${argv.join(" ")}`).problems).toHaveLength(0);
    }
  });
});

/** A value each valued flag will accept, so the round-trip tests the flag, not the value. */
function sampleFor(flag: string): string {
  switch (flag) {
    case "--tasks":
      return "a11y";
    case "--roots":
      return "exported";
    case "--heaps":
      return "off";
    case "--depth":
    case "--variants":
      return "2";
    case "--props":
      return "{}";
    case "--include-children":
      return "false";
    default:
      return "value";
  }
}
