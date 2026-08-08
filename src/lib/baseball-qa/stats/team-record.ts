/**
 * 구단 기록 질의 (kbo_structured — 팀 축).
 *
 * ⚠️ 이 파일이 왜 생겼는가 (하린아빠 2026-08-04 20:42 "도루 OPS가 왜 없어? / 우리가 다
 * 제공하고 있는 데이터인데" → 01:0x "이 답변도 안 내기로 했잖아", 삼순 #1100 5차 NO-GO).
 *
 * 종전 파이프라인은 `LG 지금 몇 위야?`·`LG 팀타율`을 **고정 안내문**으로 닫았다.
 * 근거는 "팀 단위 집계 정본이 없다" 였는데 **틀렸다**. Production 실측(2026-08-05 01:2x):
 *
 *   GET /api/standings     → LG ranking 3 · 55승 45패 1무 · 승률 .550 · 6.5게임차
 *   GET /api/team-records  → LG avg .270 · ops .759 · hr 92 · runs 511 · sb 65
 *                            LG era/whip/so/sv (pitching)
 *
 * 앱 화면(순위 탭·팀 기록 탭)이 이미 이 값을 그대로 보여주고 있다. 우리가 서빙하는 값을
 * 봇만 "못 답한다"고 하는 건 유저 입장에서 거짓말이다.
 *
 * 그래서 **선수 기록과 같은 계약**으로 답한다 — 조회한 원값 그대로, 계산·추정 없음,
 * 없으면 답하지 않음, LLM 미경유.
 */

/** 공개 도메인 self-fetch — `VERCEL_URL` 은 배포 보호에 막힌다(served-record 와 동일 패턴). */
const PUBLIC_BASE = process.env.NEXT_PUBLIC_APP_URL || "https://keubo.fan";
const TEAM_FETCH_TIMEOUT_MS = 3_000;

/** 순위표 1행 — `/api/standings` 응답 그대로. */
export interface StandingsRow {
  teamName: string;
  teamId: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  gamesBehind: number;
  ranking: number;
  continuousGameResult?: string;
}

/** 팀 기록 1행 — `/api/team-records` batting/pitching. */
export interface TeamRecordRow {
  teamId: number;
  slug: string;
  [metric: string]: unknown;
}

export interface TeamRecordsPayload {
  season?: number;
  batting?: TeamRecordRow[];
  pitching?: TeamRecordRow[];
}

/**
 * 답변 가능한 팀 지표.
 *
 * `source` 는 어느 엔드포인트에서 읽는지다. 여기 없는 지표는 **답하지 않는다** —
 * 특히 우승 횟수·상대전적처럼 우리가 서빙하지 않는 값은 LLM 이 지어내므로 뺀다.
 */
export const TEAM_METRICS = {
  ranking: { label: "순위", source: "standings", kind: "rank" },
  wins: { label: "승", source: "standings", kind: "count" },
  losses: { label: "패", source: "standings", kind: "count" },
  draws: { label: "무승부", source: "standings", kind: "count" },
  winRate: { label: "승률", source: "standings", kind: "rate" },
  games: { label: "경기", source: "standings", kind: "count" },
  gamesBehind: { label: "게임차", source: "standings", kind: "rate" },
  record: { label: "전적", source: "standings", kind: "record" },
  avg: { label: "팀 타율", source: "batting", kind: "rate" },
  ops: { label: "팀 OPS", source: "batting", kind: "rate" },
  hr: { label: "팀 홈런", source: "batting", kind: "count" },
  runs: { label: "팀 득점", source: "batting", kind: "count" },
  sb: { label: "팀 도루", source: "batting", kind: "count" },
  hits: { label: "팀 안타", source: "batting", kind: "count" },
  era: { label: "팀 평균자책점", source: "pitching", kind: "rate" },
  whip: { label: "팀 WHIP", source: "pitching", kind: "rate" },
  so: { label: "팀 탈삼진", source: "pitching", kind: "count" },
  sv: { label: "팀 세이브", source: "pitching", kind: "count" },
} as const;

export type TeamMetricKey = keyof typeof TEAM_METRICS;

/**
 * 질문에서 팀 지표를 뽑는다.
 *
 * ⚠️ 순서가 계약이다 — `승률`을 `승`보다, `도루`를 단독어보다 먼저 본다.
 * 선수 쪽 `resolveSeasonRecordIntent` 와 같은 이유(합성어 오탐)로 경계 regex 를 쓴다.
 */
const TEAM_PATTERNS: ReadonlyArray<{ metric: TeamMetricKey; pattern: RegExp }> = [
  { metric: "record", pattern: /전적|승패(?!전)/ },
  { metric: "winRate", pattern: /승률/ },
  { metric: "ranking", pattern: /순위|몇\s*위|등수|랭킹/ },
  { metric: "gamesBehind", pattern: /게임\s*차|승차/ },
  { metric: "draws", pattern: /무승부|무\s*(?:몇|개)/ },
  // ⚠️ `(?<!우)` — `우승 몇 번 했어?` 가 **팀 승수**로 답해지던 회귀를 막는다.
  // 구단 우승 이력은 서사 축(LLM·RAG 담당)이지 순위표의 시즌 승수가 아니다.
  // `승리 수`·`패배 몇 번` 같은 자연어 변형까지 여기서 잡는다.
  // 라우팅(`TEAM_CONCRETE_STAT_WORDS`)만 잡고 조회가 못 잡으면 안내문으로 새어나간다 —
  // 게이트가 실제로 그 두 문장을 잡았다.
  { metric: "wins", pattern: /(?:몇\s*승(?:수)?|\d+\s*승(?:수)?|(?<!우)승수|(?<!우)승리(?:\s*수)?|(?<!우)승\s*(?:몇|개))(?!부|률|리)/ },
  { metric: "losses", pattern: /(?:몇\s*패(?:수)?|\d+\s*패(?:수)?|패수|패배(?:\s*수)?|패\s*(?:몇|개))(?!스트|션)/ },
  { metric: "era", pattern: /평균\s*자책(?:점)?|방어율|\bera\b/i },
  { metric: "whip", pattern: /\bwhip\b/i },
  { metric: "so", pattern: /탈\s*삼진|삼진/ },
  { metric: "sv", pattern: /세이브/ },
  { metric: "avg", pattern: /(?<!장)타율|타률/ },
  { metric: "ops", pattern: /\bops\b|오피에스/i },
  { metric: "hr", pattern: /홈런|홈란/ },
  { metric: "runs", pattern: /득점/ },
  { metric: "sb", pattern: /도루/ },
  { metric: "hits", pattern: /안타/ },
  { metric: "games", pattern: /경기\s*수|몇\s*경기/ },
];

/**
 * **우리가 서빙하지 않는** 팀 수치. 물으면 안내로 닫는다 — LLM 으로 보내면 지어낸다.
 *
 * 삼순 실측: `우승 몇 번?` → generic LLM 이 근거 없는 횟수를 답했다.
 * 순위·팀기록과 달리 우승 이력·상대전적은 앱이 서빙하는 값이 아니다.
 */
/** 미서빙 지표에서 "값"을 요구하는 표현. 이게 없으면 서사 질문으로 본다. */
const UNSERVED_VALUE_ASK = /몇|얼마|횟수|개수|알려|보여|어떻게\s*돼|현황|기록\s*(?:은|는|이|가)?\s*\?*$/;

const TEAM_UNSERVED_PATTERNS: ReadonlyArray<RegExp> = [
  // 우승 서사는 범위 안이지만 **횟수 질문**은 앱 정본이 없으므로 LLM으로 보내지 않는다.
  /우승/,
  /상대\s*전적|상대전|맞대전\s*전적/,
  /관중\s*수|연봉|연봉액|몸값|순자산|연종/,
];

/**
 * **경기별 스코어** — 값 요구어 없이도 무조건 미서빙으로 닫는다.
 *
 * 순위표·팀기록은 **시즌 집계**라 "어제 몇 대 몇" 을 답할 정본이 없다.
 *
 * ⚠️ 왜 `TEAM_UNSERVED_PATTERNS`(값 요구어 동반 조건) 와 분리했는가 — 2026-08-08 실측.
 *   거기 넣었더니 `어제 LG 스코어`·`어제 LG 점수는?`·`어제 LG 승부 결과` 처럼
 *   `몇`·`알려` 가 없는 문장이 `UNSERVED_VALUE_ASK` 를 못 넘어 그대로 새었고,
 *   구단 문서 RAG 가 받아 **"서울 연고 구단이에요" 를 출처까지 달고** 내보냈다.
 *   동문서답이 근거를 입은 형태라 그냥 못 답하는 것보다 나쁘다.
 *
 *   이 명사들은 **물은 순간 답이 숫자로 확정**된다 — 값 요구어가 없어도 마찬가지다.
 *   그래서 조건을 걸지 않는다.
 *
 * ⚠️ 수치 가드를 경로별로 복사하지 않고 **이 SSOT 한 곳**에서 닫는다 —
 *   `isTeamNumericQuestion` → `isTeamRagServableQuestion` 이 이 함수를 쓰므로
 *   라우팅·구단 RAG·기사 RAG 가 한 번에 같은 판정을 받는다. 경로별 복사는 한쪽만
 *   고쳤을 때 조용히 갈라진다(#1100 에서 이미 겪은 실패 모드).
 */
const TEAM_SCORE_PATTERN = /몇\s*대\s*몇|스코어|점수|경기\s*결과|승부\s*결과/;

/**
 * 경기별 스코어를 물었는가 — **서술 표현이 붙어도 사실이 변하지 않는** 판정.
 *
 * ⚠️ 왜 별도로 내보내는가 (2026-08-08 삼순 2차 NO-GO 실측).
 *   `isTeamNumericQuestion` 은 `TEAM_DESCRIPTIVE_ASK`(`이야기`·`소개`·`유명`…)를 **먼저** 보고
 *   `false` 로 빠져나간다. 그래서 `resolveTeamRecordIntent` 가 `unserved` 로 판정해도
 *   그 호출에 도달하지 못해 우회된다:
 *     `어제 LG 스코어 이야기해줘`      → news 경로
 *     `어제 LG 몇 대 몇인지 이야기해줘` → team_rag
 *
 *   서술 표현은 **어조**일 뿐 물은 대상을 바꾸지 않는다 — "스코어 이야기해줘" 는
 *   결국 "몇 대 몇이었는지 말해달라" 다. 답이 숫자로 확정되는 건 동일하므로
 *   서술 예외보다 **앞서** 닫혀야 한다.
 */
/**
 * 스코어 **단어가 문맥으로만 쓰인** 질문 — 물은 대상이 스코어가 아니다.
 *
 * ⚠️ 왜 필요한가 (2026-08-08 삼순 3차 NO-GO 실측).
 *   `점수`·`경기 결과` 를 문맥 없이 substring 매칭했더니 반대편 과차단이 났다:
 *     `어제 LG가 점수를 못 낸 이유가 뭐야?`      → history_hold (news 여야 함)
 *     `어제 LG 경기 결과를 바꾼 결정적 장면은?`  → history_hold (news 여야 함)
 *     `LG 경기에서 점수가 같으면 연장전 규칙은?` → history_hold (공식 룰이어야 함)
 *   셋 다 `official 0 · news 0` 으로 근거 경로를 아예 안 탔다.
 *
 *   단어의 **존재**가 아니라 **질문의 대상**으로 갈라야 한다:
 *     `점수 알려줘`        → 물은 것이 점수      → 답이 숫자   → 닫는다
 *     `점수를 못 낸 이유`  → 물은 것이 이유      → 서술 가능   → 기사
 *     `점수가 같으면 규칙` → 물은 것이 규칙      → 조문 정본   → 공식 문서
 *
 *   ⚠️ 요청 동사(`알려줘`·`이야기해줘`·`소개해줘`)는 여기 넣지 않는다 — 그건 어조일 뿐
 *   물은 대상을 바꾸지 않는다(2차 NO-GO 에서 확인한 축). 진짜 의문 대상만 열거한다.
 */
const SCORE_CONTEXT_HEADS =
  /이유|원인|왜|어째서|배경|장면|과정|흐름|의미|영향|비결|비하인드|분위기|평가|규칙|룰|규정|규약|어떻게\s*되나|어떻게\s*하나/;

export function isTeamScoreQuestion(question: string): boolean {
  const normalized = question.normalize("NFKC").toLowerCase();
  // `몇 대 몇` 은 표현 자체가 스코어를 묻는다 — 문맥 예외를 두지 않는다.
  if (/몇\s*대\s*몇/.test(normalized)) return true;
  if (!TEAM_SCORE_PATTERN.test(normalized)) return false;
  // 스코어 단어가 있어도 **다른 의문 대상**이 함께 있으면 그쪽이 질문의 머리다.
  return !SCORE_CONTEXT_HEADS.test(normalized);
}

export type TeamRecordIntent =
  | { kind: "none" }
  /** 지표는 맞는데 앱이 그 값을 서빙하지 않는다 — 안내로 닫는다. */
  | { kind: "unserved" }
  | { kind: "query"; metric: TeamMetricKey; label: string };

export function resolveTeamRecordIntent(question: string): TeamRecordIntent {
  const normalized = question.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  // 미서빙 지표를 **먼저** 본다. `우승 몇 번?` 은 `몇 경기` 패턴과 닮아 순서가 밀리면
  // 엉뚱한 값을 답하게 된다.
  //
  // ⚠️ 단 **수치를 요구할 때만** 여기서 닫는다. `LG트윈스 우승` 처럼 값 요구가 없는
  // 문장은 구단 서사 질문이라 LLM 이 답해야 한다 — 여기서 닫으면 구단 과차단 회귀다
  // (게이트가 10개 구단 전부에서 실제로 잡았다).
  if (
    UNSERVED_VALUE_ASK.test(normalized) &&
    TEAM_UNSERVED_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return { kind: "unserved" };
  }

  // 경기별 스코어는 값 요구어 없이도 닫는다(위 상수 주석 참조).
  //
  // ⚠️ raw 패턴이 아니라 **문맥 판정을 거친 `isTeamScoreQuestion()`** 을 쓴다.
  //   raw 패턴을 직접 쓰면 `점수를 못 낸 이유`·`점수가 같으면 연장전 규칙` 까지 닫혀
  //   기사·공식 문서 경로가 죽는다(2026-08-08 삼순 3차 NO-GO 실측).
  //   판정기는 한 곳이어야 한다 — 두 군데서 각자 판단하면 반드시 갈라진다.
  if (isTeamScoreQuestion(normalized)) return { kind: "unserved" };

  const hit = TEAM_PATTERNS.find((entry) => entry.pattern.test(normalized));
  if (!hit) return { kind: "none" };
  return { kind: "query", metric: hit.metric, label: TEAM_METRICS[hit.metric].label };
}

async function getJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEAM_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${PUBLIC_BASE}${path}`, { cache: "no-store", signal: controller.signal });
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface TeamRecordFetchers {
  fetchStandings: () => Promise<StandingsRow[]>;
  fetchTeamRecords: () => Promise<TeamRecordsPayload>;
}

/**
 * production 주입값을 만드는 seam.
 *
 * 서버가 인라인 lambda 로 넣으면 게이트가 "호출문 존재"만 보는 정규식으로 전락한다
 * (`createServedRecordFetcher` 와 같은 이유 — 삼순 3차 P0-3).
 */
export function createTeamRecordFetchers(): TeamRecordFetchers {
  return {
    fetchStandings: async () => {
      const payload = await getJson<{ standings?: StandingsRow[] }>("/api/standings");
      if (!Array.isArray(payload.standings)) throw new Error("standings payload has no standings array");
      return payload.standings;
    },
    fetchTeamRecords: () => getJson<TeamRecordsPayload>("/api/team-records"),
  };
}

export type TeamRecordOutcome =
  | { kind: "ok"; team: string; label: string; value: string }
  /** 조회는 됐는데 그 팀 행이 없다 — 추정하지 않는다. */
  | { kind: "missing" };

function formatRate(value: unknown, digits: number): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return num.toFixed(digits);
}

/**
 * 팀 지표 1건을 **원값 그대로** 문자열로 만든다.
 *
 * ⚠️ 계산하지 않는다. 승률을 wins/games 로 다시 구하거나 게임차를 유도하지 않는다 —
 * 앱이 보여주는 값과 1비트라도 달라지면 이 기능의 유일한 계약이 깨진다.
 */
export function resolveTeamRecord(
  metric: TeamMetricKey,
  canonicalTeam: string,
  standings: StandingsRow[],
  records: TeamRecordsPayload,
  teamIdOf: (canonical: string) => number | null,
): TeamRecordOutcome {
  const teamId = teamIdOf(canonicalTeam);
  if (teamId === null) return { kind: "missing" };
  const def = TEAM_METRICS[metric];
  const label = def.label;

  if (def.source === "standings") {
    const row = standings.find((entry) => entry.teamId === teamId);
    if (!row) return { kind: "missing" };
    if (metric === "record") {
      const draws = Number(row.draws) || 0;
      const value = draws > 0
        ? `${row.wins}승 ${row.losses}패 ${draws}무`
        : `${row.wins}승 ${row.losses}패`;
      return { kind: "ok", team: canonicalTeam, label, value };
    }
    if (metric === "ranking") {
      if (!Number.isFinite(Number(row.ranking))) return { kind: "missing" };
      return { kind: "ok", team: canonicalTeam, label, value: `${row.ranking}위` };
    }
    if (metric === "winRate") {
      const rate = formatRate(row.winRate, 3);
      return rate ? { kind: "ok", team: canonicalTeam, label, value: rate } : { kind: "missing" };
    }
    if (metric === "gamesBehind") {
      const gb = Number(row.gamesBehind);
      if (!Number.isFinite(gb)) return { kind: "missing" };
      return { kind: "ok", team: canonicalTeam, label, value: gb === 0 ? "0.0 (선두)" : `${gb.toFixed(1)}` };
    }
    const raw = (row as unknown as Record<string, unknown>)[metric];
    if (!Number.isFinite(Number(raw))) return { kind: "missing" };
    return { kind: "ok", team: canonicalTeam, label, value: String(raw) };
  }

  const rows = def.source === "batting" ? records.batting : records.pitching;
  if (!Array.isArray(rows)) return { kind: "missing" };
  const row = rows.find((entry) => Number(entry.teamId) === teamId);
  if (!row) return { kind: "missing" };
  const raw = row[metric];
  if (raw === undefined || raw === null || raw === "") return { kind: "missing" };
  if (def.kind === "rate") {
    // 이미 문자열 표기(".270")로 오면 그대로 쓴다 — 재포맷은 앱 표기와 어긋날 수 있다.
    return { kind: "ok", team: canonicalTeam, label, value: String(raw) };
  }
  if (!Number.isFinite(Number(raw))) return { kind: "missing" };
  return { kind: "ok", team: canonicalTeam, label, value: String(raw) };
}

/** 받침 유무로 은/는 · 이/가 를 가른다. `순위은`·`홈런이에요` 같은 문장이 그대로 유저에게 간다. */
function hasFinalConsonant(word: string): boolean {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

export function composeTeamRecordAnswer(outcome: Extract<TeamRecordOutcome, { kind: "ok" }>): string {
  const topicParticle = hasFinalConsonant(outcome.label) ? "은" : "는";
  const copula = hasFinalConsonant(outcome.value) ? "이에요" : "예요";
  return `${outcome.team} ${outcome.label}${topicParticle} ${outcome.value}${copula}! ⚾`;
}
