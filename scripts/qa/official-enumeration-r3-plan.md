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
R4: reviewer explicitly requested green local contract smoke; author runs the two offline contract checks only. Independent semantic review is still required.

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
Superseded by reviewer thread message 1790946349.104609: round cap lifted in this thread since 10/01. Preserve cumulative history; R4 is the fourth revision, not a reset.
Not a production PR/merge request. R0 and R2 experiments remain only as historical tools.


## R4: official request identity and transport contract
R3 f9a596edd5eaa29af155d08f32985d0ecc0f4f79 NO-GO stopped before live replay.
The builder tests official mode using exact system prompt identity. R3 changed that
identity and accidentally removed reference date, metadata and #1520 annotations.
R4 first builds the unchanged official request and then appends only the instruction
in the offline adapter. Product src and production prompt API remain unchanged.
The real definition 40 fixture proves date, metadata, exclusions, complete contents
and generationConfig remain identical. No evidence selection changes.

Offline commands (no model/DB calls):
- node --import tsx scripts/qa/official-context-routing-smoke.ts
- node --import tsx scripts/qa/official-context-routing-transport-smoke.ts

Transport compared with server.ts callRagLlmWithPrompt: same model, POST JSON body,
15s normal / DEFINITION_REPAIR_TIMEOUT_MS repair timeout, no retries, non-OK status
throw, JSON/network/timeout propagation, first truthy text part, null token defaults.
Mock contract pins these behaviors including 429/500/malformed JSON and missing key.
Intentional difference: experiment sends key in x-goog-api-key header instead of
production URL; experiment reads environment at invocation rather than module load.
No claim that the mock executes the production transport; independent comparison
remains required. No live calls were spent on R3; fixed R4 budget stays 239 per mode.
P0 HOLD; standalone question and p60 selection remain unresolved.
