/** Existing period-context gate; execution/verdict owned by the reviewer. */
import assert from "node:assert/strict";
import { answerQuestion, type QaDeps, type LlmResult } from "../../../src/lib/baseball-qa/pipeline";
import type { PreviousTurnRow } from "../../../src/lib/baseball-qa/context";
import { loadRosterPlayers } from "../../../src/lib/baseball-qa/roster/load-roster-players";
import { resolveSeasonRecord, STATS_STALE_MS, type SeasonRecordQuery, type SeasonRecordRow } from "../../../src/lib/baseball-qa/stats/season-record";

const NOW = Date.parse("2026-09-08T01:55:00Z");
const AT = new Date(NOW - 60_000).toISOString();
const AVG: SeasonRecordQuery = { table: "batter", metric: "avg", label: "타율", kind: "rate" };

/** Same injected dependencies can replay the pre-fix base without editing it. */
export async function verifyForeignScalarNames(execute: typeof answerQuestion = answerQuestion) {
  const roster = await loadRosterPlayers();
  const samples = [
    { id: "FP006", short: "디아즈", avg: "0.298" },
    { id: "FP003", short: "페라자", avg: "0.294" },
  ];
  const rows: SeasonRecordRow[] = samples.map((sample) => {
    const p = roster.find((player) => player.kboId === sample.id);
    assert.ok(p);
    assert.notEqual(p.name, sample.short, "Must use real roster full-name, not a self-matching fixture");
    return { player_key: sample.id, kbo_id: sample.id, name: sample.short, team: p.team ?? null,
      updated_at: AT, avg: sample.avg, qualifiedRate: 1, games: 120, ab: 400, hits: 120 };
  });
  const harness = (records = rows, previous: PreviousTurnRow | null = null) => {
    const calls = { db: 0, served: 0, rank: 0, model: 0, cache: 0 };
    let started = false;
    let stored: LlmResult | null = null;
    const deps: QaDeps = {
      now: () => NOW, enablePlayerRag: true,
      loadGlossary: async () => [], loadPlayers: async () => roster, loadPreviousTurn: async () => previous,
      reserveDaily: async () => ({ allowed: true, remaining: 10 }), log: async () => {},
      getCache: async () => { calls.cache++; return null; }, setCache: async () => {},
      callLlm: async () => { calls.model++; throw new Error("Scalar identity must not fall back to a model"); },
      fetchSeasonRecord: async (table, id) => {
        calls.db++; assert.equal(table, "batter");
        return structuredClone(records.filter((row) => row.kbo_id === id));
      },
      fetchServedRecord: async () => { calls.served++; return []; },
      fetchBatterRanking: async () => { calls.rank++; return { updatedAt: AT, rows: structuredClone(rows) }; },
      getLlmState: async () => ({ started, result: stored }),
      acquireLlmStart: async () => { if (started) return false; started = true; return true; },
      storeLlm: async (result) => { stored = result; },
    };
    return { deps, calls };
  };
  for (const [i, sample] of samples.entries()) {
    const player = roster.find((p) => p.kboId === sample.id)!;
    for (const name of [sample.short, player.name]) {
      const question = `${name} 타율 몇이야?`;
      const h = harness();
      const answer = await execute("qa-foreign-scalar-a", question, h.deps);
      assert.equal(answer.source, "kbo_structured", question);
      assert.ok(answer.answer.includes(sample.avg), question);
      assert.deepEqual(h.calls, { db: 1, served: 0, rank: 0, model: 0, cache: 0 }, question);
      const previous: PreviousTurnRow = { question, answer: answer.answer, jobSource: answer.source,
        answeredAt: AT, currentCreatedAt: new Date(NOW).toISOString() };
      const followup = harness(rows, previous);
      const rank = await execute("qa-foreign-scalar-a", "몇등이야?", followup.deps);
      assert.equal(rank.source, "kbo_structured");
      assert.ok(rank.answer.includes(player.name) && rank.answer.includes(`타율 ${i + 1}위`));
      assert.deepEqual(followup.calls, { db: 0, served: 0, rank: 1, model: 0, cache: 0 });
    }
  }
  const diaz = roster.find((p) => p.kboId === "FP006")!;
  const resolve = (records: SeasonRecordRow[], name = diaz.name) => resolveSeasonRecord(records, AVG, "FP006", NOW, name, diaz.team);
  for (const corrupt of [
    { player_key: "FP003" }, { kbo_id: "FP003" }, { name: "페라자" },
    { name: "가짜 디아즈" }, { name: "아즈" }, { team: "한화" },
    { name: "르윈\n디아즈" }, { name: "<디아즈>" },
    { updated_at: new Date(NOW + 1).toISOString() }, { avg: "-" },
  ]) assert.equal(resolve([{ ...rows[0], ...corrupt }]).kind, "inconsistent", JSON.stringify(corrupt));
  for (const name of [null, undefined, 123]) {
    const malformed = { ...rows[0] };
    Object.assign(malformed, { name }); // Deliberately malformed DB data, never a valid player fixture.
    assert.equal(resolve([malformed]).kind, "inconsistent", "Malformed names must fail closed without throwing");
  }
  for (const name of ["요나단 페라자", "가짜 디아즈", "아즈", "르윈\n디아즈"]) {
    assert.equal(resolve([rows[0]], name).kind, "inconsistent", name);
  }
  assert.equal(resolve([]).kind, "missing");
  assert.equal(resolve([rows[0], rows[0]]).kind, "inconsistent");
  assert.equal(resolve([{ ...rows[0], updated_at: new Date(NOW - STATS_STALE_MS - 1).toISOString() }]).kind, "stale");
  assert.equal(resolveSeasonRecord([{ ...rows[0], player_key: "FP999", kbo_id: "FP999" }], AVG, "FP999", NOW, diaz.name, diaz.team).kind, "inconsistent", "Unknown foreign ID cannot license a name variant");
  assert.equal(resolveSeasonRecord([{ ...rows[0], player_key: "62404", kbo_id: "62404", name: "구자" }], AVG, "62404", NOW, "구자욱", "삼성").kind, "inconsistent", "Domestic names remain exact");
  const polluted = harness([{ ...rows[0], name: "페라자" }, rows[1]]);
  const rejected = await execute("qa-foreign-scalar-a", "디아즈 타율 몇이야?", polluted.deps);
  assert.equal(rejected.source, "blocked");
  assert.ok(!rejected.answer.includes("0.298"));
  assert.equal(polluted.calls.model, 0);
  const noContext = harness();
  assert.notEqual((await execute("qa-foreign-scalar-b", "몇등이야?", noContext.deps)).source, "kbo_structured");
  assert.equal(noContext.calls.rank, 0, "Another account must not borrow scalar context");
  for (const question of ["디아즈 타율 홈런 순위", "디아즈 상대전 타율 순위"]) {
    const h = harness();
    assert.notEqual((await execute("qa-foreign-scalar-a", question, h.deps)).source, "kbo_structured");
    assert.equal(h.calls.db, 0, "Unsupported rankings must not borrow a valid scalar row");
  }
}
