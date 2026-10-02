# Source-bound official sidecar: serving review

## Dependency and scope

This is a separate serving PR depending on Draft #1519 R2 `057dbab13944a1f060aee90d3faa9a79a4956c98`.
#1519's direction validation is NOT merge approval. Neither PR may be merged on that result.
Branch was created from origin/main and incorporates #1519; PR base is the prerequisite branch so the serving diff is reviewable separately. After #1519 merges, retarget main and recheck exact head/CI/reviewer GO.

The v2 parser was initially moved byte-for-byte into src; ingestion re-exports it. R1 extends it to v3 and regenerates the JSON from the same 13-source/9,152-chunk serving snapshot. No hand-authored rule/question exception list, no corpus/loader change, no source revision change, no embedding/DB migration.

The production request builder adds notes only for official tier1/kbo_ebook evidence. URL + revision + normalized digest first locate the sidecar; full raw content digest + parser version + offsets/quotes are then rederived and validated. Rendering ignores stored `note` text. A mismatch drops only the note. Retrieved evidence objects, numeric/provenance guard input, retrieval ranking, context, model count and system instruction are unchanged. Notes remain inside the untrusted reference-data region.

79 entries (145,463 bytes in the JSON), max note 1,083 characters. Runtime work is local hashing and span validation on matched selected evidence, with no network or extra model call. Rollback: revert this serving PR; source data needs no rollback. A later source refresh requires regenerating/reviewing sidecar data or the source safely receives no annotations. This PR does not claim to fix all rule interpretation errors.

## New P0: separate findings

Reviewer R2: standalone “그건 플라이아웃 아니야?” base 5/5 reversed the infield-fly batter-out effect; candidate 3/5 reversed it, other 2/5 drifted to foul handling. This occurs without the feature but is still an unresolved P0, not an accepted correct answer.

Read-only production lookup identified exact source question `2036062` (2026-09-25). The previous turn was “포구는 뭐야?”, answered 21.499897 seconds before the follow-up, job source `llm`. Thus the real exchange was a catch-definition correction, not an infield-fly question. The previous answer described catching as always retiring the batter and moving only after the catch; both deserve scrutiny in semantic review. Do not treat this prior answer as ground truth.

The exact previous-turn RPC result is local-only: `/Volumes/T7-Dev/reviews/runtime/flyout-real-context.json`. The replay-only camelCase input is `/Volumes/T7-Dev/reviews/runtime/flyout-previous-turn.json`. No user identifier or private conversation is committed. Historical timestamps are preserved so the normal context TTL selector, not fabricated dates, admits the turn. No user account is logged in and no production records are written.

Separate reviewer labels:
- Standalone: do not invent an infield-fly situation; any claimed effect must correctly say the batter is out on an infield-fly call irrespective of the catch.
- Real context: recognize the correction and distinguish catch from fly out (catch is broader; fly out is a batter-out event from catching a fair/foul fly under applicable rules). Preserve other rule conditions; no unsolicited infield-fly answer.
- unsure/error/timeout are not correct answers. Report raw/final answer, route, retrieved evidence, injected previous context and annotation exposure. Five clean samples cannot exclude all feature influence.

## Fixed reviewer budgets

Use the same updated harness in base (#1519 R2) and candidate worktrees. For baseline copy only the new harness + document-questions fixture (no src changes). Base keeps the original production builder; candidate uses the real new production builder. Do NOT pass `--annotations` or `--supplement` to serving comparisons: annotation injection must originate in production code, not the diagnostic wrapper. Trace `servingAnnotationCount` measures actual built-request notes. `--require-annotations=1` on candidate focus/document comparisons prevents a no-exposure false pass.

- `--suite=flyout-context --reps=5 --context-file=/Volumes/T7-Dev/reviews/runtime/flyout-previous-turn.json` each mode. This is the new P0's first real-context reproduction, not yet a fix.
- `--suite=flyout-regression --reps=5` each mode, separate from contextual answers.
- `--suite=exclusion-focus --reps=5`: 8×5 each mode, preserve the base failure question.
- `--suite=original --reps=3`: 18×3 each mode.
- `--suite=official-documents --reps=3`: 8×3 each mode. Questions and author source-grounded rubric are in fixtures/official-parenthetical-document-questions.json (4 guidebook/4 recordbook). Check exposure by document and exclude missing-evidence answers from claimed semantic coverage; numerical discard is reported separately.
- Existing real official 81×1 each mode through production request generation (no manual injection). Report the identified real follow-up separately from standalone replay.
- Each invocation needs a distinct absolute `--out`. Do not extend the budget until the desired result appears.

CI adds `qa:official-parenthetical-structure` and `qa:official-parenthetical-serving`. The latter imports the pure `buildRagLlmRequest` used by the production wrapper (not the DB-initializing `server.ts`), asserts the original row stays intact, wrong source/URL/revision/content/whitespace drop only annotation, and forged spans cannot render. Independent execution/semantic verdict remain reviewer-owned. Author tsc/lint are not QA acceptance.

## Open gates

No merge GO, no deployment, no production-user UI QA. Recordbook/guidebook regression and all production-wired replay are pending. New P0 remains at queue head; contextual reproduction is requested first. graphify rebuild remains unavailable (module absent).

## R1 — CI repair and leading conditional exception (2026-10-02)

Diff-changing rework round: 1 for #1520 (independent of #1519's two rounds).
CI import fix is commit `0a38769a4`; syntax extension is a separate subsequent commit.
R0 independent result: serving focused errors 4–5/40 → 0/40, but one candidate GENERAL answer had an incorrect reason; no closure claim. Real-context RAG answers were wrong in both modes (base 3/3 RAG, candidate 1/1 RAG). This remains P0.

Version v3 admits a leading `…경우를/을 제외하고(는)` conditional exception at a sentence/list boundary and retains the complete following sentence as its consequent. It is NOT a general-purpose Korean semantic parser. Nonconditional noun omissions, embedded subjects, multiline prefix fragments, multiple exceptions, parentheses, later provision boundaries and incomplete consequents are left unchanged. The rendering states that the consequent applies outside the exception, never inferring the exception's opposite outcome. No rule name/question matching is used. URL/revision/exact raw hash/offset validation and fail-closed behavior are unchanged. Source revision, loader, embeddings, DB and model-call budget are unchanged.

Author full-snapshot census: 18 occurrences of `제외하고`; only 1 safely structured new relationship. Existing 78 notes/relationship arrays remain identical; version fields are regenerated. This is one real-data example, not proof of broad syntax coverage.

### New relationship — complete author audit (1/1; independent audit pending)

- Serving chunk 192183, `2026 공식야구규칙#p62` (same exported snapshot).
- Exact exception UTF-16 [20,39): `인필드 플라이 규칙이 적용되는 경우`.
- Exact consequent: `내야수가 타구
에 닿지 않은 채 그대로 땅에 떨어뜨렸을 때는 타자는 아웃이 되 지 않는다.`
- Source meaning: non-out statement excludes the infield-fly case. Does not by itself establish what happens in that exception; a positive out conclusion still needs the other source provision.
- Retains PDF whitespace and both exact spans; no hand-authored annotation or source patch.
- Local full census: `/Volumes/T7-Dev/reviews/runtime/1520-prefix-census.json`.

Reviewer requests on exact head: run both CI smokes without any Supabase env, then the fixed budgets above (contextual 5, standalone 5, focus 40, original 54, documents 24, real 81 per mode). Use product wiring without `--annotations`; inspect p62 exposure specifically, not merely total note count. Distinguish absence of the source, non-RAG routing, exception inversion, opposite-effect inference and final numerical discard. Do not extend budgets to obtain clean samples. Author tsc/lint/syntax/diff-check are not independent QA. graphify is still blocked by missing Python module.
