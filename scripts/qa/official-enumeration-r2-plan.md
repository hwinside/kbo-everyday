# #1521 R2 — bounded contextual evidence selection experiment

R1 diagnosed p60 at RPC rank 11, lost at the final six-evidence cutoff. Reviewer
confirmed that attribution and withdrew re-embedding. R0's broad model annotations
remain rejected. This R2 changes **selection membership only**, not retrieval,
embeddings, corpus, enumeration rendering, answer prompt/schema or numeric guards.
It is implemented in scripts, not connected to production. P0 remains HOLD.

## Hypothesis and non-goals

The top six vector neighbors are not necessarily six direct answers. For a follow-up,
matching its words but changing its topic can be worse than using GENERAL. A bounded
selector sees the original question, exact retrieval query, and qualified previous
USER question (not previous assistant assertions), plus at most 12 sanitized original
RPC candidates. It may choose zero through six existing candidate ids. No invented
source, summaries, new rule facts, page pinning, rule/question keyword branches or new
annotations. It preserves RPC ordering within the selected subset. #1520 rendering
still runs only in the existing answer request builder.

One extra `gemini-flash-lite-latest` call per nonempty official search, 256 output tokens,
8-second timeout, no retries. The selector is a learned relevance hypothesis, not a
deterministic proof of relevance. All current R0/R1 failures remain acceptance criteria.
This experiment does NOT prove a deployable solution or assume the extra call is worth
its latency/cost. Production's existing model-call boundary is unchanged: a production
proposal would need a separately reviewed call-budget/idempotency integration.

- `select`: ids must be unique, present in sanitized candidate set, integers and ≤6.
- `no_direct_evidence`: requires an empty list. Returning no candidates permits the
  existing pipeline fallback; it does not create an answer or authorize numerical claims.
- Missing/malformed selection, timeout, 429 or transport failure: return original RPC
  candidates, let existing top-six selection run, trace `baseline-fallback`. No retry,
  widening, fake GENERAL, swallowed failure-as-success or system error answer added.
- No eligible candidates: skip selector network call.
- Context qualification: reuse `selectContextTurn` with existing TTL/source/delivery
  barrier. No new context loading, last-turn substitution or prior-answer fact import.

## Independent contract checks (reviewer only)

```
node --import tsx scripts/qa/official-contextual-selection-smoke.ts
```
Checks malformed/unknown/duplicate/fractional/too-many ids, no-direct inconsistency,
absent candidates, candidate-12 cap, original object identity/no mutation, original
ordering, no assistant text in selection input, expired context, immutable instruction
boundary and network failure/429 no-retry fallback. Mocked network only. Model resistance
to malicious source text is NOT established by these mechanical boundary checks.

## Fixed live comparison — same head, selection flag is the only intervention

`scripts/qa/genius-infield-evidence-live.ts` baseline has no `--selection` flag;
candidate adds `--selection=contextual`. Candidate refuses `--annotations` and
`--supplement`. Both use current main src, which is unchanged in this PR.
Output paths must be new and absolute. Use the same current/reference context file
and same question order per pair; do not repeat until desired answers appear.

1. `--suite=flyout-context --reps=10 --context-file=/Volumes/T7-Dev/reviews/runtime/flyout-previous-turn.json`
2. `--suite=flyout-regression --reps=10`
3. `--suite=exclusion-focus --reps=5` (8×5, particularly non-bunt line drive)
4. `--suite=original --reps=3` (18×3)
5. `--suite=official-documents --reps=3` (8×3)
6. `--suite=official81 --reps=1 --questions-file=/Volumes/T7-Dev/reviews/runtime/1521-r2-official81-questions.json`

**219 requests per mode**. The local official81 question array was extracted exactly
from `/Volumes/T7-Dev/reviews/runtime/art1520r1/r81-base.json` `.questions` (81 strings).
This historical suite is mostly standalone; actual previous-turn reproduction is
separate in (1). No personal identifiers or original answers are committed.

Example (Gateway protected environment; public Supabase URL configured separately):
```
node --use-env-proxy --import tsx scripts/qa/genius-infield-evidence-live.ts --suite=flyout-context --reps=10 --context-file=/Volumes/T7-Dev/reviews/runtime/flyout-previous-turn.json --out=/absolute/ctx-base.json
node --use-env-proxy --import tsx scripts/qa/genius-infield-evidence-live.ts --suite=flyout-context --reps=10 --context-file=/Volumes/T7-Dev/reviews/runtime/flyout-previous-turn.json --selection=contextual --out=/absolute/ctx-cand.json
node scripts/qa/summarize-official-selection-replay.mjs /absolute/ctx-base.json /absolute/ctx-cand.json
```

Trace records selector input/context/ids/status/cost/latency, full original RPC candidates,
selected candidates, final generation evidence/request/raw output and final answer.
Summarizer checks equal planned/completed budgets, questions and prior context. It reports
answer sources, error counts, selector fallbacks, generation calls, observed token totals,
missing token observations and whole-request p50/p95. Token scope is selector + answer
generation, NOT shared normalizer/glossary mapper. Missing counters must not be zeroed
and presented as complete billed usage. Latency includes the entire pipeline request.

## Semantic and cost decision criteria

Highest priority: actual catch/flyout correction must not lose baseline contextual
success (R0 baseline 9/10; compare contemporaneous baseline too). A correct but unsolicited
infield-fly explanation is a wrong-topic failure. GENERAL status alone is not correctness;
judge the answer. Do not claim success by replacing wrong answers with unsure/clarification.
Standalone remains separate; do not invent an infield-fly premise.

Retain #1520 line-drive/bunt exclusions and positive infield cases. Evaluate all original,
document and official81 cases for conclusion errors, explanation inversions, wrong-topic,
unsure, numeric/provenance discard, errors and latency/cost. Quote any adverse case.
If relevance fails or gains do not justify the extra call, reject the selector. Do not
ship just because p60 appears, fallbacks hide selector failure, or some routes become GENERAL.

No merge/deploy/DB request. Reviewer judgment on this exact implementation precedes any
production wiring. R2 is the second #1521 diff-changing rework; prior PR histories are
preserved. Avoid adding changes from further feedback to the same SHA silently.
