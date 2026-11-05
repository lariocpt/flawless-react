# C1 — CI that runs somewhere other than one machine

## Scope

`.github/workflows/ci.yml` (new), `Jenkinsfile` (Test stage de-coupled, publish stages
parameterised), `package.json` (`publishConfig`), `tests/report.test.ts` and
`tests/fixtures/actions/PostForm.flawless.json` (committed absolute paths),
`tests/toolchainPins.test.ts` (extended). No change to `src/`.

## Premise

There is no `.github/workflows` — CI is one `Jenkinsfile` on the maintainer's box, and
that file cannot run anywhere else:

- `Jenkinsfile:35-36` requires `/srv/apps` writable and `/opt/publish/bin/apps-publish`
  executable — mounts on one host;
- `Jenkinsfile:28` sets `REGISTRY = 'https://npm.in.drlario.org'` and `:218` pulls a
  Jenkins credential `verdaccio-npm-token`;
- `Jenkinsfile:98-100` resolves `apps.in.drlario.org` to an IPv4 and pins the container
  with `--add-host`, because *"builds 138/139 died on the crust fetch after 0 ms"* — the
  tailnet answers publicly but is not publicly routable;
- `Jenkinsfile:121` installs crust from `https://apps.in.drlario.org/install.sh`.

Two of those are accidental rather than essential, and that is the whole opportunity:

1. **crust is public.** `docs/e2e-and-api.md:205-209` already documents
   `curl -fsSL https://raw.githubusercontent.com/lariocpt/crust/main/install.sh | bash`
   and `npm i -g @lariocpt/crust` as *"both of its channels are public"*. The Test stage
   installs it from the tailnet anyway, which is the only reason the container needs the
   IPv4 pin.
2. **`publishConfig` points at the private registry** (`package.json:65-68`:
   `"registry": "https://npm.in.drlario.org"`) while the package is public on npm as
   `@lariocpt/flawless-react`. A contributor who clones and runs `npm publish` — the
   obvious thing to try — targets a registry they cannot reach, and the CI's own npm stage
   already works around this by staging a copy and rewriting the field.

Plus two committed absolute paths that make a stranger's run differ from the maintainer's
for no reason: `tests/report.test.ts:516`
(`const ROOT = "/home/lario/Projects/personal/mybodycorpai/apps/web";`) and
`tests/fixtures/actions/PostForm.flawless.json:3`, which carries a
`/home/lario/Projects/personal/flawless-react/…` path inside a checked-in fixture.

## What it ships

### 1. `.github/workflows/ci.yml` — the Test stage, ported verbatim

One job, the same steps the Jenkins Test stage runs, in the same order, with the same
reason comments carried over: `oven/bun:1.4` (with the concurrent-cold-cache explanation
from `Jenkinsfile:85-93`, because a portable CI must not lose the reason it is pinned),
`apt-get install jq zsh nodejs curl ca-certificates git`, the real-node check
(`Jenkinsfile:113-117`), crust from the public GitHub install, `bun install
--frozen-lockfile`, `bunx playwright install --with-deps chromium`,
`FLAWLESS_CI_BROWSER=1 FLAWLESS_CI_NATIVE=1 bun test`, cold biome, `bunx tsc --noEmit`.
Triggers: push + PR. This is the artifact that makes "the tests are green" a claim a
stranger can check.

### 2. The Jenkins Test stage loses its tailnet dependency

Same substitution — public crust install — and the `--add-host` pin and the
`getent ahostsv4` preflight go away with it. The stage's *semantics* do not move: it still
fails loudly when crust cannot be fetched, which is the FR-021 lesson the comment at
`:119-120` records.

### 3. Publish stages become optional and configured, not hardcoded

`/srv/apps`, `/opt/publish/bin/apps-publish`, the registry URL and the credential id move
to Jenkins-level env with no in-file defaults. When they are unset the pipeline runs
Test + Compile and stops with `publish skipped — APPS_PUBLISH/NPM_REGISTRY not
configured`, which is a stated state, not a silent pass. The dual version scheme
(`BASE+sha` for the apps plane, `BASE-ci.N.sha` for npm, `Jenkinsfile:44-58`) is unchanged.

### 4. `publishConfig` points at the public registry

`registry.npmjs.org`, `access: public`. The internal Verdaccio publish keeps working the
way it already does — the Jenkins `npmstage` copy that rewrites the field — and a stranger
running `npm publish` from a clone now aims at the registry the package actually lives in.
`tests/toolchainPins.test.ts` gains the pin so this cannot silently drift back.

### 5. No committed machine paths

`tests/report.test.ts` builds its repro line against a fixture path it constructs (or a
`mkdtemp` path), and the `PostForm.flawless.json` fixture's `file` field is regenerated as
a repo-relative path with the comparison made relative — the same fix `src/emitPaths.ts:9`
and `tests/emittedPaths.test.ts:16` already document as the rule for emitted paths
(*"the same repository lives under a different root on other machines"*).

## Acceptance (measured on the merge commit)

1. The GitHub Actions run is green on the step branch, and its log shows the same gate set
   as the Jenkins Test stage (crust version, `bun test` tally, cold biome, tsc). The
   receipt is the run URL plus the four decisive lines.
2. A fork with no access to any `*.in.drlario.org` host reaches green on the same workflow
   — proven by a throwaway fork, whose run URL is in the receipts. This is the criterion
   that makes it a continuity fix rather than a second CI config.
3. The Jenkins Test stage passes with the public crust install and no `--add-host`, and
   the build number is recorded.
4. With the publish env unset, the pipeline stops after Compile with the named skip
   message; with it set, it publishes as before (verified on the next CI build).
5. `npm publish --dry-run` from a clean clone reports `registry.npmjs.org`; the Verdaccio
   npm stage still publishes its staged copy unchanged (verified by the next Jenkins
   build's `npm view … --registry "$REGISTRY"` line, `Jenkinsfile:258`).
6. `grep -rn "/home/lario" tests/ src/ --include='*.ts' --include='*.json'` returns
   nothing outside `tests/.tmp/` (gitignored scratch), and the suite is green with
   `HOME` pointed at a fresh directory.

## Gates

Plan-level criteria 1–4, with criterion 2's `bun test` runs performed on the runner as
well as locally, and criterion 5's scope hygiene reading `Jenkinsfile` + workflow +
`package.json` + the two test files as the whole surface.

## Moot vs required

- Moot: replacing Jenkins as the publisher (the apps plane and Verdaccio are fine private
  infrastructure — the fix is that they are *optional*); moving the private registry
  public; containerising development.
- Required: a portable green CI, a Test stage with no tailnet dependency, publish stages
  that degrade to a named skip, a public `publishConfig`, and zero committed machine paths.

## Dependencies

None. C2 builds on the portable CI to run its release checks, so C1 first.

## Receipts

_None yet._
