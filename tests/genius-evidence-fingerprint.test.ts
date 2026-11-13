import assert from 'node:assert/strict';
import test from 'node:test';
import { contentSha256, fingerprintEvidence, readEvidenceFingerprints } from '../src/lib/baseball-qa/rag/evidence-fingerprint';
import { selectEvidence, type RagEvidence } from '../src/lib/baseball-qa/rag/retrieve';
import { packStoredQaFinal, unpackStoredQaFinal } from '../src/lib/baseball-qa/pipeline';
import { buildQuestionLogRow } from '../src/lib/baseball-qa/log-row';

const raw = '공식 야구 규칙의 근거 문장입니다. 이 문장은 식별자와 함께 선택됩니다.';
const evidence: RagEvidence = {
  chunkId: '9007199254740993', sourceContentSha256: contentSha256(raw), content: raw,
  pageTitle: '규칙', canonicalUrl: 'https://www.koreabaseball.com/rules', revision: 'v1',
  sectionPath: '규칙', asOf: '2026-11-13', sourceGrade: 'tier1', sourceKind: 'kbo_ebook',
};
test('SHA256 hashes exact UTF-8 bytes and projection keeps source identity', () => {
  assert.equal(contentSha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const selected = selectEvidence([evidence]);
  assert.equal(selected[0].chunkId, evidence.chunkId);
  const fp = fingerprintEvidence([{...selected[0], content: raw + ' 보완'}])!;
  assert.equal(fp[0].sourceContentSha256, contentSha256(raw));
  assert.notEqual(fp[0].contentSha256, fp[0].sourceContentSha256);
  assert.equal(fp[0].chunkId, '9007199254740993');
});
test('legacy, partial and malformed identity sets remain unknown; arbitrary fields stripped', () => {
  assert.equal(fingerprintEvidence([{...evidence, chunkId: undefined}]), null);
  assert.equal(fingerprintEvidence([]), null);
  const fp = fingerprintEvidence([evidence])!;
  assert.deepEqual(readEvidenceFingerprints([{...fp[0], content: 'do not store'}]), fp);
  assert.equal(readEvidenceFingerprints([{...fp[0], chunkId: 9007199254740992}]), null);
  assert.equal(readEvidenceFingerprints([{...fp[0], contentSha256: 'raw text'}]), null);
  assert.equal(readEvidenceFingerprints(Array(51).fill(fp[0])), null);
});
test('durable envelope to production log preserves ordered fingerprints without text', () => {
  const fp = fingerprintEvidence([evidence, {...evidence, chunkId: '2'}]);
  const stored = packStoredQaFinal({answer: '답', source: 'unsure', ragEvidenceFingerprints: fp}, {text: '', inputTokens: null, outputTokens: null});
  const replay = unpackStoredQaFinal(stored.text)!;
  const row = buildQuestionLogRow({userId: 'test', question: '질문', questionNorm: '질문', matchPath: 'unsure', answer: '답', inputTokens: null, outputTokens: null, ragEvidenceFingerprints: replay.ragEvidenceFingerprints}, 1);
  assert.deepEqual(row.rag_evidence_fingerprints, fp);
  assert.equal(JSON.stringify(row.rag_evidence_fingerprints).includes(raw), false);
  assert.equal(unpackStoredQaFinal(packStoredQaFinal({answer:'답', source:'unsure'}, {text:'', inputTokens:null, outputTokens:null}).text)!.ragEvidenceFingerprints, null);
});

test('legacy log schema uses the same SSOT without dropping existing observations', () => {
  const entry = {userId: 'test', question: 'q', questionNorm: 'q', matchPath: 'unsure' as const, answer: null, inputTokens: null, outputTokens: null, ragAttemptPath: 'official' as const, ragDiscardReason: 'model_insufficient' as const, ragQuestionNumericCount: 1, ragDiscardNumericCount: 2, ragEvidenceFingerprints: fingerprintEvidence([evidence])};
  const modern = buildQuestionLogRow(entry, 42);
  const legacy = buildQuestionLogRow(entry, 42, {legacyEvidenceSchema: true});
  const {rag_evidence_fingerprints, ...existing} = modern;
  assert.ok(rag_evidence_fingerprints);
  assert.deepEqual(legacy, existing);
  assert.equal(legacy.rag_attempt_path, 'official');
  assert.equal(legacy.rag_discard_numeric_count, 2);
});

test('log migration applies twice independently of RAG tables and preserves observations', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { readFileSync } = await import('node:fs');
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE public.genius_question_logs (id integer PRIMARY KEY)');
    const sql = readFileSync('supabase/migrations/20261113000100_genius_question_evidence_fingerprints.sql', 'utf8');
    await db.exec(sql);
    const fp = fingerprintEvidence([evidence]);
    await db.query('INSERT INTO public.genius_question_logs VALUES (1, $1::jsonb)', [JSON.stringify(fp)]);
    await db.exec(sql);
    const result = await db.query<{rag_evidence_fingerprints: unknown}>('SELECT rag_evidence_fingerprints FROM public.genius_question_logs WHERE id=1');
    assert.deepEqual(result.rows[0].rag_evidence_fingerprints, fp);
    await assert.rejects(db.query('INSERT INTO public.genius_question_logs VALUES (2, $1::jsonb)', [JSON.stringify(Array(51).fill(fp![0]))]));
  } finally { await db.close(); }
});


test('production official RPC deployment failures close, bounded legacy succeeds, unrelated errors propagate', async () => {
  const { readFileSync } = await import('node:fs');
  const { loadOfficialSearch } = await import('./helpers/official-rag-harness');
  const { RAG_DOCUMENT_MAX_DISTANCE, RAG_DOCUMENT_CANDIDATE_LIMIT } = await import('../src/lib/baseball-qa/rag/retrieve');
  const source = readFileSync('src/lib/baseball-qa/server.ts', 'utf8');
  for (const first of ['PGRST202', '42883']) {
    for (const second of ['PGRST202', '42883', null]) {
      const calls: string[] = [];
      const search = loadOfficialSearch(source, async (name, args) => {
        calls.push(name);
        assert.equal(args.p_max_distance, RAG_DOCUMENT_MAX_DISTANCE);
        assert.equal(args.p_limit, RAG_DOCUMENT_CANDIDATE_LIMIT);
        const code = calls.length === 1 ? first : second;
        return code ? {data: null, error: {code}} : {data: [{content: 'legacy', source_grade: 'tier1'}], error: null};
      });
      const result = await search('보크가 뭐야');
      assert.deepEqual(calls, ['search_baseball_genius_official_chunks_v2', 'search_baseball_genius_official_chunks']);
      assert.equal(result.length, second ? 0 : 1);
      if (!second) assert.equal(fingerprintEvidence(result), null);
    }
  }
  let calls = 0;
  const search = loadOfficialSearch(source, async () => {
    calls++;
    return {data: null, error: {code: 'XX000'}};
  });
  await assert.rejects(search('보크'), (error: unknown) => (error as {code: string}).code === 'XX000');
  assert.equal(calls, 1);
});
