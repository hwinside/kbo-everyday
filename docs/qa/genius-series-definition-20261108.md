# 2026-11-08 first-to-four definition

## Observed before / proposed after
Daily window 2026-11-07 11:30 to 11-08 11:30 KST: 42 questions; remove only five exact #1622 QA QIDs (3471162/3471164/3471166/3471168/3471170), leaving 37 questions / 14 actor keys. All 37 delivered DMs equal job answers; unmarked actors are not proof of real-user identity.
Q3471276 asked the Korean Series winning criterion; its answer introduced 4선승제. Q3471278 then asked “4선승제가 뭔가요”. The actual DM repeated competition pairings instead of defining first to four wins. It also described other tournament formats; correcting those RAG facts is outside this change.
Base/current main: ef07768a78442d0da5104c412ee3c352fbed940a. The 168-row operational glossary has no independent definition. Sanitized actual prior turn and delivered answer are in fixtures/genius-series-observed-20261108.json. Before is observed production evidence, not a new synthetic base RAG run.
After EXPECTED (not yet independently measured): dictionary definition states first to four wins, not four total games; ties do not add a win. No player/name/question-specific code, router or model changes. Add only one glossary row; do not rewrite completed DMs or cache.

## Evidence and scope
2026 KBO League Regulations PDF page 50 (printed p38), Article 42 specifies Korean Series 4선승제. PDF page 13 Article 1(2) allows postseason ties after 15 innings. Verified PDF text on 2026-11-08. URL: https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_%EB%A6%AC%EA%B7%B8%EA%B7%9C%EC%A0%95.pdf
The plain-language definition is editorial_definition, not a claimed verbatim official quotation. No fixed “maximum seven actual games” assertion. This does not answer current series scores, predict a winner, or define every other first-to-N format.

## Independent reviewer commands and oracles
- `npm run qa:genius-series-definition` (PGlite migration + real answerQuestion, no network/production writes). Author writes this harness; reviewer alone runs and judges it.
- 168-row before fixture: absence of new term; all existing columns equal after migration, one row added; repeat idempotence; normalized alias collisions prohibited.
- Six definition spellings and actual prior-turn pipeline return dictionary + exact definition with zero model calls. This offline prior-turn injection is NOT actual web 2-turn QA.
- Twelve boundaries preserve old matching and cannot be swallowed by this new term: current score, today’s clinch, probability, comparison to three wins, 3/2 wins, Korean Series/playoffs, ties, streak and tie schedule.
- Meaning checks reject four-total-games and fixed-seven-game interpretations. Reviewer should independently inspect answer semantics, not rely solely on matching assertions.
- Conflicting operator edit survives replay and rollback; exact inserted row rollback restores the 168-row snapshot. Rollback: data/baseball-qa/series-definition-2026.rollback.sql.
- Existing `qa:genius-glossary-map` / `qa:genius-tone-ssot` gates; judge unrelated failures separately.

## Apply and production QA (not performed)
After current exact GO + required checks under the existing daily-loop approval: snapshot current entire glossary; compare with reviewed fixture; transactionally insert one row and verify 168 old rows unchanged / total169, register only this migration. Abort on drift or conflicting existing term; never treat ON CONFLICT no-op as successful deployment.
After production READY and glossary TTL expiry (10 minutes conservatively), reviewer uses a dedicated test account for actual two turns (winning criterion → definition), spellings, ties and current-score/clinching/other-N boundaries. Capture delivered QIDs, console/HTTP failures and cleanup evidence. Independent prod QA must not be replaced by author type/lint or CI.

## Preserved failures / limits
#1541 NO-GO11, #1391 corpus HOLD and previous result-change/history/unsure/currentness defects remain open. No full source refresh, vectors/revisions/schema changes, workflow changes, production writes or personal-account QA. Prior runtime path permission denial recovered on retry without permissions/config changes. Graphify rebuild unavailable (module absent); no graph output claimed.
New PR R0, zero diff-changing review rounds, maximum three. Review → merge/deploy → independent operational QA remains necessary; no completion claim at PR creation.
