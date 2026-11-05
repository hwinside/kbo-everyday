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
    const before = JSON.parse(fs.readFileSync("scripts/qa/fixtures/baseball-terms-before-apbc-20261103.json", "utf8"));
    for (const row of before) {
      await db.query(`INSERT INTO public.baseball_terms
        (id,term,aliases,answer,category,source_kind,source_url,rule_version,reviewed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id,row.term,row.aliases,row.answer,row.category,row.source_kind,row.source_url,row.rule_version,row.reviewed_at]);
    }
    const snapshot = (await db.query("SELECT * FROM public.baseball_terms ORDER BY id")).rows;
    assert.equal(matchGlossary(before, "APBC가 뭐야?"), null, "base lacks observed definition");
    const migration = fs.readFileSync("supabase/migrations/20261103003000_baseball_terms_apbc.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration);
    const after = (await db.query<GlossaryEntry & { id: string }>("SELECT * FROM public.baseball_terms ORDER BY id")).rows;
    assert.equal(after.length, before.length + 1, "one addition, idempotent replay");
    assert.deepEqual(after.filter(row => row.term !== "APBC"), snapshot, "all existing fields preserved");
    const added = after.find(row => row.term === "APBC")!;
    const newKeys = new Set([added.term, ...added.aliases].flatMap(name => [normalizeKey(name), normalizeQuestion(name)]));
    for (const row of before) for (const name of [row.term, ...row.aliases]) {
      assert.ok(!newKeys.has(normalizeKey(name)) && !newKeys.has(normalizeQuestion(name)), `alias collision: ${row.term}`);
    }
    assert.ok(added.answer.includes("Asia Professional Baseball Championship"));
    assert.ok(added.answer.includes("아시아 프로야구 챔피언십"));
    assert.ok(isBaseballGeniusToneCompliant(added.answer));
    assert.ok(!/2023|2026|24세|29세|우승|11월/.test(added.answer), "no edition-specific facts");
    let calls = 0;
    const deps: QaDeps = {
      loadGlossary: async () => after, loadPlayers: async () => [],
      getCache: async () => null, setCache: async () => {},
      callLlm: async () => { calls++; return { text: "{\"status\":\"UNSURE\",\"answer\":\"\"}", inputTokens: 0, outputTokens: 0 }; },
      reserveDaily: async () => ({ allowed: true, remaining: 10 }), log: async () => {},
    };
    const positives = ["APBC가 뭐야?", "apbc", "ＡＰＢＣ가 뭐예요?", "아시아 프로야구 챔피언십이 뭐야?", "Asia Professional Baseball Championship"];
    for (const q of positives) {
      const result = await answerQuestion("qa-apbc-offline", q, deps);
      assert.equal(result.source, "dictionary", q);
      assert.equal(result.term, "APBC", q);
      assert.equal(result.answer, added.answer, q);
    }
    assert.equal(calls, 0, "exact definitions do not need model calls");
    const negatives = ["APBC 올해 언제 해?", "APBC 우승팀은?", "APBC 참가 나이 제한은?", "APBC랑 WBC 차이가 뭐야?", "APBC 김도영 성적 알려줘", "APBC는 왜 생겼어?", "XAPBC가 뭐야?", "WBC가 뭐야?"];
    for (const q of negatives) {
      assert.equal(matchGlossary(after, q), null, q);
      const result = await answerQuestion("qa-apbc-offline", q, deps);
      assert.notEqual(result.answer, added.answer, `definition swallowed non-definition: ${q}`);
    }
    // A conflicting preexisting row must remain untouched (migration never overwrites).
    await db.query("UPDATE public.baseball_terms SET answer = 'operator-edited' WHERE term = 'APBC'");
    await db.exec(migration);
    const conflict = await db.query<{ answer: string }>("SELECT answer FROM public.baseball_terms WHERE term = 'APBC'");
    assert.equal(conflict.rows[0].answer, "operator-edited");
    console.log(JSON.stringify({ result: "PASS", existingRowsPreserved: before.length, positive: positives.length, nonDefinitionBoundaries: negatives.length, idempotent: true }));
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
