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
