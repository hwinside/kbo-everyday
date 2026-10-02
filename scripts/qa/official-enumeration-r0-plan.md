# Flyout P0 — R0 boundary-context experiment (not a serving fix)

Base: main d441c08837f94ad23fd2e8b99de1157df24b1de6 (#1520 deployed).
No src, loader, database, embeddings, source revision, workflow or production request changes.
Prior p62 leading-exception extension was rejected twice and remains withdrawn. This new
experiment does not reset that history or claim P0 resolved. New hypothesis: a retrieved
numbered item needs its missing parent predicate, not another annotation on the exception.

## Source evidence and scope

Serving export: `/Volumes/T7-Dev/reviews/runtime/excl-serving-r1.jsonl` plus `.snapshot.json`,
exported 2026-10-02 10:02:10 UTC. Not a new live snapshot. Hash/revision/section mismatch
at replay drops the annotation, not original evidence. No claim of current source freshness.

Audited corpus: `/Volumes/T7-Dev/reviews/runtime/infield-full-v31.jsonl`.
Audit: `/Volumes/T7-Dev/reviews/runtime/pr1401-out/v31-audit.json`.
This is an UNDEPLOYED corpus, used only as offline documentary context. Its full bytes match
the PDF-verified, zero-lost-characters audit. Hashes and complete five-binding inventory are
in `fixtures/official-enumeration-r0-audit.json`. We do NOT replace serving content with it.

Generic join (no rule name / question branch): require an atomic complete numbered item,
a complete declarative lead, same document title and article, and entire item text match
ignoring whitespace only. Conflicting parent scopes are omitted. Existing leads are not
repeated. Every binding records source text hash and exact lead/item offsets. Read-only
export source generation/revision/hash is validated before generation. No model-generated
or hand-written rule statements. Remaining limitation: trusts the audited v3.1 parser's
parent selection; reviewer must inspect every surviving binding before semantic replay.

Generated: 34 candidate items, 3 serving chunks, 5 bindings:
- p45: 5.05(b)(4), safe first-base entitlement with both provisos retained.
- p60: 5.09(a)(4)/(5)/(6), batter-out lead (including infield fly).
- p65: 5.09(b)(5), runner-out lead with appeal limitation retained.
Physical PDF page numbers differ from serving printed-page labels; never equate them.
No inference from 'except' to the opposite outcome. No inferred catch/no-catch sentence.

Reproduce manifest (new output pathname required):
```
node scripts/baseball-qa/rag/emit-official-enumeration-context.mjs --serving=/Volumes/T7-Dev/reviews/runtime/excl-serving-r1.jsonl --corpus=/Volumes/T7-Dev/reviews/runtime/infield-full-v31.jsonl --audit=/Volumes/T7-Dev/reviews/runtime/pr1401-out/v31-audit.json --out=/absolute/new-enumeration.json
```
Author-generated manifest: `/Volumes/T7-Dev/reviews/runtime/flyout-enumeration-r0.json`.
The generator inventory is not QA PASS or proof of response improvement.

## Independent reviewer execution — fixed budget, no success-driven repeats

1. `node scripts/qa/official-enumeration-context-smoke.mjs`; inspect all five real bindings
   against their stored source text and audit. Check wrong document/article, conflicting
   lead, truncated item, no complete lead and offset cases.
2. Same R0 harness, both modes, `genius-infield-evidence-live.ts`:
   - flyout-context: 10 baseline + 10 candidate;
   - flyout-regression: 10 baseline + 10 candidate.
   Baseline omits annotations; candidate adds `--annotations=<generated manifest>`.
   Both use `--reps=10 --out=<unique absolute output>`.
   Context mode also requires `--context-file=/Volumes/T7-Dev/reviews/runtime/flyout-previous-turn.json`.
   No supplement option. Base code is unchanged main. Existing #1520 notes are preserved
   before experiment injection. Separate experimental exposure prevents false PASS merely
   because an old parenthetical note was exposed. Error/unsure/non-RAG are not correct.
3. Isolate retrieval/routing variation: run `genius-enumeration-paired-replay.ts` ONCE for
   each of the two captured baseline outputs with `--baseline=... --annotations=... --out=...`.
   It reuses the exact captured question, evidence order/content and extras, adds only the
   derived context and calls generation once per original official call (cap 20 per suite).
   Compare each captured baseline raw answer to the candidate. No new search, classifier,
   account writes or pipeline calls. This is generation-only: no final numeric/provenance
   guard and no UI PASS claim. Report zero exposure as HOLD. Do not extend fixed budgets.

Real question 2036062 follows '포구는 뭐야?' (~21.5 seconds), not an infield-fly context.
Private original answer/timestamps remain local; the prior answer is not a gold answer.
Contextual success must distinguish catching from a flyout and acknowledge the correction;
unprompted infield-fly detour is NOT success even if its effect is correct. Standalone
success must not invent prior context. Separately count any infield-fly out-effect reversal.

Record raw/final correctness, wrong-topic, unsure/error, RAG/LLM, evidence and exact
experimental exposure, and latency. Source not selected is retrieval HOLD, not semantic
improvement. Existing 5.05/5.09(b) scope must be audited even if flyout runs never select it.

## Next gate

R0 is a Draft experiment for design and evidence, not a deployable P0 patch. Only if fixed
budget evidence supports the hypothesis, propose a source-bound production integration
and run exclusion-focus 8x5, original 18x3, documents 8x3, official81 regression. If contextual
routing still chooses an unrelated rule, investigate that separately; do not hardcode this
question or treat the infield-fly improvement as resolution of actual conversation 2036062.
Independent reviewer GO and explicit owner merge approval are still required for any merge.

## Author static checks

TypeScript `tsc --noEmit`, changed-file ESLint and generator syntax checks completed with
exit 0. No author-run QA/semantic PASS claim. Graph rebuild attempted but unavailable:
`ModuleNotFoundError: No module named 'graphify'`. Independent smoke/live replay pending.
