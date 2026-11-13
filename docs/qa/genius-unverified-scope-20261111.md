# Unverified expression scope: Q3573589

## Current R2 / review round 3 of 3 (2026-11-12)
R0 NO-GO and R1 `2da0d2ddd` NO-GO (108 paired rows, 18 FAIL) are preserved.
The historical “R2” heading below was the first rework, not a reset of rounds.

Root cause addressed now: the official prompt enumerated three decisions, sending
all unanswerable questions to INSUFFICIENT despite its existing term-knowledge
contract. State the scope/request decision before evidence sufficiency and give
that existing term contract priority for unknown baseball expressions. No new
word-list guard, sentinel, classifier, model call or evidence bypass is added.
Remove the R1 second generic call entirely. Event/source mismatch still terminates
in the original validator before term rendering; numeric/date holds remain intact.
Do not reinterpret an arbitrary INSUFFICIENT as a term question.

Before: current main `9eb4702ae8519c7f08279df99410683c68c586e5`, original
“야구 글로벌 임팩트가 뭐여” → official/model_insufficient/unsure. Same-main
production reproduction q3612685; original user q3573589 and preceding context are
in the earlier evidence. After: expected existing SSOT clarification, **not measured**.
This is an official-branch contract correction, not a claim the unsuccessful R0
generic prompt approach worked. If paired current-base reproduction/after fails,
stop this approach at round 3, preserve failures, select another evidenced axis.

Reviewer execution (author did not run QA):
- paired `genius-unverified-scope.ts`: 18 cases ×3×2 =108. Assert base reproduces;
  assert all provider calls combined <=1; exact original must clarify; 12 non-baseball
  controls, known dictionary/name/scope controls retain source. No selective retries.
- `genius-evidence-hold-smoke.ts`: unknown-expression abstention must retain neutral
  hold with no generic call; event misattribution rejects TERM_UNVERIFIED,
  TERM_CONTEXTUAL and GENERAL; existing numeric/date/malformed/storage/replay.
- Required CI including the prior red gates and Vercel must pass; independent
  dedicated-account API/DM QA is still unverified. No merge/deploy yet.

Daily sample: 11/11 11:30–11/12 11:30 KST, 32 logs/8 actors; 28 exact known QA,
2 QA-marker questions (3612626/3612628), 2 identity-unconfirmed questions
(3612697/3612719). Four preceding messages queried; deleted QA context is absent,
not reconstructed. Attached `genius-daily-20261112-sample.json` contains the two
non-QA-marked questions and available context. The Olympics hold and player-affiliation
answer/tone issue are separate candidates, not fixed by this PR. Player affiliation
has not been independently fact-checked. No natural-use improvement demonstrated.
Local raw SHA256: a7c087fb36178f0606f0e6775f5f40c7bba994d726f39b95b57f3d2328bf7376.

Author type/lint/diff checks passed (pipeline existing lint warnings 5).
Graphify rebuild unavailable: Python module not installed. QA execution remains reviewer-owned.

## Historical R0/R1 evidence (superseded implementation below)


## Independent production before
Samsik Slack 1794387658.233469, deployment `9eb4702ae8519c7f08279df99410683c68c586e5`.
Disposable account, real POST /api/baseball-qa and delivered DM readback:
- “야구 글로벌 임팩트가 뭐여”: q3612685 → a3612686, unsure.
- “글로벌 임팩트가 뭐야”: q3612687 → a3612688, blocked.
- “보크가 뭐야”: dictionary; “야구 룰”: scope_guide.
Account/profile/conversation and QA messages deleted by reviewer. Exclude QA message IDs 3612685–3612692 from daily samples, NOT unrelated real-user 3612684. The range includes answer IDs; do not count all eight as questions.

## R2: deterministic post-abstention classification
R0 prompt-only changes were independently measured as ineffective and removed.
Before logs for original and replay: official / model_insufficient / unsure,
question numeric count 0, top distance 0.322721360216373.

The generic classifier probe is NOT an upstream production classification: official
RAG consumes the call before that generic path. Therefore this revision adds one
bounded generic classification call only for the current durable winner after
model_insufficient, after policy scope_guide, excluding definition/recordbook paths.
Only exact TERM_UNVERIFIED selects the existing UNVERIFIED_TERM_ANSWER (llm).
No provider prose is served; other statuses/invalid JSON retain the original hold;
provider failure is error, not misreported as insufficient evidence.
Original RAG text, discard observations and combined token costs are retained.
Final envelope storage/replay prevents reclassification; no cache write is added.
Numeric/date holds and grounded answers do not enter the new branch.

Reviewer gates (author has not executed them):
- `npx tsx scripts/qa/genius-unverified-scope.ts --base-root=<9eb4702 checkout> --out=<artifact.json>`
  Real official retrieval/generation plus generic classification; 12 non-baseball
  controls ×3, R1 clarification, synthetic R2 blocked, dictionary/name/scope parity.
  Not API/DM delivery. Preserve every failure, no selective retry.
- `npx tsx scripts/qa/genius-evidence-hold-smoke.ts`: numeric/date/malformed holds,
  original neutral hold on nonqualifying classification, storage/replay.
- Inspect scope_guide precedence, grounded/general parity, provider failure,
  exact-sentinel rejection and duplicate-worker behavior. Actual dedicated-account
  DM/readback and logs remain required for GO; reviewer credentials currently blocked.

## Author checks
Scoped TypeScript passed. Independent after-effect and DM QA are not yet evaluated.
