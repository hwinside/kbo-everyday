/**
 * 리그 통산·역대 순위 공식 구조화 조회 + 범위밖 denylist 인물 축 삭제 + 답변 성의(길이) 계약.
 *
 * 배경 (2026-08-10 하린아빠 캡처 + 삼순 NO-GO):
 *  - `통산 안타 기록 1위는 누구야?` 를 generic LLM 에 위임하면 숫자 가드를 피해도
 *    **오래된 이름을 확신해서 내보내는 오답**(손아섭 — 실제 1위는 최형우)을 못 잡는다.
 *    2026-08-11 실측으로 `BasicTotal.aspx` 통산 정본이 확인됐다. 전년도 말 기준선에
 *    당해 시즌 스냅샷을 더해 현재 통산값을 결정론적으로 계산한다.
 *  - `작년 LG우승에 가장 큰 기여를 한 사람은 누구야?` 가 denylist `누구` 축에 걸려
 *    전면 차단 → 인물·평가·역사 축을 denylist 에서 삭제(범위 판정은 LLM 위임).
 *  - `맛자욱 별명` 단답 → tier1·tier2·generic 전 경로 길이 계약: 유형별 목표(단순=짧게,
 *    이유·배경=충분히) + 안전 상한(RAG 320 / generic 320).
 *
 * 고정하는 계약:
 *  1. 지원 리더보드 질문은 kbo_structured, 미지원 지표는 history_hold fail-close.
 *  2. 인물·평가·역사 의문사는 결정론 차단이 아니라 LLM 범위판정 위임.
 *  3. 진짜 범위밖 어휘(맛집·날씨·추천…)는 여전히 차단.
 *  4. 길이 계약: RAG(선수·구단·뉴스) 320 + 성의 지시, generic 320 + 성의 지시.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  answerQuestion,
  routeQuestion,
  isCareerLeaderboardAsk,
  type PlayerRef,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { BASEBALL_GENIUS_MAX_ANSWER_LENGTH } from "../../src/lib/constants/baseball-genius";
import {
  CAREER_LEADERBOARD_METRIC_WORDS,
  composeCareerLeaderboardAnswer,
  isCareerLeaderboardHoldScope,
  isCareerLeaderboardQuestion,
  resolveCareerLeaderboard,
  resolveCareerLeaderboardIntent,
} from "../../src/lib/baseball-qa/stats/career-leaderboard";
import {
  KBO_OFFICIAL_GENERAL_TERMS,
  KBO_OFFICIAL_METRIC_COLUMNS,
  KBO_OFFICIAL_METRIC_TERMS,
} from "../../src/lib/baseball-qa/stats/kbo-official-metric-columns";
import {
  SERVED_BATTER_FULL_ENTRY_IDS,
  validateServedBatterPayload,
} from "../../src/lib/baseball-qa/stats/served-record";
import { BASEBALL_QA_SYSTEM_PROMPT } from "../../src/lib/baseball-qa/gemini-request";
import {
  oldestFullEntryTimestamp,
  StatsFreshnessContractError,
} from "../../src/lib/stats/full-entry";
import { GET as statsGET, handleStatsGetFailure } from "../../src/app/api/stats/route";
import { canonicalKboId } from "../../src/lib/utils/resolve-player";
import {
  RAG_ANSWER_MAX_CHARS,
  RAG_OFFICIAL_ANSWER_MAX_CHARS,
  RAG_SYSTEM_PROMPT,
  RAG_TEAM_SYSTEM_PROMPT,
  RAG_NEWS_SYSTEM_PROMPT,
} from "../../src/lib/baseball-qa/rag/retrieve";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void) {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} :: ${(e as Error).message}`); }
}

const PLAYERS = [
  { kboId: "72443", name: "최형우", team: "삼성", position: "외야수" },
] as unknown as PlayerRef[];

// ── 1. 리더보드 = 공식 구조화 조회, 미지원 지표는 fail-close ──
check("intent 양성 전수는 라우터와 동일 SSOT로 구조화 경로에 결속된다", () => {
  for (const q of [
    "통산 안타 기록 1위는 누구야?",
    "통산 최다 안타는 누가 갖고 있어?",
    "커리어 안타 1위 알려줘",
    "누적 안타 1위 알려줘",
    "통산 안타 선두 알려줘",
    "올타임 안타 1위 누구야",
  ]) {
    assert.equal(isCareerLeaderboardAsk(q), true, q);
    assert.deepEqual(resolveCareerLeaderboardIntent(q), { metric: "hits", label: "안타" }, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "career_leaderboard", q);
  }
});
check("아직 스냅샷 계약이 없는 통산 지표는 LLM 대신 hold 유지", () => {
  for (const q of ["역대 홈런 1위 누구야?", "역대 최고 타율은 누구야?"]) {
    assert.equal(isCareerLeaderboardAsk(q), true, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "history_hold", q);
  }
});
// ⚠️ 삼순 5차 P0: `STAT_WORDS`(선수 개인 기록축 토큰)에 없는 지표 alias 가 hold 조건을
// 통째로 건너뛰고 generic LLM 으로 새면, 숫자 가드로도 못 막는 **이름 단답 환각**이 난다.
// 아래 두 축은 서로를 가리지 않는다 — 지표 어휘 축(순위 표지 없음)과 순위 표지 축(미열거 지표).
check("P0: 닫힌 지표 SSOT — 미지원 통산 지표 alias 는 순위 표지 없이도 hold", () => {
  // ⚠️ 여기 표본에는 순위 표지(`N위`·`최다`·`선두`·`상위`·`많`)를 **일부러 넣지 않는다**.
  // 넣으면 표지 축이 지표 축을 가려 `CAREER_LEADERBOARD_METRIC_WORDS` 를 통째로 지워도
  // 스모크가 GREEN 이 된다(실측: `다승` 제거 mutation 검출력 0). 두 가드는 각각 단독으로
  // 증명돼야 한다 — 수량 비교(`누가 제일 많아?`) 형태는 아래 순위 표지 check 가 맡는다.
  for (const q of [
    "통산 실책 누구야?",   // `STAT_WORDS` 미포함 alias — 지표 SSOT 단독 판정
    "역대 볼넷 누구야?",
    "통산 이닝 알려줘",
  ]) {
    assert.equal(isCareerLeaderboardAsk(q), true, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "history_hold", q);
  }
});
// ⚠️ 삼순 8차 P0 — **의문사 없는 형태**. 종전 앞단 prefilter(ask regex)가 이걸 탈락시켜
// generic LLM 으로 샜다. 아래 표본에는 `1위|누구|누가|최다|최고|선두|알려` 를 **한 글자도
// 넣지 않는다** — 넣으면 옛 prefilter 가 대신 통과시켜 계약이 깨져도 GREEN 이 된다.
check("P0: 의문사 없는 질문도 지표 어휘만으로 hold 에 결속된다", () => {
  for (const q of [
    "통산 안타 상위 10명",
    "역대 홈런 많은 타자",
    "통산 도루 랭킹",
    "역대 탈삼진 순위",
  ]) {
    for (const forbidden of ["1위", "누구", "누가", "최다", "최고", "선두", "알려"]) {
      assert.ok(!q.includes(forbidden), `표본에 옛 prefilter 어휘가 섞이면 false-green: ${q}`);
    }
    assert.equal(isCareerLeaderboardAsk(q), true, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "history_hold", q);
  }
});
check("P0: prefilter/hold 는 물리적으로 같은 함수다 (drift 불가)", () => {
  assert.equal(isCareerLeaderboardQuestion, isCareerLeaderboardHoldScope);
});

// ⚠️ 2026-08-12 A안(하린아빠 확정) — 표지 축(열린 언어) 폐기. 판정은 `시점어 + 지표 SSOT` 한 줄.
// 6·7·9차 NO-GO 가 전부 이 표지 축에서 났다(지표 열거 → `많` 추가 → `많` 과차단 되돌리기).
// 지표는 KBO 공식 기록실 컬럼이라 **닫힌 집합**이고, 반례가 오면 배열 한 줄 추가로 끝난다.
check("P0: 지표 SSOT — 표현이 어떻든 지표 어휘가 있으면 hold 로 결속", () => {
  for (const q of [
    "통산 폭투 1위 누구야?",
    "통산 폭투 누가 제일 많아?",
    "역대 실책 많은 선수",
    "통산 이닝 상위 10명",
    "역대 도루 순위 보여줘",
    "통산 세이브 랭킹",
    "역대 몸에맞는공 누가 많이 맞았어?",
    "통산 다승 누가 제일 많아?",
  ]) {
    assert.equal(routeQuestion(q, [], PLAYERS), "history_hold", q);
  }
});
check("P0: 판정 어휘 = 공식 컬럼 inventory 파생 (exact-set, extra 0)", () => {
  // 손열거였을 때 OOB(주루사)·PKO(견제사) 가 빠졌고 게이트가 그 누락을 "허용"으로 굳혔다
  // (삼순 10차 P0). 판정 어휘는 inventory 에서만 나와야 하고 임의 추가는 불가능해야 한다.
  assert.deepEqual(
    [...CAREER_LEADERBOARD_METRIC_WORDS].sort(),
    [...KBO_OFFICIAL_METRIC_TERMS].sort(),
    "판정 어휘가 inventory 파생이 아니다 — 손으로 늘렸거나 몰래 줄였다",
  );
  const fromColumns = new Set(KBO_OFFICIAL_METRIC_COLUMNS.flatMap((c) => c.terms));
  const extra = CAREER_LEADERBOARD_METRIC_WORDS.filter((w) => !fromColumns.has(w));
  assert.deepEqual(extra, [], `inventory 밖 어휘가 섞였다: ${extra.join(", ")}`);
});
check("P0: 주루·수비 공식 컬럼 누락 0 (OOB/PKO 실측 누락 재발 방지)", () => {
  // 삼순 exact — 손열거에서 실제로 빠졌던 두 컬럼.
  for (const code of ["OOB", "PKO", "SBA", "SB", "CS", "SB%", "E", "PO", "A", "FPCT", "PB", "CS%"]) {
    assert.ok(
      KBO_OFFICIAL_METRIC_COLUMNS.some((c) => c.code === code),
      `공식 컬럼 ${code} 가 inventory 에 없다`,
    );
  }
  // 그리고 그 컬럼이 실제 질문 결속까지 이어지는지 — inventory 등재만으로 끝나면 무의미하다.
  for (const q of ["역대 주루사 누가 많아?", "통산 견제사 1위 누구야?"]) {
    assert.equal(isCareerLeaderboardAsk(q), true, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "history_hold", q);
  }
});
check("P0: inventory 전 컬럼이 질문 결속까지 도달한다 (등재-판정 괴리 0)", () => {
  for (const column of KBO_OFFICIAL_METRIC_COLUMNS) {
    for (const term of column.terms) {
      const q = `통산 ${term} 1위 누구야?`;
      assert.equal(isCareerLeaderboardAsk(q), true, `${column.code}/${term} 미결속`);
    }
  }
});
check("P0: 일반명사 공식 컬럼(`경기`·`선발`)은 판정 어휘에서 분리된다", () => {
  // 삼순 10차 P0 — bare `경기` 를 지표로 넣으면 서술·주관 질문이 과차단된다.
  assert.ok(KBO_OFFICIAL_GENERAL_TERMS.includes("경기"));
  assert.ok(KBO_OFFICIAL_GENERAL_TERMS.includes("선발"));
  const overlap = KBO_OFFICIAL_GENERAL_TERMS.filter((w) => KBO_OFFICIAL_METRIC_TERMS.includes(w));
  assert.deepEqual(overlap, [], `일반명사가 판정 어휘에 섞였다: ${overlap.join(", ")}`);
  // 같은 컬럼은 비일반 공식 표기로 여전히 결속된다(기능 손실 없음).
  for (const q of ["통산 경기수 1위 누구야?", "통산 선발등판 1위 누구야?"]) {
    assert.equal(isCareerLeaderboardAsk(q), true, q);
  }
});
check("P0 무회귀: 일반명사만 있는 서술·주관 질문은 과차단하지 않는다 (삼순 exact)", () => {
  for (const q of [
    "역대 최고의 경기 알려줘",              // 삼순 exact
    "커리어 선발로 가장 기억나는 경기는?",   // 삼순 exact
    "통산 최고의 경기 뭐야?",
  ]) {
    assert.equal(routeQuestion(q, [], []), "llm_scope_gate", q);
  }
});

// ⚠️ 삼순 9차 P0 + A안의 핵심 이득 — 지표 어휘가 없으면 시점어·수량·최상급 표현이 있어도
// 우리 소관이 아니다. 표지 축을 버렸기 때문에 이 축이 구조적으로 안전해졌다.
check("P0 무회귀: 시점어 + 수량/최상급 표현이 있어도 지표 어휘가 없으면 LLM 범위 판정", () => {
  for (const q of [
    "누적 피로가 많으면 구속이 떨어져?",   // 삼순 exact
    "커리어가 긴 투수는 부상이 많아?",     // 삼순 exact
    "통산 성적이 좋으면 연봉도 많이 받아?",
    "역대 최고의 타자는 누구야?",
    "역대 가장 멋진 선수 누구야?",
    "역대 제일 인상 깊은 선수 누구야?",
  ]) {
    assert.equal(routeQuestion(q, [], []), "llm_scope_gate", q);
  }
});

check("야구 인물 질문은 결정론 차단이 아니라 위임이다 (캡처 exact 포함)", () => {
  for (const q of [
    "작년 LG우승에 가장 큰 기여를 한 사람은 누구야?", // `LG우승` 결합 토큰 — 팀 면제도 못 타던 표본
    "작년 한국시리즈 MVP 누구야?",
    "LG트윈스 감독 누구야?",
    "역대 최고의 타자는 누구야?", // 지표 없는 주관 평가 — 리더보드 아님, LLM 범위판정
  ]) {
    assert.equal(routeQuestion(q, [], []), "llm_scope_gate", q);
  }
});
check("진짜 범위밖 어휘는 여전히 차단된다 (denylist 축소 방향 안전핀)", () => {
  for (const q of ["LG 경기장 근처 맛집 추천해줘", "오늘 저녁 메뉴 추천", "날씨 어때?"]) {
    assert.equal(routeQuestion(q, [], []), "blocked", q);
  }
});

/** 리그 전체 규모의 2026 current rows 표본(기본 300행) — 빈/부분 응답 fail-close 계약의 양성 쪽. */
function makeCurrentRows(updatedAt = "2026-08-11T14:00:00Z") {
  return SERVED_BATTER_FULL_ENTRY_IDS.map((id, index) => ({
    kbo_id: id, player_key: id,
    name: id === "77532" ? "손아섭" : id === "72443" ? "최형우" : `현역${index}`,
    team: id === "77532" ? "두산" : id === "72443" ? "삼성" : "팀",
    hits: id === "77532" ? 35 : id === "72443" ? 109 : index % 150,
    updated_at: updatedAt,
  }));
}
function makeBaselineSnapshot() {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    kboId: String(70000 + index), name: `선수${index}`, team: "팀", hits: Math.max(0, 2500 - index),
  }));
  rows[0] = { kboId: "77532", name: "손아섭", team: "두산", hits: 2618 };
  rows[1] = { kboId: "72443", name: "최형우", team: "삼성", hits: 2586 };
  return {
    schemaVersion: 1, throughSeason: 2025, rowCount: rows.length, rows,
    source: { url: "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx", seasonValue: "9999", sortKey: "HIT_CN", order: "DESC" },
  };
}

check("기준선 + 올시즌 증분이 현재 통산 1위를 뒤집어 계산한다 (+출처 표기)", () => {
  const snapshot = makeBaselineSnapshot();
  const current = makeCurrentRows();
  const result = resolveCareerLeaderboard(snapshot, current as never, "2026-08-11T14:00:00Z", { metric: "hits", label: "안타" }, new Date("2026-08-11T15:00:00Z"));
  assert.equal(result?.leaders[0].name, "최형우");
  assert.equal(result?.leaders[0].total, 2695);
  const answer = composeCareerLeaderboardAnswer(result!);
  assert.ok(answer.includes("2,695안타"));
  assert.ok(answer.includes("출처") && answer.includes("KBO 공식 기록실"), `답변에 출처 표기가 있어야 한다: ${answer}`);
});

check("P0: 유효 기준선 + 빈/부분 currentRows 는 fail-close (2025값 단정 금지)", () => {
  const intent = { metric: "hits", label: "안타" } as const;
  const snapshot = makeBaselineSnapshot();
  const now = new Date("2026-08-11T15:00:00Z");
  assert.equal(resolveCareerLeaderboard(snapshot, [], "2026-08-11T14:00:00Z", intent, now), null, "빈 currentRows");
  assert.equal(resolveCareerLeaderboard(snapshot, makeCurrentRows().slice(0, 100) as never, "2026-08-11T14:00:00Z", intent, now), null, "임의 100행 currentRows");
  const missingLeader = makeCurrentRows().filter((row) => row.kbo_id !== "72443");
  assert.equal(resolveCareerLeaderboard(snapshot, missingLeader as never, "2026-08-11T14:00:00Z", intent, now), null, "known full-entry ID 1개 누락");
});

check("P0: /api/stats envelope type/count + known full-entry ID coverage 계약", () => {
  const rows = makeCurrentRows().map((row) => ({ ...row, kboId: row.kbo_id }));
  assert.equal(validateServedBatterPayload({ stats: rows, type: "batter", count: rows.length })?.length, rows.length);
  assert.equal(validateServedBatterPayload({ stats: rows, type: "pitcher", count: rows.length }), null, "type 변형");
  assert.equal(validateServedBatterPayload({ stats: rows, type: "batter", count: rows.length - 1 }), null, "count 불일치");
  assert.equal(validateServedBatterPayload({ stats: rows.slice(0, 100), type: "batter", count: 100 }), null, "임의 100행");
  const missingKnownId = rows.filter((row) => row.kboId !== SERVED_BATTER_FULL_ENTRY_IDS[0]);
  assert.equal(validateServedBatterPayload({ stats: missingKnownId, type: "batter", count: missingKnownId.length }), null, "known ID 누락");
  // 운영 실형태: static 숫자 54400과 full 응답 FP006은 같은 선수여야 coverage가 닫힌다.
  assert.equal(canonicalKboId("54400"), "FP006");
  assert.ok(SERVED_BATTER_FULL_ENTRY_IDS.includes("FP006"));
  assert.ok(!SERVED_BATTER_FULL_ENTRY_IDS.includes("54400"));
});

check("P0: baseline 숫자 외국인 ID와 current canonical 영문 ID를 같은 선수로 결합", () => {
  const snapshot = makeBaselineSnapshot();
  snapshot.rows[0] = { kboId: "54400", name: "외국인표본", team: "팀", hits: 3000 };
  const current = makeCurrentRows().map((row) => row.kbo_id === "FP006"
    ? { ...row, name: "외국인표본", hits: 10 }
    : row);
  const result = resolveCareerLeaderboard(snapshot, current as never, "2026-08-11T14:00:00Z", { metric: "hits", label: "안타" }, new Date("2026-08-11T15:00:00Z"));
  assert.equal(result?.leaders[0].kboId, "FP006");
  assert.equal(result?.leaders[0].total, 3010);
});

check("P0: full=1 freshness는 모든 구성시각 검증 후 가장 오래된 시각", () => {
  const now = new Date("2026-08-12T01:00:00Z");
  assert.equal(
    oldestFullEntryTimestamp(["2026-08-12T01:00:00Z", "2026-08-10T20:21:46.603Z"], now),
    "2026-08-10T20:21:46.603Z",
  );
  assert.equal(oldestFullEntryTimestamp(["2026-08-12T01:00:00Z", undefined], now), null, "구성시각 누락 fail-close");
  assert.equal(
    oldestFullEntryTimestamp(["2026-08-12T01:00:00Z", "2026-08-13T01:00:00Z"], now),
    null,
    "미래 static을 min 계산으로 숨기면 안 된다",
  );
  const routeSource = readFileSync("src/app/api/stats/route.ts", "utf8");
  assert.match(routeSource, /const updatedAt = full\s*\? requireOldestFullEntryTimestamp\(\[currentUpdatedAt, staticGeneratedAt\]\)/);
  assert.match(routeSource, /statsMeta\.battersGeneratedAt/);
});

check("P0: current 컬럼 원타입 변형(hits '109' 문자열·필드 누락)은 fail-close", () => {
  const intent = { metric: "hits", label: "안타" } as const;
  const snapshot = makeBaselineSnapshot();
  const now = new Date("2026-08-11T15:00:00Z");
  const stringTyped = [
    ...makeCurrentRows().filter((row) => row.kbo_id !== "72443"),
    { kbo_id: "72443", player_key: "72443", name: "최형우", team: "삼성", hits: "109", updated_at: "2026-08-11T14:00:00Z" },
  ];
  assert.equal(resolveCareerLeaderboard(snapshot, stringTyped as never, "2026-08-11T14:00:00Z", intent, now), null, "문자열 hits");
  const missing = [
    ...makeCurrentRows().filter((row) => row.kbo_id !== "72443"),
    { kbo_id: "72443", player_key: "72443", name: "최형우", team: "삼성", updated_at: "2026-08-11T14:00:00Z" },
  ];
  assert.equal(resolveCareerLeaderboard(snapshot, missing as never, "2026-08-11T14:00:00Z", intent, now), null, "hits 필드 누락");
});

check("P0: 범위형(1위부터 10위)은 단일 1위로 오매칭하지 않고 hold 로 내려간다", () => {
  for (const q of [
    "통산 안타기록 기준으로 현재까지 1위부터 10위까지가 누구누구야?", // 하린아빠 exact
    "통산 안타 1위부터 5위 알려줘",
    "통산 안타 상위 10명 누구야?",
    "통산 안타 top10 알려줘",
    "통산 안타 3위 누구야?",
    "통산 안타 최다 10명 알려줘", // 삼순 2차 NO-GO exact
    "통산 안타 최다 두 명 알려줘", // 삼순 3차 NO-GO exact
    "통산 안타 1위는 누구고 2위는 누구야?", // 삼순 4차 NO-GO: 부분절 consume 금지
    "통산 홈런 1위는 누구야? 안타도 궁금해", // 삼순 4차 NO-GO: 타 지표 절의 안타 오결속 금지
    // ⚠️ 아래 두 표본은 각각 rankTokens 폐쇄·범위 표지 폐쇄를 **단독으로** 무너뜨린다.
    // 표지 없는 복수 순위(1위 2위)는 rankTokens 만, 1위+부터는 범위 표지만 잡는다 —
    // 하나가 빠져도 다른 가드가 가려 mutation 검출력이 0이 되는 것을 막는 쌍이다.
    "통산 안타 1위 2위 누구야?",
    "통산 안타 1위부터 알려줘",
  ]) {
    assert.equal(resolveCareerLeaderboardIntent(q), null, q);
    assert.equal(routeQuestion(q, [], PLAYERS), "history_hold", q);
  }
});
check("결함주입: 빈/낡은/중복 identity/컬럼 변형은 fail-close", () => {
  const intent = { metric: "hits", label: "안타" } as const;
  const rows = Array.from({ length: 100 }, (_, index) => ({
    kboId: String(70000 + index), name: `선수${index}`, team: "팀", hits: 2500 - index,
  }));
  const valid = {
    schemaVersion: 1, throughSeason: 2025, rowCount: rows.length, rows,
    source: { url: "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx", seasonValue: "9999", sortKey: "HIT_CN", order: "DESC" },
  };
  const fullCurrent = makeCurrentRows();
  assert.equal(resolveCareerLeaderboard({}, fullCurrent as never, "2026-08-11T14:00:00Z", intent, new Date("2026-08-11T15:00:00Z")), null, "empty baseline");
  assert.equal(resolveCareerLeaderboard(valid, fullCurrent as never, "2026-08-09T14:00:00Z", intent, new Date("2026-08-11T15:00:00Z")), null, "stale");
  assert.equal(resolveCareerLeaderboard(valid, [
    ...fullCurrent,
    { kbo_id: "70000", player_key: "70000", name: "선수0", team: "팀", hits: 1, updated_at: "2026-08-11T14:00:00Z" },
    { kbo_id: "70000", player_key: "70000", name: "선수0", team: "팀", hits: 1, updated_at: "2026-08-11T14:00:00Z" },
  ] as never, "2026-08-11T14:00:00Z", intent, new Date("2026-08-11T15:00:00Z")), null, "duplicate identity");
  const swapped = { ...valid, rows: rows.map((row, index) => index === 0 ? { ...row, hits: "2500" } : row) };
  assert.equal(resolveCareerLeaderboard(swapped, fullCurrent as never, "2026-08-11T14:00:00Z", intent, new Date("2026-08-11T15:00:00Z")), null, "H column type swap");
});

check("무회귀: 선수 지명·시점어 없는 질문은 리더보드가 아니다", () => {
  assert.equal(routeQuestion("최형우 통산 타율 알려줘", [], PLAYERS), "history_hold");
  assert.equal(isCareerLeaderboardAsk("지금 홈런 1위 누구야?"), false);
  assert.equal(isCareerLeaderboardAsk("통산 기록이 뭐야?"), false);
});

// ── 3. 길이·성의 계약 — 전 경로 (선수·구단·뉴스 RAG + generic) ─────────────────
check("tier2 상한 320 = tier1, 선수 RAG 성의 지시", () => {
  assert.equal(RAG_ANSWER_MAX_CHARS, 320);
  assert.equal(RAG_ANSWER_MAX_CHARS, RAG_OFFICIAL_ANSWER_MAX_CHARS);
  assert.ok(RAG_SYSTEM_PROMPT.includes("이유·배경·사연을 묻는 질문은 자료 안의 맥락을 두세 문장으로 충분히 설명한다"));
  assert.ok(RAG_SYSTEM_PROMPT.includes("자료에 없는 내용을 보태 길이를 채우지 않는다"));
});
check("구단 RAG 도 같은 성의 계약이다 — 한두 문장 강제 잔존 금지 (삼순 축 ③)", () => {
  assert.ok(RAG_TEAM_SYSTEM_PROMPT.includes("이유·배경·사연을 묻는 질문은 자료 안의 맥락을 두세 문장으로 충분히 설명한다"));
  assert.ok(!RAG_TEAM_SYSTEM_PROMPT.includes("한두 문장으로 다시 서술"));
});
check("뉴스 RAG 성의 계약", () => {
  assert.ok(RAG_NEWS_SYSTEM_PROMPT.includes("두세 문장으로 충분히"));
});
check("generic 상한 320 + 성의 지시 (200자 계약 폐기)", () => {
  assert.equal(BASEBALL_GENIUS_MAX_ANSWER_LENGTH, 320);
  assert.ok(BASEBALL_QA_SYSTEM_PROMPT.includes("320자 이하"));
  assert.ok(!BASEBALL_QA_SYSTEM_PROMPT.includes("200자 이하"));
  assert.ok(BASEBALL_QA_SYSTEM_PROMPT.includes("이유·배경·사연·과정을 묻는 질문은 두세 문장으로 충분히"));
});

// ── 4. 성의 축 — 실제 생성답 E2E (삼순 2026-08-10: 프롬프트 문자열 단정만으로는
// 행동 개선이 검증되지 않는다). RAG 경로에 두세 문장·250자 답을 물려 **그대로**
// 유저에게 나가는지, 320 초과는 여전히 거부되는지 종단으로 고정한다.
const RAG_PLAYERS = [
  { kboId: "55555", name: "맛자욱", team: "LG", position: "내야수" },
] as unknown as PlayerRef[];
// ⚠️ deterministic 답(FULL_ANSWER)의 **모든 사실은 이 근거 안에 있어야 한다** (삼순
// 3차: 근거 밖 사실을 정답으로 고정하면 게이트가 환각을 승인하는 셈이다).
const RAG_EVIDENCE = [{
  content: "맛자욱은 먹방 예능에서 보여준 남다른 먹성 때문에 팬들이 맛자욱이라는 별명을 붙였다고 알려져 있다. 데뷔 초 방송 출연이 화제가 된 뒤 응원단이 먼저 부르기 시작했고, 홈 경기 응원가에도 등장하면서 널리 퍼졌다. 본인도 그 별명을 마음에 들어해 인터뷰에서 직접 언급했으며 지금까지 정착했다.",
  pageTitle: "맛자욱", canonicalUrl: "https://namu.wiki/w/맛자욱", revision: "1",
  sectionPath: "별명", asOf: "2026-01-01", sourceGrade: "tier2",
}];
function ragDeps(llmAnswer: string): { deps: QaDeps; counters: { llm: number } } {
  const counters = { llm: 0 };
  let stored: unknown = null;
  let started = false;
  const deps = {
    loadGlossary: async () => [],
    loadPlayers: async () => RAG_PLAYERS,
    getCache: async () => null,
    setCache: async () => {},
    enablePlayerRag: true,
    searchRag: async () => RAG_EVIDENCE as never,
    callRagLlm: async () => {
      counters.llm++;
      return { text: JSON.stringify({ status: "GROUNDED", answer: llmAnswer }), inputTokens: 10, outputTokens: 5 };
    },
    callLlm: async () => { throw new Error("선수 RAG 질문에서 generic LLM 금지"); },
    searchOfficialRag: async () => { throw new Error("선수 질문은 공식 RAG 미사용"); },
    callOfficialRagLlm: async () => { throw new Error("선수 질문은 공식 RAG 미사용"); },
    reserveDaily: async () => ({ allowed: true, remaining: 9 }),
    log: async () => {},
    getLlmState: async () => ({ started, result: stored, ownerActive: false }),
    acquireLlmStart: async () => { started = true; return true; },
    storeLlm: async (r: unknown) => { stored = r; },
  } as unknown as QaDeps;
  return { deps, counters };
}
const asyncChecks: { name: string; fn: () => Promise<void> }[] = [];
function checkAsync(name: string, fn: () => Promise<void>) { asyncChecks.push({ name, fn }); }

checkAsync("GET 경계: freshness 계약 오류는 fallback 200으로 우회하지 않는다", async () => {
  const response = handleStatsGetFailure(
    new StatsFreshnessContractError(),
    "2026",
    "batter",
    new Date("2026-08-12T01:00:00Z"),
  );
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.stats.length, 0);
  assert.notEqual(body.source, "fallback");
});

checkAsync("GET call-site 실결속: 실패 경로가 handler를 통과해 freshness를 검증한다", async () => {
  // 삼순 5차 P1: handler 직접 호출만 검증하면 GET catch 가 handler 결속을 잃어도 GREEN 이다.
  // 여기서는 **실제 GET** 을 태운다 — fetch 를 죽여 catch 로 보내고, 시계를 static 생성시각
  // 이전으로 얼려 fallback 구성시각을 `미래`로 만든다. 결속이 살아 있으면 500 fail-close.
  const realFetch = globalThis.fetch;
  const RealDate = globalThis.Date;
  const frozen = new RealDate("2020-01-01T00:00:00Z").getTime();
  globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  class FrozenDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor>) {
      if (args.length === 0) super(frozen);
      else super(...(args as [string]));
    }
    static now(): number { return frozen; }
  }
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  try {
    const req = { nextUrl: new URL("https://keubo.fan/api/stats?type=batter&season=2026") };
    const response = await statsGET(req as never);
    assert.equal(response.status, 500, "미래 구성시각 fallback 이 200 으로 새면 안 된다");
    const body = await response.json();
    assert.equal(body.stats.length, 0);
    assert.notEqual(body.source, "fallback");
  } finally {
    globalThis.fetch = realFetch;
    globalThis.Date = RealDate;
  }
});

checkAsync("E2E: 캡처 exact가 history_hold/LLM이 아니라 kbo_structured로 종결된다", async () => {
  let genericLlm = 0;
  const deps = {
    loadGlossary: async () => [], loadPlayers: async () => PLAYERS,
    getCache: async () => null, setCache: async () => {},
    callLlm: async () => { genericLlm++; throw new Error("통산 정본 질문은 LLM 금지"); },
    fetchCareerLeaderboard: async () => ({
      metric: "hits", label: "안타", asOf: "2026-08-11T14:00:00Z", baselineThroughSeason: 2025,
      sourceUrl: "https://www.koreabaseball.com/Record/Player/HitterBasic/BasicTotal.aspx",
      leaders: [{ kboId: "72443", name: "최형우", team: "삼성", total: 2695, baseline: 2586, current: 109 }],
    }),
    reserveDaily: async () => ({ allowed: true, remaining: 9 }), log: async () => {},
  } as unknown as QaDeps;
  const result = await answerQuestion("u1", "통산 안타 기록 1위는 누구야?", deps);
  assert.equal(result.source, "kbo_structured");
  assert.ok(result.answer.includes("최형우(삼성)"));
  assert.ok(result.answer.includes("2,695안타"));
  assert.equal(genericLlm, 0);
});

const FULL_ANSWER =
  "맛자욱이라는 별명은 먹방 예능에서 보여준 남다른 먹성 때문에 팬들이 붙여준 거예요. " +
  "데뷔 초 방송 출연이 화제가 된 뒤 응원단이 먼저 부르기 시작했고, 홈 경기 응원가에도 등장하면서 널리 퍼졌다고 알려져 있어요. " +
  "본인도 그 별명을 마음에 들어해서 인터뷰에서 직접 언급할 만큼 지금까지 정착했다고 해요.";
checkAsync("E2E: 이유·배경 질문의 세 문장 답변이 잘리지 않고 그대로 나간다 (캡처 성의 축)", async () => {
  const { deps, counters } = ragDeps(FULL_ANSWER);
  const result = await answerQuestion("u1", "맛자욱 별명이 생긴 이유가 뭐야?", deps);
  // 본문 세 문장이 한 글자도 잃지 않고 나가고, 출처 표기만 뒤에 붙는다.
  assert.ok(result.answer.startsWith(FULL_ANSWER), `세 문장 전체가 그대로 나가야 한다: ${result.answer}`);
  assert.ok(result.answer.includes("출처"), "출처 표기 유지");
  assert.ok(FULL_ANSWER.length > 160, "종전 상한(160)을 실제로 넘는 표본이어야 상향이 검증된다");
  assert.equal(counters.llm, 1);
});
checkAsync("E2E 반대축: 320 초과 답변은 여전히 거부된다 (상한 상향이 무제한 아님)", async () => {
  const over = "가".repeat(340);
  const { deps } = ragDeps(over);
  const result = await answerQuestion("u1", "맛자욱 별명이 생긴 이유가 뭐야?", deps);
  assert.notEqual(result.answer, over, "320 초과가 그대로 나가면 상한이 죽은 것");
});

(async () => {
  for (const item of asyncChecks) {
    try { await item.fn(); pass += 1; console.log(`PASS ${item.name}`); }
    catch (e) { failures.push(item.name); console.log(`FAIL ${item.name} :: ${(e as Error).message}`); }
  }
  console.log(`\nbaseball QA leaderboard: PASS=*** FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
})();
