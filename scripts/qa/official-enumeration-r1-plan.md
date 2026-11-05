# #1521 R1 — retrieval diagnosis, NOT a serving fix

R0 `87a01c61` is NO-GO. Its five bindings passed independent source inspection,
but p60 reached neither live (40 calls) nor paired (20 calls) model inputs.
Only p65 runner-out context was injected. Real-context success fell 9/10 → 0/10;
standalone improvement cannot compensate or establish the p60 hypothesis.
Evidence: `/Volumes/T7-Dev/reviews/runtime/art1521r0/`.
R0 reproduction remains available, but its model-input annotation design is rejected.
The next experiment must not silently reuse `--annotations`.

## R1 observed result (author diagnostic, not independent QA)

Full local artifact: `/Volumes/T7-Dev/reviews/runtime/1521-r1-retrieval.json`.
Reviewable measurements: `fixtures/official-enumeration-r1-distances.json`.
Live snapshot contained **9,152** eligible chunks (not the earlier 9,150); 13 embedding
calls, seven queries. Stored vs unchanged-text distances agree to five decimal places.

p60 stored → lead-bound (distance / exhaustive rank):
- 플라이아웃: 0.41377 / 13 → 0.41883 / 17.
- 그건 플라이아웃 아니야?: 0.39376 / 11 → 0.39422 / 11.
- 포구는 뭐야?: 0.41862 / 125 → 0.43820 / 657 (crosses 0.42 cutoff).
- 포구와 플라이아웃은 어떻게 달라?: 0.36934 / 11 → 0.38259 / 20.
- 인필드 플라이 아웃: 0.29544 / 6 → 0.29403 / 6.
- 인필드 플라이가 선언되면 타자는 아웃이야?: 0.28962 / 5 → 0.27192 / 5.
- 인필드 플라이를 떨어뜨리면 타자는 아웃이야?: 0.28966 / 5 → 0.26980 / 5.

Important correction to the retrieval hypothesis: p60 DOES occur in production RPC
candidates for the original question at rank 11. The reviewer's original R0 traces
independently confirm it: ctx/reg × base/candidate **40/40 retrieval traces** contain
p60 at rank 11, but **0/40 generation inputs** do. `pipeline.ts` passes the candidates
through `selectEvidence` (`retrieve.ts`), which takes the first six nonempty same-grade
rows. p60 is lost at this final evidence cutoff, not at the RPC threshold or top-12 gate.
The existing 40-call traces establish this without rerunning generation.

Decision: **do not propose production re-embedding on these results.** It does not
improve original-question rank and worsens two catch/flyout queries. Explicit infield
fly questions already retrieve p60 in the top six. Do not increase evidence count or
pin p60 simply to make this experiment pass. Next investigation is context-aware
evidence relevance/selection versus GENERAL, separately from scope binding. R1 is
review-ready diagnostic evidence, not a request to accept R0 or claim P0 resolution.

## R1 question and bounded read-only measurement

`scripts/baseball-qa/rag/diagnose-enumeration-retrieval.ts` uses the same embedding
model, query/document formatting, threshold (0.42) and candidate limit (12) as serving.
It GETs tier1 document serving vectors, compares source generation/revision before and
after, and calls the read-only production search RPC with each of seven fixed queries.
It checks all three R0 target content hashes and their original lead/item bindings.
No answer generation, account/cache/log writes, corpus mutation, refresh or migration.

For each target it reports:
- stored-vector exact cosine distance/rank across the entire eligible snapshot;
- newly embedded unchanged text (control for model/index drift);
- newly embedded original lead + unchanged text (local counterfactual only);
- production RPC results separately (ANN results need not equal exhaustive local ranks).

Each counterfactual replaces ONE original id, never supplements a duplicate. A rank
within 12 still does not establish selection among six model evidences or semantic QA.
Thirteen embedding calls total: six document calls and seven queries; no success-driven
retries. Failed infrastructure preflight is not a completed comparison.
Whole-chunk prefix is a diagnostic hypothesis, NOT a safe ingestion contract: a lead
cannot be propagated over unrelated or partial items without a separate scope audit.

Gateway execution (protected credentials inherited, public URL configured separately):
```
node --use-env-proxy --import tsx scripts/baseball-qa/rag/diagnose-enumeration-retrieval.ts --manifest=/Volumes/T7-Dev/reviews/runtime/flyout-enumeration-r0.json --out=/absolute/new-result.json
```

## Model-input scope decision

Do not deploy a query-word list or p65 blacklist, nor assign relevance from the mere
presence of a retrieved chunk. R0 proves neither that its derived note is relevant nor
that a correct runner-out note helps a catch/flyout conversation.
For the next retrieval-only experiment, NEW model-input notes are disabled on ALL
chunks, including p65. Existing #1520 parenthetical serving remains unchanged.
This is containment, not a claimed relevance solution. Do not label it B2 resolved.
If model-side parent context is later needed, first select complete item-level evidence
with its original parent attached; evaluate relevance with the prior turn and permit
GENERAL/clarification when no item answers the question. No arbitrary lexical cutoff.

## Proposed DB change boundary and rollback — NOT authorized/applied by this PR

First use local shadow vectors and preserve stored content/ids. Initial diagnostic
scope is exactly three target chunks, not all 9,150 official chunks or all 12 sources.
No loader-wide revision bump. Do not mutate production to discover whether it works.

Before any actual DB proposal:
1. Audit full item boundaries and parent scope; produce an exact id/content/embedding/
   revision/claim-generation before-image and candidate hash inventory. Derive the
   changed count from the resulting manifest, not a guessed whole-corpus refresh.
2. Prefer a versioned shadow index + gated reader whose original index remains intact.
   Show schema, transactional publication, current-generation CAS, embedding model/
   dimension/input-version and index build/storage cost. Concurrent source changes
   abort publication rather than overwrite fresh content. Loader reingestion must
   preserve the chosen embedding-text contract.
3. Rollback switches the reader to the untouched original index; no reverse inference
   or costly full re-embedding. If proposing in-place writes instead, exact before-image
   restoration with post-apply hash CAS and rollback rehearsal is mandatory. No such
   mutation tool or SQL is included in R1.
4. Get exact-SHA independent GO and the applicable explicit approval for that concrete
   mutation/deployment. This diagnostic does not request merge or DB approval.

## Next independent gate

First inspect R1 distances/ranks and the unchanged-text embedding control. If p60 still
does not reach candidates, stop: widening thresholds or pinning p60 is not evidence.
If supported, prepare a local replacement-vector retrieval mode (no duplicate, no new
model note), then fixed-context/standalone base vs candidate 10 each with exact query,
prior turn, candidate/rerank/selected-evidence traces. Separate retrieval changes from
semantic parent rendering; do not mix both interventions in one comparison.
Real-context success must answer the catch vs flyout correction. Unprompted infield-fly
detours, effect reversal, unsure/error and unexposed p60 remain separate failures/HOLD.
Any serving proposal still needs focus/original/documents/official81 regressions.

P0 remains unresolved; no production code, loader, database or workflow change.
Rework history: #1519 R0/R1 and #1520 R0/R1/R2 remain recorded in their PRs; #1521 R0
NO-GO is not erased by this R1 diagnostic or a future PR split.
