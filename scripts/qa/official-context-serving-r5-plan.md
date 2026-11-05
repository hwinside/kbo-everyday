# R5: product connection of R4 context instruction

R4 independent direction review (Slack 1790947194.391639, art1521r4):
239 per mode, contracts PASS, context-rules 20/20 -> 20/20, no observed regression.
Context effect inversion 4/10 -> 0/10, but direct intent answers 5/10 -> ~2–4/10.
Not P0 resolution or merge GO. Standalone and p60 selection remain unresolved.

## Product scope
server.buildProductionRagRequest routes the exact official prompt identity to a pure
buildOfficialContextRequest. It completes existing official rendering before adding
exactly the R4 instruction, only with qualified extras.context. No qualification,
retrieval, selection, evidence, numeric/provenance guard, response schema, model,
timeout, error handling, retries, idempotency or request budget change. No DB writes.
Non-official calls retain their old builder. Missing context is the old request.
No new model calls. Rollback: revert the R5 product connection commit; no data rollback.
The old offline R4 module is retained as a frozen comparator, not imported by src.

## Contracts and replay
node --import tsx scripts/qa/official-context-serving-smoke.ts
uses synthetic credentials and mocked fetch to execute the real server official call.
It asserts R4 request equality for context/no context/recordbook variants, no changes
to team/default calls, and one fetch per official call. No network or semantic QA.

Independent live comparison: baseline = parent 3dd1365c (NO routing flag),
candidate = R5 (NO routing flag). Both use server.callOfficialRagLlm, not the
experimental fetch. The trace now uses server.buildProductionRagRequest too.
Do not use --routing=context for the product comparison.
Same seven suites and inputs as art1521r4: ctx10 + reg10 + focus40 + orig54 + docs24
+ official81 + context-rules20 = 239 per mode. Fresh output paths, no retry-to-pass.
Count inversion, wrong-topic, direct-intent success, unsure, error, token/latency and
provider errors separately. Confirm routingApplied=0 for absent qualified context.
Prioritize two-out and line-drive rules + Reyes 202 record after catch context.

After exact-SHA GO and applicable owner approval, merge/deploy and independent
production QA with dedicated test account including multi-turn context and controls.
Do not close P0 based on inversion-only improvement. No deployment yet.

R5 is fifth cumulative revision; prior experiments/review failures remain in history.
Thread cap waiver reference: 1790946349.104609. No counter reset.
Sibling addition proposal is separate: define how adding inside six can preserve all
existing six, e.g. available slots vs grouping budget, before changing selection.
No sibling experiment or p60 pinning is included here.
