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

## R1 — R0 NO-GO retained (1/3)

R0 exact `e82a7e2d747c4477be0b0740e646afb357ad4cac`; independent artifact
`art1607/live.json`: head 7/15 failures. No live R1 PASS claimed by author.

- Actual transition 3/3: app input present, model team_standing with target.source=none,
  empty teams => renderer selected both fixture rows. The old prompt restricted
  inherited targets to same-game discussion. R1 adds a scenario relation contract
  (continue_scenario / actual_same_team / new_topic / none), passes the validated
  scenario marker to the interpreter, and binds the first two relations to prior
  resolver entities in code. Current explicit teams win; new-topic/all does not inherit.
- Hypothetical followup repeat=1: app input present but value absent, then blocked.
  Thus NOT a pre-interpreter router block. R0's 4.5s Promise.race or provider/JSON
  failure can yield into the generic NOT_BASEBALL mock, which intentionally has
  no app-only context. Old artifact cannot distinguish timeout from rejection.
  R1 traces provider start/resolution/rejection, generic fallback, final source
  with elapsed ms; unavailable app interpretation with valid scenario context
  now returns durable error, not a false out-of-scope claim. Timeout remains a
  live gate failure, not a successful scenario answer. No blanket context opening.
- explicit-other-team: pre-existing team_record terminal history_hold on BOTH refs.
  Deferred, not fixed. Known-fail applies ONLY to this case with no app input,
  history_hold and the exact existing team-record hold prefix. Every other failure
  still counts; if this route begins reaching the interpreter it must pass normal
  Samsung-only assertions. The renderer-level current-team override is separately
  tested offline. This known-fail is NOT End-User PASS.
- Added offline binding/explicit-override/new-topic and provider-rejection checks.
  Original 5×3×base/head live set plus explicit-all-teams (6×3×2=36 sequences) and both regression scripts remain reviewer-owned.
  Author does not execute these QA scripts. Trace is collected during that run.

## R2 — R1 NO-GO retained (2/3)

R1 exact 428c2d7f62ef26f6a4c431da8df3c90d25212c52. Reviewer-confirmed on R1:
qa-3243004 3/3 PASS (Kiwoom row only, R0 blocker resolved), paraphrase 3/3,
new-rule 3/3; explicit-other-team remains the pre-existing team-record known-fail.

Blocker fixed here: the R1 override treated an empty teamNames.question as
"target omitted", so an explicit league-wide request was narrowed to the
inherited team even though the model had correctly returned source=none and
teams=[]. Relation and scope are now independent axes. The inheritance is
skipped when the current utterance carries closed-set league-wide wording, and
when the model already bound teams/excluded/background/stadium. A misclassified
actual_same_team can no longer change scope; the prompt lists all-team/league
requests as new_topic examples. The closed set only suppresses an inheritance:
it never selects a team, a row or an answer, and no routing path is added.

Added offline counterexamples: misclassified relation + explicit all-team must
return every fixture row, and a model-bound other team must not be replaced.

Known limitations recorded, not fixed here:
- P1 (reviewer-raised): the interpretationUnavailable branch returns
  SYSTEM_ERROR_ANSWER for the one turn after a stored scenario hold whenever the
  app interpreter times out or throws, regardless of the new question topic. A
  slow provider can answer an unrelated new question with the error notice
  instead of the general path. Scope is that single immediate turn; silently
  falling through reintroduces the false out-of-scope reply. Next-axis candidate.
- Environment: R1 live runs hit consecutive 3s app-provider TimeoutError on the
  first turn of qa-3242998 (2 of 3 runs), so those sequences never produced a
  scenario topic. Recorded as an environment observation, not a PR PASS.

## R3 — R2 NO-GO retained (3/3 cap reached, owner allowed one more round)

R2 exact f9b28742b4d8e2fa75717cda1b5b85f2dc5cc33c. The reviewer found the
PR's own offline gate RED at scripts/qa/genius-scenario-history.ts:115. The
cause was the fixture, not the product: it supplied target.teams=["삼성"] with
empty source/quote/mentions while the current question names no team, and the
renderer correctly refuses an ungrounded target with the existing clarify
reply. Reproduced locally at the same exact before changing anything.

R3 corrections:
- The assertion now states the real contract: an ungrounded model target stays
  on the existing clarify path (source=context_missing) and is neither served
  nor swapped for the inherited scenario team. A grounded current team is
  already covered by the explicit-other-team case.
- Renderer-fallback attribution for qa-3242998: the harness now records, on the
  synthetic generic fallback, whether the app provider actually answered and the
  last model payload. A provider error and a renderer-null yield the same final
  text, so the previous trace could not separate them.

Author self-check at this exact (not a QA verdict): offline gate exit 0
(twoTurn PASS, boundaries PASS, genericHistoryHold CLOSED), qa:genius-scenario-outcome
exit 0, qa:genius-game-conversation exit 0, QA typecheck and product tsc PASS,
product ESLint 0 errors / 5 pre-existing warnings, git diff --check clean.
Product diff is unchanged from R2; this round touches the QA harness and docs.
The reviewer still owns the 36-sequence live judgement, including re-running it
once the app provider stops returning timeouts and 502s.

