# Daily quality: observed facts versus scenario outcomes

## Observed evidence (not a synthetic QA success)

Window: 2026-10-31 18:43:51–2026-11-01 18:43:51 KST.
29 unique questions / 18 accounts, 29 exact question-linked DM replies; all
29 match the durable job answer. Reply kinds: answer 19, unavailable 9, ack 1.
All accounts exist and none has the inspected QA markers. This does **not**
establish real-user identity or exclude unmarked QA accounts.
Private raw logs SHA256:
`f92b79f0b6269abf0d76d24af252199b520b26401e8edaa2b065ac030f611508`.
Raw data and complete private context stay in the operator evidence directory,
not in this repository. No actual user IDs or account addresses are published.

Reproduction question: `키움 메이저리거 선수들이 돌아오면 몇등임`.
The original conversation has **no preceding messages**; do not invent context.
Actual DM before: `2026-11-01 확인한 앱 순위표입니다. · 키움: 10위, 50승 90패 4무`.
This is a wrong question-to-data mapping, not proof that the observed standings
were themselves numerically incorrect.

## Cause and bounded change

Base: `ff4030156` (full base SHA is pinned in the PR evidence).
The app-fact selector can represent current standings, dates, qualification and
match predictions, but cannot represent an outcome under changed player composition.
The renderer correctly projects the supplied standings plan; it cannot tell
that this plan silently discarded the user's scenario. `period=unsupported`
alone describes a date limit, not a counterfactual world.

Add one information-need value, `scenario_outcome`, to the existing semantic
selector contract. Its canonical plan is `app_facts / none / unsupported`, with
the same original request quote/intent-source validation. The renderer explains
that current facts cannot calculate the hypothetical result. A fresh, correctly bound current rank may appear
only in a separately labelled reference section, never as that result. No keyword guards, player-name lists, prediction engine,
DB/schema/cache changes or additional provider calls.

After **expected**, pending independent execution: explain the limitation and
explain the effect cannot be calculated and separate fresh actual standings as reference, without reporting 10th as the hypothetical result.
The recorded old-style plan still projects 10th, deliberately: the fix depends
on the semantic classifier choosing the new supported category. Renderer-only
PASS must not be represented as a live semantic fix.

## Reviewer execution / before-after artifact

Author wrote the scripts but did not execute QA. Reviewer must run:

```sh
npm run qa:genius-scenario-outcome
npm run qa:genius-scenario-outcome -- --live --base-root=<clean-base-worktree> --out=<private-artifact.json>
npm run qa:genius-game-conversation
npm run qa:genius-deictic-temporal-followup
```

Use the protected provider environment. Base worktree belongs under
`OPENCLAW_REVIEW_ROOT`, pinned to this PR base. Live mode uses each ref's own
provider, prompt, schema and renderer. No shared head prompt on base. It records
all 17 cases × 3 repetitions × 2 refs, including failures; base is diagnostic,
head failures fail the run. Fixtures supply synthetic, fresh standings and empty
schedules so the live selector cannot derive labels from response data.

Deterministic coverage: old-plan projection; new-plan hold; invalid quote and stale reference exclusion;
full answerQuestion durable storage/replay and no shared-cache/generic fallback.
Semantic coverage: real question, paraphrase, inherited roster scenario, conditional wins,
actual current rank, completed return, explicit reset to actual facts, conditional
lookup, unmodified scheduled prediction, unrelated definition.

GO requires demonstrated base reproduction, head correction and preserved
positive controls, not merely more refusal answers. If the real question does
not reproduce on current base, preserve that result and do not claim current-main
reproduction. End-user QA remains separate: dedicated test accounts only,
after deployment, actual UI input and delivered DM verified by Samsik.

## Existing work / preservation

Open PRs and remote heads were checked before branching from origin/main.

| PR | Preserved head | Decision / overlap |
| --- | --- | --- |
| #1541 | 22d58f13c6827101037592d36d3fef5ea4f48728 | Preserve code, failed live cases and NO-GO 11. Stop that failed approach; no count reset or patch copied. Term-referent grounding is not scenario-to-current-stat projection. |
| #1523 Draft | 7d58238216fa2e5fffc922686eb13cf96ba3fcd1 | Preserve experimental sibling evidence and R3 counterexamples. Do not promote the failed experiment. No app-fact projection changes. |
| #1536 Draft | 7b52745f6464f4e8b07257924cfff85c675895a7 | Preserve scope-boundary design; archived #1538 design already merged. Recommend closure as superseded design, not deletion. |
| #1537 Draft | 6696de5d37e040085701b9527325578351959933 | Preserve smoke/effect-HOLD experiment and inversion failures. No production promotion or repeated replay here. |

No branch/PR has been deleted or force-pushed. Existing work does not implement
the selected app-fact need; creating this bounded PR is not restarting #1541.
New PR has at most 3 review rounds; failed approaches must retain their evidence.
The temporal followup, glossary and other newly observed answer-quality risks
remain separate unresolved axes, not fixes claimed by this PR.

## Runtime limits

Local Graphify refresh was attempted but `graphify` is not installed in the
active Python environment. No graph artifacts were fabricated or deleted.
The scheduled run also reported unavailable Higgsfield MCP listing; this task
does not use it and claims no Higgsfield-backed work.

## R0 NO-GO / R1 changes (round 1 of 3 preserved)

Reviewer Slack `1793526915.183269`, exact R0
`825c4a564dbf6a635f5d48b332aa7bf531e26bd3`:
- Deterministic PASS; original 60 live runs: head 30/30 intent matches,
  base 12/12 wrong classifications on the four scenario cases.
- Independent expanded probe exposed a P0 regression: head 21/21 conditional
  rule/rank questions were swallowed by `scenario_outcome`. R0 **NO-GO**.
- Cause: broad “wins/losses/conditions” definition, reinforced by the wrong
  `result-change` oracle. Do not treat the first 30/30 as overall PASS.

R1 narrows the category to player-composition effects (return/acquisition/absence),
leaves conditional standings/qualification in existing app-fact categories, and
rules/game-gap principles in `other`. Seven expanded cases join the gate; the
result-change oracle is corrected. The player-absence paraphrase is synthetic;
other six exact phrasings were provided in the independent review. The canonical
current snapshot renderer is reused for reference, including its freshness and
entity binding; stale/unknown data cannot appear as a reference rank. There is no
new generated projection or future ranking claim. R1 live outcome is **pending**.

Compare the three outcomes during review: base's actual final general answer,
R0's uninformative hold, R1's explanation + explicitly separate observed facts.
The goal is useful correct responses, not maximizing holds. Existing conditional
ranking correctness is not newly claimed: those capabilities retain their old
limitations and must not regress into player-composition holds.
