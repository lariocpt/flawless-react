# S3 — runtime truth: "emitted" and "executed" stop being the same word

## Scope

`src/reporters/verdict.ts` (one new reader, no change to the generation contract), a new
`src/reporters/runRecord.ts`, `src/runner/runTests.ts` (tally capture), the emitted
vitest/playwright configs in `src/scaffold-tests/templates.ts` / `src/tasks/e2eRoutes.ts`
(one conditional reporter each), `src/reporters/report.ts` (one table),
`tests/verdict.test.ts` + `tests/runRecord.test.ts` (new/extended). No new task id.

## Premise

M1 fixed a real lie: the report used to say *"1 of 7 tasks, Not run: the other six"* while
the other six had results. What it replaced it with is honest but incomplete, and the
incompleteness is now the biggest gap in the accounting. `verdict.ts:23-27` states the
contract plainly:

> *"The tallies are generation tallies — what THIS tool measures when it writes the suite…
> Runtime pass/fail belongs to the runner; when a plane's runner reports, its numbers join
> the entry. A verdict never guesses at a number it did not measure: an absent field is an
> unmeasured field, not a zero."*

Today nothing ever joins the file. `VerdictEntry`
(`src/reporters/verdict.ts:58-83`) has `ok`, `written`, `findings`, `skips`,
`skipReasons`, `todos`, `evidence`, `summary` — all generation facts. The only trace of
execution is that `core.ts:876-884` adds `load/last-*.json` to `evidence` *if someone ran
crust*, and `--run-tests` covers only `["perf-harness", "unit-browser", "e2e"]`
(`core.ts:978`), never `load`. So a suite where 501 unit tests, 164 browser tests and 0
e2e tests have ever been executed is indistinguishable, in the durable record, from a
suite where all of them have.

That is the accounting hole the v0.3.3 evaluation was pointing at with *"generated-but-unrun"*.

## What it ships

### 1. `flawless/RUN.json` — the executed record, kept separate on purpose

Generation and execution are different events with different stability rules, so they get
different files. `RUN.json` is keyed by (task, targetHash) and holds, per suite:

```
{ task, targetHash, suite, ran: true, passed, failed, skipped,
  command, reporter, at, source: "runner" | "recorded" }
```

`VERDICT.json` is **not** changed, which is what keeps M1's byte-stability property
(`REDESIGN-01` acceptance 4: two runs on an unchanged tree add no entries and are
byte-stable) intact. A timestamped execution record inside the verdict would have broken
it on the first run. This subfile states that trade-off explicitly because the alternative
— bolting run times onto the verdict — was the obvious design and is wrong.

### 2. The runner captures real tallies, not a boolean

`runTests.ts` today reports `ran` and a `green` boolean (`:40-45`, *"Zero means nothing
ran — never report green"*). Ship structured capture: the runner invokes the same emitted
scripts with `FLAWLESS_REPORT=<path>` set, and the emitted vitest/playwright configs add a
JSON reporter writing to that path **only when the variable is set**. Default runs are
byte-identical to today's; the runner's runs produce parseable tallies. Vitest
`--reporter=json` and Playwright's `json` reporter are the formats; a parse failure is
recorded as `tallies: unparseable` with the reporter file kept, never as zeros.

### 3. `VERDICT.md` gains a "last executed" column

Per plane: `never executed — emitted only`, or `2026-11-05 · 501 pass / 2 fail / 54 skip
· unit`, or `stale — ran against target <hash> ≠ current <hash>`. The staleness case is
the point of keying by target hash: an app that changed since the last run does not get to
wear the old run's green. `REPORT.md` gets the same one-line-per-plane summary, in the
existing *"Not measured — absence of a table here is absence of measurement, not absence
of debt"* voice (`report.ts:518-525`).

### 4. Blocked and absent are states, not silences

S1's `blocked` (setup unfilled) and S2's `crust: absent` land here as first-class values,
so the vocabulary is: `never run` · `blocked (reasons)` · `ran (tallies)` · `stale (hashes)`
· `not applicable (measured-and-declined, e.g. perf-harness under --expo,
perfHarness.ts:27-34)`. Every one of them is a string a user can grep and a test can
assert; none of them is a blank cell.

### 5. A recorded-run path for runs the runner did not spawn

`bun run flawless:verdict:record` (emitted) lets a CI job that ran `bun run flawless:e2e`
its own way — Jenkins, a matrix, a laptop — write the same record from a reporter file.
Without it the record would describe only the runs this tool happened to spawn, which is
the same class of over-claim the whole verdict exists to avoid.

## Acceptance (measured on the merge commit)

1. `--run-tests` on the pinned tree writes `RUN.json` with per-suite tallies that equal,
   test for test, the runner's own stdout summary; a deliberately red spec changes `failed`
   by exactly one.
2. `VERDICT.md` shows `never executed — emitted only` for a plane with no record, and the
   executed line for one with a record, on the same run — both strings present, one grep
   apart.
3. Byte-stability is preserved where it was promised: two generations on an unchanged tree
   leave `VERDICT.json`/`VERDICT.md`'s generation block byte-identical (the M1 property
   still passes), and `RUN.json` is byte-identical when the two runs produce the same
   tallies. The receipts show both `sha256sum -c` outputs.
4. Staleness: generate, run, edit one analysed source file, regenerate, and the plane
   reports `stale` with both hashes. A guard-the-guard case: making the comparison
   permissive must fail this test.
5. Parse failure is honest: a reporter file that cannot be parsed records
   `tallies: unparseable` and keeps the file; it never records zeros. Proven by feeding a
   truncated reporter file.
6. `load` is representable: a `crust` run's `last-*.json` produces a `ran` record for the
   load plane via the record path, closing the hole `core.ts:1075-1076` currently
   documents (*"load pipes are a suite, but not one `--run-tests` executes"*).

## Gates

Plan-level criteria 1–4. Criterion 3's regen probe is the one that matters most here: the
verdict's generation block must stay byte-stable, and `RUN.json` must be listed in the
probe's expected-M set only when a run actually happened between the two generations.

## Moot vs required

- Moot: historical run history, trend charts, a database, or any claim about a run the
  tool did not observe and was not told about. Also moot: making `--run-tests` run `load`
  — a load run against a dev server measures the compiler, and the tool will not do that
  quietly to satisfy a column.
- Required: the separate run record, structured tallies, the staleness rule, the named
  blocked/absent/not-applicable states, and the record path for externally-spawned runs.

## Dependencies

S1 and S2 define `blocked` and the crust fact; this step gives them a home. Independent of
track D, though D0's census is the natural next column in the same table.

## Receipts

_None yet._
