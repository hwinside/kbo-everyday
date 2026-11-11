# Unverified expression scope: Q3573589

## Independent production before
Samsik Slack 1794387658.233469, deployment `9eb4702ae8519c7f08279df99410683c68c586e5`.
Disposable account, real POST /api/baseball-qa and delivered DM readback:
- “야구 글로벌 임팩트가 뭐여”: q3612685 → a3612686, unsure.
- “글로벌 임팩트가 뭐야”: q3612687 → a3612688, blocked.
- “보크가 뭐야”: dictionary; “야구 룰”: scope_guide.
Account/profile/conversation and QA messages deleted by reviewer. Exclude QA message IDs 3612685–3612692 from daily samples, NOT unrelated real-user 3612684. The range includes answer IDs; do not count all eight as questions.

## Change and acceptance
Unknown meaning/domain is not evidence of non-baseball scope. Clarify only when the meaning request is clear, no supporting meaning is bound, and usage context is missing. Reuse existing TERM_UNVERIFIED + UNVERIFIED_TERM_ANSWER; no new sentinel/copy, term-specific runtime guard, routing reorder, or wholesale unsure conversion. Known terms, name suggestions, scope guides, stat clarification and explicit non-baseball remain unchanged. Shared term prompt also applies to official generation.

Reviewer-only paired gate:
`npx tsx scripts/qa/genius-unverified-scope.ts --base-root=<9eb4702 checkout> --out=<artifact.json>`
Uses current same glossary/roster snapshot, real provider, in-memory answerQuestion, 9 cases × 3 × 2. No DB/cache/DM writes. Does not execute RAG or actual API delivery: R1/R2 and R3/R4 must separately pass real production-equivalent path review before claiming impact. Preserve failures and provider errors; no best-of retries. Prompt-only change is a candidate, not proven improvement.

Independent regression gates: existing genius-unbound-name, refusal/scope, stat clarification, term-knowledge cases. Confirm factual source bindings and contextual/known terms are not downgraded. Unknown-expression clarification must not assert that the term is a real baseball term.

## Author checks
Scoped TypeScript, ESLint and diff whitespace checks passed. Initial scoped TypeScript run lacked generated next-env.d.ts; restored the standard generated declaration locally and reran successfully. Graph rebuild could not run: Python graphify module unavailable. Author did not execute reviewer-only QA. No claim of after-path or factual-quality PASS.
