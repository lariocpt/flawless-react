# Production-readiness assessment — August 2026

Scored against the post-engagement state (main after PRs #1–#4), with every
score anchored to evidence: a file, a measurement, or a dogfood outcome from
[`2026-08-review.md`](2026-08-review.md). An open P0 in the findings ledger
would cap its dimension at 2; none is open. Dimensions 2–4 count double —
they are the product.

## Scorecard

Scale: 1 broken/absent · 2 works on the author's machines · 3 works for a
colleague following the docs · 4 usable by a stranger team in production ·
5 best-in-class.

| # | Dimension | Score | Evidence |
|---|---|---|---|
| 1 | Install & runtime story | **2** | Published only to a LAN Verdaccio (`publishConfig.registry: npm.in.drlario.org`); compiled binary distributed via the private apps plane; Bun-only engines gate; binary needs biome reachable for a11y/react-rules. A stranger cannot install it today. |
| 2 | Emitted-artefact correctness ×2 | **3** | Dogfood: all five layers green (unit 508, browser 191, perf 212, e2e 39/39, load 33/33); emitted configs/servers executed by the repo's own tests. Held back by open P1s that bite on common shapes: title injection via backtick labels (FR-012), `src/`-assuming colocate glob (FR-013), dotted-callee mocks that fail correct RSCs (FR-014). |
| 3 | Analysis soundness ×2 | **3** | Two-hop props, intersections, cva tables, hooks/deps, honest `uncertain` bails; effect-only and useRender shapes detected since this round (183/183 components accounted, 0 unreadable). Held back by FR-011 — wrapper-typed props (`forwardRef<E,P>`, `FC<P> = memo`) extract silently empty, violating the tool's own recorded-give-up contract — and 181 TODO markers of residual hand-work. |
| 4 | Honesty of findings ×2 | **4** | The differentiator: skip-with-reason specs, REPORT.md's printed arithmetic, baseline-gated pipes, throw-on-login e2e setup, commented-out unfilled pipes, machine-independent repro lines. This round closed the exit-code P0 (FR-001) and suppression noise (FR-008). Not a 5 while FR-011's silent empties exist. |
| 5 | Docs accuracy | **4** | The doc-honesty sweep landed: regeneration contract, refusal scope, profile path, click-rerender description all verified against code; the perf claim carries a dated measurement. Docs, website, and skills were rewritten from the same evidence. |
| 6 | Error handling & DX | **3** | UsageError→exit-2 now consistent (incl. `--nextjs`, directory patterns); non-TTY safe; good biome-missing message; `--help` complete. Real workflow friction remains: no-force over an adopted suite exits 1 with no refresh mode (FR-028), `--changed` needs a task subset to run anything (FR-017). |
| 7 | Test suite & CI rigor | **3** | 513 tests; the emitted-execution pattern is genuinely unusual (emitted shell/js executed under real interpreters, servers booted and curled, configs interrogated via the real runners). Gaps: no emitted unit spec runs under real vitest in CI (FR-018), no playwright spec meets a browser (FR-022), no crust in CI (FR-021), no biome gate (FR-023). |
| 8 | Performance at scale | **5** | Measured: full 7-task generation over 99 files ≈ 0.95 s user-felt; analysis 463 ms; 3 child processes per run; no LLM latency or cost anywhere. Extrapolates to seconds at 500 files. Best-in-class for the category by construction. |
| 9 | Security of emitted code | **4** | Host and mock servers bind `127.0.0.1` explicitly (templates.ts:482, :1472); `e2e/.auth.json` (session cookies) is auto-gitignored; identifiers reaching emitted code go through JSON.stringify/regex-escape (titles excepted — FR-012). No formal threat model. |
| 10 | Versioning & compat | **2** | `0.3.0-dev`; no declared support matrix (proven on React 19.2 + Next 16 in practice); no semver discipline; write-once files never receive later fixes (FR-016, B-4) — the upgrade story for adopted suites is git archaeology. |
| 11 | Portability / machine assumptions | **3** | Emitted artefacts are machine-independent by design (relative repro lines, no timestamps, indentation-preserving merges — all tested). The tool's own distribution and CI are single-LAN (Verdaccio, Jenkins mounts). |

**Weighted total: 46/70 (66%).** Verdict: **B− as an internal power tool,
not yet shippable as a product.** For the team that built it — on this stack,
this LAN — it is genuinely production-useful today, and dimensions 4 and 8
are already best-in-class traits. The distance to "a stranger team adopts it"
is concentrated in two gates.

**Gates to 1.0** (every dimension ≤ 2 contributes):
1. **Distribution** — publish to a public registry (or public binary
   releases); declare the support matrix; CI off the private LAN.
2. **Upgrade story** — a refresh mode between nothing and `--force`
   (FR-028), a regenerable host registry (FR-016), and content-hash
   refresh for colocated specs (B-4), so adopted suites can receive tool
   improvements without clobbering hand-work.

## Out-of-the-box coverage and impact (measured, this app)

What one command produced on mybodycorpai `apps/web` (99 files, 183
components), before any hand-work:

| Layer | Estate | Result |
|---|---|---|
| Unit (vitest/jsdom) | 174 spec files, 522 tests | 508 pass / 14 reasoned skips |
| Browser (playwright vs bun host) | 96 specs | 191 pass / 12 skips |
| Perf profile (Profiler + react-scan + heaps) | 96 specs | 212 pass / 263 scaffold-time skips |
| Route e2e (real server, real login) | 31 routes / 39 tests | 39 pass |
| Load (crust pipes, baseline-gated) | 33 pipes | 33 pass |
| Findings | perf-static 245 · a11y+react-rules burned to 0 | triaged |

Measured line coverage of the **unit layer alone** (v8): **64.7% of all
component-file lines**; inside `src/components/`: 66.2% lines / 88.9%
branches. The browser, profile, e2e and load layers sit on top of that and
are not measurable by v8. (`src/lib/` coverage is 15% — correctly so: the
tool targets components, not libraries. Combined crust+flawless coverage of
a full Next.js app is a future exercise.)

**Time-saving estimate, stated honestly.** Hand-writing comparable
scaffolding — 174 RTL spec files (~15–30 min each), 31 route e2e specs, 33
load pipes with an env contract, and a working Profiler/react-scan/heap
harness — is roughly **70–130 hours** of competent work. Generation costs
~1 second plus the hardening loop; dogfood iteration 3 (fixtures filled,
findings burned to zero, three specs hand-hardened) took about 90 minutes.
The honest caveats: generated assertions are shallower than an engineer's
best hand-written test for a critical flow; 181 `TODO(flawless)` markers
remain as the priced-in hand-work (89% of them in three mechanically
derivable clusters — the backlog's B-1/2/3); and the number that matters
long-term is maintenance, where regeneration tracking source changes
(iteration 4: regenerated specs correctly followed the id-keyed form
refactor) beats hand-maintained suites at their weakest point.

## Competitor comparison

Facts researched 2026-08-24; every claim carries its source in the research
log, unverifiable ones are marked. Two landscape findings first, because they
reframe everything: **Octomind was discontinued in May 2026** (domain no
longer resolves; no first-party post-mortem) and **Qodo Cover's repo was
abandoned 2025-06-15** (Qodo pivoted to PR review) — of the dedicated
AI-test-generation products chosen for this comparison a year ago, half no
longer exist. Nobody left in the space publishes prices; the only transparent
pricing is editor-agent subscriptions.

react-scan and axe are components flawless *uses*, not competitors, and are
deliberately absent.

| | Mechanism | Determinism | Input needed | You own the code | Categories | Source stays local | Price (as-of 2026-08) | Maintenance | React 19 / RSC |
|---|---|---|---|---|---|---|---|---|---|
| **flawless-react** | static analysis + codegen | same input → same bytes | source only | yes, entirely | unit, browser, perf-profile, perf-static, a11y, react-rules, e2e, load | yes — offline loop (two opt-outable network touches) | $0 marginal | regen tracks source; write-once set holds hand-work | proven (dogfooded on React 19.2 + Next 16, RSC-aware) |
| **Meticulous** | record/replay, AI-curated | replay deterministic; curation not | script tag + real traffic + (Next.js) your app container on their infra | no — hosted suite, no test code exists | visual/behavioral e2e regression | no — sessions incl. network responses uploaded | sales-led, pricing page 404 | fully automatic (their side) | Next.js App Router guide; React 19 unstated |
| **Checksum.ai** | LLM agents → Playwright PRs | output runs deterministically; generation/healing not | repo + running test environment | yes — plain Playwright via PRs | e2e, API, CI-generated tests | no — SaaS with repo access | tiered by workflows, $ undisclosed | self-healing agent (~70% autonomous, self-reported) | framework-agnostic (browser-level); unstated |
| **Qodo Cover** | LLM loop, coverage-validated | generation nondeterministic | buildable project + LLM key | yes — AGPL OSS | unit only | yes, with a self-hosted model | free + tokens | none — **abandoned 2025-06** | no JS/TS support listed |
| **Octomind** | LLM authoring → Playwright | execution deterministic | URL of running app | exportable Playwright | web e2e only | no | historical, conflicting | none — **discontinued 2026-05** | moot |
| **Editor agents** (Copilot/Cursor/Claude Code) | general LLM, prompted | generation varies run-to-run; committed tests run deterministically | source + a test command | yes | anything you ask for, quality bounded by review | no — cloud inference | $10–100/user/mo | manual re-prompt; agent fixes on demand | yes — current model knowledge |
| **Manual** (Testing Library + Playwright + Profiler wiring) | a person | as good as the person | source + time | yes | anything, at ~70–130 h for this scale | yes | salary | full manual burden | yes |

**Choose it when:**
- *flawless-react* — you want a deterministic, code-owned scaffold of the
  whole quality surface in one second from an offline analysis/generation
  loop, and accept hardening the TODOs and living without vendor support.
- *Meticulous* — you have real traffic, want zero test-authoring forever, and
  accept renting a suite you can neither read nor take with you.
- *Checksum* — you want maintained Playwright e2e in your repo without writing
  it, and accept a SaaS in the loop.
- *Editor agents* — the realistic 2026 default: flexible, framework-current,
  and only as rigorous as the review you give it. A team can rationally use
  flawless for the mechanical scaffold and an editor agent for the deep
  hand-written flows — they compose rather than compete.
- *Manual* — the critical flows where an engineer's intent is the point.

**Face-off on the dimensions where flawless competes directly** (1–5;
maturity/support scored honestly against funded vendors):

| Dimension | flawless | Meticulous | Checksum | Editor agents | Manual |
|---|---|---|---|---|---|
| Determinism (input→output) | 5 | 4 | 3 | 2 | 5 |
| Code ownership / exit cost | 5 | 1 | 4 | 5 | 5 |
| Offline / source stays local | 5 | 1 | 1 | 1 | 5 |
| Marginal cost per run | 5 | 2 (unverified) | 2 (unverified) | 4 | 1 |
| Category breadth (unit→load) | 5 | 2 | 2 | 4 | 4 |
| Setup to first green suite | 4 | 3 | 3 | 4 | 1 |
| Maintenance automation | 3 | 5 | 4 | 2 | 1 |
| Maturity / support / community | **1** | 4 | 3 | 5 | 5 |
| Framework future-proofing | 3 | 3 | 4 | 5 | 5 |

*The offline 5, precisely:* the analysis/generation loop is offline; the two
network touches are opt-outable — `--swagger-url` fetches a live OpenAPI spec
(`--swagger-url off` disables it) and `--run-tests` auto-runs `bunx playwright
install chromium` (`FLAWLESS_SKIP_BROWSER_INSTALL=1` skips it).

The two rows flawless loses are real: it is a single-author 0.3.0-dev tool on
a private registry with no support channel, and its framework coverage moves
only when its author moves it — a funded vendor or a frontier model tracks
React's churn for you. The rows it wins, it wins by construction, not by
polish: no LLM anywhere, and no network in the analysis/generation loop (the
two optional network touches — live-swagger probe, playwright install — both
have documented opt-outs), is a property the funded
half of this table cannot retrofit, and the May-2026/June-2025 shutdowns are
a reminder that a hosted suite's exit cost is the whole suite.

**Final rating:** flawless-react is a **strong niche instrument as a
deterministic, code-owned test scaffolder for React/Next.js with an offline
analysis/generation loop — the only product in this comparison covering
unit-through-load in one pass —
compared against tools that are either better-funded conveniences with rented
output (Meticulous, Checksum), general-purpose agents with no determinism
story (editor LLMs), or dead (Octomind, Qodo Cover). At 66% weighted
production-readiness it is production-useful for its own team today and two
gates (public distribution, an upgrade story for adopted suites) away from
being honestly recommendable to strangers.**


## Rescore — 2026-08-24, after waves 0–5 (PRs #6–#18, dogfood round 5)

The table above is the pre-wave baseline and stays as written. Rescored
against the same anchors after the implementation waves and dogfood round 5:

| # | Dimension | Was | Now | What moved it |
|---|---|---|---|---|
| 1 | Install & runtime story | 2 | **2** | Unchanged by design — public distribution is gate 1, explicitly deferred. CI now genuinely publishes (first green build in the job's history), but only to the LAN planes. |
| 2 | Emitted-artefact correctness ×2 | 3 | **4** | FR-012/013/014 fixed; executing emitted suites for the first time found and fixed two shipped P1s (jsx "preserve" killing every spec in stock Next hosts; `__dirname` under the ESM loader). Round 5: all five layers green against a fresh seed with zero adjustments. |
| 3 | Analysis soundness ×2 | 3 | **4** | FR-011 wrapper props fixed; waves 3's inference (server-action returns, dep annotations/OpenAPI, compound families) landed with never-guess bail policies; dogfood TODOs 178→118 with the remainder root-caused to one wall (B-8 workspace types), not scattered gaps. |
| 4 | Honesty of findings ×2 | 4 | **5** | The held-back reason (FR-011 silent empties) is gone. Since then: provenance stamps, enriched-dep crashes report red instead of hiding behind the skip escape, mock fallbacks and escapes share one predicate, kept scripts recorded durably in REPORT.md. |
| 5 | Docs accuracy | 4 | **4** | Docs/website/skills re-synced from evidence each wave; still no declared support matrix. |
| 6 | Error handling & DX | 3 | **4** | Both cited blockers fixed: refresh mode replaces the refusal (FR-028) and `--changed` full-selection runs affected tests (FR-017); migration warnings name their exact escapes and were followed successfully in round 5. |
| 7 | Test suite & CI rigor | 3 | **4** | All four cited gaps closed (FR-018/021/022/023): real vitest executes an emitted suite, a real chromium runs a browser spec, real crust runs the baseline gate, biome ci gates the tree — 744 tests. Held from 5 by FR-020 (the --ci contract still untested) and a single-LAN CI. |
| 8 | Performance at scale | 5 | **5** | Unchanged. |
| 9 | Security of emitted code | 4 | **4** | FR-012 title injection fixed; still no formal threat model. |
| 10 | Versioning & compat | 2 | **3** | The cited upgrade-story failures are all fixed and were exercised live in round 5: refresh mode, the regenerated host registry (FR-016 migration performed on a real pre-split suite), hash-stamped colocated specs (a 174-spec `--force` clobbered nothing), and script-merge that keeps user commands (FR-034). CI publishes versioned artifacts per build. Still no public semver discipline or support matrix. |
| 11 | Portability | 3 | **3** | Unchanged — tool CI/distribution still single-LAN. |

**Weighted total: 55/70 (79%), up from 46/70.** Verdict: **A− as an
internal power tool; distribution is now the only 1.0 gate.** Gate 2
(the upgrade story) is closed and dogfood-verified; every dimension the
waves touched moved on evidence that is executed, not read.


## Rescore — 2026-08-24 (round 6: FR-020 + B-8 + dogfood)

Only the dimensions that moved; everything else stands as the wave 0–5
rescore above.

| # | Dimension | Was | Now | What moved it |
|---|---|---|---|---|
| 3 | Analysis soundness ×2 | 4 | **4** | B-8 landed (workspace map + barrel relocation, adversarially hardened: private-decl shadow, explicit-over-star precedence, depth-not-breadth bound) — but held at 4 honestly: round 6 disproved the round-5 claim that the TODO remainder was "one wall". Measured per callee it is z.infer members (B-9), client factories, and `cache()`-wrapped exports (B-10) — real inference frontiers, now recorded instead of misattributed. |
| 7 | Test suite & CI rigor | 4 | **5** | The stated holdback is gone: FR-020 closed the last ledger item (34/34) with the --ci contract pinned subprocess-level, red-run blob and anti-vacuity control included, and mutation probes proved every new assertion bites. 774 tests. The remaining caveat (single-LAN CI) is distribution's gate, scored in #1/#11. |

**Weighted total: 56/70 (80%), up from 55/70.** Verdict unchanged: **A− as
an internal power tool; distribution is the only 1.0 gate.**


## Rescore — 2026-08-24 (round 7: B-9 + the r7 review)

| # | Dimension | Was | Now | What moved it |
|---|---|---|---|---|
| 3 | Analysis soundness ×2 | 4 | **5** | B-8 and B-9 both shipped adversarially hardened (private-decl shadowing, star-vs-explicit precedence, depth-not-breadth bounds, export enforcement at the root of import-reached lookups), and the frontier is now MEASURED rather than asserted: dogfood r7 attributes every remaining marker to a named cause — `getDb` (unannotatable), dotted callees (FR-014, deferred), `cache()` wrappers (B-10). Nine new tests executed green on a real app on first run. |
| 4 | Honesty of findings ×2 | 5 | **5** | Held at 5, earned again: the round's own adversarial sweep found four silent-pass paths (unknown task ids, unresolvable `--changed` ref, unparseable files reported clean, a vacuous RSC assertion) and all four were fixed inside the round, each with a control proving the new guard can fail. |

**Weighted total: 57/70 (81%), up from 56/70.** Verdict unchanged: **A− as an
internal power tool; distribution is the only 1.0 gate.**
