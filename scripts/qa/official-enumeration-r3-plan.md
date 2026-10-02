# R3: preserve evidence, isolate conversational interpretation

R2 NO-GO exact 2b7c10438067cef2c3d33565c6d3cc580d7e6eee:
context 9/10 -> 10/10, but two-out rule answers regressed and every official
request incurred another call (+0.9–1.2 seconds). R2 selector is rejected for serving.
R3 does not call it. All RPC candidates and final top-six evidence remain unchanged.
No page pinning, DB writes, embedding changes, source notes or product src changes.

Only when production supplies qualified extras.context to the official answer call,
append an interpretation instruction to that SAME generation call. No extra call or
forced GENERAL status. Do not infer rule applicability from the previous topic; current
rule conditions, exceptions and record questions must still use official evidence.
Without extras.context, execute the exact existing server function. No model/prompt
change at all in standalone cases. Context status remains model-decided, not proven.
Standalone flyout P0 and missing p60 remain unresolved; no full-P0 closure claim.

Reviewer contracts: node --import tsx scripts/qa/official-context-routing-smoke.ts
Author does not execute QA. Independent semantic review is required.

Replay the R2 six suites with identical budgets (219 per mode) and same inputs.
Baseline: no flags. Candidate: --routing=context (NOT --selection).
Additionally both modes run --suite=context-rules --reps=5 with the same qualified
--context-file as flyout-context: four rule/record questions after the catch question,
20 per mode, total 239. This probes improper GENERAL promotion after general context.
Same summarizer accepts the new mode. Output new absolute paths, no repeat-to-pass.
Trace routingApplied plus exact request and original evidence. Existing numeric,
provenance, refusal guards stay untouched. Count unsure and wrong-topic separately.
Compare full latency, input tokens and generation count, not only selected successes.

Priority: two-out colloquial/explicit questions, line-drive exclusions, record answers,
then contextual correction success; any new wrong answer is NO-GO. No context branch
may promote a current explicit rule or record question merely due to previous topic.
Expired/missing context uses the existing qualification; not manufactured by experiment.

R3 is third diff-changing rework (R1 diagnosis, R2 selector, R3 context interpretation).
Flow counter previously said 1; preserve this explicit history rather than reset it.
Any further diff-changing rework exceeds three and must be escalated before proceeding.
Not a production PR/merge request. R0 and R2 experiments remain only as historical tools.
