# Jev offline shadow (experimental; no production imports)

Owner: 삼순 (runner), 삼식 (independent labels, live execution, verdict).
This is **not** a production integration, model-quality PASS, or merge authorization.
AI SDK `7.0.105` and its lockfile are isolated here; application dependencies are unchanged.
Node >=22. Official API: https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway

## Install / implementation self-check

```sh
cd scripts/experiments/jev-shadow
npm ci --ignore-scripts --no-audit --no-fund
npm run selfcheck
```

The synthetic self-check does not call a model and is not independent QA.

## Independently prepared data (never commit production samples)

Stage 1: 200 de-identified JSONL cases, 100 per routing task (baseball_scope/stat_intent), 50 tune + 50 holdout per task. Citation is excluded/HOLD until historical evidence exists. The runner also accepts 300 cases when all three tasks are explicitly included.
Each task includes >=25 questions of <=6 Unicode code points after trimming,
>=50 independently verified failure/boundary cases and >=20 with prior turns.
These are overlapping quotas; the runner uses this conservative per-task interpretation.
Reviewer must verify failure/boundary provenance, de-identification, and group membership.
A numerical quota alone is not proof of representative sampling.

```json
{"case_id":"case-synthetic-1","task":"citation","question":"희생플라이?","prior_turns":[],"candidate_answer":"희생플라이는 타수에서 제외합니다.","evidence":["희생플라이는 타수에 포함하지 않는다."]}
```

- Tasks / label enums: `baseball_scope`: `BASEBALL|NON_BASEBALL|AMBIGUOUS`;
  `stat_intent`: `RECORD|NARRATIVE|NA`; `citation`: `SUPPORTED|CONTRADICTED|INSUFFICIENT`.
- `prior_turns` is chronological `string[]`, max 2; include speaker designation in each string if needed.
- `evidence` is `string[]`; citation requires `candidate_answer` and evidence (empty array allowed).
- Separate `baseline.jsonl` rows contain `{case_id,current_label,stratum}`; `current_label` may be null (unrecoverable baseline, quality comparison HOLD). `stratum` is `string[]` of `short|failure_boundary|multi_turn|ordinary`.
- IDs must be pseudonyms matching `case-[a-z0-9-]{1,60}`, not original account/conversation IDs.
- The model receives only question/prior turns, plus candidate/evidence for citation.
  Baseline `current_label`, task labels, case ID, strata, split and gold are never supplied as state.
- Gold stays in a separate reviewer-owned `labels.jsonl`:
  `{case_id,gold_label,label_reason,reviewer}`. Runner cannot load it.
- Logs such as match_path/tone_compliant are **not independent gold**.
- Do not use synthetic examples as production-quality evaluation evidence.

Reviewer provides `split.json` with a fixed seed and assignment:

```json
{"seed":20260919,"cases":[{"case_id":"case-synthetic-1","group_id":"group-001","split":"tune"}]}
```

This example is deliberately incomplete and fails the full-dataset validator.
`group_id` must represent connected components linking BOTH shared conversations and
normalized near-duplicate questions, including cross-task duplicates. Seed alone does
not prove grouping; preserve the sampling/normalization procedure in the review protocol.
Runner verifies group-disjoint splits, exact ID coverage and quotas; it does not invent
missing cases, gold labels or groups. Freeze input and split hashes before looking at holdout.

## Validate and run (삼식 after full gold / input review)

```sh
node runner.mjs --input /protected/cases.jsonl --baseline /protected/baseline.jsonl --manifest /protected/split.json --split tune --out /protected/tune-run
```

Without `--live`, only validates and prints hashes; no credentials/network required.
For live evaluation use the same command plus `--live --reviewed-input-sha256 <input hash>`.
Configure `AI_GATEWAY_API_KEY` or valid Vercel OIDC in the process's protected environment;
never put secret values on the command line or in Slack. This runner does not extract credentials.
For holdout use `--split holdout --frozen-protocol-sha256 <sha256 of reviewed frozen protocol>`.
This binds an attestation, not cryptographic proof of correct tuning; reviewer retains the protocol.
The output directory must be new and its parent must exist.

Routing-only: each split calls 100 cases three times (300 calls/split, 600 total). Three-task mode: 150 cases per split three times (450/split, 900 total). Serial requests,
10s timeout, SDK retries disabled, ZDR enabled. API charges still apply; not “cost 0”.
At the first provider/schema/auth/rate-limit error, stop with `INCOMPLETE_HOLD`;
completed rows remain on disk. No retry, silent model fallback, or replacement case.
Do not infer >=99% success from partial outputs; investigate and document any rerun.
Each row is checkpointed immediately; interrupted runs have no completed summary.

Output per repeat is **only** `case_id,predicted_label,confidence,latency_ms,provider_status,error_code`.
No source text, raw provider response, headers or SDK error messages are stored.
`confidence` is native `providerMetadata.typesafe.confidence.decision`, nullable;
NOT selected-class probability. Missing confidence is never replaced with 1 or 0.
`run.json` binds model alias, SDK, input/split/runner/lock/prompt hashes and protocol hash.
The provider model alias may move; these hashes do not pin provider weights.
`summary.json` gives success, end-to-end per-call p95 and three-repeat agreement overall
and by task. Complete-case and all-case agreement denominators are separate.
It always leaves quality verdict HOLD. No majority-vote selection of a favorable repeat.

## Pre-registered quality gates (independent reviewer computes from separate gold)

Citation-specific criteria remain HOLD in the two-task stage; never count them as PASS.

Holdout only, thresholds/abstention policy fixed using tune first:
- Newly introduced harmful errors: 0 observed (not a zero-population-risk claim).
- Macro-F1 improvement >=5 percentage points versus current_label.
- Citation incorrect pass reduction >=30%; if baseline count is zero, relative reduction
  is undefined and must be explicitly adjudicated, never reported as an improvement.
- Unnecessary rejection of correct answers increases <=2 percentage points.
- Call success >=99%; p95 added model-call latency <=700ms.

Freeze task-specific harmful-error definitions, numerator/denominator definitions,
confidence/abstention handling, zero-support classes, baseline-zero handling and the
three-repeat acceptance rule in the protocol BEFORE holdout. Report each task, short
queries and each repeat separately. No independent gold/partial run => HOLD.
This runner reports raw predictions, not policy-adjusted metrics or an automatic GO.
Deterministic numeric/date/current-roster checks remain authoritative; Jev must never
turn their failure into a pass. Production enablement requires a separate reviewed change.

## Read-only candidate export

`extract-candidates.mjs --out /protected/new-export-dir` uses the existing protected
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment and only GETs
question logs, jobs and exact-linked message conversation metadata. No database writes.
Window is inclusive 2026-08-20 09:37:59 through 2026-09-19 09:37:59 KST.
Up to 200 actual cases per task; seeded failure/short/context-prioritized selection.
No synthetic padding. Broad stat keyword selection is candidate selection, NOT gold.
Question normalization removes punctuation/spacing/symbols and uses NFKC/lowercase;
normalized bigram Dice >=0.9 links near duplicates (minimum length 4; length ratio >=0.8).
Conversation and text links form connected groups across all tasks before sampling.
Raw IDs remain in process memory only; output case/group IDs use a random HMAC salt
which is destroyed on exit. Existing exports are never overwritten.
Automated email/phone/UUID/URL/mention/token redaction is only a first pass; the
independent full-text privacy audit is required before any model calls.
`prior_turns` reconstructs up to two earlier logged question-answer pairs in the same
conversation WITHIN the window; this is not proof of the precise historical model context.
Historical citation evidence is not in the log schema; missing evidence is omitted,
flagged in baseline and counted. Never substitute current retrieval or label it as
a genuine INSUFFICIENT judgment. Logs' route names are not scope/intent ground truth;
only exact persisted RECORD/NARRATIVE tokens become a stat baseline, all else is null.
No text/IDs go into the extraction report, only counts and absolute time bounds.
Exports: candidate-pool.jsonl, baseline.jsonl, groups.jsonl, extraction-report.json.
Reviewer creates final cases.jsonl / labels.jsonl / split.json after the full audit.

## R1: group-disjoint split without splitting the large connected component

`node propose-routing-split.mjs --dir /protected/export --out /protected/new-proposal`
creates a **reviewer proposal**, not a frozen evaluation dataset. The large component
is real: 168 valid conversations linked through common/near-duplicate questions, not
a shared missing-conversation sentinel. Keep it intact: choose <=50/task exclusively
for tune, leave all other rows of that component unselected; choose 50/task holdout
from other components. The proposal has quota counts and pseudonymous unselected IDs
with reasons. Statistical distribution differs between components; report split-level
strata and do not claim representative population accuracy. `groups-v2.jsonl` retains
the original groups; it does not manufacture independence by breaking links.

Missing-conversation rows are outside model candidates and retained separately in
`exclusion-audit-v2.jsonl` with masked question, candidate task memberships, short/failure
strata and `multi_turn_status: UNKNOWN_MISSING_CONVERSATION` (not false). No original
IDs/timestamps are retained. They have independent roots joined only by normalized
text links; they never share a null-conversation bucket. Review this audit against
candidate strata before accepting selection bias. `--excluded-out` plus
`--diagnostic-only` exports the audit without overwriting the original candidates.

## Native incumbent baseline and pre-mapping confusion

```sh
./node_modules/.bin/tsx baseline.mjs --input /protected/candidate-pool.jsonl --out /protected/baseline-v2.jsonl
```

Default is validate-only; `--live` runs up to 400 routing candidates with protected
`GEMINI_API_KEY`. Uses the current pure Gemini prompt/request builder at this source
revision, not a copied approximation. The same question and supplied prior pairs go
to the incumbent; the harness extends contents to both supplied pairs, while the
production builder normally receives one selected pair. No historical roster/context
snapshot is recreated. This is the incumbent **LLM classifier component** baseline,
not an end-to-end historical route reproduction. No production pipeline/log/cache/DB
write imports. One call per candidate, 15s timeout, no retries. Provider HTTP/rate-limit/timeout errors stop the run; classifier schema errors remain explicit rows and do not silently drop remaining cases. Use --task stat_intent to run that task only without recalling completed scope cases.
Baseline latency includes generation (the incumbent combines classifier and answer).

`native_prediction` is preserved. `RULE_TERM` has `prediction:null`, successful
provider status, and no silent conversion to NA/NARRATIVE. Native NOT_BASEBALL/UNSURE project to NA in stat_intent under mapping v2; both native and mapped counts stay visible. Scope status projection
and unmapped intent are recorded in `baseline-mapping.json` with an explicit version.
Reviewer must version any later RULE_TERM mapping before holdout. Only after independent
gold is available, produce BOTH raw-native and mapped confusion matrices:

```sh
node baseline-report.mjs --cases /protected/final/cases.jsonl --baseline /protected/baseline-v2.jsonl --labels /protected/labels.jsonl --manifest /protected/final/split.json --mapping baseline-mapping.json --out /protected/baseline-confusion.json
```

Counts are per task AND split; errors and unmapped predictions remain visible. A partial
baseline or missing gold fails the join instead of dropping rows. Input/mapping hashes
bind the report. The report never generates gold or automatically declares GO.
