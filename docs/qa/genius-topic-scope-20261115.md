# R2 revision — reviewed beginner introduction (R1 NO-GO retained)

Reviewer Slack1794710513.036889 / correction1794710533.930569: exact ecdff5df NO-GO, round1/3. Source unchanged from47dad0cf, paired96 head topic13/21 unsure; original first question3/3 unsure, second2/3 unsure. Some successful RAG responses describe disciplinary regulations or advanced terms. Artifact `workspace/state/qa/1636/paired.json`. **Routing-only approach failed; no improvement claimed.**

R2 removes probabilistic retrieval from broad beginner-topic definitions: a small static vetted glossary extension supplies basic game goal, scoring, three outs and innings; the terms introduction also defines batter/pitcher/runner. The same existing residue grammar identifies a topic with no remaining specific referent. Capability/compound/specific/negative requests keep their existing owners. Existing DB glossary entries retain priority. This follows the existing `VERIFIED_TERM_ORIGINS` static glossary extension pattern: no migration or keyword-by-question exception, no model call for these introductions. Source remains `dictionary` (reviewed editorial definition), not official-RAG/generated evidence.

Evidence: repository original official2026 rulebook page25 rules1.02–1.06 and page91 rule5.09(e), `scripts/qa/fixtures/kbo-rulebook-boundary-pages.json`; definition INNING. Third-out scoring caveat retained; no innings limit/season facts/numeric live claims. Independent reviewer must verify text and boundary overmatching. Broad-topic parsing uses the same grammar in capability-required and domain-topic modes; no duplicated parser.

R2 acceptance: repeat paired96 with current head; all7 topic forms must return accurate dictionary introductions, meta3 stay scope_guide, specific/control6 unchanged. Run original fixture with previous context and no context, refusal/mascot/full CI. Added assertions check goals/outs/inning and reject disciplinary jargon. Paired numeric success still is not factual/UI PASS. Base M1/M21 mutation misses are pre-existing P1, preserved and to be tracked separately (not covered by this PR).

---

# Topic explanations vs capability questions — 2026-11-15

## Evidence and cause
Base/main: `70e6a1b4747b731903e7287b8252bb1c6212b4c2` (#1634).
Production Q3690662 `야구룰 알려줘` and Q3690664 `야구 룰` both returned the identical SCOPE_GUIDE_ANSWER, actual DM3690663/3690665. Previous four messages and actual replies are in `scripts/qa/fixtures/genius-topic-scope-20261115.json`. Personal IDs omitted. QA identity unconfirmed, not claimed natural-user proof.

`isScopeAskPhrase` treated domain nouns (야구/룰/규칙/용어) as sufficient evidence of a capability request. Removing the grammatical shell erased the requested topic, bypassing all content answering. The change requires an assistant/capability subject from the existing vocabulary. Topic words remain in the existing residue grammar so `야구 질문 뭐 물어볼 수 있어` retains scope guidance. No question-specific guard, extra provider call, source label, schema or workflow changes.

## Before / after
- Before: actual two questions + DM show scope_guide, no rules explanation. Base paired reproduction is mandatory.
- After expected: existing answer pipeline answers broad rule/topic requests; meta-capability requests retain deterministic scope_guide. **Live content improvement not yet measured; routing alone is not success.**
- No claim of fixing #1630 official factual errors, #1635 static-only freshness, probabilistic transfers, or all beginner explanations.

## Independent reviewer execution
Author wrote scripts but did not run QA. Typecheck, lint and whitespace are author checks only.
1. `npm run qa:genius-refusal-scope` — actual answerQuestion with controlled dependencies, content/meta split and existing refusal paths.
2. Existing mascot-motion QA: scope guide uses a real capability question now.
3. In a reviewer worktree, with protected provider/DB read credentials: `npx tsx scripts/qa/genius-topic-scope.ts --base-root=<base-worktree> --out=<review-root>/paired.json`.
   16 cases × 3 repeats × base/head = 96 rows; original two requests include previous turn selected from the preserved four-message context. DB/DM/cache writes forbidden, durable state in memory; roster/game-conversation and normalization wiring are not production-complete. Do not call this production E2E.
4. Review **actual content**: basic goals, scoring, outs/inning structure must be relevant and accurate; retaining only unsure/hold or a service menu is FAIL. Compare boundary/control answers base/head. Factual correctness is explicitly not auto-PASS in the harness.
5. RAG numeric/identity and existing refusal-scope mutation suite, with TMPDIR under OPENCLAW_REVIEW_ROOT. Confirm capability particle/no-space boundaries, specific terms, out-of-scope/injection and polite-topic variants. Source change counters must not silently weaken mutations.
6. After exact GO + required checks, daily standing approval allows merge. Then reviewer dedicated-account UI→DM QA of original pair, polite variation, capability question, specific rule, and out-of-scope controls. Actual DOM=stored DM, cleanup; native/natural-use unverified separately.

## Daily sample and preserved work
Window Nov14 11:30–Nov15 11:30 KST: 59 logs / 58 questions / 13 hashed actors; one correction duplicate. Auth-present16, absent42, marker0. Absence does not establish QA; all unconfirmed identities retained separately. Available context42/jobs42/actual replies41 questions. Missing/deleted DM is not inferred delivery failure. Raw hash `7dcc510c3f6f1327616842507840c94fac8f698e55ab64ddaed03e84571e0c89`.
#1633/#1634 merged; independent UI/DM8/8 and10/10 in original thread, #1632 closed/#1635 open. They do not fix this topic/meta axis. #1629 NO-GO3/3 stopped, Draft; #1541 NO-GO11 stopped, preserved exact22d58f13; #1523 closed/remote preserved, #1536/#1537 Draft preserved (overlap/ineffective experiment evidence remains in daily state). No closures/deletions/count resets. #1391 short-rule intent differs: this change only removes deterministic topic-to-capability interception.

Graphify unavailable (`ModuleNotFoundError`), explicitly not a successful rebuild. Maximum three review rounds for this PR; preserve unsuccessful approaches and switch axis after third NO-GO.
