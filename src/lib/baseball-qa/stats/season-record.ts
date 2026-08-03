/**
 * 야잘알봇 시즌 기록 질의 (kbo_structured).
 *
 * `문보경 올해 2루타 몇 개?` 처럼 **수치**를 묻는 질문은 나무위키(tier2)로 답하면 안 된다
 * (§12 수치 계약: 위키 숫자는 정본이 아니다). 대신 운영 DB의 구조화 기록
 * `player_stats_batter` / `player_stats_pitcher` 최신 row 를 kboId 로 직접 조회해
 * **원값 그대로** 답한다. 계산하지 않고, 추정하지 않고, 없으면 답하지 않는다.
 *
 * 하린아빠 2026-08-03: "그런대 기록도 레퍼런스하는거야? 가령 문보경 올해 2루타 몇개 쳤어?"
 */

/** 지원 시즌. 운영 DB 의 stats 테이블은 **현재 시즌 단일 스냅샷**이라 과거 시즌 row 가 없다. */
export const SUPPORTED_SEASON = 2026;

/**
 * 답변 가능한 타자 지표.
 *
 * ⚠️ `pa`(타석)·`sac`(희생번트)·`sf`(희생플라이) 는 **의도적으로 제외**한다.
 * Naver 폴백 경로가 이 세 필드를 제공하지 않아 upsert 페이로드에서 빠지고(기존값 보존 목적),
 * 그 결과 KBO 수집이 끊긴 구간 동안 값이 과거에 얼어붙는다. Production 실측(2026-08-03)에서
 * 330행 중 233행이 `pa < ab` — 야구 규칙상 불가능한 값이다. 틀린 숫자를 답하느니 안 답한다.
 * (데이터 정합 자체는 별도 P0 트랙.)
 */
export const BATTER_METRICS = {
  avg: { label: "타율", aliases: ["타율", "타률", "애버리지"], kind: "rate" },
  games: { label: "경기", aliases: ["경기", "출장", "경기수"], kind: "count" },
  ab: { label: "타수", aliases: ["타수"], kind: "count" },
  runs: { label: "득점", aliases: ["득점"], kind: "count" },
  hits: { label: "안타", aliases: ["안타"], kind: "count" },
  doubles: { label: "2루타", aliases: ["2루타", "이루타", "２루타", "2베이스", "투베이스"], kind: "count" },
  triples: { label: "3루타", aliases: ["3루타", "삼루타", "３루타", "3베이스", "쓰리베이스"], kind: "count" },
  hr: { label: "홈런", aliases: ["홈런", "홈란", "아치"], kind: "count" },
  tb: { label: "루타", aliases: ["루타", "총루타"], kind: "count" },
  rbi: { label: "타점", aliases: ["타점"], kind: "count" },
} as const;

/** 답변 가능한 투수 지표. Naver 폴백이 매 갱신마다 직접 주는 필드만. */
export const PITCHER_METRICS = {
  era: { label: "평균자책점", aliases: ["평균자책", "평균자책점", "방어율", "era"], kind: "rate" },
  games: { label: "경기", aliases: ["경기", "출장", "등판", "경기수"], kind: "count" },
  wins: { label: "승", aliases: ["승", "승수", "몇승"], kind: "count" },
  losses: { label: "패", aliases: ["패", "패수", "몇패"], kind: "count" },
  saves: { label: "세이브", aliases: ["세이브"], kind: "count" },
  holds: { label: "홀드", aliases: ["홀드"], kind: "count" },
  wpct: { label: "승률", aliases: ["승률"], kind: "rate" },
  ip: { label: "이닝", aliases: ["이닝", "투구이닝"], kind: "raw" },
  h: { label: "피안타", aliases: ["피안타"], kind: "count" },
  hr: { label: "피홈런", aliases: ["피홈런"], kind: "count" },
  bb: { label: "볼넷", aliases: ["볼넷", "사사구", "포볼"], kind: "count" },
  hbp: { label: "사구", aliases: ["사구", "몸에맞는공", "몸에맞는볼"], kind: "count" },
  so: { label: "탈삼진", aliases: ["삼진", "탈삼진", "케이"], kind: "count" },
  r: { label: "실점", aliases: ["실점"], kind: "count" },
  er: { label: "자책점", aliases: ["자책", "자책점"], kind: "count" },
  whip: { label: "WHIP", aliases: ["whip"], kind: "rate" },
} as const;

export type BatterMetricKey = keyof typeof BATTER_METRICS;
export type PitcherMetricKey = keyof typeof PITCHER_METRICS;

/**
 * 제외 지표 — 질문에 이게 나오면 **답변하지 않는다**.
 *
 * 단순 미지원이 아니라 "값은 있는데 믿을 수 없다"는 뜻이다. 조용히 빈손으로 두면
 * 나중에 누가 allowlist 에 넣어버릴 수 있어 명시 집합으로 남긴다.
 */
export const UNTRUSTED_METRIC_ALIASES = [
  "타석", "희생번트", "희생타", "희생플라이", "번트타", "사사구", "pa", "sac", "sf",
] as const;

/** 시즌 표현. 올해만 답한다 — 과거 시즌 row 가 DB 에 없기 때문이다. */
const CURRENT_SEASON_WORDS = ["올해", "올시즌", "이번시즌", "금년", "올해의", String(SUPPORTED_SEASON)];
const UNSUPPORTED_SEASON_WORDS = [
  "작년", "지난해", "지난시즌", "지난 시즌", "전시즌", "전 시즌", "이전시즌", "이전 시즌", "지지난해", "재작년",
  "통산", "커리어", "역대", "생애", "누적",
];

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function normalizeWithSpaces(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 모든 명시 연도 중 2026 외 값은 미지원. 하드코딩 연도 목록은 2019/2027을 놓친다. */
function hasUnsupportedSeason(value: string): boolean {
  const normalized = normalizeWithSpaces(value);
  if (UNSUPPORTED_SEASON_WORDS.some((word) => normalized.includes(normalizeWithSpaces(word)))) return true;
  return [...normalized.matchAll(/(?:19|20)\d{2}(?:\s*년|\s*시즌)?/g)]
    .some((match) => Number(match[0].match(/\d{4}/)?.[0]) !== SUPPORTED_SEASON);
}

/** 수치를 묻는 문장인가. 이게 false 면 기록 경로가 아니다(서술형 RAG 로 간다). */
const NUMERIC_QUESTION = /몇|얼마|개야|개나|개\?|기록|스탯|성적|알려|보여|어때|어떻게\s*돼|쳤|던졌|했/;

export interface SeasonRecordQuery {
  /** 'batter' | 'pitcher' — 어느 테이블을 볼지. */
  table: "batter" | "pitcher";
  metric: string;
  label: string;
  kind: "count" | "rate" | "raw";
}

export type SeasonRecordIntent =
  | { kind: "none" }
  /** 신뢰할 수 없는 지표(pa/sac/sf) — 명시적으로 답변 거절. */
  | { kind: "untrusted_metric" }
  /** 지원하지 않는 시즌(작년·통산) — fail-close. */
  | { kind: "unsupported_season" }
  | { kind: "query"; query: SeasonRecordQuery };

/**
 * 질문에서 "올해 시즌 기록" 의도를 뽑는다.
 *
 * 판정 순서가 곧 안전 계약이다.
 *   ① 신뢰 못 하는 지표 → 즉시 거절 (allowlist 확인보다 먼저 — 통과 경로를 아예 안 만든다)
 *   ② 과거 시즌 → 거절 (DB 에 그 시즌 row 가 없다)
 *   ③ allowlist 지표 매칭
 *   ④ 수치 질문 형태인지 확인
 */
export function resolveSeasonRecordIntent(
  question: string,
  preferredTable?: "batter" | "pitcher",
): SeasonRecordIntent {
  const compact = normalize(question);

  if (UNTRUSTED_METRIC_ALIASES.some((alias) => compact.includes(normalize(alias)))) {
    return { kind: "untrusted_metric" };
  }
  if (!NUMERIC_QUESTION.test(compact)) return { kind: "none" };

  // substring 매칭은 1글자 `패`를 `패스트볼`에서 잡고, `승`을 `승부`에서 잡는다.
  // 지표별 경계 regex를 명시해 합성어를 기록 질문으로 오답 변환하지 않는다.
  const patterns: Array<{
    table: "batter" | "pitcher";
    metric: string;
    pattern: RegExp;
  }> = [
    // 투수 전용(타자 공통명보다 먼저)
    { table: "pitcher", metric: "era", pattern: /평균\s*자책(?:점)?|방어율|\bera\b/i },
    { table: "pitcher", metric: "hr", pattern: /피\s*홈런/ },
    { table: "pitcher", metric: "h", pattern: /피\s*안타/ },
    { table: "pitcher", metric: "saves", pattern: /세이브/ },
    { table: "pitcher", metric: "holds", pattern: /홀드/ },
    { table: "pitcher", metric: "wpct", pattern: /승률/ },
    { table: "pitcher", metric: "ip", pattern: /투구\s*이닝|이닝/ },
    { table: "pitcher", metric: "bb", pattern: /볼넷|포볼/ },
    { table: "pitcher", metric: "hbp", pattern: /몸에\s*맞는\s*(?:공|볼)|사구(?!체)/ },
    { table: "pitcher", metric: "so", pattern: /탈\s*삼진|삼진/ },
    { table: "pitcher", metric: "er", pattern: /자책(?:점)?/ },
    { table: "pitcher", metric: "r", pattern: /실점/ },
    { table: "pitcher", metric: "whip", pattern: /\bwhip\b/i },
    { table: "pitcher", metric: "games", pattern: /등판(?:\s*(?:경기|수))?/ },
    // `몇승/몇 승/승수/10승`은 허용하되 승부·승률은 제외.
    { table: "pitcher", metric: "wins", pattern: /(?:몇\s*승(?:수)?|\d+\s*승(?:수)?|승수|승\s*(?:몇|개))(?!부|률|리)/ },
    { table: "pitcher", metric: "losses", pattern: /(?:몇\s*패(?:수)?|\d+\s*패(?:수)?|패수|패\s*(?:몇|개))(?!스트|배|션)/ },

    // 타자
    { table: "batter", metric: "avg", pattern: /(?<!장)타율|타률|애버리지/ },
    { table: "batter", metric: "doubles", pattern: /(?:2|이)\s*루타|투\s*베이스/ },
    { table: "batter", metric: "triples", pattern: /(?:3|삼)\s*루타|쓰리\s*베이스/ },
    { table: "batter", metric: "hr", pattern: /홈런|홈란|아치/ },
    { table: "batter", metric: "tb", pattern: /총\s*루타|루타/ },
    { table: "batter", metric: "rbi", pattern: /타점/ },
    { table: "batter", metric: "ab", pattern: /타수/ },
    { table: "batter", metric: "runs", pattern: /득점/ },
    { table: "batter", metric: "hits", pattern: /안타/ },
    { table: "batter", metric: "games", pattern: /출장(?:\s*(?:경기|수))?|경기\s*수/ },
  ];

  const normalized = normalizeWithSpaces(question);
  let best = patterns.find((entry) => entry.pattern.test(normalized));
  if (!best) return { kind: "none" };
  // `경기 수`는 타자/투수 공통어다. 이름으로 확정된 로스터 포지션이 투수면 pitcher로 결속한다.
  if (best.metric === "games" && preferredTable) best = { ...best, table: preferredTable };
  // 과거 시즌 차단은 지원 metric 수치 질문에만 적용한다. `작년에 별명이 뭐였어?` 같은
  // 선수 서술형은 기존 RAG로 내려보내야 한다.
  if (hasUnsupportedSeason(question)) return { kind: "unsupported_season" };
  const metrics = best.table === "pitcher" ? PITCHER_METRICS : BATTER_METRICS;
  const def = metrics[best.metric as keyof typeof metrics] as {
    label: string;
    kind: SeasonRecordQuery["kind"];
  };
  return {
    kind: "query",
    query: {
      table: best.table,
      metric: best.metric,
      label: def.label,
      kind: def.kind,
    },
  };
}

/** 명시적으로 올해를 지목했는가. 시즌 표현이 아예 없으면 현재 시즌으로 본다. */
export function mentionsCurrentSeason(question: string): boolean {
  return !hasUnsupportedSeason(question);
}

export { CURRENT_SEASON_WORDS };

/** DB row (snake_case 그대로). 값 변환은 하지 않는다. */
export interface SeasonRecordRow {
  player_key: string;
  kbo_id: string;
  name: string;
  team: string | null;
  updated_at: string;
  [metric: string]: unknown;
}

/**
 * stats cron 1주기.
 *
 * Vercel cron 실측: `/api/cron/stats` 는 `0 21 * * *` (매일 21:00 UTC) 1회다.
 * 한 주기를 넘겨도 갱신이 없으면 그 값은 "오늘 경기 결과가 빠진 값"일 수 있으므로 답하지 않는다.
 * 삼순 확정 계약대로 경계는 24시간이다 — 25시간 row를 허용했던 30h 구현은 회귀다.
 */
export const STATS_STALE_MS = 24 * 60 * 60 * 1000;

export type SeasonRecordOutcome =
  | { kind: "ok"; value: string; label: string; asOf: string; name: string; team: string | null }
  /** row 없음 / 값 없음 — 수집 안 된 선수. */
  | { kind: "missing" }
  /** 기준시각이 너무 오래됨 — 틀린 값을 최신인 척 답하지 않는다. */
  | { kind: "stale"; asOf: string }
  /** identity 불일치·행 중복 등 신뢰 붕괴. */
  | { kind: "inconsistent" };

/**
 * 조회 결과를 답변 가능한 형태로 확정한다.
 *
 * @param rows kboId exact 조회 결과 (이름 조회 금지 — 동명이인이 섞인다)
 * @param expectedKboId 서버가 특정한 kboId. row 가 이걸 벗어나면 타 선수 오염이다.
 * @param now 판정 기준 시각 (테스트 주입)
 */
export function resolveSeasonRecord(
  rows: SeasonRecordRow[],
  query: SeasonRecordQuery,
  expectedKboId: string,
  now: number,
  expectedName?: string,
  expectedTeam?: string | null,
): SeasonRecordOutcome {
  // row 0 = 미수집, 2+ = 같은 kboId 가 여러 행 → 어느 게 맞는지 모른다. 둘 다 답하지 않는다.
  if (rows.length !== 1) return rows.length === 0 ? { kind: "missing" } : { kind: "inconsistent" };
  const row = rows[0];
  // 서버가 특정한 선수의 행이 맞는지 두 축으로 재확인한다.
  // player_key 는 upsert 충돌키(정본), kbo_id 는 소비자 식별키다. 둘 중 하나라도 다르면
  // 조회 조건이 제거/변경됐거나 오염행이다 — 이름이 같아도 답하지 않는다.
  if (row.player_key !== expectedKboId || row.kbo_id !== expectedKboId) {
    return { kind: "inconsistent" };
  }
  if (expectedName !== undefined &&
      (row.name !== expectedName || (row.team ?? null) !== (expectedTeam ?? null))) {
    return { kind: "inconsistent" };
  }

  const updatedAt = Date.parse(row.updated_at);
  if (!Number.isFinite(updatedAt)) return { kind: "inconsistent" };
  // 미래 시각도 잘못된 데이터다. `now - future`가 음수라 stale 검사만으로는 통과한다.
  if (updatedAt > now) return { kind: "inconsistent" };
  if (now - updatedAt > STATS_STALE_MS) return { kind: "stale", asOf: row.updated_at };

  const raw = row[query.metric];
  if (raw === null || raw === undefined || raw === "") return { kind: "missing" };

  // **원값 그대로** 낸다. 재계산하지 않는다 — 타율을 hits/ab 로 다시 구하면 DB 표기와 어긋난다.
  let value: string;
  if (query.kind === "count") {
    // 경기수·안타·2루타 같은 누적 count 는 **0 이상 정수**다. 1.5는 오염값이다.
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      return { kind: "inconsistent" };
    }
    value = String(raw);
  } else if (query.kind === "rate") {
    if (typeof raw !== "string" && typeof raw !== "number") return { kind: "inconsistent" };
    value = String(raw).trim();
    // 타율 `.238`, ERA `3.42`, WHIP `1.23`만. `N/A`·Infinity·음수는 금지.
    if (!/^(?:\d+(?:\.\d{1,3})?|\.\d{1,3})$/.test(value) || Number(value) < 0) {
      return { kind: "inconsistent" };
    }
    // 타율·승률은 확률값이라 [0,1]. ERA/WHIP은 1을 넘을 수 있으므로 공통 상한 금지.
    if ((query.metric === "avg" || query.metric === "wpct") && Number(value) > 1) {
      return { kind: "inconsistent" };
    }
  } else {
    if (typeof raw !== "string") return { kind: "inconsistent" };
    value = raw.trim();
    // 이닝은 cron mapper가 보장하는 KBO 표기(예: `120`, `120 1/3`, `120 2/3`)만.
    if (!/^\d+(?: [12]\/3)?$/.test(value)) return { kind: "inconsistent" };
  }

  return {
    kind: "ok",
    value,
    label: query.label,
    asOf: row.updated_at,
    name: row.name,
    team: (row.team as string | null) ?? null,
  };
}

/** 기준시각을 KST 날짜로 표기. 유저가 "언제 기준 값인지" 알아야 숫자를 믿을 수 있다. */
export function formatAsOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

export function composeSeasonRecordAnswer(outcome: Extract<SeasonRecordOutcome, { kind: "ok" }>): string {
  const asOf = formatAsOf(outcome.asOf);
  const who = outcome.team ? `${outcome.name}(${outcome.team})` : outcome.name;
  const suffix = asOf ? `\n\n📊 ${SUPPORTED_SEASON} 시즌 · ${asOf} 기준` : "";
  return `${who} 선수의 ${SUPPORTED_SEASON} 시즌 ${outcome.label}은 ${outcome.value}입니다.${suffix}`;
}

export const UNTRUSTED_METRIC_ANSWER =
  "그 기록은 아직 정확하게 알려드릴 수 없어요. 타율·안타·2루타·홈런·타점 같은 기록은 물어봐 주세요!";
export const UNSUPPORTED_SEASON_ANSWER =
  `${SUPPORTED_SEASON} 시즌 기록만 알려드릴 수 있어요. 지난 시즌이나 통산 기록은 아직 준비 중이에요.`;
export const RECORD_MISSING_ANSWER =
  "그 선수의 올 시즌 기록을 아직 못 찾았어요. 조금 뒤에 다시 물어봐 주세요!";
