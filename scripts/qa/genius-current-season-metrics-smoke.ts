/** Synthetic boundary fixtures, not production accuracy measurements. Reviewer-run. */
import assert from "node:assert/strict";
import { answerQuestion, type QaDeps, type PlayerRef } from "../../src/lib/baseball-qa/pipeline";
import { resolveSeasonRecordIntent, type SeasonRecordRow } from "../../src/lib/baseball-qa/stats/season-record";
const now = Date.parse("2026-09-29T12:00:00Z");
const player = { kboId: "52402", name: "김영웅", team: "삼성", position: "내야수" };
const row: SeasonRecordRow = { player_key: "52402", kbo_id: "52402", name: "김영웅", team: "삼성", updated_at: "2026-09-29T11:00:00Z", avg: "0.251", hr: 19, rbi: 65, hits: 103, games: 119, tb: 184 };
async function ask(question: string, rows = [row], extra: Partial<QaDeps> = {}) {
  let calls = 0; const logs: string[] = []; let started = false; let stored: unknown = null;
  const deps = {
    loadGlossary: async () => [], loadPlayers: async () => [player] as PlayerRef[],
    getCache: async () => null, setCache: async () => {},
    callLlm: async () => { throw new Error("Unexpected ungrounded LLM"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (entry: { matchPath: string }) => { logs.push(entry.matchPath); },
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; }, storeLlm: async (r: unknown) => { stored = r; },
    now: () => now, enablePlayerRag: true,
    fetchSeasonRecord: async () => { calls++; return rows; },
    searchRag: async () => { throw new Error("Unexpected tier2 fallback"); }, ...extra,
  } as unknown as QaDeps;
  const result = await answerQuestion("qa-only", question, deps);
  return { result, calls, logs };
}
async function main() {
  for (const q of ["2026시즌 김영웅 성적", "김영웅 올해 성적 알려줘", "김영웅 2026시즌 타율,홈런,안타,경기,루타"]) {
    const { result, calls, logs } = await ask(q);
    assert.equal(result.source, "kbo_structured", q);
    for (const value of ["0.251", "19", "103", "119", "184"]) assert.ok(result.answer.includes(value), `${q}: missing ${value}`);
    assert.equal(calls, 1, "bundle fetches same source once");
    assert.deepEqual(logs, ["kbo_structured"], "one final log, no per-metric logs");
  }
  const partial = await ask("김영웅 2026 vs 2024 성적 비교");
  assert.equal(partial.result.source, "kbo_structured");
  assert.match(partial.result.answer, /0\.251/);
  assert.match(partial.result.answer, /2024 시즌은.*제공하지 못/);
  assert.match(partial.result.answer, /시즌 간 비교 결과가 아닙니다/);
  for (const broken of [[], [{ ...row, kbo_id: "00000" }], [{ ...row, name: "다른선수" }], [{ ...row, team: "KIA" }], [{ ...row, updated_at: "2026-09-25T00:00:00Z" }], [{ ...row, updated_at: "2026-09-30T00:00:00Z" }], [row, row]]) {
    const { result } = await ask("김영웅 올해 성적", broken);
    assert.notEqual(result.source, "kbo_structured");
    assert.ok(!result.answer.includes("0.251"));
  }
  const missing = await ask("김영웅 타율,홈런", [{ ...row, hr: null }]);
  assert.match(missing.result.answer, /0\.251/);
  assert.match(missing.result.answer, /홈런: 검증된 기록을 확인하지 못/);
  const error = await ask("김영웅 올해 성적", [row], { fetchSeasonRecord: async () => { throw new Error("db"); } });
  assert.equal(error.result.source, "error");
  const unsafe = await ask("김영웅 타율,타석");
  assert.equal(unsafe.result.source, "blocked"); assert.equal(unsafe.calls, 0);
  for (const q of ["김영웅 오늘 성적", "김영웅 어제 성적", "김영웅 2024 성적", "김영웅 2024~2026 성적", "김영웅 최근 3경기 성적", "김영웅 2024부터 2026까지 성적 비교", "김영웅 2026 vs 2024 최고 타율 비교"]) {
    assert.equal(resolveSeasonRecordIntent(q, "batter", { playerBound: true }).kind, "unsupported_season", q);
  }
  for (const [q, keys] of [["김영웅 2루타", ["doubles"]], ["김영웅 도루실패", ["cs"]], ["김영웅 장타율", ["slg"]], ["김영웅 피홈런", ["hr"]]] as const) {
    const intent = resolveSeasonRecordIntent(q, "batter", { playerBound: true });
    assert.equal(intent.kind, "query");
    if (intent.kind === "query") assert.deepEqual((intent.queries ?? [intent.query]).map((x) => x.metric), keys);
  }
  const pitcher = resolveSeasonRecordIntent("원태인 올해 성적", "pitcher", { playerBound: true });
  assert.equal(pitcher.kind, "query");
  if (pitcher.kind === "query") assert.ok(pitcher.queries?.every((q) => q.table === "pitcher"));
  assert.equal(resolveSeasonRecordIntent("김영웅은 어떤 선수야", "batter", { playerBound: true }).kind, "none");
  assert.equal(resolveSeasonRecordIntent("김영웅 2024 타율", "batter", { playerBound: true }).kind, "career");
  console.log("PASS current-season summaries, multi-metric completeness, partial comparison and fail-closed boundaries");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
