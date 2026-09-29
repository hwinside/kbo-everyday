/** Reviewer-run synthetic boundary tests, not a production accuracy score. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { answerQuestion, type QaDeps, type PlayerRef } from "../../src/lib/baseball-qa/pipeline";
import { createCurrentSeasonRecordFetcher } from "../../src/lib/baseball-qa/stats/current-season-source";
import { fetchServedCareerSnapshot } from "../../src/lib/baseball-qa/stats/served-record";
import { FULL_ENTRY_BATTER_IDS, FULL_ENTRY_PITCHER_IDS } from "../../src/lib/stats/full-entry-roster";
import type { SeasonRecordRow } from "../../src/lib/baseball-qa/stats/season-record";
const now = Date.parse("2026-09-29T14:30:00Z");
const asOf = "2026-09-29T14:17:00Z";
const player = { kboId: "52605", name: "김도영", team: "KIA", position: "내야수" };
const row: SeasonRecordRow = { player_key: player.kboId, kbo_id: player.kboId, name: player.name, team: player.team,
  updated_at: asOf, avg: "0.314", hits: 143, hr: 18, rbi: 62, games: 118, tb: 223, ops: "0.901", sb: 20 };
async function ask(question: string, rows = [row], fail = false, selected = player) {
  let calls = 0, dbCalls = 0, stores = 0, started = false;
  let stored: unknown = null;
  const logs: string[] = [];
  const current = createCurrentSeasonRecordFetcher(async () => {
    calls++;
    if (fail) throw new Error("served unavailable");
    return { rows, updatedAt: asOf };
  });
  const deps = {
    loadGlossary: async () => [], loadPlayers: async () => [selected] as PlayerRef[],
    getCache: async () => null, setCache: async () => {},
    callLlm: async () => { throw new Error("No numeric fallback"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (entry: { matchPath: string }) => { logs.push(entry.matchPath); },
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (result: unknown) => { stores++; stored = result; },
    now: () => now, enablePlayerRag: true,
    fetchCurrentSeasonRecord: current,
    // A valid but older daily row must neither win nor rescue a failed app snapshot.
    fetchSeasonRecord: async () => { dbCalls++; return [{ ...row, avg: "0.310", hits: 140 }]; },
    fetchServedRecord: async () => { throw new Error("No second source per metric"); },
    searchRag: async () => { throw new Error("No tier2 fallback"); },
  } as unknown as QaDeps;
  const result = await answerQuestion("qa-only", question, deps);
  return { result, calls, dbCalls, logs, stores, replay: () => answerQuestion("qa-only", question, deps), counts: () => ({ calls, stores }) };
}
async function main() {
  for (const question of ["김도영 타율 얼마야?", "김도영 올해 성적", "김도영 타율,안타,OPS", "김도영 도루 몇개야?"]) {
    const a = await ask(question);
    assert.equal(a.result.source, "kbo_structured", question);
    if (!question.includes("도루")) assert.match(a.result.answer, /0\.314/, question);
    assert.doesNotMatch(a.result.answer, /0\.310|140/);
    assert.match(a.result.answer, /앱 기록 스냅샷 09\/29 23:17 KST 갱신/);
    assert.match(a.result.answer, /경기 반영 완료 시각은 아님/);
    assert.equal(a.calls, 1); assert.equal(a.dbCalls, 0);
    assert.deepEqual(a.logs, ["kbo_structured"]);
    const counts = a.counts();
    assert.equal((await a.replay()).answer, a.result.answer);
    assert.deepEqual(a.counts(), counts, "durable replay must not refetch/store");
  }
  const bundle = await ask("김도영 올해 성적");
  assert.match(bundle.result.answer, /안타 143/);
  for (const broken of [[], [row, row], [{ ...row, player_key: "wrong" }], [{ ...row, kbo_id: "wrong" }],
    [{ ...row, name: "다른선수" }], [{ ...row, team: "LG" }], [{ ...row, updated_at: "2026-09-27T00:00:00Z" }],
    [{ ...row, updated_at: "2026-09-30T00:00:00Z" }], [{ ...row, avg: "garbage" }]]) {
    const a = await ask("김도영 타율 얼마야?", broken);
    assert.notEqual(a.result.source, "kbo_structured"); assert.equal(a.dbCalls, 0);
    assert.doesNotMatch(a.result.answer, /0\.310|0\.314/);
  }
  const failure = await ask("김도영 올해 성적", [row], true);
  assert.equal(failure.result.source, "error"); assert.equal(failure.calls, 1); assert.equal(failure.dbCalls, 0);
  const partial = await ask("김도영 타율,안타", [{ ...row, hits: null }]);
  assert.match(partial.result.answer, /0\.314/); assert.match(partial.result.answer, /안타: 검증된 기록을 확인하지 못/);
  assert.equal(partial.dbCalls, 0);
  for (const q of ["김도영 포스트시즌 성적", "김도영 LG전 성적", "김도영 오늘 경기 성적"]) {
    const a = await ask(q); assert.notEqual(a.result.source, "kbo_structured"); assert.equal(a.calls, 0);
  }
  const pitcher = { kboId: "52456", name: "원태인", team: "삼성", position: "투수" };
  const p = await ask("원태인 평균자책점", [{ ...row, player_key: pitcher.kboId, kbo_id: pitcher.kboId,
    name: pitcher.name, team: pitcher.team, era: "3.24" }], false, pitcher);
  assert.equal(p.result.source, "kbo_structured"); assert.match(p.result.answer, /3\.24/); assert.equal(p.dbCalls, 0);

  // Exercise the real default loader + envelope/full-entry validation, not just an injected row.
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let corrupt = false;
  globalThis.fetch = (async (url) => {
    const path = String(url); requests.push(path);
    assert.match(path, /\/api\/stats\?type=(?:batter|pitcher)&full=1$/);
    const table = path.includes("type=batter") ? "batter" : "pitcher";
    const ids = table === "batter" ? FULL_ENTRY_BATTER_IDS : FULL_ENTRY_PITCHER_IDS;
    const stats = ids.map((id) => ({ kboId: id, name: id === player.kboId ? player.name : "테스트선수", team: "KIA", avg: "0.314", hits: 143 }));
    if (corrupt) stats.pop();
    return new Response(JSON.stringify({ type: table, count: stats.length, updatedAt: asOf, stats }), { status: 200 });
  }) as typeof fetch;
  try {
    const fetchCurrent = createCurrentSeasonRecordFetcher();
    const [a, b] = await Promise.all([fetchCurrent("batter", player.kboId), fetchCurrent("batter", player.kboId)]);
    assert.equal(a[0].avg, "0.314"); assert.deepEqual(a, b); assert.equal(requests.length, 1);
    await fetchCurrent("pitcher", FULL_ENTRY_PITCHER_IDS[0]); assert.equal(requests.length, 2);
    corrupt = true;
    await assert.rejects(createCurrentSeasonRecordFetcher()("batter", player.kboId), /completeness/);
    await assert.rejects(fetchServedCareerSnapshot("pitcher"), /coverage/);
  } finally { globalThis.fetch = originalFetch; }
  const server = readFileSync("src/lib/baseball-qa/server.ts", "utf8");
  assert.match(server, /fetchCurrentSeasonRecord:\s*createCurrentSeasonRecordFetcher\(\)/, "production wiring");
  console.log("PASS app snapshot authority, single/bundle, no DB fallback, identity/freshness, pitcher, raw values, single fetch/log and durable replay");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
