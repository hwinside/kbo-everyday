# Daily quality: source-bound substitution interpretation (R1)

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

New source: `kbo:ebook:2026-공식야구규칙-필수-조항-510`, revision `sha256:2342ad7c446a3fee`, 9 chunks. Existing sources, 2-chunk infield supplement and revision-bound sidecars remain untouched. R0 had no serving change. R1 adds exact-source editorial interpretation to model evidence rendering only; no question routing, system-prompt, threshold, response schema, grounding, cache, DM, workflow or main-branch change.

Before: missing rule (a)/(d) evidence and observed wrong/off-topic answers. Candidate after: source-bound complete evidence is available to ordinary similarity ranking. **R0 measured NO-GO**: adding evidence alone created confident errors. R1 effects remain unmeasured; no semantic PASS is claimed. No corpus application or embedding has been performed by the author.

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

## R0 NO-GO → R1 redesign

Reviewer Slack `1793760413.526079`, exact `99d79b3fec30c473cc529b89aea3a6049ceb5084`: 90/90 observations, errors 0; NO-GO (1/3). Evidence: `$OPENCLAW_REVIEW_ROOT/art1611/live.json` and `grade.txt`. Same-inning return became confidently wrong 3/3, observed repeated question still wrong 2/3; next-inning answer imported Futures-only minimum 3/3, KBO first-team minimum regressed to unsure 3/3. Removal and second outward move improved, unrelated 7 cases unchanged. Keep these results, not merely the passing corpus validation.

R1 keeps all nine official chunks, hashes, source revision and rollback unchanged. The redesign is **reviewed editorial interpretation, not more official source text and not a syntactic parser**:

- `official-rule-interpretations.json` binds five complete chunks to exact canonical URL + revision + whitespace-normalized content digest + tier1/kbo_ebook. It carries verbatim related clauses from the same PDF and explicitly labels the explanation as editorial, separate from the original. Review its semantics against the source; a matching hash alone does not prove an interpretation correct.
- For (a)/(d), represent game participation separately from fielding position: out of game → no re-entry; pitcher → fielder → pitcher permitted; another outward move within the inning forbidden. A bare “left the mound” does not specify which state changed. The false previous DM is not rule evidence. No DH or special-case adjudication is inferred.
- For (g), its continuation and (i), preserve the Futures-only scope across the chunk boundary and distinguish minimum-batter duty from next-inning eligibility. No extension of the Futures obligation to KBO first-team baseball.
- Rendering appends only this source-bound note. Original evidence, ranking, numeric/calendar guards and citation/provenance inputs are unchanged. Related quotes/interpretation do **not** license new numbers. Missing/stale/mutated bindings get no note, not a fabricated answer. These bindings cover the newly added source only; old-source weaknesses are not silently claimed fixed.
- This is intentionally a source-specific **data interpretation**, not a rule-specific question matcher or an automatic semantic verifier. It still relies on model reading and independent live assessment. A new confident error remains NO-GO; no threshold weakening or hiding failing cases.

### R1 review commands and acceptance

1. `npx --no-install tsx scripts/qa/genius-rule-interpretation.ts`: real corpus quotation/binding checks, original/grounding preservation, sanitizer compatibility and stale/revision/URL/grade/kind/truncation/content mutation rejection. Also run existing `qa:official-parenthetical-serving` and `qa:genius-required-rule-corpus`. Author does not execute QA scripts.
2. Re-run the existing paired live command to a **new output path**, preserving R0 artifacts. The preview now uses the actual loader revision (not the old fake `local-substitution-preview`), so exact-source notes activate just as in production. Baseline has no new source; note matching therefore cannot change its model input. Record note-file SHA alongside corpus/fixture SHA. Same 15 cases × 3 × baseline/candidate = 90, frozen read results, no writes. This is still pre-application retrieval, not production QA.
3. Grade *every* sample. P0 return must be correctly allowed 3/3, removal and second outward move forbidden, the two complete observed questions must explicitly distinguish the states rather than merely quote the once-per-inning sentence. Incomplete correction may ask for clarification; `unsure` remains unresolved, never PASS. No KBO first-team Futures leakage or loss of the existing correct minimum answer. Same 7 unrelated regressions required. Test independent paraphrases and competing scopes (explicit Futures, DH effect) as counterexamples; do not accept blanket permission outside the source's scope.
4. No application/merge before current exact GO and required checks. R0 NO-GO count retained; R1 is the first diff-changing rework. If this source-bound interpretation does not eliminate confident errors, keep NO-GO and use the remaining round budget/stop rule rather than shipping the corpus alone.


## R1 NO-GO → R2 (historical round-limit interpretation; corrected below)

Reviewer Slack `1793761075.561809`, exact `41c5bba89d2a5e4860ed1f2ce4a71fffa54c0bc6`: all contract/type gates PASS and paired90 completed without errors, but NO-GO **2/3**. `art1611r1/live.json` / `grade.txt` remain the evidence. Same-inning return and first observed question improved to 3/3, but third-turn observed question only 1/3 acceptable; next-inning answers omitted the Futures qualifier 3/3. First-team minimum unsure is not a regression against a baseline whose stated exception was wrong. Preserve this reviewer correction to R0 assessment.

R2 keeps source bytes, editorial interpretation text, ranking, context, numeric guards and answer schemas unchanged. It adds an exact-binding-derived, deduplicated interpretation summary **after** conversation data, with evidence indices, not isolated quotations. A generic application instruction is enabled only for official rule requests with these exact bindings (not recordbook, stat-definition, specialized rule requests or generic RAG). It requires separating participation/position states, not treating a previous bot claim as evidence, and retaining a limited rule's scope in the same answer sentence. No question keywords, fixed answer, model retry, threshold changes or privileged data instructions. Raw sources/interpretations remain untrusted data; actual conflicts must still be held.

Reviewer: rerun binding/request assembly mutations plus existing serving/corpus gates and the **same paired90**, with all original cases and prior DM intact. Added assertions cover actual request placement, conditional system instruction, no-binding/mutation and generic RAG isolation, and deduplicated evidence indices. These establish request wiring, not correctness.

Acceptance: observed-3316782 must distinguish removal versus position change and directly permit return in all 3 repetitions; regression-2 must retain next-inning permission without a general three-batter obligation. If mentioning a Futures obligation its qualifier must appear explicitly. Preserve R1 successes and unrelated seven cases. Independently probe a false previous answer, explicit Futures/first-team wording, and DH/special-case limitations; do not turn limited evidence into blanket permission. If R2 remains NO-GO, stop this approach at 3/3 and escalate; do not merge or ingest. Semantic effect remains unmeasured by the author.


## R2 NO-GO → R3: scope travels with the source

R2 exact `9712675581a5a467343438438bb2c5a175880db3` remains NO-GO. Reviewer completed paired90 plus 24 independent cases, no execution errors. Observed first/third turns and regression-0/1/3 passed 3/3. `regression-2` still had one unqualified three-batter obligation, one explicit Futures qualifier, and one vague “depending on league” answer; baseline was correct 3/3. These sample counts are not estimated production failure probabilities. Preserve `art1611r2/live.json`, `extra.json`, `grade.txt` and the nonblocking false-context/DH findings.

**Authority correction:** the earlier stop-at-3/3 text above was mistaken. Owner `U0AKA391YLR` instructed “왕복 상한 관계 없이 계속 끊김 없이 진행해줘” in this thread (Slack `1790836841.298079`; verified via anchored session history). Reviewer correction/request `1793777048.892289` resumes R3 with the same 114 evaluations. Preserve all three NO-GO decisions and the rework count; no counter reset, merge, ingestion or GO implied.

R3 changes only the presentation of the three exact-bound pitching-duty notes:
- Attach structured clause/scope/meaning/quote groups: general 5.10(f)/(g), general next-inning 5.10(i), and **Futures-only** 5.10(g) proviso plus its continuation. Quotes remain verbatim and are no longer rendered as unscoped isolated snippets.
- Prepend explicitly editorial scope metadata immediately before each bound raw chunk, including continuation-first chunks. Raw content stays contiguous and byte-identical, and remains the only grounding/numeric/provenance input. The model rendering may now start with the editorial label, not the raw content.
- Carry the same clause/scope/meaning groups into the existing post-conversation summary. Position-change notes, conditional prompt, question routing, response schema, retrieval ranking, corpus bytes/revision and validation thresholds are unchanged. No fixed answer or model retry.
- Exact URL/revision/content digest/grade/kind binding is unchanged. A missing or mutated binding receives no scope preamble. Related quoted numbers still cannot bypass grounding.

Reviewer: run `genius-rule-interpretation.ts` (extended for verbatim scoped quotes, scope-before-original real request assembly, summary propagation and mutation fail-closed) plus existing corpus/parenthetical gates. Author runs type/lint only, not reviewer QA scripts. Repeat the **same paired90 + independent24 = 114**, including all original inputs, previous answers and repetitions; do not drop or soften regression-2. Require explicit Futures qualification whenever the three-batter obligation is stated, and preserve the correct general next-inning answer and R2 successes. Scope serialization is a contract check, not a semantic PASS; independent live grading remains required. No merge/ingestion before exact GO and applicable approval.
