/**
 * ① 오늘 선발 매치업 게이트 (2026-08-11 하린아빠 제보 · 삼순 A안).
 *
 * 계약:
 *  1. 판정 = full-string 폐쇄 문법. (오늘|금일)+선발 조합만 소유 — `어제 선발`·`선발 잘 던질까`·
 *     `선발투수가 뭐야?`(사전 축)는 이 경로가 잡지 않는다.
 *  2. 답변 = 직접 렌더 (LLM·RAG·cache 0). 데이터 원값 그대로, match_path=kbo_structured.
 *  3. 팀 미지정 → 전체 경기 / 팀 지정 → 해당 경기만 / 경기 없음·미발표 → 사실대로 안내.
 *  4. 조회 실패는 "경기 없음"으로 둔갑하지 않는다 — error fail-close.
 *
 * 실행: npm run qa:genius-today-starters
 */
import assert from "node:assert/strict";
import {
  answerQuestion,
  renderTodayStartersAnswer,
  resolveTodayStartersIntent,
  SYSTEM_ERROR_ANSWER,
  TODAY_NO_GAMES_ANSWER,
  type QaDeps,
  type TodayGameStarters,
} from "../../src/lib/baseball-qa/pipeline";

const GAMES: TodayGameStarters[] = [
  { awayName: "한화", homeName: "두산", awayStarterName: "왕옌청", homeStarterName: "곽빈", time: "19:00", stadium: "잠실", status: "scheduled", starterSourceOk: true },
  { awayName: "LG", homeName: "키움", awayStarterName: "카라스코", homeStarterName: "안우진", time: "19:00", stadium: "고척", status: "scheduled", starterSourceOk: true },
  // 진짜 미발표: KBO 소스는 살아있으나(이 경기가 KBO 응답에 있음) 선발명이 빈값.
  { awayName: "KT", homeName: "NC", awayStarterName: "", homeStarterName: "라일리", time: "19:00", stadium: "창원", status: "scheduled", starterSourceOk: true },
  // 소스 장애: KBO enrich 실패/부분 누락 — 빈 선발을 미발표로 위장하면 안 된다(삼순 P0).
  { awayName: "롯데", homeName: "SSG", awayStarterName: "", homeStarterName: "", time: "18:30", stadium: "문학", status: "scheduled", starterSourceOk: false },
  // 취소 경기: 매치업이 아니라 취소를 명시해야 한다(삼순 ③축).
  { awayName: "삼성", homeName: "KIA", awayStarterName: "원태인", homeStarterName: "네일", time: "18:30", stadium: "광주", status: "cancelled", starterSourceOk: true },
];

interface State { fetches: string[]; games: TodayGameStarters[]; throws: boolean; llmCalls: number; logs: string[]; cacheWrites: number }
function fresh(overrides: Partial<State> = {}): State {
  return { fetches: [], games: GAMES, throws: false, llmCalls: 0, logs: [], cacheWrites: 0, ...overrides };
}
function makeDeps(state: State): QaDeps {
  return {
    loadGlossary: async () => [],
    loadPlayers: async () => [],
    getCache: async () => null,
    setCache: async () => { state.cacheWrites++; },
    callLlm: async () => {
      state.llmCalls++;
      return { text: '{"status":"UNSURE","answer":""}', inputTokens: 1, outputTokens: 1 };
    },
    fetchTodayStarters: async (date) => {
      state.fetches.push(date);
      if (state.throws) throw new Error("source down");
      return state.games;
    },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async (entry) => { state.logs.push(entry.matchPath); },
    // KST 2026-08-11 01:00 = UTC 2026-08-10 16:00 — UTC 날짜와 KST 날짜가 갈리는
    // 경계 시각이다. KST 보정을 빼먹은 변종은 20260810 을 조회해 RED 난다.
    now: () => Date.parse("2026-08-10T16:00:00Z"),
  };
}

async function main() {
  // ── 판정: 폐쇄 문법 소유/비소유 ─────────────────────────────────────
  for (const q of [
    "오늘 선발 투수 알려줘",
    "오늘 선발 누구야?",
    "금일 선발투수",
    "오늘 LG 선발 누구야?",
    "오늘의 선발 매치업 보여줘",
  ]) {
    assert.ok(resolveTodayStartersIntent(q), `소유해야 함: ${q}`);
  }
  assert.equal(resolveTodayStartersIntent("오늘 LG 선발 누구야?")?.team, "LG");
  for (const q of [
    "어제 선발 투수 알려줘",       // 과거 — 기존 경로
    "내일 선발 누구야?",           // 미래 — 기존 경로
    "선발투수가 뭐야?",            // 정의 — 사전 축
    "오늘 선발 잘 던질까?",        // 예측 서술 — full-string 탈락
    "오늘 경기 결과 알려줘",       // 선발 아님
    "오늘 우리팀 선발 누구야?",    // 사용자 팀 결속 없음 — 전체 답변은 질문과 다른 답 (삼순 ②축)
    "오늘 우리 선발 알려줘",       // 동일 축
    "오늘 LG 두산 선발 알려줘",    // 복수 구단 — 해석 모호, 소유 금지 (삼순 ②축)
    "오늘 엘지 키움 선발 누구야",  // 복수 구단 한글 표기
  ]) {
    assert.equal(resolveTodayStartersIntent(q), null, `소유하면 안 됨: ${q}`);
  }

  // ── 렌더: 원값 그대로·미발표 표기·팀 필터 ──────────────────────────
  {
    const all = renderTodayStartersAnswer(GAMES, null);
    assert.ok(all.includes("한화 왕옌청 vs 두산 곽빈"));
    assert.ok(all.includes("KT 미발표 vs NC 라일리")); // 소스 정상 + 빈 선발 = 진짜 미발표
    // 소스 장애 경기: 미발표 위장 금지 — 확인 불가로 fail-close (삼순 P0).
    assert.ok(all.includes("롯데 vs SSG — 선발 정보를 지금 확인할 수 없어요"));
    assert.ok(!all.includes("롯데 미발표"), "소스 장애가 미발표로 위장됐다");
    // 취소 경기: 매치업·시간 대신 취소 명시 (삼순 ③축).
    assert.ok(all.includes("삼성 vs KIA — 취소"));
    assert.ok(!all.includes("삼성 원태인"), "취소 경기가 정상 매치업처럼 렌더됐다");
    const lg = renderTodayStartersAnswer(GAMES, "LG");
    assert.ok(lg.includes("LG 카라스코 vs 키움 안우진"));
    assert.ok(!lg.includes("한화")); // 팀 지정 시 해당 경기만
    assert.equal(renderTodayStartersAnswer([], null), TODAY_NO_GAMES_ANSWER);
    // 팀 지정 + 취소도 취소로 명시된다("경기 없음" 아님).
    assert.ok(renderTodayStartersAnswer(GAMES, "삼성").includes("삼성 vs KIA — 취소"));
    assert.ok(renderTodayStartersAnswer(GAMES.slice(0, 3), "삼성").includes("삼성 경기가 없어요"));
  }

  // ── 종단: LLM·cache 0 · kbo_structured · KST 날짜 ───────────────────
  {
    const state = fresh();
    const result = await answerQuestion("u1", "오늘 선발 투수 알려줘", makeDeps(state));
    assert.equal(result.source, "kbo_structured");
    assert.ok(result.answer.includes("왕옌청"));
    assert.equal(state.llmCalls, 0);
    assert.equal(state.cacheWrites, 0);
    assert.deepEqual(state.logs, ["kbo_structured"]);
    assert.deepEqual(state.fetches, ["20260811"]); // UTC(0810)가 아니라 KST(0811)
  }
  // 조회 실패 → error fail-close ("경기 없음" 둔갑 금지)
  {
    const state = fresh({ throws: true });
    const result = await answerQuestion("u1", "오늘 선발 투수 알려줘", makeDeps(state));
    assert.equal(result.answer, SYSTEM_ERROR_ANSWER);
    assert.deepEqual(state.logs, ["error"]);
  }
  // 미배선(fetchTodayStarters 없음) → 이 경로 비활성, 기존 동작
  {
    const state = fresh();
    const deps = makeDeps(state);
    delete (deps as { fetchTodayStarters?: unknown }).fetchTodayStarters;
    const result = await answerQuestion("u1", "오늘 선발 투수 알려줘", deps);
    assert.notEqual(result.source, "kbo_structured");
  }

  console.log("genius-today-starters-smoke: all PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
