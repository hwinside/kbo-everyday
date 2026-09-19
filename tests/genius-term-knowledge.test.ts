import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerQuestion, validateLlmResponse, packStoredQaFinal, unpackStoredQaFinal, type QaDeps, type LlmResult } from '../src/lib/baseball-qa/pipeline';
import { validateRagResponse, type RagEvidence } from '../src/lib/baseball-qa/rag/retrieve';
import { TERM_UNVERIFIED, UNVERIFIED_TERM_ANSWER, UNVERIFIED_TERM_CORRECTION_ANSWER, termKnowledgeCacheKey, TERM_KNOWLEDGE_CACHE_VERSION } from '../src/lib/baseball-qa/term-knowledge';

const raw = (correctsPrevious = false): LlmResult => ({ text: JSON.stringify({ status: TERM_UNVERIFIED, correctsPrevious, answer: '세븐히트는 타자가 일곱 번 타석에 서는 공식 야구 용어입니다.' }), inputTokens: 20, outputTokens: 10 });
const evidence: RagEvidence = { content: '안타는 타자가 친 공으로 안전하게 진루하는 기록이다.', pageTitle: '공식야구규칙', canonicalUrl: 'https://www.koreabaseball.com/Reference/Etc/GameRule.aspx', revision: '2026', sectionPath: '기록', asOf: '2026-09-18', sourceGrade: 'tier1' };
function harness(official = false) {
  const writes: string[] = [];
  const reads: string[] = [];
  let stored: LlmResult | null = null;
  let calls = 0;
  const deps: QaDeps = {
    loadGlossary: async () => [], loadPlayers: async () => [],
    getCache: async key => { reads.push(key); return key.startsWith(`term-v${TERM_KNOWLEDGE_CACHE_VERSION}:`) ? null : '세븐히트는 일곱 안타입니다.'; },
    setCache: async key => { writes.push(key); },
    callLlm: async () => { calls++; return raw(); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
    storeLlm: async result => { stored = result; },
    ...(official ? { searchOfficialRag: async () => [evidence], callOfficialRagLlm: async () => { calls++; return raw(); } } : {}),
  };
  return { deps, writes, reads, get stored() { return stored; }, get calls() { return calls; } };
}

test('unverified provider prose is discarded in both generation paths; correction is explicit', () => {
  for (const correction of [false, true]) {
    const expected = correction ? UNVERIFIED_TERM_CORRECTION_ANSWER : UNVERIFIED_TERM_ANSWER;
    const generic = validateLlmResponse(raw(correction).text, '세븐히트가 뭐야');
    assert.equal(generic.answer, expected);
    const official = validateRagResponse(raw(correction).text, { generalFallback: { question: '세븐히트가 뭐야' } });
    assert.equal(official.kind, 'general');
    if (official.kind === 'general') assert.equal(official.answer, expected);
  }
  // This contract must not turn on in unrelated news/player RAG.
  assert.equal(validateRagResponse(raw().text).kind, 'insufficient');
  assert.equal(validateLlmResponse(JSON.stringify({ status: TERM_UNVERIFIED, correctsPrevious: 'true' })).answer, UNVERIFIED_TERM_ANSWER);
});

test('generic and official pipeline: no fabricated definition, citation or shared-cache write; replay stable', async () => {
  for (const official of [false, true]) {
    const h = harness(official);
    const first = await answerQuestion('test-user', '세븐히트가 뭐야', h.deps);
    assert.equal(first.answer, UNVERIFIED_TERM_ANSWER);
    assert.equal(first.source, 'llm');
    assert.equal(first.sourceUrl, undefined);
    assert.equal(h.calls, 1);
    assert.equal(h.writes.length, 0);
    assert.ok(h.stored);
    const saved = h.stored;
    const second = await answerQuestion('test-user', '세븐히트가 뭐야', { ...h.deps, getLlmState: async () => ({ started: true, result: saved }) });
    assert.equal(second.answer, first.answer);
    assert.equal(h.calls, 1);
    assert.equal(h.writes.length, 0);
  }
});

test('old final replay cannot seed the new shared cache; same-job response remains idempotent', async () => {
  const h = harness();
  const old = packStoredQaFinal({ answer: '야구에서 이전 용어 설명입니다.', source: 'llm', cacheable: true }, raw());
  const response = await answerQuestion('test-user', '야구 용어 설명', { ...h.deps, getLlmState: async () => ({ started: true, result: old }) });
  assert.equal(response.answer, '야구에서 이전 용어 설명입니다.');
  assert.equal(h.writes.length, 0);
  assert.equal(h.calls, 0);
});

test('current cache version survives durable crash recovery', async () => {
  const h = harness();
  const final = packStoredQaFinal({ answer: '야구에서 안타는 타자가 친 공으로 안전하게 진루한 기록입니다.', source: 'llm', cacheable: true, cacheVersion: TERM_KNOWLEDGE_CACHE_VERSION }, raw());
  assert.equal(unpackStoredQaFinal(final.text)?.cacheVersion, TERM_KNOWLEDGE_CACHE_VERSION);
  await answerQuestion('test-user', '안타', { ...h.deps, getLlmState: async () => ({ started: true, result: final }) });
  assert.equal(h.writes.length, 1);
  assert.ok(h.writes[0].startsWith(`term-v${TERM_KNOWLEDGE_CACHE_VERSION}:`));
  assert.notEqual(termKnowledgeCacheKey('안타'), '안타');
});

test('known dictionary and generated baseball terms still answer', async () => {
  const h = harness();
  const answer = '야구에서 안타는 타자가 친 공으로 안전하게 진루한 기록입니다.';
  h.deps.loadGlossary = async () => [{ term: '안타', aliases: [], answer }];
  const result = await answerQuestion('test-user', '안타', h.deps);
  assert.equal(result.source, 'dictionary');
  assert.equal(result.answer, answer);
  assert.equal(h.calls, 0);
  assert.equal(validateLlmResponse(JSON.stringify({ status: 'BASEBALL_RULE_TERM', answer }), '안타가 뭐야').kind, 'answer');
  assert.equal(validateRagResponse(JSON.stringify({ status: 'GENERAL', answer }), { generalFallback: { question: '안타가 뭐야' } }).kind, 'general');
});

test('pre-policy cached definitions cannot bypass new generation', async () => {
  const h = harness();
  h.deps.callLlm = async () => raw();
  h.deps.loadGlossary = async () => [{ term: '보크', aliases: [], answer: '야구에서 투수의 반칙 투구입니다.' }];
  const result = await answerQuestion('test-user', '보크 규칙이 왜 필요해?', h.deps);
  assert.ok(h.reads.length > 0, 'exercise cache-eligible rule route, not a scope-gate bypass');
  assert.ok(h.reads.every(key => key.startsWith(`term-v${TERM_KNOWLEDGE_CACHE_VERSION}:`)));
  assert.equal(result.answer, UNVERIFIED_TERM_ANSWER);
  assert.equal(h.writes.length, 0);
});

test('contextual interpretation quotes only the user usage span, never model-added facts', async () => {
  const question = '친구가 안타 일곱 개 친 걸 보고 세븐히트라고 농담했대';
  const text = JSON.stringify({ status: 'TERM_CONTEXTUAL', contextMeaning: '안타 일곱 개 친', answer: 'KBO 역사상 존재하지 않는 기록입니다.' });
  const generic = validateLlmResponse(text, question);
  assert.match(generic.answer!, /말씀하신 “안타 일곱 개 친”/);
  assert.match(generic.answer!, /문맥상 해석/);
  assert.doesNotMatch(generic.answer!, /역사상/);
  const official = validateRagResponse(text, { generalFallback: { question } });
  assert.equal(official.kind, 'general');
  if (official.kind === 'general') assert.equal(official.answer, generic.answer);
  // Safe rendering cannot promote a span absent from this current question.
  const unknown = validateLlmResponse(text, '세븐히트가 뭐야');
  assert.equal(unknown.answer, UNVERIFIED_TERM_ANSWER);
  const invented = validateLlmResponse(JSON.stringify({ status: 'TERM_CONTEXTUAL', contextMeaning: '프로 역사상 최초', answer: '' }), question);
  assert.equal(invented.answer, UNVERIFIED_TERM_ANSWER);
  const unsafe = validateLlmResponse(JSON.stringify({ status: 'TERM_CONTEXTUAL', contextMeaning: 'https://example.com', answer: '' }), 'https://example.com 야구 용어');
  assert.equal(unsafe.answer, UNVERIFIED_TERM_ANSWER);
});

const prior = (answer: string, question = '세븐히트가 뭐야?') => ({
  question, answer, jobSource: 'llm', answeredAt: '2026-09-19T00:00:00Z', currentCreatedAt: '2026-09-19T00:01:00Z',
});
const response = (status: string, contextMeaning = ''): LlmResult => ({
  text: JSON.stringify({ status, contextMeaning, correctsPrevious: false, answer: '' }), inputTokens: 10, outputTokens: 10,
});

test('R1 bare term cannot masquerade as a situation in either full pipeline', async () => {
  for (const official of [false, true]) {
    const h = harness(official);
    h.deps.callLlm = async () => response('TERM_CONTEXTUAL', '세븐히트');
    if (official) h.deps.callOfficialRagLlm = async () => h.deps.callLlm('unused');
    const result = await answerQuestion('test-user', '세븐히트가 뭐야?', h.deps);
    assert.equal(result.answer, UNVERIFIED_TERM_ANSWER);
    assert.equal(result.source, 'llm');
  }
});

test('R1 actual usage passes mixed-stat routing and reaches validated contextual terminal', async () => {
  const question = '문자에서 친구가 오늘 안타 일곱 개 친 걸 보고 세븐히트라고 농담했대. 여기서는 무슨 말이야?';
  for (const official of [false, true]) {
    const h = harness(official);
    let calls = 0;
    const call = async () => { calls++; return response('TERM_CONTEXTUAL', '안타 일곱 개 친'); };
    h.deps.callLlm = call;
    if (official) h.deps.callOfficialRagLlm = call;
    const result = await answerQuestion('test-user', question, h.deps);
    assert.equal(calls, 1);
    assert.equal(result.source, 'llm');
    assert.match(result.answer, /“안타 일곱 개 친”.*문맥상 해석/);
    const replay = await answerQuestion('test-user', question, { ...h.deps, getLlmState: async () => ({ started: true, result: h.stored }) });
    assert.equal(replay.answer, result.answer);
    assert.equal(calls, 1);
    assert.equal(result.sourceUrl, undefined);
    assert.equal(h.writes.length, 0);
  }
});

test('R1 previous same-term assertion is retracted despite false model flag in both terminals', async () => {
  for (const official of [false, true]) for (const status of ['TERM_UNVERIFIED', 'TERM_CONTEXTUAL']) {
    const h = harness(official);
    h.deps.loadPreviousTurn = async () => prior('세븐히트는 한 선수가 일곱 안타를 치는 공식 용어입니다.');
    h.deps.callLlm = async () => response(status, '세븐히트');
    if (official) h.deps.callOfficialRagLlm = async () => h.deps.callLlm('unused');
    const result = await answerQuestion('test-user', '세븐히트가 뭐라고?', h.deps);
    assert.equal(result.answer, UNVERIFIED_TERM_CORRECTION_ANSWER);
    assert.equal(h.writes.length, 0);
    assert.ok(h.stored);
    const replay = await answerQuestion('test-user', '세븐히트가 뭐라고?', { ...h.deps, getLlmState: async () => ({ started: true, result: h.stored }) });
    assert.equal(replay.answer, result.answer);
  }
});

test('R1 unrelated or already-qualified prior answers are not retracted', async () => {
  for (const previous of [prior('DH는 지명타자입니다.', 'DH가 뭐야?'), prior(UNVERIFIED_TERM_ANSWER), prior('세븐히트는 문맥상 추정일 뿐입니다.')]) {
    const h = harness();
    h.deps.loadPreviousTurn = async () => previous;
    const result = await answerQuestion('test-user', '세븐히트가 뭐라고?', h.deps);
    assert.equal(result.answer, UNVERIFIED_TERM_ANSWER);
  }
});


test('R1 usage exception cannot publish free-form model records or swallow a mixed record request', async () => {
  const question = '문자에서 친구가 오늘 안타 일곱 개 친 걸 보고 세븐히트라고 농담했대. 여기서는 무슨 말이야?';
  const h = harness();
  h.deps.callLlm = async () => ({ text: JSON.stringify({ status: 'BASEBALL_RULE_TERM', answer: '야구에서 세븐히트는 공식 기록이며 역대 최다는 99개입니다.' }), inputTokens: 10, outputTokens: 10 });
  const rejected = await answerQuestion('test-user', question, h.deps);
  assert.equal(rejected.source, 'stat_clarify');
  assert.doesNotMatch(rejected.answer, /99|공식 기록/);
  const record = await answerQuestion('test-user', question + ' LG 팀타율이랑 오타니 홈런 몇개?', harness().deps);
  assert.equal(record.source, 'stat_clarify');
});

// Production QA regression: the second turn must use the actual first terminal
// answer, not a handcrafted prior, even when the provider incorrectly says true.
for (const official of [false, true]) for (const term of ['세븐히트', '큐에이포틴히트']) {
  test(`hotfix two-turn ${official ? 'official' : 'generic'} ${term}: qualified answer vetoes provider retraction`, async () => {
    const h = harness(official);
    const firstQuestion = `${term}가 뭐라고?`;
    const usageQuestion = `문자에서 친구가 오늘 안타 일곱 개 친 걸 보고 ${term}라고 농담했대. 여기서는 무슨 말이야?`;
    let next = raw();
    let genericCalls = 0;
    let officialCalls = 0;
    h.deps.callLlm = async () => { genericCalls++; return next; };
    if (official) h.deps.callOfficialRagLlm = async () => { officialCalls++; return next; };
    const first = await answerQuestion('test-user', firstQuestion, h.deps);
    assert.equal(first.answer, UNVERIFIED_TERM_ANSWER);
    h.deps.loadPreviousTurn = async () => prior(first.answer, firstQuestion);
    next = { ...raw(true), text: JSON.stringify({ status: 'TERM_CONTEXTUAL', contextMeaning: '안타 일곱 개 친', correctsPrevious: true }) };
    const second = await answerQuestion('test-user', usageQuestion, h.deps);
    const expected = '말씀하신 “안타 일곱 개 친” 상황을 가리킨 표현으로 보입니다. 문맥상 해석이며, 확인된 야구 용어의 정의는 아닙니다.';
    assert.equal(second.answer, expected);
    assert.equal(second.source, 'llm');
    assert.equal(second.sourceUrl, undefined);
    // A contextual terminal is also qualified on the following turn.
    h.deps.loadPreviousTurn = async () => prior(second.answer, usageQuestion);
    const third = await answerQuestion('test-user', usageQuestion, h.deps);
    assert.equal(third.answer, expected);
    assert.equal(genericCalls, official ? 0 : 3);
    assert.equal(officialCalls, official ? 3 : 0);
    assert.ok(h.stored);
    const saved = h.stored;
    const replay = await answerQuestion('test-user', usageQuestion, { ...h.deps, getLlmState: async () => ({ started: true, result: saved }) });
    assert.equal(replay.answer, expected);
    assert.equal(genericCalls + officialCalls, 3);
    assert.equal(h.writes.length, 0);
  });
}

test('hotfix both validators: qualified prior veto applies to unknown and invalid context terminals', () => {
  const question = '세븐히트가 뭐라고?';
  const contextual = '말씀하신 “안타 일곱 개 친” 상황을 가리킨 표현으로 보입니다. 문맥상 해석이며, 확인된 야구 용어의 정의는 아닙니다.';
  for (const answer of [UNVERIFIED_TERM_ANSWER, UNVERIFIED_TERM_CORRECTION_ANSWER, contextual]) {
    for (const status of ['TERM_UNVERIFIED', 'TERM_CONTEXTUAL']) {
      const text = JSON.stringify({ status, correctsPrevious: true, contextMeaning: '질문에 없는 사용 상황' });
      const previous = prior(answer);
      assert.equal(validateLlmResponse(text, question, previous).answer, UNVERIFIED_TERM_ANSWER);
      const official = validateRagResponse(text, { generalFallback: { question, previous } });
      assert.equal(official.kind, 'general');
      if (official.kind === 'general') assert.equal(official.answer, UNVERIFIED_TERM_ANSWER);
    }
  }
});

test('hotfix genuine prior assertion still retracts with either provider flag and valid contextual meaning', async () => {
  const question = '친구가 안타 일곱 개 친 걸 보고 세븐히트라고 농담했대';
  for (const official of [false, true]) for (const correctsPrevious of [false, true]) {
    const h = harness(official);
    h.deps.loadPreviousTurn = async () => prior('세븐히트는 한 선수가 일곱 안타를 치는 공식 용어입니다.');
    const call = async () => ({ ...raw(), text: JSON.stringify({ status: 'TERM_CONTEXTUAL', contextMeaning: '안타 일곱 개 친', correctsPrevious }) });
    h.deps.callLlm = call;
    if (official) h.deps.callOfficialRagLlm = call;
    const result = await answerQuestion('test-user', question, h.deps);
    assert.match(result.answer, /^앞서 확인되지 않은 뜻을 단정한 설명은 철회합니다\. 말씀하신 “안타 일곱 개 친”/);
    assert.equal(h.writes.length, 0);
  }
});
