# M2 — zero-unexplained-red emission (rebased on 0.3.2)

## Scope

`src/scaffold-tests/templates.ts` (spec emission: provenance comments, skip reasons,
failure-shape guard), `src/scaffold-tests/mocks.ts` (per-stub provenance), and the
verdict's skip aggregation hook (M1). Surface declared: scaffold-tests + the M1 hook.

## What 0.3.2 already did (dead design input — do not re-plan)

- The 30-reds mechanism: `resolveAsyncUi` now **walks every prop and awaits
  top-level thenables** (`templates.ts:2529`), and `RSC_RENDER_SETTLED`
  (`templates.ts:2602`) renders under `Suspense` with a `data-flawless-suspended`
  fallback and settles before asserting (audit C13 — dead).
- The silent `catch { return; }` in the static-text render path is **removed**; the
  RSC guard-catch (assertion hoisted, guard rethrows non-guard errors) stands at
  ~2703–2718 (audit C29 — dead).

## What remains (the rebase)

The contract's fail-branch — "a red carries a cause the tool asserts" — is no longer
tested by a 30-red regression (none exists to reproduce). Acceptance moves to
**emission-shape receipts** plus two emissions 0.3.2 still lacks:

1. **Per-stub mock provenance inside specs.** 0.3.2 records provenance in
   `mocks/handlers.ts` (`handlersProvenance` 6/0 on the regen tree) but the emitted
   specs do not name it per fetch. Every `http.get/post` stub an emitted spec installs
   carries `// provenance: <spec|synthesised> <source-file>` so a red "body mismatch"
   reads "mock M (synthesised from schema, no example in openapi.json) returned X".
2. **Skip-reason aggregation in the verdict** (M1's pipe, `TodoCounter` 169–174 →
   verdict `skips` grouped by reason-string, counted, not per-file).
3. **The fail-shape guard stays asserted**: a spec whose mount cannot settle emits the
   suspended-marker path, never a bare empty-container assert (the shape that made the
   0.3.1 reds uninterpretable).

## Acceptance (measured on the merge commit)

1. Regenerate the pinned `c00697f` tree: the **25** specs with non-empty
   `PROMISE_PROPS` (22 `["params"]`-only, 2 `["searchParams"]`-only, 1 both — audit
   C15) contain the thenable-awaiting resolver emission and none contains the
   empty-container failure pattern (string checks on the resolved spec bytes).
2. Every stub in every emitted spec carries the provenance comment: stub count ==
   provenance-comment count (per file, summed).
3. Dogfood-baseline #7 shape: the regen's unit plane receipts are 18/0 (pass/fail) on
   the emission — an **emission-level** receipt; this step claims no plane tally on a
   0.3.2-era tree beyond what was actually run.
4. Verdict `skips` groups: every reason string present in specs appears in the verdict
   with its count; totals reconcile with the plane tallies.

## Gates

Plan-level criteria 1–4. M2-specific: criterion 3's idempotence probe is unchanged —
provenance comments are deterministic (same source ⇒ same comment), so the second
regen must be 0 A / 0 D.

## Moot vs required

- Moot: the 30-reds acceptance case; the silent-catch deletion (both done in 0.3.2).
- Required: items 1–3 above.

## Dependencies

M1 (the aggregation lands in the verdict doc). Order slot 2.
