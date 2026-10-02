/** Reviewer-owned execution: contract boundaries + real official provision census. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { annotationContentDigest, structureOfficialParentheticals as derive, renderOfficialParentheticals as render } from '../baseball-qa/rag/official-parenthetical-structure.mjs';
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

// Manifest producer and reviewer consumer must use exactly the same fingerprint.
assert.equal(annotationContentDigest("플라이 볼\n(직선타구 제외)"), annotationContentDigest("플라이볼 (직선타구 제외)"));
assert.notEqual(annotationContentDigest("직선타구 제외"), annotationContentDigest("직선타구 포함"));
const harness = fs.readFileSync(new URL("./genius-infield-evidence-live.ts", import.meta.url), "utf8");
const emitter = fs.readFileSync(new URL("../baseball-qa/rag/emit-official-parentheticals.mjs", import.meta.url), "utf8");
assert.match(harness, /const digest = annotationContentDigest;/);
assert.match(emitter, /contentSha256: annotationContentDigest\(row.text\)/);
assert.match(harness, /a.sourceRevision === row.revision/);


// Real serving boundaries, not the unapplied v3.1 corpus. Producer/consumer contract.
const serving = JSON.parse(fs.readFileSync(new URL('./fixtures/official-parenthetical-serving.json', import.meta.url)));
const otherSections = new Set();
for (const { row, annotation } of serving.rows) {
  assert.equal(annotation.contentSha256, annotationContentDigest(row.text));
  assert.equal(annotation.sourceRevision, row.revision);
  assert.equal(annotation.claimGeneration, row.claimGeneration);
  assert.equal(annotation.canonicalUrl, row.canonicalUrl);
  assert.equal(render(row.text, row.revision, annotation.structure), annotation.note);
  assert.ok(annotation.structure.relations.length > 0);
  if (!row.section.includes('40. INFIELD FLY')) otherSections.add(row.section);
}
assert.ok(otherSections.size >= 10, `only ${otherSections.size} other serving sections`);

// Scope markers must survive only as exact quotations, not asserted exclusions.
for (const inner of ['연속 이닝 선발 등판 무실점 기록에서 제외', '’89 이후, ’99~’00 양대리그 제외', '단, 우천시 제외', '1989 이전 제외', '1989부터 제외', '2000까지 제외', '명단으로 제외', '기록에 제외']) {
  const text = `본문 (${inner})`;
  const structure = derive(text, 'r');
  assert.equal(structure.relations[0].kind, 'qualifier-quote', inner);
  assert.equal(structure.relations[0].parenthetical.quote, `(${inner})`);
  assert.doesNotMatch(render(text, 'r', structure), /제외 항목/);
}

console.log(`PASS: ${serving.rows.length} serving chunks / ${otherSections.size} other sections; shared digest + revision + render`);

// Leading exception scope: generic syntax, no rule or question keyword routing.
for (const text of [
  '[부기] 허가가 있는 경우를 제외하고 참가자는 대기하여야 한다.',
  '허가가 있는 경우를 제외하고는 참가자는 대기하여야 한다.',
  '앞 문장이다. [주] 승인이 있는 경우를 제외하고, 물품은 보관한다.',
]) {
  const s = derive(text, 'r');
  const relation = s.relations.find(r => r.kind === 'leading-exception');
  assert.ok(relation, text);
  assert.match(relation.items[0].quote, /경우$/);
  assert.doesNotMatch(relation.context.quote, /제외하고/);
  assert.match(render(text, 'r', s), /예외 상황의 효과는 이 문장의 반대로 추론하지 않고/);
  const forged = structuredClone(s); forged.relations[0].context.quote = '반대 효과';
  assert.throws(() => render(text, 'r', forged));
}
for (const text of [
  '횟수는 허가가 있는 경우를 제외하고 제한한다.',
  '[주] 허가가 있는 경우를 제외하고 참가자는 대기',
  '[주] 허가가 있는 경우를 제외하지 않고 참가자는 대기한다.',
  '[주] 허가가 있는 경우를 제외하고 [다음 조항] 물품은 보관한다.',
  '[주] 허가가 있는 경우를 제외하고 다만 물품은 보관한다.',
  '[주] 허가가 있는 경우를 제외하고 승인된 경우를 제외한다.',
  '두 타자를 제외하고 전원 출루한다.',
]) assert.equal(derive(text, 'r').relations.filter(r => r.kind === 'leading-exception').length, 0, text);
const exceptionRow = serving.rows.find(x => x.annotation.structure.relations.some(r => r.kind === 'leading-exception'));
assert.ok(exceptionRow, 'actual serving leading-exception fixture required');
assert.match(exceptionRow.annotation.note, /예외 조건을 제외한 경우에만 적용되는 본문/);
