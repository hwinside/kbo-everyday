#!/usr/bin/env node
/**
 * 리더보드 fail-close·denylist·길이 계약 + 한국시리즈 MVP 정본 축 mutation 러너.
 *
 * 계약: 원본을 in-memory 백업 후 결함 주입 → smoke 재실행 → FAIL 마커가 나와야 RED.
 * 앵커 부재 = 러너 고장으로 FAIL (조용한 skip 금지). 종료 시 무조건 원복.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const RETRIEVE = "src/lib/baseball-qa/rag/retrieve.ts";
const CONSTANTS = "src/lib/constants/baseball-genius.ts";
const PRIZE = "src/lib/baseball-qa/awards/series-prize.ts";
const CAREER_LEADERBOARD = "src/lib/baseball-qa/stats/career-leaderboard.ts";
const SERVED_RECORD = "src/lib/baseball-qa/stats/served-record.ts";
const FULL_ENTRY = "src/lib/stats/full-entry.ts";
const FULL_ENTRY_ROSTER = "src/lib/stats/full-entry-roster.ts";
const STATS_ROUTE = "src/app/api/stats/route.ts";
const TONE = "src/lib/baseball-qa/tone.ts";
const GEMINI_REQUEST = "src/lib/baseball-qa/gemini-request.ts";
const ANSWER_BUDGET = "src/lib/baseball-qa/answer-budget.ts";

const MUTATIONS = [
  {
    name: "m1 intent 직접결속 제거 — 양성 intent가 history_hold로 회귀",
    file: PIPELINE,
    from: '    if (resolveCareerMetricIntent(question)) return "career_leaderboard";',
    to: '    if (resolveCareerMetricIntent(question)) return "history_hold";',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m1b 올시즌 증분 제거 — 작년 1위가 그대로 나가는 stale 회귀",
    file: CAREER_LEADERBOARD,
    from: "total: base[intent.metric] + delta,",
    to: "total: base[intent.metric],",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m1c stale 가드 제거 — 하루 넘은 올시즌 값으로 최신 통산을 단정",
    file: CAREER_LEADERBOARD,
    from: "now.getTime() - updatedMs > STATS_STALE_MS || ",
    to: "",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m1f(C안) hold 판정을 main 과 다르게 변형 — 이 PR 의 '거절 범위 변화 0' 계약 파괴",
    file: PIPELINE,
    from: "const CAREER_LEADERBOARD_ASK = /1\\s*위|누구|누가|최다|최고/;",
    to: "const CAREER_LEADERBOARD_ASK = /1\\s*위|누구|누가|최다|최고|많|상위/;",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m1g(C안) intent 결속을 hold 뒤로 밀어냄 — 본목적(안타 1위 실답)이 hold 로 회귀",
    file: PIPELINE,
    from: '    if (resolveCareerMetricIntent(question)) return "career_leaderboard";',
    to: "",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m2 인물 축 denylist 복원 — 우승 기여자 질문이 다시 차단",
    file: PIPELINE,
    from: "const OUT_OF_SCOPE_INTENT =\n  /추천|",
    to: "const OUT_OF_SCOPE_INTENT =\n  /누구|추천|",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    // ⚠️ 앵커를 **깊이 SSOT 상수 자체**에 건다. 종전에는 프롬프트 안의 복제 문구를
    //   앵커로 썼는데, 문구가 4곳에 복제돼 있어 한 곳만 바꾸면 앵커 MISS 로 러너가
    //   조용히 깨졌다(2026-08-15 앵커 복제 교훈). SSOT 는 하나뿐이라 그 함정이 없다.
    name: "m3 깊이 지시 제거 — 5경로 전부 즉답 강제로 회귀",
    file: TONE,
    from: '  "답변은 질문이 요구하는 만큼 충분히 설명한다. 한 줄로 끊어 즉답만 던지지 않는다.",',
    to: '  "답변은 한두 문장으로 짧게 서술한다.",',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m3b 무근거 채움 금지 제거 — 근거 밖 내용으로 길이를 늘려도 통과",
    file: TONE,
    from: '  "다만 확인되지 않은 내용을 지어내 길이를 채우지 않는다 — 길이는 근거가 허락하는 만큼만 늘린다.",',
    to: '  "필요하면 알고 있는 배경 지식을 덧붙여 길이를 늘린다.",',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    // ⚠️ 앵커는 **예산 SSOT 상수 선언**에 건다. 세 상한이 전부 이 값을 파생하므로
    //   여기 하나만 되돌리면 전 경로가 함께 회귀한다(리터럴 3개를 각각 앵커하던 시대 종료).
    name: "m4 답변 문자 상한 320 회귀 — 상향 이전 값으로 되돌림",
    file: ANSWER_BUDGET,
    from: "export const BASEBALL_GENIUS_ANSWER_MAX_CHARS = 700;",
    to: "export const BASEBALL_GENIUS_ANSWER_MAX_CHARS = 320;",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m4b tier1 상한만 갈라놓기 — SSOT 파생을 끊고 경로별 길이 불일치",
    file: RETRIEVE,
    from: "export const RAG_OFFICIAL_ANSWER_MAX_CHARS = BASEBALL_GENIUS_ANSWER_MAX_CHARS;",
    to: "export const RAG_OFFICIAL_ANSWER_MAX_CHARS = 320;",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m4e 생성 토큰 상한 256 회귀 — 700자 답변이 JSON 절단으로 전량 폐기 (삼순 P0 재현)",
    file: ANSWER_BUDGET,
    from: "export const BASEBALL_GENIUS_MAX_OUTPUT_TOKENS = 1_024;",
    to: "export const BASEBALL_GENIUS_MAX_OUTPUT_TOKENS = 256;",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    // ⚠️ 첫 가드만 지우는 변이는 **의도적으로 쓰지 않는다** — 1.5배 여유 가드가 같은 입력을
    //   여전히 잡아내므로 검출력 0 이 되고, 그건 코드 결함이 아니라 두 가드가 겹친다는 뜻이다
    //   (실측으로 확인: 256 < ceil(552*1.5)=828 이라 두 번째 가드가 대신 잡는다).
    //   판정 자체를 무력화하는 변이라야 "게이트가 이 함수를 실제로 태우는가"를 검사한다.
    name: "m4f 예산 정합 판정 무력화 — 어떤 토큰 상한도 통과시킨다",
    file: ANSWER_BUDGET,
    from: "): string | null {\n  if (maxOutputTokens < worstMeasuredTokens) {",
    to: "): string | null {\n  return null;\n  if (maxOutputTokens < worstMeasuredTokens) {",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m4g RAG 요청 토큰 미배선 — 상수는 맞는데 실제 body 가 옛 리터럴",
    file: RETRIEVE,
    from: "      maxOutputTokens: BASEBALL_GENIUS_MAX_OUTPUT_TOKENS,",
    to: "      maxOutputTokens: 256,",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m4h generic 요청 토큰 미배선 — 상수는 맞는데 실제 body 가 옛 리터럴",
    file: GEMINI_REQUEST,
    from: "      maxOutputTokens: BASEBALL_GENIUS_MAX_OUTPUT_TOKENS,",
    to: "      maxOutputTokens: 256,",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m4c 근거 건수 회귀 — 상한만 올리고 재료를 되돌림",
    file: RETRIEVE,
    from: "export const RAG_EVIDENCE_LIMIT = 6;",
    to: "export const RAG_EVIDENCE_LIMIT = 4;",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m4d 근거 길이 회귀 — 문단 뒷부분이 다시 잘림",
    file: RETRIEVE,
    from: "export const RAG_EVIDENCE_MAX_CHARS = 800;",
    to: "export const RAG_EVIDENCE_MAX_CHARS = 600;",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m5 generic 상한만 SSOT 파생을 끊고 320 회귀",
    file: CONSTANTS,
    from: "export const BASEBALL_GENIUS_MAX_ANSWER_LENGTH = BASEBALL_GENIUS_ANSWER_MAX_CHARS;",
    to: "export const BASEBALL_GENIUS_MAX_ANSWER_LENGTH = 320;",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m5b generic 프롬프트만 구 상한 문구로 회귀 — 상수와 지시 불일치",
    file: GEMINI_REQUEST,
    from: 'BASEBALL_RULE_TERM일 때만 ${BASEBALL_GENIUS_ANSWER_MAX_CHARS}자 이하 답변',
    to: 'BASEBALL_RULE_TERM일 때만 320자 이하 답변',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m5c 깊이 SSOT 미배선 — 구단 RAG 프롬프트에서만 빠짐(복제 시대 회귀)",
    file: RETRIEVE,
    from: '  // 성의 계약 (2026-08-10 하린아빠 12:06 + 삼순: 선수·뉴스만 고치고 구단을 빼면 미완):\n  BASEBALL_GENIUS_DEPTH_PROMPT,',
    to: '  // 성의 계약 (2026-08-10 하린아빠 12:06 + 삼순: 선수·뉴스만 고치고 구단을 빼면 미완):',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m6 known full-entry current coverage 제거 — 리더 빠진 임의 100행으로 2025값 단정",
    file: CAREER_LEADERBOARD,
    from: "if (!SERVED_BATTER_FULL_ENTRY_IDS.every((id) => currentById.has(id))) return null;",
    to: "",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m6b /api/stats type 계약 제거 — pitcher payload를 batter 통산에 혼합",
    file: SERVED_RECORD,
    from: 'if (payload.type !== "batter" || !Number.isInteger(payload.count)) return null;',
    to: 'if (!Number.isInteger(payload.count)) return null;',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m6c /api/stats count 계약 제거 — 선언 count와 실제 rows 불일치 통과",
    file: SERVED_RECORD,
    from: "if (!rows || payload.count !== rows.length) return null;",
    to: "if (!rows) return null;",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m6d /api/stats known full-entry coverage 제거 — 임의 100행 payload 통과",
    file: SERVED_RECORD,
    from: "if (!SERVED_BATTER_FULL_ENTRY_IDS.every((id) => ids.has(id))) return null;",
    to: "",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m6e static numeric→canonical ID 정규화 제거 — FP006 운영 payload 상시 거절",
    file: FULL_ENTRY_ROSTER,
    from: `  (batterStats2026 as Array<Record<string, unknown>>).map((row) =>
    canonicalKboId(row.kboId as string | number | null),
  ),`,
    to: '  (batterStats2026 as Array<Record<string, unknown>>).map((row) => String(row.kboId ?? "")),',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m6f baseline numeric→canonical ID 정규화 제거 — 외국인 current와 결합 실패",
    file: CAREER_LEADERBOARD,
    from: 'const canonicalId = canonicalKboId(base.kboId);',
    to: 'const canonicalId = base.kboId;',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m6g oldest component freshness 계산 반전 — full=1이 최신 now로 stale 우회",
    file: FULL_ENTRY,
    from: 'item.ms < oldest.ms ? item : oldest',
    to: 'item.ms > oldest.ms ? item : oldest',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m6h route static 생성시각 결속 제거 — full=1이 live now만 노출",
    file: STATS_ROUTE,
    from: 'requireOldestFullEntryTimestamp([currentUpdatedAt, staticGeneratedAt])',
    to: 'requireOldestFullEntryTimestamp([currentUpdatedAt, currentUpdatedAt])',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m6i 미래 구성시각 선검증 제거 — min(now,futureStatic)이 now로 오염을 숨김",
    file: FULL_ENTRY,
    from: " || item.ms > nowMs + 5 * 60_000",
    to: "",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m6j GET catch 의 handler 결속 제거 — 옛 인라인 fallback 이 freshness 를 우회",
    file: STATS_ROUTE,
    from: "    return handleStatsGetFailure(e, season, type);",
    to: `    if (season === "2026" || season === "current") {
      const fb = type === "pitcher"
        ? (pitcherStats2026 as unknown as PlayerStat[])
        : (batterStats2026 as unknown as PlayerStat[]);
      const fbAt = type === "pitcher" ? statsMeta.pitchersGeneratedAt : statsMeta.battersGeneratedAt;
      return NextResponse.json({ stats: fb, type, count: fb.length, season: 2026, source: "fallback", updatedAt: fbAt });
    }
    return NextResponse.json({ error: (e as Error).message, stats: [] }, { status: 500 });`,
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m7 current 원타입 계약 제거 — 문자열 '109'/필드 누락이 그대로 합산",
    file: CAREER_LEADERBOARD,
    from: `    const raw = row[intent.metric];
    if (raw === undefined || raw === null || typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return null;
    }
    currentById.set(id, row);`,
    to: "    currentById.set(id, row);",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m8 전체질의 consume 종단 앵커 제거 — 1위/2위 복수절 앞부분만 먹음",
    file: CAREER_LEADERBOARD,
    from: 'const explicitFirst = new RegExp(`^${temporal}안타(?:기록)?1위(?:는|가|를)?${who}$`);',
    to: 'const explicitFirst = new RegExp(`^${temporal}안타(?:기록)?1위(?:는|가|를)?${who}`);',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m8b 최다 singular positive grammar 우회 — 최다 두 명을 단일답으로",
    file: CAREER_LEADERBOARD,
    from: "if (!explicitFirst.test(normalized) && !singularLeader.test(normalized)) return null;",
    to: 'if (!explicitFirst.test(normalized) && !singularLeader.test(normalized) && !normalized.includes("최다")) return null;',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m8c 지표-순위 결속 제거 — 홈런 1위 절 뒤 안타를 오결속",
    file: CAREER_LEADERBOARD,
    from: "if (!explicitFirst.test(normalized) && !singularLeader.test(normalized)) return null;",
    to: 'if (!explicitFirst.test(normalized) && !singularLeader.test(normalized) && !(normalized.includes("1위") && normalized.includes("안타"))) return null;',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m9 temporal SSOT 올타임 제거 — resolver와 라우터 양성이 drift",
    file: CAREER_LEADERBOARD,
    from: '  "통산", "역대", "커리어", "누적", "올타임",',
    to: '  "통산", "역대", "커리어", "누적",',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m9b freshness 계약 오류 분리 제거 — GET catch가 static fallback 200으로 우회",
    file: STATS_ROUTE,
    from: '  if (error instanceof StatsFreshnessContractError) {',
    to: '  if (false && error instanceof StatsFreshnessContractError) {',
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "m10 출처 표기 제거 — 답변에서 공식 출처·기준 연도 소실",
    file: CAREER_LEADERBOARD,
    from: "\\n\ud83d\udcc4 출처: KBO 공식 기록실(${result.baselineThroughSeason}년 말 통산) + 크보팬 2026 시즌 기록",
    to: "",
    smoke: "scripts/qa/baseball-qa-leaderboard-smoke.ts",
  },
  {
    name: "s1 수상 페이지 신원 마커 검증 제거 — 에러 페이지로도 답한다",
    file: PRIZE,
    from: 'if (!html.includes(PAGE_MARKER) || !html.includes(HEADER_MARKER_ALLSTAR)) return null;',
    to: "",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s2 연도 범위 검증 제거 — 오염 연도 통과",
    file: PRIZE,
    from: "if (year < KBO_FIRST_YEAR || year > kstYear(now) + 1) return null;",
    to: "",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s3 미확정(`-`) 처리 제거 — 올해 질문에 과거 수상자 혼입",
    file: PRIZE,
    from: `if (ks.length === 3 && ks.every((v) => v === "-")) {
      rows.push({ year, koreanSeries: null });
      continue;
    }`,
    to: `if (ks.length === 3 && ks.every((v) => v === "-")) {
      continue;
    }`,
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s4 전제 정정 제거 — 틀린 우승팀 전제를 침묵 승인",
    file: PRIZE,
    from: `const premiseFix = mentionedTeam && mentionedTeam !== w.team
    ? \`\${year}년 한국시리즈 우승은 \${mentionedTeam}이(가) 아니라 \${w.team}이었습니다. \`
    : "";`,
    to: 'const premiseFix = "";',
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s5 미배선 hold 제거 — generic LLM 폴백 부활 (원래 사고 재현)",
    file: PIPELINE,
    from: `if (!deps.fetchSeriesPrizeHtml) {
        return settlePrize(resolveHoldAnswer(question), "history_hold");
      }`,
    to: `if (!deps.fetchSeriesPrizeHtml) {
        // mutated: fall through to generic LLM
      } else if (false) {
        return settlePrize(resolveHoldAnswer(question), "history_hold");
      }
      if (deps.fetchSeriesPrizeHtml) {`,
    extraClose: true,
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s6 의도 판정 제거 — 캡처 질문이 정본을 우회해 LLM 으로",
    file: PRIZE,
    from: 'if (KS_MVP_DIRECT.test(normalized)) return "ks_mvp";',
    to: "",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s7 타 대회 차단 제거 — 아시안게임·준우승·정규시즌까지 KS MVP 로 과포착 (삼순 P0 재현)",
    file: PRIZE,
    from: "if (OTHER_COMPETITION.test(normalized)) return null;",
    to: "",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s11 양성 결속 제거 — 무한정 우승(구단 없음)까지 KS MVP proxy 로 확대 (denylist 회귀)",
    file: PRIZE,
    from: "if (KS_WORD.test(normalized) || resolvePrizeTeamMention(question) !== null) {",
    to: "if (true) {",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s14 bare 연도 추출 제거 — 2024 한국시리즈 MVP가 최신으로 축소 (삼순 5차 재현)",
    file: PRIZE,
    from: "[...rest.matchAll(/(19[89]\\d|20\\d{2})/g)].map((m) => Number(m[1])),",
    to: "[...rest.matchAll(/(19[89]\\d|20\\d{2})(?:년|시즌)/g)].map((m) => Number(m[1])),",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s15 상대 시점어 전 집계 제거 — 지난시즌·내년 참조 소실로 단일값 축소 (삼순 5차 재현)",
    file: PRIZE,
    from: '["지난시즌", -1], ["지난해", -1], ["작년", -1], ["직전시즌", -1], ["전시즌", -1],',
    to: '["지난해", -1], ["작년", -1],',
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s16 미래 연도 미확정 분기 제거 — 내년이 기록 미보유 오안내로 (삼순 5차 재현)",
    file: PRIZE,
    from: "if (nowYear <= year) {",
    to: "if (false) {",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s12 복수·범위·역대 fail-close 제거 — 2024년과 2025년이 첫 값 단일답으로 축소 (삼순 4차 재현)",
    file: PIPELINE,
    from: 'if (prizeYear.kind === "ambiguous") {',
    to: "if (false) {",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s13 범위표지 검출 제거 — 역대/이후/최근N 이 최신 단일답으로 축소 (삼순 4차 재현)",
    file: PRIZE,
    from: 'return { kind: "ambiguous" };',
    to: 'return { kind: "latest" };',
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s8 미개최/미확정 분리 제거 — 1985 에 '시즌이 끝나면' 오안내 (삼순 P1 재현)",
    file: PRIZE,
    from: "if (year >= nowYear) {",
    to: "if (true) {",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s9 KST 보정 제거 — UTC 연도 회귀로 자정 경계에서 작년이 1년 어긋남 (삼순 P1 재현)",
    file: PRIZE,
    from: "return new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCFullYear();",
    to: "return now.getUTCFullYear();",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
  {
    name: "s10 붙여쓰기 팀 해석 제거 — 한화우승 전제 정정 소실 (삼순 P1 재현)",
    file: PIPELINE,
    from: "resolvePrizeTeamMention(question), kstYear(now),",
    to: "null, kstYear(now),",
    smoke: "scripts/qa/baseball-qa-series-prize-smoke.ts",
  },
];

let red = 0;
const misses = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.log(`MISS ${m.name} — 앵커 부재 (러너 고장)`);
    misses.push(m.name);
    continue;
  }
  let mutated = original.replace(m.from, m.to);
  if (m.extraClose) {
    // s5: 조건 블록을 닫기 위해 settlePrize 마지막 return 뒤에 닫는 중괄호 추가
    mutated = mutated.replace(
      'return settlePrize(rendered.answer, rendered.grounded ? "kbo_structured" : "history_hold");',
      'return settlePrize(rendered.answer, rendered.grounded ? "kbo_structured" : "history_hold");\n      }',
    );
  }
  writeFileSync(m.file, mutated);
  let out = "";
  let exitFail = false;
  try {
    out = execSync(`npx tsx ${m.smoke}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000 });
  } catch (error) {
    exitFail = true;
    out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  writeFileSync(m.file, original);
  // RED = smoke 가 **의도한 FAIL 마커**를 찍고 요약행까지 도달했다 (삼순 2026-08-10 B5:
  // 컴파일 오류·러너 고장 같은 아무 nonzero exit 를 검출로 세면 검증력이 0이다).
  const intended = /\nFAIL /.test(`\n${out}`) && out.includes("FAIL=") && exitFail;
  if (intended) {
    console.log(`RED  ${m.name}`);
    red++;
  } else if (exitFail) {
    console.log(`MISS ${m.name} — 프로세스는 죽었지만 의도한 FAIL 마커가 아니다 (러너/컴파일 고장)`);
    misses.push(m.name);
  } else {
    console.log(`MISS ${m.name} — 결함이 통과했다 (검출력 0)`);
    misses.push(m.name);
  }
}

console.log(misses.length === 0 ? `\n✅ mutations: ${red}/${MUTATIONS.length} RED` : `\n❌ ${misses.length} 축 미검출`);
if (misses.length > 0) process.exitCode = 1;
