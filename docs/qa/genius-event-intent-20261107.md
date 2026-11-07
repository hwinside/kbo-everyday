# Daily quality 2026-11-07: occurrence vs conditional outcome

## Evidence and scope
- Window: 2026-11-06 11:30–2026-11-07 11:30 KST; 28 logs / 27 distinct questions / 12 actor hashes.
- Exclude only #1620 QA exact IDs 3433486, 3433488, 3433490, 3433492, 3433494, 3433496, 3433498, 3433500. Remaining 19 questions / 11 actors; actual DM 19/19 matches job.answer. Unmarked is not proven natural use.
- Actual Q3433658: “엘지가 구자욱 영입할 확률”; previous messages=[]; DM says hypothetical ranking cannot be determined and attaches LG current standings. The question asks whether the acquisition occurs, not the effect if it occurs. Redacted actual fixture: scripts/qa/fixtures/genius-event-intent-20261107.json.
- Current base main 63cec345f retains the same scenario classifier contract. Independent paired live reproduction is required before GO: a stored operational failure is not a new main test.
- Root cause hypothesis: semantic classifier conflates probability of a roster change with its conditional sporting outcome. Clarify that general distinction in the existing information-need contract. No player/team string guard, routing enum, renderer, schema, DB, cache, or workflow changes.

## Before / after
- Before observed actual DM: history_hold + hypothetical standings explanation for an acquisition probability question.
- After expected, NOT yet measured: action=other / non-scenario request goes to existing evidence path; no irrelevant scenario standings response. This does not promise a numerical probability or improved downstream RAG factuality.
- Reviewer must attach paired base/head results and inspect downstream replies before GO. Confident unsupported acquisition probability is FAIL, not an acceptable replacement.

## Independent QA (삼식 execution only)
- Existing harness extended to 22 cases × 3 repeats × base/head = 132 selector/renderer observations. Includes observed question, acquisition/return/trade occurrence, conditional championship outcome, original scenario cases and 17 prior controls.
- Run `npx tsx scripts/qa/genius-scenario-outcome.ts --live --base-root=<isolated base63cec345f worktree> --out=<artifact.json>` in approved protected environment. Base uses its own production selector and renderer; head likewise. No production DM writes, auth/quota/cache mutations. Synthetic snapshots are not live standings.
- Existing `scripts/qa/genius-scenario-history.ts` covers actual/league-wide transitions; run independently as regression.
- All head assertions must pass; inspect whether base reproduces selected defect. Preserve timeouts/failures, do not select only passing repeats. If no base reproduction, record and decide HOLD rather than claiming measured improvement.
- Before merge, independently probe the final answer path for observed/no-context acquisition, semantic variants and conditional-result contrast. Selector-only PASS is not end-to-end quality PASS. Unsupported outcomes should abstain rather than fabricate percentages or current transfer news.
- After production READY, use only dedicated QA account for the same query and controls, actual web DM and console errors; report native unverified separately. No real-user account changes or retrospective DM sends.

## Author checks / workflow
- Product + harness TypeScript and ESLint PASS; diff check PASS. QA execution by author: zero. Graphify rebuild unavailable (`ModuleNotFoundError: graphify`).
- New PR has max 3 review rounds; NO-GO/conditional is not GO. After current exact GO and all required checks, standing user authorization permits merge, deployment confirmation, and reviewer production QA without renewed owner prompt.
- gh pr list + git ls-remote checked. No pending implementation for this semantic distinction. #1391 short-rule corpus HOLD/NO-GO2-of-3 is a separate axis; preserve frozen work. #1541 term-referent NO-GO11 remains stopped and unchanged. Draft #1523 sibling experiment retained; #1536 overlaps merged #1538 and is recommended for later closure, not closed here; #1537 boundary experiment HOLD retained. No deletion, closing, count reset, or adoption of their failed approaches.
- #1620/#1425/#1607/#1608 have no new relevant non-QA validation in this sample. #1620 observed QA matches deployed definitions, not proof of natural-use effect.
- Unresolved other candidates: typo 낫다웃, 후루꾸, postseason-vs-regular championship comparison, team-currentness, player identification. Not solved by this PR.
- Rollback: revert only this prompt clarification; no DB migration or data rollback needed.
