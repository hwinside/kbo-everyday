# #1523 R3 — skip sibling binding for requests with context

R2 C rejected: Slack 1790959009.792759. R3 requested: 1790961969.171879.
Third diff-changing rework (R1, R2, R3); Flow count 0 is stale, not a reset.
Scripts-only Draft: no src, DB, production transport or routing-note changes.
P0 remains OPEN. No merge/deployment requested.

## Fixed arms: 259 requests each, one pass

A: --routing=context
B: --routing=context --siblings=<audited manifest>
R3: --routing=context --siblings=<same manifest> --sibling-scope=standalone

Use the R2 context file, manifest, question list and identical reference clock.
Each arm: flyout-context 20, flyout-regression 20, context-rules 4x5,
exclusion-focus 8x5, original 18x3, official-documents 8x3, official81 81x1.
Distinct output files; no selection, annotations, supplement or routing=intent.
All arms share existing experimental transport. No success-driven repeats.

R0 sibling function is unchanged for B. R3 wraps it: any non-null extras.context
(including empty strings in its fields) returns original selected evidence,
zero trace and original physical chunk count. Absent/undefined context delegates
to R0 unchanged. No question matching and no dependency on suite or previousTurn.
The actual extras at official-generation call is the gate, not CLI context input.
Output contains siblingScope and per-call skippedForContext plus existing extras,
request, raw/final, exposure, count and latency evidence.

Reviewer runs official-sibling-evidence-smoke.ts (extended R3 payload identity
and non-mutation boundary checks) and official-context-routing-transport-smoke.ts.
Author only runs TypeScript/ESLint; smoke and semantic results remain unverified.
With context: R3 payload must equal A; without context: R3 must equal B.
Report selected-context coverage, wrong topic, reversal, contradiction, direct
intent fit, GENERAL/GROUNDED/unsure/error, token cost and p50/p95. Inspect crules
(two-outs, line-drive exclusion, Reyes 202) for lost sibling benefits, not only
conclusion labels. Report non-exposure as HOLD, never improvement evidence.

Seven physical chunks remain seven when standalone binding succeeds, although
rendered as six records. Guard/raw provenance mismatch is still a product blocker.
This experiment does not establish a serving contract or resolve P0 on its own.
