/**
 * ① 선발 매치업 게이트 (2026-08-11 하린아빠 제보 · 삼순 A안 / 2026-08-16 `내일` 확장).
 *
 * 계약:
 *  1. 판정 = full-string 폐쇄 문법. `<시점어>+선발` 조합만 소유하며, 시점어는
 *     `STARTER_DATE_SCOPES` 폐쇄집합(오늘|금일|내일|명일)이다 — `어제 선발`·`모레 선발`·
 *     `선발 잘 던질까`·`선발투수가 뭐야?`(사전 축)는 이 경로가 잡지 않는다.
 *     시점어가 **둘 이상**이면(`오늘이랑 내일 선발`) 모호하므로 소유하지 않는다.
 *  2. 답변 = 직접 렌더 (LLM·RAG·cache 0). 데이터 원값 그대로, match_path=kbo_structured.
 *  3. 팀 미지정 → 전체 경기 / 팀 지정 → 해당 경기만 / 경기 없음·미발표 → 사실대로 안내.
 *  4. 조회 실패는 "경기 없음"으로 둔갑하지 않는다 — error fail-close.
 *
 * 실행: npm run qa:genius-today-starters
 */
import assert from "node:assert/strict";
import {
  adaptTodayStarters,
  answerQuestion,
  renderTodayStartersAnswer,
  resolveTodayStartersIntent,
  SYSTEM_ERROR_ANSWER,
  TODAY_NO_GAMES_ANSWER,
  TOMORROW_NO_GAMES_ANSWER,
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

interface State { fetches: string[]; games: TodayGameStarters[]; throws: boolean; llmCalls: number; logs: string[]; cacheWrites: number; mapperCalls: number }
function fresh(overrides: Partial<State> = {}): State {
  return { fetches: [], games: GAMES, throws: false, llmCalls: 0, logs: [], cacheWrites: 0, mapperCalls: 0, ...overrides };
}
// production 형 glossary (삼순 #1148 NO-GO ①축 — false-green 해소):
// 종전에는 glossary 가 비어 있고 mapper 도 없어, ①-b 매퍼가 선발 질문을 선점해도
// 이 smoke 는 GREEN 이었다. 실제 사전처럼 `선발·투수` 후보가 생기는 구성으로 바꾸고
// 매퍼 호출 0회를 actual 로 고정한다 — owner 가드 제거 변종은 여기서 RED 난다.
const PROD_LIKE_GLOSSARY = [
  { term: "선발 투수", aliases: ["선발", "선발투수", "starting pitcher"], answer: "경기를 첫 타자부터 시작하는 투수입니다." },
  { term: "투수", aliases: ["pitcher"], answer: "마운드에서 공을 던지는 선수입니다." },
];
function makeDeps(state: State): QaDeps {
  return {
    loadGlossary: async () => PROD_LIKE_GLOSSARY,
    mapGlossaryDefinition: async () => {
      state.mapperCalls++;
      return { term: "선발 투수", inputTokens: 1, outputTokens: 1 };
    },
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
    const intent = resolveTodayStartersIntent(q);
    assert.ok(intent, `소유해야 함: ${q}`);
    assert.equal(intent.offsetDays, 0, `오늘 시점인데 offsetDays=${intent.offsetDays}: ${q}`);
  }
  assert.equal(resolveTodayStartersIntent("오늘 LG 선발 누구야?")?.team, "LG");

  // ── `내일` 확장 (2026-08-16 운영 로그 전수조사) ──────────────────────────
  // `오늘 선발` 은 답하면서 `내일 기아 선발 누구?` 는 unsure("질문을 정확히 이해하지
  // 못했어요")로 끝났다. **같은 `/api/games` 가 내일 경기도 서빙한다**(실측 8/18·8/19
  // 각 5경기 sourceOk 5/5). 우리가 가진 데이터를 봇만 "이해 못 했다"고 하면 거짓 안내다.
  //
  // ⚠️ 로그 원문 그대로 태운다 — 지어낸 문자열이 아니다.
  for (const q of [
    "내일 기아 선발 누구?",
    "내일 기아 선발 투수 누구?",
    "내일 선발투수 누구야",
    "내일 선발 누구야?",
    "명일 선발투수",
  ]) {
    const intent = resolveTodayStartersIntent(q);
    assert.ok(intent, `소유해야 함: ${q}`);
    assert.equal(intent.offsetDays, 1, `내일 시점인데 offsetDays=${intent.offsetDays}: ${q}`);
  }
  assert.equal(resolveTodayStartersIntent("내일 기아 선발 누구?")?.team, "KIA");
  for (const q of [
    "어제 선발 투수 알려줘",       // 과거 — 기존 경로(선발이 아니라 결과 질문에 가깝다)
    "모레 선발 누구야?",           // 지원 범위 밖 — KBO 가 발표하지 않아 전 경기 미발표만 나온다
    "다음주 선발 로테이션",        // 지원 범위 밖
    "오늘이랑 내일 선발 누구야?",  // 시점어 2개 — 어느 날짜인지 확정 불가, fail-close
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

  // ── adapter actual: fetchGamesUserFacingWithMeta → adaptTodayStarters 다리 (삼순 2차 NO-GO) ──
  // 손으로 만든 fixture가 아니라 **배포 어댑터 함수 자체**를 실행해 starterSourceOk 파생을 고정한다.
  {
    const raw = [
      { gameId: "20260811HHOB0", awayName: "한화", homeName: "두산", awayStarterName: "왕옌청", homeStarterName: "곽빈", time: "19:00", stadium: "잠실", status: "scheduled" },
      { gameId: "20260811KTNC0", awayName: "KT", homeName: "NC", awayStarterName: "", homeStarterName: "라일리", time: "19:00", stadium: "창원", status: "scheduled" },
      { gameId: "20260811LTSK0", awayName: "롯데", homeName: "SSG", awayStarterName: "", homeStarterName: "", time: "18:30", stadium: "문학", status: "scheduled" },
    ];
    // ① KBO 조회 실패(null) → 전 경기 확인 불가. 빈 선발이 미발표로 위장될 경로가 없다.
    {
      const adapted = adaptTodayStarters(raw, null);
      assert.ok(adapted.every((g) => g.starterSourceOk === false), "kboGameIds=null인데 sourceOk=true");
      const rendered = renderTodayStartersAnswer(adapted, null);
      assert.ok(!rendered.includes("미발표"), "소스 전체 장애가 미발표로 위장됐다");
      assert.ok(rendered.includes("확인할 수 없습니다"));
    }
    // ② 부분 누락: KBO 응답에 있던 경기만 true.
    {
      const adapted = adaptTodayStarters(raw, new Set(["20260811HHOB0", "20260811KTNC0"]));
      assert.deepEqual(adapted.map((g) => g.starterSourceOk), [true, true, false]);
      const rendered = renderTodayStartersAnswer(adapted, null);
      assert.ok(rendered.includes("한화 왕옌청 vs 두산 곽빈"));
      assert.ok(rendered.includes("KT 미발표 vs NC 라일리")); // 소스 정상 + 빈값 = 진짜 미발표
      assert.ok(rendered.includes("롯데 vs SSG — 선발 정보를 지금 확인할 수 없습니다"));
    }
    // ③ 전체 정상 + 빈 선발 → true/미발표 (진짜 미발표는 미발표로 남는다).
    {
      const adapted = adaptTodayStarters(raw, new Set(raw.map((g) => g.gameId)));
      assert.ok(adapted.every((g) => g.starterSourceOk === true));
      const rendered = renderTodayStartersAnswer(adapted, null);
      assert.ok(rendered.includes("KT 미발표 vs NC 라일리"));
      assert.ok(rendered.includes("롯데 미발표 vs SSG 미발표"));
      assert.ok(!rendered.includes("확인할 수 없습니다"));
    }
  }

  // ── 렌더: 원값 그대로·미발표 표기·팀 필터 ──────────────────────────
  {
    const all = renderTodayStartersAnswer(GAMES, null);
    assert.ok(all.includes("한화 왕옌청 vs 두산 곽빈"));
    assert.ok(all.includes("KT 미발표 vs NC 라일리")); // 소스 정상 + 빈 선발 = 진짜 미발표
    // 소스 장애 경기: 미발표 위장 금지 — 확인 불가로 fail-close (삼순 P0).
    assert.ok(all.includes("롯데 vs SSG — 선발 정보를 지금 확인할 수 없습니다"));
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
    assert.ok(renderTodayStartersAnswer(GAMES.slice(0, 3), "삼성").includes("삼성 경기가 없습니다"));
  }

  // ── 종단: LLM·cache 0 · kbo_structured · KST 날짜 ───────────────────
  {
    const state = fresh();
    const result = await answerQuestion("u1", "오늘 선발 투수 알려줘", makeDeps(state));
    assert.equal(result.source, "kbo_structured");
    assert.ok(result.answer.includes("왕옌청"));
    assert.equal(state.llmCalls, 0);
    assert.equal(state.cacheWrites, 0);
    // 삼순 #1148 NO-GO ①축: production 형 glossary 후보(`선발`·`투수`)가 있어도
    // ①-b 매퍼가 선발 소유 질문을 선점하지 않는다 — 매퍼 0회가 actual 이다.
    assert.equal(state.mapperCalls, 0, "선발 소유 질문에 ①-b 매퍼가 호출됐다");
    assert.deepEqual(state.logs, ["kbo_structured"]);
    assert.deepEqual(state.fetches, ["20260811"]); // UTC(0810)가 아니라 KST(0811)
  }
  // 팀 지정 선발 질문도 동일 — 구단 가드·선발 가드 둘 다 이 질문을 매퍼에서 장씨한다.
  {
    const state = fresh();
    const result = await answerQuestion("u1", "오늘 LG 선발 누구야?", makeDeps(state));
    assert.equal(result.source, "kbo_structured");
    assert.ok(result.answer.includes("카라스코"));
    assert.ok(!result.answer.includes("한화"));
    assert.equal(state.mapperCalls, 0, "팀 지정 선발 질문에 ①-b 매퍼가 호출됐다");
    assert.equal(state.llmCalls, 0);
  }
  // 조회 실패 → error fail-close ("경기 없음" 둔갑 금지)
  {
    const state = fresh({ throws: true });
    const result = await answerQuestion("u1", "오늘 선발 투수 알려줘", makeDeps(state));
    assert.equal(result.answer, SYSTEM_ERROR_ANSWER);
    assert.deepEqual(state.logs, ["error"]);
  }
  // ── `내일` 렌더: 시점 표기가 헤더·경기없음 안내문 양쪽에 반영되는가 ──────────
  // 렌더가 `오늘` 을 하드코딩하고 있으면 내일 경기 밑에 "오늘의 선발 매치업입니다" 가 붙는다.
  {
    const tomorrow = renderTodayStartersAnswer(GAMES, null, 1);
    assert.ok(tomorrow.startsWith("내일의 선발 매치업입니다"), `내일 헤더 불일치: ${tomorrow.split("\n")[0]}`);
    assert.ok(!tomorrow.includes("오늘"), "내일 답변에 `오늘` 표기가 남았다");
    // 경기 내용 자체는 시점과 무관하게 같은 규칙으로 렌더된다(회귀 방지).
    assert.ok(tomorrow.includes("한화 왕옌청 vs 두산 곽빈"));
    assert.ok(tomorrow.includes("롯데 vs SSG — 선발 정보를 지금 확인할 수 없습니다"));

    const tomorrowTeam = renderTodayStartersAnswer(GAMES, "LG", 1);
    assert.ok(tomorrowTeam.startsWith("내일 LG 경기 선발입니다"), `내일 팀 헤더 불일치: ${tomorrowTeam.split("\n")[0]}`);

    // 경기 없음 — 시점별 전용 안내문
    assert.equal(renderTodayStartersAnswer([], null, 1), TOMORROW_NO_GAMES_ANSWER);
    assert.equal(renderTodayStartersAnswer([], null, 0), TODAY_NO_GAMES_ANSWER);
    assert.notEqual(TOMORROW_NO_GAMES_ANSWER, TODAY_NO_GAMES_ANSWER, "두 안내문이 같으면 시점 구분이 없다");
    assert.ok(renderTodayStartersAnswer(GAMES.slice(0, 3), "삼성", 1).includes("내일은 삼성 경기가 없습니다"));
    // 기본값(생략) = 오늘 — 기존 호출부 무회귀.
    assert.equal(renderTodayStartersAnswer([], null), TODAY_NO_GAMES_ANSWER);
  }

  // ── 종단: `내일` 질문이 **다음날 날짜**를 조회하는가 (KST 기준) ────────────────
  // deps.now = KST 2026-08-11 01:00. 내일이면 20260812 를 조회해야 한다.
  // UTC 날짜(0810)로 자르거나 오프셋을 안 더한 변종은 여기서 RED 난다.
  {
    const state = fresh();
    const result = await answerQuestion("u1", "내일 선발 누구야?", makeDeps(state));
    assert.equal(result.source, "kbo_structured");
    assert.deepEqual(state.fetches, ["20260812"], `내일 조회 날짜 불일치: ${state.fetches.join(",")}`);
    assert.ok(result.answer.startsWith("내일의 선발 매치업입니다"), `내일 종단 헤더: ${result.answer.split("\n")[0]}`);
    assert.equal(state.llmCalls, 0);
    assert.equal(state.cacheWrites, 0);
    assert.equal(state.mapperCalls, 0, "내일 선발 질문에 ①-b 매퍼가 호출됐다");
    assert.deepEqual(state.logs, ["kbo_structured"]);
  }
  // 팀 지정 + 내일 — 로그 원문 그대로
  {
    const state = fresh();
    const result = await answerQuestion("u1", "내일 기아 선발 누구?", makeDeps(state));
    assert.equal(result.source, "kbo_structured");
    assert.deepEqual(state.fetches, ["20260812"]);
    assert.equal(state.llmCalls, 0);
  }
  // 오늘 질문은 그대로 오늘 날짜 — 오프셋 확장이 기존 경로를 밀지 않았는가
  {
    const state = fresh();
    await answerQuestion("u1", "오늘 선발 투수 알려줘", makeDeps(state));
    assert.deepEqual(state.fetches, ["20260811"], "오늘 질문이 다른 날짜를 조회한다");
  }
  // 지원 범위 밖 시점은 이 경로가 소유하지 않는다 — 조회 자체가 일어나면 안 된다.
  {
    const state = fresh();
    const result = await answerQuestion("u1", "모레 선발 누구야?", makeDeps(state));
    assert.notEqual(result.source, "kbo_structured");
    assert.deepEqual(state.fetches, [], "지원 범위 밖 시점인데 경기 조회가 일어났다");
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
