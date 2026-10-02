# #1523 R2 — R0 anchor restoration + independent intent axis

R1 fa703099 rejected at Slack 1790957066.755119: contextual intent 17/20 to
7/20 and standalone 2/20. R0 anchor had 7/10 standalone but contextual regression.
Restore sibling implementation AND its smoke byte-for-byte from cc95af5e.
Do not claim R0 results apply to this new routing intervention.

Scripts only: no src/DB changes, no product integration, P0 OPEN. No question
allowlist or extra model call. New --routing=intent appends an instruction AFTER
production official/context rendering, only for qualified extras.context. It
separates user intent from retrieved special-case evidence without removing any
records. Old --routing=context remains the unchanged production-equivalent control.

## Fixed three-arm comparison (259 each, once)

A: --routing=context (production-equivalent payload, no siblings)
B: --routing=context --siblings=<audited manifest> (R0 anchor control)
C: --routing=intent --siblings=<same manifest> (only routing differs from B)

All three arms use the same existing callContextRouting transport, including
non-context requests. This avoids transport confounding between arms; it is NOT
a production transport QA claim. Existing transport smoke covers the shared
experimental sender. No --selection/--annotations/--supplement. Unique output
paths per arm; output records routingMode and intentRoutingApplied separately.
No context => B and C identical payloads; new note must be absent. A/B/C retain
existing official date, metadata and exclusion annotation rendering.

Each arm: flyout-context 20, flyout-regression 20, context-rules 4x5,
exclusion-focus 8x5, original 18x3, official-documents 8x3, official81 81x1.
Same context file and audited manifest as R1. No success-driven repeats.
Independent reviewer first executes official-sibling-evidence-smoke.ts (R0),
official-intent-routing-smoke.ts and official-context-routing-transport-smoke.ts.
No-exposure suites remain HOLD for sibling effect, not an instruction PASS.

Compare A/B to locate evidence regression and B/C to isolate routing. C must
preserve A contextual intent AND standalone gain; report law reversal, wrong
topic, self-contradiction, raw/final answer, GENERAL/GROUNDED/unsure/error,
source section exposures, tokens and p50/p95. Inspect two-out explanations,
line-drive exclusions and record answers, not only final yes/no. Fixed budgets
are ceilings, not permission to rerun until success. Non-context B/C differences
are sampling, not routing effects.

Seven physical chunks remain explicitly seven even though anchor rendering has
six records. Guards still see original selected evidence: raw/final provenance
mismatch remains a product blocker. Do not merge or deploy this experiment.

R2 is second diff-changing rework in #1523; R0/R1 rejection evidence retained.
Flow previously reported reworkRounds=0; do not erase documented history.
Author checks are static only. Independent semantic QA pending.
