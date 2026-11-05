# C4 — a dogfood target a stranger can clone, and a corpus loop that is a script

## Scope

`scripts/dogfood.ts` (new), `dogfood/` (new fixture app, or a public sibling repo — the
decision is this subfile's first deliverable), `tests/dogfood-baseline.test.ts`
(extended), `package.json` (one script), the pinned-SHA recipes quoted in
`docs/redesign/REDESIGN-01-verdict-doc.md:59-68` and in every future subfile's Receipts.
No change to emission.

## Premise

Every acceptance number this project is proud of was measured on a repository nobody else
can open. `docs/redesign/REDESIGN-01-verdict-doc.md:59-68` is a model receipt — binary
built from `c505977`, worktree added at `c00697f`, command run from `apps/web`, decisive
lines quoted — and it is reproducible only by someone who has `mybodycorpai` checked out
at those commits. `DOGFOOD-0.3.1-FIX-PLAN.md:3-5` names the target as a private monorepo
(Next 16 app-router + hono in `apps/web`, Expo SDK 54 in `apps/mobile`); the secondary
corpus is `~/react-corpus/*` checkouts (`CURRENT_WORK.md:1869-1870`), and `AGENTS.md:67`
says corpus branches are never pushed.

Two consequences, both real:

1. **The receipts are not falsifiable.** A number in a subfile can only be re-measured by
   one person, which is the same failure mode as an unscripted release, one level up.
2. **The in-repo substitute is too small to hold the acceptance criteria.**
   `tests/fixtures/nextapp` and `tests/fixtures/expoapp` are minimal fixtures — good for a
   generation smoke, not a tree with 132 components, 54 zero-hit Radix subcomponents, real
   guards, predicates, server actions and document roots. The M1 acceptance item that
   needed a 54-name ledger derivation exists nowhere reproducible.

The corpus loop's mechanics are prose too: `AGENTS.md:52-60` tells you to rebuild the
binary from the measured tree into `/tmp/opencode/fl-bintest-<tree>` and to keep a
before/after on the same binary lineage. That is a rule with a script inside it.

## What it ships

### 1. `scripts/dogfood.ts` — the corpus loop, mechanised

```
bun run dogfood -- --repo <url> --sha <sha> [--tasks …] [--out receipt.json]
```

It clones (or reuses) a cache under a documented `FLAWLESS_DOGFOOD_CACHE`, adds a worktree
at the exact SHA, builds the binary from the **measured tree** with the exact
`bun build --compile --minify` command `AGENTS.md:56-58` prescribes, runs the seven planes,
and writes a receipt JSON: binary hash, tree hash, command, per-plane tallies, TODO and
skip censuses, and the D0 depth census. `--control <sha>` runs the same thing on a second
tree and emits the delta, which is what makes the *same binary lineage* rule
self-enforcing instead of remembered.

The scratch convention stops being tribal: the binary lives in the cache directory, named
by tree hash, and the receipt names it.

### 2. A public dogfood target, chosen by a written decision

Three options, and the subfile's first commit is the choice with its measurement:

- **A. Grow `tests/fixtures/nextapp`** into a full-shape app. Cheapest, but it lives in
  this repo's test tree and every fixture edit is a tool-repo commit — the drift the
  corpus exists to avoid.
- **B. A public sibling repo** (`lariocpt/flawless-dogfood-target`): a real-shaped Next 16
  app-router app + an Expo app, MIT, containing the feature surface the acceptance
  criteria actually reference — the Radix `select`/`dropdown-menu` families that produce
  the zero-hit subcomponent pattern, RSC pages with guards and predicate inversions, forms
  wired to server actions, cva variants, effect fetches against a local API, error
  boundaries, a document root, and a `params.json`-shaped dynamic route set.
- **C. Adopt public upstream repos** from `~/react-corpus` as pinned targets — zero authoring
  cost, but each is someone else's code with its own churn, and the feature surface is
  luck.

Recommendation: **B**, because the acceptance criteria name a *feature surface*, and only
an authored target guarantees it; C is kept as a second opinion (a pinned public repo per
major release, run through `scripts/dogfood.ts`), A stays as the fast smoke. The decision
commit records the measured feature coverage of each option against the M1 receipt's
requirements — the 54-name pattern in particular — rather than picking on taste.

### 3. Acceptance criteria re-expressed on the public target

From the step that lands this onward, a Receipts line names the public target and its SHA
first, and the private tree second if it was also run. Existing receipts are not rewritten
— they are dated records — but `docs/redesign/REDESIGN-01-verdict-doc.md` gains a
forward-pointing note that its numbers are private-target measurements, with the public
target's equivalent measured once here as the bridge.

### 4. The corpus list stops being a home directory

`dogfood/targets.json`: the pinned public targets, their SHAs, the planes to run, and the
expected tallies as of the last verification. `scripts/dogfood.ts --all` runs the file. A
target whose measured tallies drift from the recorded ones is reported, which is the same
drift-detector posture the tool sells to its own users.

## Acceptance (measured on the merge commit)

1. `bun run dogfood -- --repo <public target> --sha <sha>` runs from a clean clone on a
   machine with no access to anything private and produces a receipt whose per-plane
   tallies are quoted in this subfile.
2. The public target reproduces the structural pattern M1's acceptance item 3 needed: a
   stated count of zero-hit subcomponents derived the same way (specs committed − renamed
   primaries − one-hit groups), with the derivation commands shown.
3. `--control` produces a before/after delta for a one-commit change, and the receipt
   proves both binaries were built from their own trees (binary hashes differ, tree hashes
   differ, and the receipt says which is which).
4. `dogfood/targets.json` + `--all` runs green against the recorded expectations, and a
   deliberately stale expectation makes it report the drift rather than pass.
5. `AGENTS.md`'s binary-staleness rule now points at `scripts/dogfood.ts` for the
   mechanical part and keeps the *why*; no prose rule is deleted without the script that
   replaced it.

## Gates

Plan-level criteria 1–4. This is the largest step in the plan and the only one whose
deliverable is mostly not this repo: criterion 5's scope hygiene treats the target repo's
commits as part of the surface, and the target repo must itself be CI-green (C1's shape)
before anything here cites it.

## Moot vs required

- Moot: publishing `mybodycorpai`, or reconstructing it — the point is a target with the
  same *shape*, not the same code. Also moot: a corpus of dozens of repos; three pinned
  public targets measured honestly beat thirty measured aspirationally.
- Required: the dogfood script, one public target that carries the acceptance feature
  surface, the targets file with drift reporting, and receipts that a stranger can re-run.

## Dependencies

D0 (the depth census is part of what the receipt records). C1 (the target repo needs a CI
a stranger can read). Largest step; schedule it last in track C.

## Receipts

_None yet._
