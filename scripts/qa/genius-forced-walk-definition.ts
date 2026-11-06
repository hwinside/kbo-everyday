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
    const before = JSON.parse(fs.readFileSync("scripts/qa/fixtures/baseball-terms-before-forced-walk-20261106.json", "utf8"));
    for (const row of before) {
      await db.query(`INSERT INTO public.baseball_terms
        (id,term,aliases,answer,category,source_kind,source_url,rule_version,reviewed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id,row.term,row.aliases,row.answer,row.category,row.source_kind,row.source_url,row.rule_version,row.reviewed_at]);
    }
    const snapshot = (await db.query("SELECT * FROM public.baseball_terms ORDER BY id")).rows;
    assert.equal(matchGlossary(before, "밀어내기 볼넷?"), null, "base lacks observed definition");
    const migration = fs.readFileSync("supabase/migrations/20261106023000_baseball_terms_forced_walk.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration);
    const after = (await db.query<GlossaryEntry & { id: string }>("SELECT * FROM public.baseball_terms ORDER BY id")).rows;
    assert.equal(after.length, before.length + 1, "one addition, idempotent replay");
    assert.deepEqual(after.filter(row => row.term !== "밀어내기 볼넷"), snapshot, "all existing fields preserved");
    const added = after.find(row => row.term === "밀어내기 볼넷")!;
    const newKeys = new Set([added.term, ...added.aliases].flatMap(name => [normalizeKey(name), normalizeQuestion(name)]));
    for (const row of before) for (const name of [row.term, ...row.aliases]) {
      assert.ok(!newKeys.has(normalizeKey(name)) && !newKeys.has(normalizeQuestion(name)), `alias collision: ${row.term}`);
    }
    assert.ok(added.answer.includes("만루에서"));
    assert.ok(added.answer.includes("3루 주자가 홈을 밟아"));
    assert.ok(added.answer.includes("타점이 기록"));
    assert.ok(added.answer.includes("만루가 아니라면"));
    assert.ok(isBaseballGeniusToneCompliant(added.answer));
    let calls = 0;
    const deps: QaDeps = {
      loadGlossary: async () => after, loadPlayers: async () => [],
      getCache: async () => null, setCache: async () => {},
      callLlm: async () => { calls++; return { text: "{\"status\":\"UNSURE\",\"answer\":\"\"}", inputTokens: 0, outputTokens: 0 }; },
      reserveDaily: async () => ({ allowed: true, remaining: 10 }), log: async () => {},
    };
    const positives = ["밀어내기 볼넷?", "밀어내기볼넷", "밀어내기 볼넷이 뭐야?", "밀어내기 포볼"];
    for (const q of positives) {
      const result = await answerQuestion("qa-forced-walk-offline", q, deps);
      assert.equal(result.source, "dictionary", q);
      assert.equal(result.term, "밀어내기 볼넷", q);
      assert.equal(result.answer, added.answer, q);
    }
    const observed = JSON.parse(fs.readFileSync("scripts/qa/fixtures/genius-forced-walk-observed-20261106.json", "utf8"));
    const paired = await answerQuestion("qa-forced-walk-offline", observed.question, {
      ...deps, loadPreviousTurn: async () => observed.previousTurn,
    });
    assert.equal(paired.source, "dictionary", "observed two-turn definition");
    assert.equal(paired.answer, added.answer);
    assert.equal(calls, 0, "exact definitions do not need model calls");
    const negatives = ["밀어내기 볼넷 올해 몇 개야?", "밀어내기 볼넷 최다 선수는?", "밀어내기 볼넷과 몸에 맞는 공 차이", "만루가 아닌데 볼넷이면 득점해?", "밀어내기 몸에 맞는 공", "보크", "볼넷", "타점", "희생 플라이", "병살타"];
    for (const q of negatives) {
      const baseline = matchGlossary(before, q);
      assert.deepEqual(matchGlossary(after, q), baseline, `preserve existing match: ${q}`);
      const result = await answerQuestion("qa-forced-walk-offline", q, deps);
      assert.notEqual(result.term, "밀어내기 볼넷", q);
      assert.notEqual(result.answer, added.answer, `definition swallowed non-definition: ${q}`);
    }
    // A conflicting preexisting row must remain untouched (migration never overwrites).
    await db.query("UPDATE public.baseball_terms SET answer = 'operator-edited' WHERE term = '밀어내기 볼넷'");
    await db.exec(migration);
    const conflict = await db.query<{ answer: string }>("SELECT answer FROM public.baseball_terms WHERE term = '밀어내기 볼넷'");
    assert.equal(conflict.rows[0].answer, "operator-edited");
    console.log(JSON.stringify({ result: "PASS", existingRowsPreserved: before.length, positive: positives.length, nonDefinitionBoundaries: negatives.length, idempotent: true }));
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
