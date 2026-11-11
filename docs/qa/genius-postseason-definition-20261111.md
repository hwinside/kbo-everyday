# 2026-11-11 canonical postseason definition

## Observation and current-main reproduction
Window: Nov 10 11:30–Nov 11 11:30 KST. Seven logged questions / two actor keys. Separate exact prior QA QIDs 3573463/65/67/69/71/73; one unmarked question remains (identity unconfirmed). Q3573589 actual DM3573590 equals completed job.answer; four preceding messages retained in sanitized fixture. Global-impact question remains unsure, not solved.
Q3573465 “포스트시즌 알려줘” returned “와일드카드 결정전 승자 간 준플레이오프”. This is an independently observed production QA failure, NOT a natural-user case. Deleted QA account's preceding messages and actual DM cannot be queried today: preserve logged answer, do not invent missing context. Earlier Q3471278 also returned tournament exposition instead of a definition; no claim of new natural-user reproduction.
Current origin/main b27af12e0 and operational 169-row snapshot lack a postseason definition (and its autumn-baseball alias). Existing official-RAG paraphrase can omit one participant. The scoped cause fixed here is missing canonical concept coverage, not the general RAG summarizer. Use the existing sourced glossary mechanism, one row; no term-specific router/regex guard. Broader RAG relation omission remains unresolved.
Before: current glossary has no exact definition; observed production paraphrase is wrong. After EXPECTED, NOT measured: definition names WC 4th vs 5th, semi-PO 3rd vs WC winner, PO 2nd vs semi-PO winner, KS 1st vs PO winner. Never claim a new paired live-RAG before measurement.

## Ground truth
2026 KBO League Regulations Articles 30/34/38/42, PDF pages 44/46/48/50: https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_%EB%A6%AC%EA%B7%B8%EA%B7%9C%EC%A0%95.pdf
Official text explicitly states “KBO 정규시즌 승률 3위구단과 KBO 와일드카드 결정전 승리구단”. Source text checked against locally preserved official PDF extraction. Editorial synthesis, not a verbatim quote; metadata editorial_definition/version2026. No current teams, dates, predictions, fixed maximum actual games, or historical formats.

## Reviewer-only executable reproduction and regression
`npx tsx scripts/qa/genius-postseason-definition.ts`
Author writes, reviewer executes/judges. PGlite imports all169 baseline rows, asserts missing baseline concept, applies migration twice, compares all old fields, rejects normalized alias collisions. Real answerQuestion tests eight definitions including observed question and autumn alias with no LLM calls. Twelve boundaries cover dates/current bracket, winning teams/probability, comparisons, adjacent existing definitions, and actual new unmarked question. Preserve existing match; do not swallow non-definition. Exact-content rollback preserves operator edit and restores baseline. QA runner not added to CI/workflows in this scoped change.
Run existing glossary-map/tone-ssot and definition-intent regressions as relevant; independent extra counterexamples encouraged. Baseline-vs-head glossary harness is not paired live RAG or end-user QA. QA source facts must be read independently, not judged just by copied string assertions.

## Deployment / safeguards
Only after exact GO + required checks under Nov1 daily standing approval: fresh entire glossary snapshot must equal reviewed169; transactionally insert one row, verify170 and all old columns unchanged, register this migration. Abort on drift/conflict; DO NOTHING alone is not deployment success. No DM/cache rewrite. Rollback SQL only exact inserted contents, never operator changes. Confirm deployment READY/SHA/domain and conservative10min glossary TTL; reviewer dedicated-account UI asks original question, autumn alias, dates/current bracket, adjacent definitions. Capture actual DM/QIDs/content facts/errors/cleanup. Production/real-use/native QA currently unverified.

## Preserved work and round limit
#1541 exact22d58f13 NO-GO11 preserved, failed approach stopped. #1536 Draft duplicate design (already incorporated elsewhere) preserved/recommend closure; #1537 Draft effect HOLD/context reversal preserved/not productized; #1523 CLOSED, branch7d582382 preserved; #1391 HOLD. gh pr list + git ls-remote checked before new branch. No active daily PR to resume; no duplicate scope.
New PR R0, 0 rework; maximum3 review rounds then stop failed approach and switch axis. Graphify availability and author type/lint are reported separately. No author QA execution, main/force/workflow push, destructive DB, or retroactive DM.
