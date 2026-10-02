/** Reviewer-owned execution. Synthetic scope collisions + actual audit contract. */
import assert from 'node:assert/strict';
import { enumerationCandidates, bindEnumerationContexts } from '../baseball-qa/rag/official-enumeration-context.mjs';
const corpusRow = (section, lead, item) => ({ source: 'kbo_official', unit: 'complete_rule', atomic: true,
  title: '공식 문서', section, text: `공식 문서 / ${section}\n${lead} ${item}`, page: 3 });
const item = '⑸ 공이 정규로 처리되었을 경우';
const a = corpusRow('1.01 판정 / ⒜ / ⑸', '다음의 경우 타자는 아웃된다.', item);
const b = corpusRow('1.01 판정 / ⒝ / ⑸', '다음의 경우 주자는 아웃된다.', item);
const serving = { section: '공식 문서#p2', text: `1.01 판정 (이어짐)\n${item}`, canonicalUrl: 'https://example.test/a', revision: 'rev' };
assert.equal(bindEnumerationContexts([serving], enumerationCandidates([a])).length, 1);
assert.equal(bindEnumerationContexts([serving], enumerationCandidates([a, b])).length, 0, 'conflicting enumeration scope');
assert.equal(bindEnumerationContexts([{ ...serving, section: '다른 문서#p2' }], enumerationCandidates([a])).length, 0);
assert.equal(bindEnumerationContexts([{ ...serving, text: serving.text.replace('1.01', '2.01') }], enumerationCandidates([a])).length, 0);
assert.equal(bindEnumerationContexts([{ ...serving, text: serving.text + '\n다음의 경우 타자는 아웃된다.' }], enumerationCandidates([a])).length, 0);
assert.equal(enumerationCandidates([corpusRow('1.01 판정 / ⒜ / ⑸', '조건이 절단되어', item)]).length, 0);
assert.equal(bindEnumerationContexts([{ ...serving, text: serving.text.slice(0, -5) }], enumerationCandidates([a])).length, 0);
const note = bindEnumerationContexts([serving], enumerationCandidates([a]))[0];
for (const binding of note.bindings) {
  assert.equal(binding.sourceText.slice(binding.leadStart, binding.leadStart + binding.lead.length), binding.lead);
  assert.equal(binding.sourceText.slice(binding.itemStart, binding.itemStart + binding.item.length), binding.item);
}
console.log('PASS: enumeration scope collisions, document/article identity, truncation and source spans');
