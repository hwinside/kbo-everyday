/** Author self-check and independent reviewer check. Offline only; no model or DB access. */
import assert from 'node:assert/strict';
import parentheticals from './fixtures/official-parenthetical-serving.json';
import { officialParentheticalNote } from '../../src/lib/baseball-qa/rag/official-parenthetical-evidence';
import fixtures from './fixtures/official-scope-spans-census.json';
import { parseScope, renderScope, sha256, EXTRA_UNITS, type Source } from '../baseball-qa/rag/experimental-scope-spans';
import { scopeRequest, withScopeTransport } from '../baseball-qa/rag/experimental-scope-request';
import { buildOfficialContextRequest } from '../../src/lib/baseball-qa/rag/official-context-request';
import { siblingEvidence, standaloneSiblingEvidence, type OfficialEvidenceBundle } from '../../src/lib/baseball-qa/rag/official-sibling-evidence';
import type { RagEvidence } from '../../src/lib/baseball-qa/rag/retrieve';

const row = (s: Source): RagEvidence => ({...s, pageTitle: '공식 원문', asOf: '2026-10-04', sourceGrade: 'tier1', sourceKind: 'kbo_ebook'});
const plainBundle = (rows: RagEvidence[]): OfficialEvidenceBundle => ({modelEvidence:rows,rawEvidence:rows,guardEvidence:rows,
  trace:[],primaryCount:rows.length,physicalChunkCount:rows.length,skippedForContext:false,skipReason:null});
async function main() {
  const census = fixtures.rows.map(s => {
    assert.equal(sha256(s.content), s.rawContentSha256);
    const parsed = parseScope(s);
    if (parsed.relation) {
      const rendered = renderScope(s, parsed.relation);
      assert.equal(rendered.applied, true);
      assert.equal(rendered.content.length - s.content.length, 19);
      assert.equal(rendered.content.replace('[예외절 원문]', '').replace('\n[적용 본문 원문]', ''), s.content);
      for (const changed of [{...s,revision:s.revision+'x'}, {...s,canonicalUrl:s.canonicalUrl+'x'},
        {...s,sectionPath:s.sectionPath+'x'}, {...s,content:s.content+' '}])
        assert.equal(renderScope(changed,parsed.relation).content,changed.content);
      const wrong = structuredClone(parsed.relation); wrong.governedClause[0]++;
      assert.equal(renderScope(s,wrong).content,s.content);
    }
    return {id:s.id, manual:s.manualAssessment, automatic:parsed.reason, applied:Boolean(parsed.relation)};
  });
  console.log(JSON.stringify({census},null,2));
  // HOLD on disagreement with the frozen six candidate / eight reject / four unsupported census.
  assert.equal(census.filter(r=>r.applied).length,6,'HOLD: automatic census differs');
  assert.ok(census.every(r=>r.applied === r.manual.startsWith('통과:')),'HOLD: per-row census differs');
  assert.equal(EXTRA_UNITS,19);
  const p62 = row(fixtures.rows.find(r=>r.id===192183)!);
  // Topic vs adnominal, particle allomorphs, and list boundaries: synthetic
  // vocabulary and identities, independent of the frozen corpus row IDs.
  for (const content of [
    '차단막은 플레이 과정에 눌린 부분을 제외하고 나머지는 유지한다.',
    '플레이 장비에 닿는 부분을 제외하고 나머지는 유지한다.',
    '장비이 물체에 닿는 부분을 제외하고 나머지는 유지한다.',
    '장벽가 물체에 닿는 부분을 제외하고 나머지는 유지한다.',
    '장비가 표면은 닿는 부분을 제외하고 나머지는 유지한다.',
  ]) assert.equal(parseScope({...p62,content}).relation,undefined,content);
  for (const bullet of ['- ', '·', '• ', '* ']) {
    const lead = `앞선 제목\n  ${bullet}`;
    const sentence = '장비가 물체에 닿는 부분을 제외하고 나머지는 유지한다.';
    const source = {...p62,content:lead+sentence};
    const parsed = parseScope(source).relation!;
    assert.ok(parsed,'list marker must delimit the scope');
    assert.equal(parsed.sentence[0],lead.length);
    assert.equal(renderScope(source,parsed).content,lead+'[예외절 원문]장비가 물체에 닿는 부분을 제외하고\n[적용 본문 원문] 나머지는 유지한다.');
    assert.equal(parseScope({...source,content:lead+'차단막은 플레이 과정에 눌린 부분을 제외하고 나머지는 유지한다.'}).relation,undefined);
  }
  assert.ok(parseScope({...p62,content:'장벽이 물체에 닿는 부분을 제외하고 나머지는 유지한다.'}).relation);
  const emoji = {...p62,content:'😀\n'+p62.content};
  const relation = parseScope(emoji).relation!;
  assert.equal(emoji.content.slice(...relation.excludedScope),'인필드 플라이 규칙이 적용되는 경우');
  for (const content of ['앞부분 없는 경우를 제외하고 끝이 잘렸', '경우를 제외하고 경우를 제외하고 한다.',
    '경우를 제외하고는 적용한다.', '경우를 제외하고 (다른 경우는 제외) 적용한다.'])
    assert.equal(parseScope({...p62,content}).relation,undefined);
  const extras = {referenceTimeMs: Date.parse('2026-10-04T00:00:00Z'),context:{question:'포구는 뭐야?',answer:'고정된 직전 답변'}};
  const definition = parentheticals.rows.find(s=>s.row.section.includes('40. INFIELD FLY'))!.row;
  const definitionRow = row({canonicalUrl:definition.canonicalUrl,revision:definition.revision,
    sectionPath:definition.section,content:definition.text});
  const note = officialParentheticalNote(definitionRow);
  assert.ok(note.includes('직선타구') && note.includes('번트'));
  const rows = [p62,definitionRow], bundle = plainBundle(rows);
  const frozen = JSON.stringify(bundle);
  const base = buildOfficialContextRequest('그건 플라이아웃 아니야?',rows,extras);
  const baseBytes = JSON.stringify(base);
  const changed = scopeRequest(base,rows,bundle);
  assert.equal(changed.applied,1);
  assert.equal(changed.addedUnits,19);
  assert.ok(changed.request.contents[0].parts[0].text.includes(note));
  assert.equal(JSON.stringify(bundle),frozen,'raw/guard/model input immutable');
  assert.equal(JSON.stringify(base),baseBytes,'base immutable');
  assert.deepEqual(changed.request.systemInstruction,base.systemInstruction);
  assert.deepEqual(changed.request.generationConfig,base.generationConfig);
  assert.equal(changed.request.contents[0].parts[0].text.replace('[예외절 원문]','').replace('\n[적용 본문 원문]',''),base.contents[0].parts[0].text);
  for (const skipped of [undefined, {...bundle,physicalChunkCount:8}, {...bundle,modelEvidence:[]}]) {
    assert.equal(JSON.stringify(scopeRequest(base,rows,skipped).request),baseBytes);
  }
  const noScope = [row({...p62,content:'일반 문장이다.'})];
  const noRequest = buildOfficialContextRequest('정의?',noScope,extras);
  assert.equal(scopeRequest(noRequest,noScope,plainBundle(noScope)).request,noRequest);

  // Real sibling builder: transform bound anchor only, never parse the synthetic block.
  const anchor = {...p62,content:'5.09 아웃\n[부기] 인필드 플라이 규칙이 적용되는 경우를 제외하고 타자는 아웃이 되지 않는다.'};
  const sibling = {...p62,sectionPath:'test#p60',content:'5.09 아웃\n⑸ 인필드 플라이가 선언되었을 경우'};
  const sourceText = '타자 아웃\n⑸ 인필드 플라이가 선언되었을 경우';
  const manifest = [{canonicalUrl:sibling.canonicalUrl,sourceRevision:sibling.revision,section:sibling.sectionPath,
    rawContentSha256:sha256(sibling.content),bindings:[{section:'5.09',lead:'타자 아웃',item:'⑸ 인필드 플라이가 선언되었을 경우',
      sourceText,sourceTextSha256:sha256(sourceText),leadStart:0,itemStart:6}]}];
  const sb = {...siblingEvidence([anchor],[sibling],manifest),skippedForContext:false,skipReason:null} as OfficialEvidenceBundle;
  assert.equal(sb.trace.length,1,'test must exercise actual sibling bundle');
  const sbFrozen=JSON.stringify(sb);
  const sbRequest=buildOfficialContextRequest('독립 질문',sb.modelEvidence,{referenceTimeMs:extras.referenceTimeMs});
  const sbChanged=scopeRequest(sbRequest,sb.modelEvidence,sb);
  assert.equal(sbChanged.applied,1);
  assert.equal(JSON.stringify(sb),sbFrozen);
  assert.equal(sbChanged.request.contents[0].parts[0].text.replace('[예외절 원문]','').replace('\n[적용 본문 원문]',''),sbRequest.contents[0].parts[0].text);
  assert.equal(standaloneSiblingEvidence([anchor],[sibling],manifest,extras).skipReason,'context');

  // A fake transport observes URL/headers/signal/options unchanged and one call only.
  const realFetch=globalThis.fetch;
  const signal=new AbortController().signal;
  const init={method:'POST',headers:{'Content-Type':'application/json'},signal,body:baseBytes};
  let observed=0;
  const fake: typeof fetch=async (_input,options)=>{
    observed++; assert.equal(options?.signal,signal); assert.equal(options?.headers,init.headers);
    assert.equal(options?.body,JSON.stringify(changed.request));
    return new Response('{}',{status:200});
  };
  globalThis.fetch=fake;
  try {
    await withScopeTransport(base,changed.request,()=>fetch('https://generativelanguage.googleapis.com/v1beta/models/test:generateContent',init));
    assert.equal(observed,1);assert.equal(globalThis.fetch,fake);
    await assert.rejects(()=>withScopeTransport(base,changed.request,()=>fetch('https://example.org',init)),/contract mismatch/);
    assert.equal(globalThis.fetch,fake);
    await assert.rejects(()=>withScopeTransport(base,changed.request,async()=>{throw new Error('server-failure');}),/server-failure/);
    assert.equal(globalThis.fetch,fake);
  } finally {globalThis.fetch=realFetch;}
  console.log('PASS: lossless spans, frozen census, raw/guard preservation, payload and transport invariants (offline; not semantic QA)');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
