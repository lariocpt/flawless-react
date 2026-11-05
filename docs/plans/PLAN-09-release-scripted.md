# C2 — a release is a script, and exactly one human step

## Scope

`scripts/release.ts` (new, plus `release/` helpers if it needs them), `package.json`
(four `release:*` scripts), `docs/releasing.md` (new), `tests/releaseScript.test.ts`
(new), `tests/docsLint.test.ts` (the new prose joins the corpus automatically — it walks
`docs/*.md`). No change to emission or the analyser.

## Premise

v0.3.3 was released by hand, on one machine, from notes in a file that is deliberately
never committed. `AGENTS.md` says *"`CURRENT_WORK.md` — handoff notes, excluded via
`.git/info/exclude`"* under **Never commit**, and yet the only release runbook this project
has lives in `CURRENT_WORK.md` §36 and §39. There is no `scripts/release.*`, no
`docs/releasing.md`, and no Makefile. The steps are: bump `package.json` (the version is a
static JSON import, `src/version.ts:11-13`, so one edit is enough), write the CHANGELOG
section, commit, merge, tag, cross-compile four binaries, smoke them, build SHA256SUMS,
`gh release create` with hand-copied notes, verify `install.sh`, and publish to npm.

Measured on 2026-11-05 while shipping v0.3.3, the parts that are not scripted are all of
the above except the merge, and the last one is not scriptable to completion:

- `npm publish` from a staged copy returned 403 with *"This token can only publish to the
  staging area. Run `npm stage publish`…"* — npm's staged-publish workflow;
- `npm stage publish` succeeded (the package sits staged, `status: staged`, `tag: latest`);
- `npm stage approve <stage-id>` returns `EOTP` — *"This operation requires a one-time
  password. Open this URL in your browser to authenticate"*.

So the honest design is: **script all of it, and make the one proof-of-presence step
explicit, single, and impossible to lose.** As this plan is written, v0.3.3 is still in
that state — GitHub has it (`v0.3.3`, latest, five assets), npm still serves 0.3.2. The
outcome is recorded in this subfile's Receipts when it lands, because a plan that
describes an open blocker as closed is the thing this repo exists to refuse.

Two more measured facts:

- Defect #15 in `DOGFOOD-0.3.1-FIX-PLAN.md:620-626` — *"`releases/latest` was `v0.3.0`
  while npm carried `0.3.1`… It was a release-process gap, not a tool defect"* — is
  exactly what a verify step catches.
- The Jenkins pipeline publishes CI builds (`Jenkinsfile:44-58`, dual version scheme) but
  does not cut releases; nothing in CI knows what a release is.

## What it ships

### `bun run release:check <version>`

Fails before anything is written: tree clean and equal to `origin/main`; `package.json`
version equals the argument; `CHANGELOG.md` has a `## [<version>]` section with a date and
no empty `[Unreleased]` claims left behind; the five gates green (cold biome, tsc, `bun
test` twice with identical tallies, stripped-`PATH` `bun test`); the tag does not already
exist; and the docs-sync check — `tests/docsLint.test.ts` green **with the sibling website
checkout present** (`tests/helpers/docs.ts:135-138` silently skips it when absent, which
is right for a contributor and wrong for a release).

### `bun run release:assets <version>`

Cross-compiles the four shipped targets from the exact tree
(`bun build --compile --minify` for `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`), smoke-tests each with the assertions Jenkins uses (`--version` prints the
argument, `--help` exits 0), and writes `SHA256SUMS`. The asset names are the ones
`install.sh:90-107` consumes, asserted rather than remembered.

### `bun run release:github <version>`

Annotated tag on the exact commit, push tag, `gh release create` with notes extracted from
the CHANGELOG section (not hand-copied), the five assets uploaded, then verify:
`releases/latest` redirects to this tag, each asset returns 200, and an anonymous
`install.sh` run into a throwaway `HOME` installs a binary that reports this version.
That last check is the one that would have caught defect #15.

### `bun run release:npm <version>`

Stages the publish copy the way Jenkins' `npmstage` does (bin, src, scripts, `.agents`,
README, LICENSE, package.json), rewrites `publishConfig` for the target registry, and
publishes. When the credential is staging-restricted it runs `npm stage publish` instead
and then prints, in one block, the exact command and the URL:

```
npm stage approve <stage-id>
→ open the printed URL in a browser and complete the one-time password
then: bun run release:verify <version>
```

It does not attempt to bypass or automate proof-of-presence, and it exits non-zero with
that block as its whole output, so a half-published release cannot be mistaken for a
finished one.

### `bun run release:verify <version>`

Idempotent, runnable by anyone, no credentials: latest-release redirect, asset 200s,
anonymous `install.sh` into a temp `HOME`, installed binary's `--version`, and
`npm view @lariocpt/flawless-react version`. Prints a table with a pass/fail per row and
exits non-zero on any fail. This is also what CI can run after a release to prove the two
channels agree.

### `docs/releasing.md`

The runbook, in the repo, with the measured v0.3.3 sequence as its worked example and the
npm staged-publish step documented as the one human gate — including why it cannot be
scripted (npm's proof-of-presence requirement) and what to do when the staged package
sits unapproved. `CURRENT_WORK.md` §36/§39 stop being the only copy.

## Acceptance (measured on the merge commit)

1. `release:check` refuses on each of: dirty tree, version mismatch, missing CHANGELOG
   section, existing tag, and a docsLint failure — five guard-the-guard cases in
   `tests/releaseScript.test.ts`, each proving the refusal fires and why.
2. `release:assets` produces the four assets plus `SHA256SUMS` from a clean checkout, and
   every smoke assertion is exercised (a deliberately mis-stamped binary fails it).
3. `release:verify` run against the live v0.3.3 release reports the true state at the time
   of the merge — including, if npm is still unapproved, a failing npm row. The receipts
   quote the table verbatim.
4. `docs/releasing.md` is in the docsLint corpus and green; the four `release:*` scripts
   exist in `package.json` and each is invoked by at least one test or by the runbook's
   worked example.
5. The next release after this merges is performed with the scripts, and its receipts
   record which steps were scripted and which needed a human — a release performed by hand
   after this step is a defect against it, not a preference.

## Gates

Plan-level criteria 1–4. Criterion 2's `bun test` runs are the ones `release:check` runs,
so the gate and the script are the same measurement.

## Moot vs required

- Moot: automating the 2FA approval, storing an authenticator seed in CI, or using a
  granular token with 2FA disabled to skip it — the point of continuity is that a release
  is reproducible, not that it is unattended. Also moot: changing the dual version scheme
  or the apps-plane channel.
- Required: the five script halves, the in-repo runbook, and the verify step being run
  against a real release before this merges.

## Dependencies

C1 first: the portable CI is where `release:verify` earns its keep, and C1's
`publishConfig` change is a precondition of `release:npm`.

## Receipts

_None yet._
