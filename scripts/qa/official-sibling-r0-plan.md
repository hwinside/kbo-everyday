# Flyout sibling R0 — read-only experiment, not a serving patch

Base: origin/main e5f258449 (includes #1521 5df4f016). New branch, no DB, loader,
embeddings, src, workflows or deployed request changes. Existing R0–R5 failures in
#1521 remain part of the history; this does not claim P0 closure or reset them.

## Hypothesis and deliberate design HOLD

p60 was retrieved at rank 11 but discarded by the final six-record selector. Do not
pin that page, change rank, drop existing evidence, call another model or infer a
positive rule from an exception. At generation only, consider the already retrieved
candidates in RPC order. Append at most one missing, source-bound enumeration chunk
to an anchor from the same canonical URL, revision and explicit article header.
The full sibling content and its audited parent/item quotes carry their own section
and hash. Article identity is a structural relation, NOT proof of question relevance.
R0 deliberately tests whether this broad relation causes another wrong-topic regression.

**Six primary records are preserved, but six plus one is SEVEN physical chunks.**
This is not compliance with a strict six-physical-chunk production cap. Do not ship
this bundling as a way around that cap. This Draft requests experiment/design review;
if the cap is non-negotiable for experiments too, stop before paid replay and review
this conflict. Production needs a separately reviewed evidence-unit/citation contract.
The experiment leaves pipeline guard evidence unchanged, so appended-only facts can
be rejected by guards: report raw AND final answers. It cannot establish end-to-end
provenance or production QA. Do not loosen guards to make the experiment pass.

At most 1,800 added characters globally, no truncation. Original primary byte strings,
order, official metadata, date, #1520 annotations, #1521 context instruction and
server transport are preserved. No standalone p65 annotation. Sibling matching requires
full raw hash/revision/URL/section identity, item containment, article agreement,
audited source-text hash and exact quote offsets. Missing/stale/conflicting source
identities fail closed. Already selected siblings are skipped. No network source fetch.
The model-input mutation is limited to the diagnostic harness's explicit --siblings flag.

## Input provenance

Regenerate via the existing read-only audited generator (new output filename):
```
node scripts/baseball-qa/rag/emit-official-enumeration-context.mjs --serving=/Volumes/T7-Dev/reviews/runtime/excl-serving-r1.jsonl --corpus=/Volumes/T7-Dev/reviews/runtime/infield-full-v31.jsonl --audit=/Volumes/T7-Dev/reviews/runtime/pr1401-out/v31-audit.json --out=/absolute/new-siblings.json
```
These are the historical 2026-10-02 snapshot and undeployed audited v3.1 documentary
corpus, NOT a fresh DB export. Re-read all 5 bindings/3 chunks; old inventory is
scripts/qa/fixtures/official-enumeration-r0-audit.json. Runtime live candidates must
still match full hashes and revision. Zero exposure terminates HOLD, never PASS.
No raw private conversation is committed.

## Reviewer execution, fixed budgets

1. `npx tsx scripts/qa/official-sibling-evidence-smoke.ts` (author writes, reviewer runs).
2. After design acceptance: same new harness on both modes; baseline has NO experiment
flag, candidate only `--siblings=/absolute/new-siblings.json`. No --routing, --selection,
--annotations or --supplement. Both retain deployed #1521 context behavior.
3. Fixed 239 observations per mode, once: flyout-context 10, flyout-regression 10,
exclusion-focus 8x5, original 18x3, official-documents 8x3, official81 81x1,
context-rules 4x5. Use unique absolute --out. Context suites use the existing real
--context-file; official81 uses the existing --questions-file. Same input and budgets.
Do not rerun until success. If a control suite has zero eligible siblings, preserve
its completed output and report non-exposure HOLD for the intervention (not a crash).
4. Inspect `sibling-bundle`: candidate/anchor indices, section, addedChars, primaryCount,
physicalChunkCount and exact modelEvidence. Count p60 reaching the model, not RPC only.
Compare raw/final correctness, wrong topic, unsure, error, route, input/output tokens,
p50/p95 and error/timeout counts. No selecting favorable samples.

The real prior turn is '포구는 뭐야?'. Correct infield-fly law alone is NOT a correct
answer to the correction. Keep standalone ambiguity separate. Fail on regression of
'이사에서는…', explicit two-out 1·2루, non-bunt line drive or Reyes 202 hits. Report
context intent success separately from effect reversal. P0 stays open until independent
semantic evidence, approved production integration and dedicated-account UI QA.

## Author checks

`tsc --noEmit --pretty false` exit 0; changed-file ESLint no diagnostics; diff check
clean. Independent smoke/live replay NOT run by author. Graph rebuild attempted but
blocked by `ModuleNotFoundError: No module named 'graphify'`. No semantic PASS claim.
