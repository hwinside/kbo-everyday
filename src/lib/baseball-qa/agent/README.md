# Production supplemental search (#1466 follow-up)

The original router, successful answers, permissions/quota, blocked responses,
pickers, structural holds, and cache stay authoritative. Only `unsure` results
at the news/official/generic model boundary (or the existing deterministic durable
boundary) may be supplemented, and only explicit latest/news or international
baseball questions qualify. Short elliptical follow-ups are intentionally not
expanded in this first production slice.

- Search occurs after durable ownership, before the stored final; replay uses the
  same final without another model call. No fallback DM or DB write path exists.
- Total fallback budget is at most 15 seconds and at most the remaining 25-second
  pipeline wall budget, below the existing 30-second LLM ownership fence. Fewer
  than 3 seconds remaining means skip. Failed/timed-out/invalid fallback preserves
  the original unavailable answer. Primary outputs never invoke the agent.
- Shared PoC quote checks remain mandatory. A separate verifier must approve
  meaning, identity, tournament/year and event time. Publication/crawl `asOf` is
  not an event date. Numeric assertions must appear in quoted content. This is a
  conservative guard, not a mathematical guarantee of semantic correctness.
- Allowlisted provenance only; one document per response because current DM
  payload supports one source URL. Multi-document synthesis is rejected.
- Production adapters differ from the experimental CLI: no corpus/embedding
  download. News queries are 30-day, time-filtered, at most 3 terms × 6 rows,
  newest first; wiki uses bounded title/content lookup. No official rules search
  for tournament schedule fallback. This can reduce recall; quality must be
  measured using these actual adapters, not inferred from CLI results.
- Existing `rag`/`news_rag` output/provenance contracts; no shared answer cache.
- Server kill switch `BASEBALL_GENIUS_AGENT_FALLBACK=0` disables supplemental calls.
  Revert this PR for code rollback. No schema/data migration or backfill.

Review gates: `qa:genius-agent-fallback` (CI tier), existing `news-rag-wiring`,
`genius-rag-first`, `genius-reply-mascot`, existing PoC fixtures. Independent reviewer
runs them. Review additionally requires the same 156-question comparison with the
37 existing-answer controls unchanged, date/citation counterexamples, production
adapter coverage and actual latency/budget checks. Production QA must include a
real unavailable→answered case and failure/replay, not only no-regression.
