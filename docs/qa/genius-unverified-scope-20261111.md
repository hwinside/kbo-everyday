# Unverified expression scope: Q3573589

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
