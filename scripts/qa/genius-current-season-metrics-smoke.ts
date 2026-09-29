/** Synthetic boundary fixtures, not production accuracy measurements. Reviewer-run. */
import assert from "node:assert/strict";
import { answerQuestion, HISTORY_HOLD_ANSWER, type QaDeps, type PlayerRef } from "../../src/lib/baseball-qa/pipeline";
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
    assert.equal((result.answer.match(/📊/g) ?? []).length, 1, "one provenance footer");
    assert.equal((result.answer.match(/김영웅\(삼성\)/g) ?? []).length, 1, "one player header");
    assert.equal(calls, 1, "bundle fetches same source once");
    assert.deepEqual(logs, ["kbo_structured"], "one final log, no per-metric logs");
  }
  const negativeScopes = [
    "김영웅 포스트시즌 성적", "김영웅 LG전 성적", "김영웅 홈 성적",
    "김영웅 후반기 성적", "김영웅 좌투수 상대 성적", "김영웅 대표팀 성적",
    "김영웅 아시안게임 성적", "김영웅 퓨처스 성적", "김영웅 올스타 기록",
    "김영웅 부상 기록", "김영웅 다음 경기", "김영웅 오늘 경기",
  ];
  for (const q of negativeScopes) {
    assert.ok(["none", "unsupported_season"].includes(resolveSeasonRecordIntent(q, "batter", { playerBound: true }).kind), q);
    const { result, calls } = await ask(q);
    assert.notEqual(result.source, "kbo_structured", q);
    assert.equal(calls, 0, `${q}: no season snapshot fetch`);
    assert.ok(!result.answer.includes("0.251") && !result.answer.includes("119"), q);
  }
  for (const scope of ["PS", "가을야구", "원정", "전반기", "득점권", "주자", "우투수 상대", "국대", "WBC", "2군", "월간", "주간"]) {
    for (const metric of ["성적", "타율,홈런"]) {
      assert.equal(resolveSeasonRecordIntent(`김영웅 ${scope} ${metric}`, "batter", { playerBound: true }).kind, "unsupported_season");
    }
  }
  assert.equal(resolveSeasonRecordIntent("김영웅 경기", "batter", { playerBound: true }).kind, "none");
  for (const separator of [",", "·", "/"]) {
    const intent = resolveSeasonRecordIntent(`김영웅 타율${separator} 경기`, "batter", { playerBound: true });
    assert.equal(intent.kind, "query");
    if (intent.kind === "query") assert.ok(intent.queries?.some((q) => q.metric === "games"));
  }
  // Frozen base cfe47e4a routes from reviewer replay; empty RAG fixture does
  // not claim production answer quality, only preservation of route ownership.
  const generalQuestions = [
    ["홈화면에 어떡해 점수 떠?", "product_feature_guide"],
    ["그 아이폰 홈화면에 어떻게 띄워?", "product_feature_guide"],
    ["기아 케이티 상대전적", "scope_guide"],
    ["주상에서 대주자를 내보내면 다음 공격 타석에서 대주자가 나와야해?", "unsure", "untrusted_metric"],
    ["상대팀에게 빨리 하라고 하는 말", "unsure"],
    ["가을야구 언제부터야??", "unsure"],
    ["다음 올스타전은 언제야?", "unsure"],
    ["채은성 부상", "unsure"],
    ["9월4일 삼성 엘지 선발알려줘", "unsure"],
    ["아시안 게임 야구 일정 알려줘", "unsure"],
  ] as const;
  for (const [q, baseSource, boundIntent = "none"] of generalQuestions) {
    for (const playerBound of [false, true]) {
      // Base retains the untrusted 타석 guard only when player-bound.
      assert.equal(resolveSeasonRecordIntent(q, "batter", { playerBound }).kind, playerBound ? boundIntent : "none", q);
    }
    const { result, calls } = await ask(q, [row], {
      searchRag: async () => [],
      // General questions may legitimately reach the LLM on both base and head.
      callLlm: async () => ({ text: JSON.stringify({ status: "UNSURE" }), inputTokens: 1, outputTokens: 1 }),
    });
    assert.equal(result.source, baseSource, `${q}: preserve base route`);
    assert.equal(calls, 0, `${q}: not a season-record request`);
  }
  assert.equal(resolveSeasonRecordIntent("오늘 경기 몇시에 시작했어?", "batter", { playerBound: true }).kind, "none");
  assert.equal(resolveSeasonRecordIntent("김영웅 득점권", "batter", { playerBound: true }).kind, "none");
  assert.equal(resolveSeasonRecordIntent("김영웅 득점권 타율", "batter", { playerBound: true }).kind, "unsupported_season");
  for (const q of ["김영웅 통산 기록 알려줘", "김영웅 통산 성적", "김영웅 커리어 기록", "김영웅 작년 성적", "김영웅 2024 성적"]) {
    assert.equal(resolveSeasonRecordIntent(q, "batter", { playerBound: true }).kind, "none", q);
    const { result, calls } = await ask(q);
    assert.equal(result.source, "history_hold", `${q}: preserve history guide`);
    assert.equal(result.answer, HISTORY_HOLD_ANSWER, q);
    assert.equal(calls, 0, q);
  }
  for (const q of ["김영웅 2024~2026 성적", "김영웅 2024부터 2026까지 성적 비교"]) {
    assert.equal(resolveSeasonRecordIntent(q, "batter", { playerBound: true }).kind, "none", q);
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
  for (const q of ["김영웅 오늘 성적", "김영웅 어제 성적", "김영웅 최근 3경기 성적", "김영웅 2026 vs 2024 최고 타율 비교"]) {
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
