# #1523 R1 — independent seventh evidence record

Parent R0 cc95af5e80d15e939f665a28f4b5c3d02201d66f. Same main baseline inherited.
R0 review (Slack 1790953763.965579): standalone direction improved, but contextual
intent 10/10 → 6/10 and two rule errors; NOT shippable, P0 remains OPEN.
Reviewer authorized the seven-physical-chunk diagnostic at 1790953479.249619.

## One intervention

Keep R0 candidate eligibility, RPC order, same-document/revision/article matching,
manifest/hash/span validation, payload bytes, single-sibling/1,800-char budget intact.
Only change placement: instead of modifying the first same-article anchor's content,
append an independent final RagEvidence with the sibling's own metadata. With six
primary records this becomes explicitly [자료7]. All six primary records and their
rendered dates/metadata/sidecar notes remain unchanged. No source/page/question allowlist.
The anchor index now denotes only the structural eligibility witness, not insertion.

This is still scripts-only. The production server transport receives seven model
records, but pipeline guards still see original selected records, as in R0. This
known raw/final provenance gap remains a product integration blocker, not silently
fixed as part of this placement A/B. Source src/loader/DB and production behavior
are unchanged. No merge/deployment/semantic PASS claim.

## Independent execution: fixed 259 observations per mode, once

Use this R1 harness for BOTH base (no experiment flags) and candidate
(--siblings=<same regenerated audited manifest>). Do not use R0's 10-run output as
the new baseline. Do not add --routing/--selection/--annotations/--supplement.
- flyout-context: 20 base + 20 candidate, existing real --context-file.
- flyout-regression: 20 base + 20 candidate.
- context-rules: 4x5 per mode, same --context-file; inspect the line-drive explanation
  in '이사에서는…' separately from the correct two-out conclusion.
- exclusion-focus 8x5, original 18x3, official-documents 8x3, official81 81x1 unchanged.
Both flyout suites now REQUIRE --reps=20. Other fixed suite budgets remain unchanged.
New unique --out files required. No success-driven reruns. Zero exposure ends HOLD
with the completed output retained (e.g. documents); not semantic failure or PASS.

First run `npx tsx scripts/qa/official-sibling-evidence-smoke.ts` independently.
Smoke asserts full first-six record equality, [자료7] metadata identity and preserved
system/config, in addition to R0 source mismatch/offset cases. Prior regenerated
manifest/5-binding audit remains reusable when hashes/revisions match; generator
and provenance paths are in official-sibling-r0-plan.md.

Report raw/final intent correctness, law reversal/self-contradiction, wrong topic,
unsure/error, routes, sibling section and exposure, input tokens and p50/p95.
Do not equate correct infield-fly law with responding to '포구' → '플라이아웃'.
Inspect p65 attachments and context-rules factual explanations, not just conclusions.
R0's 239/mode and R1's 259/mode are distinct budgets and results. R0–R5 #1521 and
#1523 R0 failure/rework history is retained; R1 is the first rework in this PR.

## Author static checks

TypeScript exit 0, changed-file ESLint exit 0, diff check clean. Author did not run
reviewer-owned smoke/live QA. Graph rebuild attempted, unavailable (graphify module
not installed). Independent R1 evidence is pending; R0 smoke is not an R1 PASS.
