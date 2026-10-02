/** Reviewer-owned execution: contract boundaries + real official provision census. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { structureOfficialParentheticals as derive, renderOfficialParentheticals as render } from '../baseball-qa/rag/official-parenthetical-structure.mjs';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/official-parenthetical-provisions.json', import.meta.url)));
let others = 0;
for (const row of fixture.rows) {
  const s = derive(row.text, 'fixture-v1');
  for (const r of s.relations) for (const span of [r.context, r.parenthetical, ...r.items]) {
    assert.equal(row.text.slice(span.start, span.end), span.quote);
  }
  if (row.section.startsWith('40.')) {
    assert.deepEqual(s.relations[0].items.map(i => i.quote), ['직선타구', '번트한 것이 떠올라 플라이 볼이 된 것']);
    assert.equal(s.relations[0].coordination, 'explicit-or');
  } else if (s.relations.length) others++;
  const note = render(row.text, 'fixture-v1', s);
  assert.equal(Boolean(note), Boolean(s.relations.length));
  assert.throws(() => render(row.text + '변경', 'fixture-v1', s));
  assert.throws(() => render(row.text, 'changed-revision', s));
  if (s.relations.length) {
    const forged = structuredClone(s); forged.relations[0].items[0].quote = '허위 항목';
    assert.throws(() => render(row.text, 'fixture-v1', forged));
  }
}
assert.ok(others >= 10, `only ${others} additional official provisions`);
assert.equal(derive('범주 (사과 또는 배는 제외)', 'r').relations[0].items.length, 2);
assert.equal(derive('범주 (두 사과 또는 배는 제외)', 'r').relations[0].coordination, 'unsplit');
assert.equal(derive('범주 (사과 또는 배 또는 감은 제외)', 'r').relations[0].coordination, 'unsplit');
assert.equal(derive('범주 (사과는 제외하지 않는다)', 'r').relations[0].kind, 'qualifier-quote');
assert.equal(derive('범주 (사과(품종) 제외)', 'r').relations.length, 0);
assert.equal(derive('범주 (사과 제외', 'r').relations.length, 0);
assert.equal(derive('범주 (사과 제외) 잘린 (뒷부분', 'r').relations.length, 0);
assert.equal(derive('범주 (영어 번역)', 'r').relations.length, 0);
// JSONB key reordering must not invalidate a genuine contract.
const s = derive('범주 (사과 제외)', 'r');
assert.ok(render('범주 (사과 제외)', 'r', Object.fromEntries(Object.entries(s).reverse())));
console.log(`PASS: definition 40 + ${others} other official provisions; stale/forged/nested/truncated/negative boundaries`);
