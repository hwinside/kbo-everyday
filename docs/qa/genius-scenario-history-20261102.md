# Daily quality: preserve scenario topic across delivered turns

Base: `5c11b04c534e9705c7daa2473cf28fdc0b740afc`. Production defect confirmed independently in #1591 QA
Slack 1793528310.366879; current main retains the same history_hold barrier.

## Fresh sample, not fabricated user usage

2026-11-01 11:30–2026-11-02 11:30 KST: 47 distinct questions / 18 actors.
14 exact QIDs belong to the previously identified deleted QA account. Their
question logs remain, but DM rows have been deleted: this run does not claim
fresh UI or DM readback for those 14. Independent original UI evidence is kept
in the private #1591 artifact. Remaining 33 questions / 17 actors have 33 exact
DM replies matching 33 job answers; real-user identity remains unverified.
18 overlap the previous sample, 15 are new. Raw SHA256:
`325e40ed03c57f6bb2331afffd4675fa603e0110b45d3fc5350ef7297e024536`. Private raw/context/DM evidence stays outside git.

New candidates: `643뜻` after `6 4 3 병살 뜻` loses the position-number
explanation (unsure); `왜 못 알려주니` after unavailable player records is unsure;
home-team batting-order rule and today's playoff time also return unsure.
Unknown-term clarification for 홈보설/도미넌트 is not declared factually wrong
without independent terminology evidence. These are not folded into this fix.
No new unmarked scenario example exists in this window; the recurring QA-proven
P1 is selected per the standing daily instruction.

## Before / expected after (independent execution required)

Actual question: `키움 메이저리거 선수들이 돌아오면 몇등임`.
Original real question Q3242076 had no preceding messages. #1591's dedicated QA
repeated it, then submitted these actual followups:

| Followup | Recorded before | Required after |
|---|---|---|
| Q3242998 `그러면 몇 등일까?` | ctx=false; whole current standings table | inherited player-composition scenario; no current rank presented as forecast |
| Q3243004 `가정 말고 실제 지금 순위는?` | ctx=false; whole current standings table | actual current **키움** rank only, explicitly leaves scenario |

The previous reference standings are not factual support for a hypothetical
forecast. The app interpreter receives only the original user topic plus a
neutral marker, never the preceding reference rank/record answer.

## Cause and bounded correction

history_hold represents both an unanswerable record and a recognized scenario.
The global allowlist deliberately excludes it. Opening all history_hold would
allow unrelated holds into generation. Instead the validated scenario renderer
writes versioned topic metadata in the existing durable final envelope.
The exact predecessor RPC adapter accepts it only when final source AND answer
match the delivered row. App-fact-only selection retains existing delivery,
ordering, TTL and immediate-turn barrier checks. Generic, draft and origin
selectors are unchanged; old/malformed/unmarked holds stay closed. Injection
screening also applies to the recovered topic. No SQL migration, new model call,
new source/reply kind, keyword/individual-player guard or shared cache change.

## Independent execution

Author wrote but did not execute QA. Type/lint checks are not independent QA.

```sh
npx tsx scripts/qa/genius-scenario-history.ts
npx tsx scripts/qa/genius-scenario-history.ts --live --base-root=<base-worktree> --out=<private-json>
npm run qa:genius-scenario-outcome
npm run qa:genius-game-conversation
```

Live mode: 5 sequences × 3 repetitions × base/head, each runs answerQuestion
for both turns, using each ref's own provider, pipeline, final envelope and SQL
adapter. The second turn is NOT injected as a prequalified ContextTurn.
Cases: actual two followups, paraphrase, explicit other team, unrelated WC rule.
Offline: durable envelope roundtrip, generic/draft barriers, malformed metadata,
missing DM, exact answer/source mismatch, future/in-flight timestamps,
600000/600001ms TTL. No DB/account/DM writes. Synthetic standings; not UI QA.
After merge, Samsik owns actual two-turn dedicated-account browser DM QA.

## Preservation and review contract

#1541 stays NO-GO11 (`22d58f13`); term-referent changes/counterexamples preserved,
not covered or reopened by this fix. #1523 Draft (`7d582382`) sibling experiment
remains excluded; #1536 (`7b52745f`) duplicates merged #1538 design and stays
preserved pending closure decision; #1537 (`6696de5d`) smoke GO/effect HOLD and
context-reversal evidence preserved, not productized. No close/delete/reset.
Existing open PRs + remote branches checked; no incomplete scenario-history PR.

New PR review cap: 3 rounds, then preserve failed approach and move to next axis.
Standing user approval 1793526075.463129 permits merge only after exact Samsik GO
and required checks, then deployment verification and independent production QA.
No direct main/workflow/force push. Graphify rebuild attempted: module unavailable
(if still unavailable, see local graphify.log); no graph success claim.
