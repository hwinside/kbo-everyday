/** Independent reviewer executes; no network, production writes, or model calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { answerQuestion, matchGlossary, type GlossaryEntry, type QaDeps } from "../../src/lib/baseball-qa/pipeline";
import { normalizeKey, normalizeQuestion } from "../../src/lib/baseball-qa/normalize";
import { isBaseballGeniusToneCompliant } from "../../src/lib/baseball-qa/tone";

async function main() {
  const db = new PGlite();
  try {
    const schema = fs.readFileSync("supabase/migrations/20260730_baseball_qa.sql", "utf8").split(";")[0] + ";";
    await db.exec(schema);
    const before = JSON.parse(fs.readFileSync("scripts/qa/fixtures/baseball-terms-before-series-20261108.json", "utf8"));
    for (const row of before) {
      await db.query(`INSERT INTO public.baseball_terms
        (id,term,aliases,answer,category,source_kind,source_url,rule_version,reviewed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id,row.term,row.aliases,row.answer,row.category,row.source_kind,row.source_url,row.rule_version,row.reviewed_at]);
    }
    const snapshot = (await db.query("SELECT * FROM public.baseball_terms ORDER BY id")).rows;
    assert.equal(matchGlossary(before, "4선승제?"), null, "base lacks observed definition");
    const migration = fs.readFileSync("supabase/migrations/20261108050000_baseball_terms_series_definition.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration);
    const after = (await db.query<GlossaryEntry & { id: string }>("SELECT * FROM public.baseball_terms ORDER BY id")).rows;
    assert.equal(after.length, before.length + 1, "one addition, idempotent replay");
    assert.deepEqual(after.filter(row => row.term !== "4선승제"), snapshot, "all existing fields preserved");
    const added = after.find(row => row.term === "4선승제")!;
    const newKeys = new Set([added.term, ...added.aliases].flatMap(name => [normalizeKey(name), normalizeQuestion(name)]));
    for (const row of before) for (const name of [row.term, ...row.aliases]) {
      assert.ok(!newKeys.has(normalizeKey(name)) && !newKeys.has(normalizeQuestion(name)), `alias collision: ${row.term}`);
    }
    assert.match(added.answer, /먼저 4승을 거둔 팀/);
    assert.match(added.answer, /4경기를 치른다는 뜻이 아니라/);
    assert.match(added.answer, /무승부는 어느 팀의 승수에도 더하지 않습니다/);
    assert.doesNotMatch(added.answer, /최대 7경기|무조건 7경기/);
    assert.ok(isBaseballGeniusToneCompliant(added.answer));
    let calls = 0;
    const deps: QaDeps = {
      loadGlossary: async () => after, loadPlayers: async () => [],
      getCache: async () => null, setCache: async () => {},
      callLlm: async () => { calls++; return { text: "{\"status\":\"UNSURE\",\"answer\":\"\"}", inputTokens: 0, outputTokens: 0 }; },
      reserveDaily: async () => ({ allowed: true, remaining: 10 }), log: async () => {},
    };
    const positives = ["4선승제가 뭔가요", "4선승제", "4선승", "사선승제", "7전 4선승제", "7전4선승제"];
    for (const q of positives) {
      const result = await answerQuestion("qa-series-offline", q, deps);
      assert.equal(result.source, "dictionary", q);
      assert.equal(result.term, "4선승제", q);
      assert.equal(result.answer, added.answer, q);
    }
    const observed = JSON.parse(fs.readFileSync("scripts/qa/fixtures/genius-series-observed-20261108.json", "utf8"));
    const paired = await answerQuestion("qa-series-offline", observed.question, {
      ...deps, loadPreviousTurn: async () => observed.previousTurn,
    });
    assert.equal(paired.source, "dictionary", "observed two-turn definition");
    assert.equal(paired.answer, added.answer);
    assert.equal(calls, 0, "exact definitions do not need model calls");
    const negatives = ["4선승제 현재 몇 승이야?", "4선승제에서 삼성이 오늘 이기면 끝나?", "4선승제 우승 확률", "4선승제와 3선승제 차이", "3선승제", "2선승제", "한국시리즈", "플레이오프", "준플레이오프", "무승부", "4연승", "7전 4선승제 무승부면 몇 경기까지 해?"];
    for (const q of negatives) {
      const baseline = matchGlossary(before, q);
      assert.equal(matchGlossary(after, q)?.term, baseline?.term, `preserve existing match: ${q}`);
      const result = await answerQuestion("qa-series-offline", q, deps);
      assert.notEqual(result.term, "4선승제", q);
      assert.notEqual(result.answer, added.answer, `definition swallowed non-definition: ${q}`);
    }
    // A conflicting preexisting row must remain untouched (migration never overwrites).
    await db.query("UPDATE public.baseball_terms SET answer = 'operator-edited' WHERE term = '4선승제'");
    await db.exec(migration);
    const conflict = await db.query<{ answer: string }>("SELECT answer FROM public.baseball_terms WHERE term = '4선승제'");
    assert.equal(conflict.rows[0].answer, "operator-edited");
    const rollback = fs.readFileSync("data/baseball-qa/series-definition-2026.rollback.sql", "utf8");
    await db.exec(rollback);
    assert.equal((await db.query<{ answer: string }>("SELECT answer FROM public.baseball_terms WHERE term = '4선승제'")).rows[0].answer, "operator-edited");
    await db.query("UPDATE public.baseball_terms SET answer = $1 WHERE term = '4선승제'", [added.answer]);
    await db.exec(rollback);
    assert.deepEqual((await db.query("SELECT * FROM public.baseball_terms ORDER BY id")).rows, snapshot, "exact rollback restores baseline");
    console.log(JSON.stringify({ result: "PASS", existingRowsPreserved: before.length, positive: positives.length, nonDefinitionBoundaries: negatives.length, idempotent: true }));
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
