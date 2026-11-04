# Daily quality: restore substitution evidence, not a question-specific guard

## Observation and source

- Window: 2026-11-03 11:30–11-04 11:30 KST. 27 logs/questions, 11 actor keys. Exclude the exact 8 #1608 QA question IDs (3316670, 3316672, 3316674, 3316676, 3316678, 3316680, 3316682, 3316684): 19 questions / 9 actor keys remain. No QA markers among those 19, but actual user identity is **unverified**, not proved by absence of a marker.
- Actual DM: 18/19 remaining questions. Q3316845 has `ready / dm_send_failed`; no linked DM was found. This is a separate delivery defect, not corrected here. No retroactive DM was sent. Follow-up conversation lookup was denied by the gateway (`Direct shared-state reader requires current integrity admission`); no alternate privileged route was attempted.
- Q3316778: “한번 마운드에서 냐려갓던 투수는 다시 올라올수잇어?” → answered minimum-batter / mound-visit rules, not the return question.
- Q3316780: “아니 마운드에서 한전” → actual previous DM is retained in the fixture; the generated answer incorrectly banned return after playing another fielding position as well as after removal from the game.
- Q3316782 repeats the full question → another blanket prohibition. Raw historical retrieval lists were not stored: current corpus queries are evidence of today's coverage gap, **not** a reconstruction of the exact historical search result.
- Current corpus search for 5.10 / re-entry / position change found partial mound-visit provisions but not the complete 5.10(a)/(d) distinction. Current main has the original 2-chunk infield supplement, not this 9-chunk bundle. Fresh main/head semantic reproduction remains reviewer-owned.
- Official PDF re-downloaded 2026-11-04: `https://6ptotvmi5753.edge.naverncp.com/KBO_FILE/ebook/pdf/2026_%EC%95%BC%EA%B5%AC%EA%B7%9C%EC%B9%99.pdf`, SHA256 `deb2c0d58ef41c6631f47a3dcfbe37d853a97275b9891ad50f0a8525b302a16a`. Existing producer independently compared all 205 text pages to the PDF; lost chars 0. Complete 5.10 (physical pp93–99), 9 chunks, no authored rule summary.

## Change and safety boundary

The existing producer/selector restores the **whole section**, including exceptions, Futures-only minimum-batter scope, and mound visits. The selector now supports a numbered-rule bundle. The loader validates that the bundle suffix matches every included section, preserving existing document/PDF/ordinal/count checks. This is reusable source isolation, not a keyword answer override.

New source: `kbo:ebook:2026-공식야구규칙-필수-조항-510`, revision `sha256:2342ad7c446a3fee`, 9 chunks. Existing sources, 2-chunk infield supplement and revision-bound sidecars remain untouched. No serving prompt, threshold, route, schema, cache, DM, workflow or main-branch change.

Before: missing rule (a)/(d) evidence and observed wrong/off-topic answers. Candidate after: source-bound complete evidence is available to ordinary similarity ranking. **Answer improvement is not yet measured**; adding evidence alone is not a semantic PASS. No corpus application or embedding has been performed by the author.

## Reviewer execution

1. Inspect PDF pp93–99 against all 9 chunks and audit hash; verify existing supplement bytes and other sources are unchanged. Run existing `qa:genius-required-rule-corpus` (now includes isolated-source and wrong-bundle/partial/duplicate/PDF mutations), relevant existing serving/loader checks, and CI. Author type-check and lint passed; Graphify rebuild could not run because its Python module is missing.
2. Protected gateway environment: `npx --no-install tsx scripts/qa/genius-substitution-live.ts --live --out=<NEW_ABSOLUTE_JSON> --reps=3`. 15 cases × 3 × 2 = 90 observations. It calls the current pipeline with the actual previous DM and an explicit read/model dependency allowlist; no production writes. Baseline/candidate share per-query frozen RPC results; the candidate locally ranks embedded additions with the same distance/limit. This is **pre-application preview**, not deployed retrieval. Inspect recorded normalized queries and context usage; do not count errors/unsure as correct answers.
3. Grade the 3 actual questions plus 12 regressions: removal vs position change, next inning, once-per-inning switch, KBO first-team vs Futures minimum, infield/bunt boundaries, catcher/runner interference, fair-base contact, APBC dictionary. Confirm fresh baseline reproduces the deficiency; if it does not, HOLD rather than claiming an improvement. Compare matched semantic outcomes and all negative cases, not just source count.
4. Only exact-SHA GO + required checks permit merge under the daily standing approval. If no GO in 3 rounds, preserve findings and stop this approach. Then apply **only** this source via the existing protected loader, with a pre-application snapshot of all sources and active chunks, source-key absence check, and post-readback preservation comparison. Never refresh another source.
5. Production QA by Samsik using a dedicated account: real 3-turn conversation, explicit removal, position change, next inning and regressions. Web/UI, server and native device conclusions must be reported separately. No author self-check substitutes for QA.

## Reproduction / apply / rollback

```sh
python3 scripts/baseball-qa/rag/prepare-rulebook-corpus.py --input=<pages-jsonl> --pdf=<verified-pdf> --output=<full-jsonl> --audit=<full-audit>
python3 scripts/baseball-qa/rag/select-rulebook-supplement.py --input=<full-jsonl> --audit=<full-audit> --section='5.10 선수교체 및 마운드 방문' --bundle-rule=5.10 --output=<bundle-jsonl>
node scripts/baseball-qa/rag/load-official-corpus.mjs --corpus=<ABS>/data/baseball-qa/kbo-substitution-2026.jsonl --manifest=<ABS>/data/baseball-qa/kbo-rulebook-supplement-2026.manifest.json
# Only after exact GO, checks, merge and preflight snapshot:
node scripts/baseball-qa/rag/load-official-corpus.mjs --corpus=<ABS>/data/baseball-qa/kbo-substitution-2026.jsonl --manifest=<ABS>/data/baseball-qa/kbo-rulebook-supplement-2026.manifest.json --state=<NEW_ABS_STATE> --apply
```

Dry-run: one source, 9 chunks, no skipped records, one embedding batch planned; DB/embedding calls 0. Rollback SQL is identity/revision/hash-bound and disables only the new source, retaining vectors and all old sources; it is **not** an automatically applied migration.

## Existing work and continuation

`gh pr list` + `git ls-remote --heads` checked before branching from origin/main. #1608 is merged/QA complete. No other active substitution-source fix. #1541 remains NO-GO11 (not reset); its failed term-referent approach is not resumed. #1523 Draft sibling R3 and #1537 Draft scope experiments retain counterexamples, excluded from this patch. #1536 Draft is redundant with the #1538 merged design; preserve before any separate closure decision. No PR/branch deleted or force-pushed.

This PR's Flow owns exact SHA, review rounds, next actor and review continuation. Daily SSOT: `state/followups/genius-daily-quality.md` in the agent workspace. Next daily sample must distinguish QA IDs, natural-use evidence, semantic regression and delivery failures; analysis-only is not improvement completion.
