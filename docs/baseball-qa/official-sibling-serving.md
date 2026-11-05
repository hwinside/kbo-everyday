# Official sibling serving contract

Follow-up product PR to experiment #1523 R3 `7d582382` (Draft stays open).
Experiment rework count remains R1/R2/R3 = 3, not reset or waived by this PR.
This is an incremental improvement, not closure of standalone flyout P0.

## Budget and paths

- Existing selection limit stays 6 primary records. Official serving permits at most
  7 physical chunks: six preserved primaries plus one already-retrieved sibling.
- Model layout is reviewed R0: sibling block attached to the matching clause anchor,
  explicitly labelled separate source, with its own URL/revision/section/raw hash.
  Six rendered records are **not** six physical chunks. Sibling block <= 1,800 chars,
  including metadata/annotations/relations; oversized blocks are skipped, never cut.
  The existing primary/parenthetical rendering budget is unchanged. This is not a
  new global token cap. No extra retrieval/provider calls, rank pinning or DB writes.
- Any non-null actual `extras.context` skips binding. Context model and guard inputs
  remain unchanged. Standalone model request uses existing production transport.
- URL + revision + raw content hash + section must match the bundled manifest;
  source spans are hash/offset validated. RPC candidate order selects at most one.
- `rawEvidence` contains all seven original rows. `guardEvidence` preserves six
  primaries and adds sibling raw text plus only validated lead/item spans actually
  exposed to the model. Unexposed sourceText/metadata cannot authorize numbers.
- Guard, raw response, final response and discard reason are distinct. The live
  replay records the actual pipeline bundle through a diagnostic-only QaDeps sink,
  alongside existing generation and final-log traces. Production has no sink/I/O.
- The public source is the existing allowlisted source of the matching anchor,
  which must share URL/revision with the sibling. No misleading page claim is added.
  Raw bundle keeps sibling section independently. Recordbook citations unchanged.

## Reproducible refresh (no automatic corpus/DB writes)

1. Export a current serving snapshot via existing protected Gateway egress:
   `node --use-env-proxy scripts/baseball-qa/rag/export-serving-official-corpus.mjs --out=<new-serving.jsonl>`
2. Obtain the matching lossless PDF-verified corpus and audit. Do not hand-edit
   rules, offsets or revision identifiers. The emitter checks snapshot hash, active
   claim generation, revision, canonical URL, row hashes and the PDF audit.
3. Generate to a **new** file (existing output is refused):
   `node scripts/baseball-qa/rag/emit-official-enumeration-context.mjs --serving=<new-serving.jsonl> --corpus=<audited.jsonl> --audit=<audit.json> --out=<new-manifest.json>`
4. Review generated manifest + `.audit.json`, then copy both to
   `src/lib/baseball-qa/rag/official-sibling-manifest{,.audit}.json` in a normal PR.
   Audit version and canonical JSON digest bind both artifacts. Typecheck, reviewer
   contract checks and fixed-budget exposure/regression replay precede deployment.
5. On serving revision/hash drift, only sibling enrichment stops until that PR is
   deployed; original six evidence remains. Never substitute a cached missing chunk.

Current artifact was regenerated from the same audited snapshot as R3: 3 chunks,
5 bindings. Audit lists corpus/PDF/serving hashes and export timestamp. It is not
proof of live exposure after a subsequent corpus refresh.

## Reviewer checks and fixed replay

Author runs type/lint checks; reviewer executes:
- `npx tsx scripts/qa/official-sibling-serving-smoke.ts` (bounds, source identity,
  span corruption, context byte identity, independent seventh guard, real pipeline)
- `npx tsx scripts/qa/official-context-serving-smoke.ts` (unchanged transport)
- Existing official RAG contract smoke for regressions.
- `genius-infield-evidence-live.ts`, no experimental flags, base main vs this SHA.
  Each arm: flyout-context 20, flyout-regression 20, context-rules 4x5,
  exclusion-focus 8x5, original 18x3, official-documents 8x3, official81 81x1 = 259.
  Same R3 context/questions/reference clock; new output files, one pass, no retries.
- Compare actual bundle exposure, raw answers, final answers and discard reasons;
  particularly p60-only quantities and previous orig-R discard. Judge reversal,
  self-contradiction, wrong topic and direct intent fit separately. Report unexposed
  suites as HOLD, not evidence of improvement; include tokens and latency.

Exact SHA GO + authorized merge approval still required. After deployment, reviewer
runs dedicated-account UI QA including context turns. Rollback is a product revert
PR; no database rollback. P0 remains open pending product review and real QA.
