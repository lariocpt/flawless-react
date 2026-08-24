import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyStamped,
  hashBody,
  restampGenerated,
  STAMP_RE,
  splitStamp,
  stamp,
} from "../src/scaffold-tests/stamp.ts";
import { VERSION } from "../src/version.ts";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "flawless-stamp-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const BODY = 'import { test } from "vitest";\n\ntest("x", () => {});\n';

describe("stamp / splitStamp", () => {
  test("round-trip: the stamp names the body's hash and the tool version", () => {
    const text = stamp(BODY);
    expect(STAMP_RE.test(text)).toBe(true);
    const { hash, version, body } = splitStamp(text);
    expect(body).toBe(BODY);
    expect(hash).toBe(hashBody(BODY));
    expect(version).toBe(VERSION);
  });

  test("hashBody covers the body only — stamping never changes the hash it names", () => {
    // If the hash covered the whole file (stamp line included), no stamp could
    // ever validate: the line carrying the hash would perturb it.
    expect(splitStamp(stamp(BODY)).hash).toBe(hashBody(splitStamp(stamp(BODY)).body));
  });

  test("stampless text passes through whole, with no hash or version", () => {
    const { hash, version, body } = splitStamp(BODY);
    expect(hash).toBeUndefined();
    expect(version).toBeUndefined();
    expect(body).toBe(BODY);
  });

  test("the stamp is only a stamp on the FIRST line", () => {
    const buried = `// a human comment\n${stamp(BODY)}`;
    expect(splitStamp(buried).hash).toBeUndefined();
    expect(classifyStamped(buried)).toBe("stampless");
  });

  test("a CRLF line ending after the stamp line still peels", () => {
    const text = `// @flawless-generated sha256:${hashBody(BODY)} flawless-react@1.2.3\r\n${BODY}`;
    const { hash, version, body } = splitStamp(text);
    expect(hash).toBe(hashBody(BODY));
    expect(version).toBe("1.2.3");
    expect(body).toBe(BODY);
    expect(classifyStamped(text)).toBe("untouched");
  });
});

describe("classifyStamped", () => {
  test("a freshly stamped file is untouched", () => {
    expect(classifyStamped(stamp(BODY))).toBe("untouched");
  });

  test("any body change after stamping is edited", () => {
    expect(classifyStamped(`${stamp(BODY)}// hand-hardened\n`)).toBe("edited");
  });

  test("a corrupted hash character reads as edited, never untouched", () => {
    // Guard-the-guard: if a mangled stamp classified as untouched, --force
    // would clobber a file precisely when its provenance is least trustworthy.
    const text = stamp(BODY);
    const m = text.match(STAMP_RE);
    expect(m).not.toBeNull();
    const hash = (m as RegExpMatchArray)[1] as string;
    const flipped = hash[0] === "0" ? `f${hash.slice(1)}` : `0${hash.slice(1)}`;
    expect(classifyStamped(text.replace(hash, flipped))).toBe("edited");
  });

  test("no stamp line at all is stampless", () => {
    expect(classifyStamped(BODY)).toBe("stampless");
  });
});

describe("restampGenerated", () => {
  test("rewrites the stamp after the body changed, preserving the stamp's own version", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "spec.test.tsx");
    writeFileSync(file, stamp(BODY, "0.0.0-test"));
    // Simulate a formatter pass: the body changes, the stale stamp stays.
    const formatted = BODY.replace('test("x"', 'test("x", { timeout: 1 }');
    expect(formatted).not.toBe(BODY);
    const stale = readFileSync(file, "utf8").split("\n")[0] as string;
    writeFileSync(file, `${stale}\n${formatted}`);
    expect(classifyStamped(readFileSync(file, "utf8"))).toBe("edited");

    expect(await restampGenerated([file])).toBe(1);
    const text = readFileSync(file, "utf8");
    const { hash, version, body } = splitStamp(text);
    expect(body).toBe(formatted);
    expect(hash).toBe(hashBody(formatted));
    expect(version).toBe("0.0.0-test");
    expect(classifyStamped(text)).toBe("untouched");
  });

  test("a matching stamp is left byte-identical", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "spec.test.tsx");
    const original = stamp(BODY);
    writeFileSync(file, original);
    expect(await restampGenerated([file])).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  test("restamping a CRLF-converted file writes a CRLF stamp line, never mixed EOLs", async () => {
    // A host biome with formatter.lineEnding "crlf" converts the whole file —
    // stamp line included — after the provisional LF stamp was written. The
    // restamp must follow the body's convention or every --force run hands the
    // project's own formatter a mixed-EOL file to churn straight back.
    const dir = tmpDir();
    const file = path.join(dir, "spec.test.tsx");
    const crlfBody = BODY.replaceAll("\n", "\r\n");
    writeFileSync(
      file,
      `// @flawless-generated sha256:${hashBody(BODY)} flawless-react@1.2.3\r\n${crlfBody}`,
    );
    expect(await restampGenerated([file])).toBe(1);
    const text = readFileSync(file, "utf8");
    const firstLine = text.slice(0, text.indexOf("\n") + 1);
    expect(firstLine.endsWith("\r\n")).toBe(true);
    const { hash, version, body } = splitStamp(text);
    expect(body).toBe(crlfBody);
    expect(hash).toBe(hashBody(crlfBody));
    expect(version).toBe("1.2.3");
    expect(classifyStamped(text)).toBe("untouched");
  });

  test("ignores stampless files and missing paths — callers pass mixed lists", async () => {
    const dir = tmpDir();
    const plain = path.join(dir, "plain.ts");
    writeFileSync(plain, BODY);
    const missing = path.join(dir, "never-written.ts");
    expect(await restampGenerated([plain, missing])).toBe(0);
    expect(readFileSync(plain, "utf8")).toBe(BODY);
  });
});
