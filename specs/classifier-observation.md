# Classifier observation and production evaluation seam

This change does not improve classification by itself. It establishes observation
and a production-identical evaluation entry point for the frozen 2026-09-20 contract.
No prompt, model, schema, numeric guard, response text or route policy is changed.
PR #1391's independent prompt work is not incorporated.

## Serving and replay

- `answerQuestion` owns the existing pipeline; a per-request dependency wrapper observes
  its answer-generating generic/intent and RAG calls. Mapper, embeddings and retrieval
  provider calls are explicitly outside `provider_outcome`'s denominator.
- `context_selected` is the global selector result after the existing injection filter.
  It does not assert that context was passed to every provider or obeyed by the model.
  NULL means the selector was not reached or a legacy result lacks observation.
- `stat_intent_mode` records an actual generic call with intent mode enabled, not a
  retrospective guard estimate. False is an observed run without an intent call;
  NULL is unknown historical replay.
- `provider_outcome` describes the last covered call. JSON/parser outcomes are separate.
  `calls` and `providerFailures` preserve the total across retry/repair/reask sequences.
  HTTP errors and timeouts remain errors, not unsure/parser failures.
- Only closed labels, booleans and counters are added. No raw error text, model output,
  user IDs, questions or answers are added to the observation object.
- Jobs atomically save the observation alongside existing llm_text. Retry restores it
  before logging. Historical/malformed observations become `legacy_unknown`, never a
  fabricated successful call or false intent flag. There is no backfill.
- Apply the additive migration before deploying code that selects/inserts the new
  columns. Rollback: revert code first; nullable unused columns can remain.

## Offline evaluation

`evaluateProductionCase` calls the production `answerQuestion` with raw `question`.
The caller must supply isolated dependencies and same-user previous-turn RPC fixtures.
The production selector, guards, validators and final route execute unchanged. No
forced intent flag or manually concatenated two-turn context is permitted. Actual
provider adapters must continue to use `buildBaseballQaGeminiRequest`.

`evaluateProductionTriplet` runs three independent repetitions with a caller-supplied
label projection. `majorityOfThree` flags any disagreement and preserves all-distinct
runs as `UNSTABLE_NO_MAJORITY`. Labels for general TERM_* and intent scope exits are
explicit; `rule_term_reask` is never equated with final answer success.

This is an evaluation seam, not a corpus extractor or a completed A/B quality report.
`pairedClassifierMetrics` computes accuracy/macro-F1 and paired bootstrap deltas
(10,000 repetitions, seed 20260920, 95% percentile CI). Invalid/provider/no-majority
predictions stay in the denominator. A fixed gold-label set is required.
Reviewer execution on the fresh post-freeze blind corpus and broader operational
metrics remain pending; no quality claims are based on these unit fixtures.
The caller must not wire production quota/log/cache writes into offline runs.

## Independent gate

`npm run qa:classifier-observation` (CI tier) covers parser vs provider failure,
request/context assembly, observation isolation, durable/legacy replay, raw input into
the actual pipeline, production log-row mapping and additive migration replay in PGlite.
Run `qa:query-guard` and relevant existing pipeline/durable gates independently as well.
The author only runs TypeScript/diff self-checks; reviewer execution is required.

## Diagnosis limitations (no raw operational text in repository)

70 diagnosis rows were provided separately from 58 blind-reserved rows. Of the 40
`official/model_insufficient` diagnosis rows, manual content-only triage found:
11 context-dependent candidates; 4 app-help; 12 chitchat/non-questions;
12 non-rule information requests; 1 rule/draft candidate.
These are not causal verdicts or gold labels. Historical previous-turn/selector inputs,
retrieved evidence text and discarded answers were not supplied. All 70 causal verdicts
remain unconfirmed. Numeric discard reasons are validator outcomes, not proof of false
claims. No diagnosis row may enter the fresh blind set.

The reported 618 vs 617 discrepancy is a time-window difference (one ack row), not a
missing-question filter. The 4/617 estimate still uses the current glossary snapshot;
it is not an exact historical intent-call rate and is not combined with a 30-day bound.
