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
  "타석", "희생번트", "희생타", "희생플라이", "번트타", "pa", "sac", "sf",
] as const;

/** 시즌 표현. 올해만 답한다 — 과거 시즌 row 가 DB 에 없기 때문이다. */
const CURRENT_SEASON_WORDS = ["올해", "올시즌", "이번시즌", "금년", "올해의", String(SUPPORTED_SEASON)];
const PAST_SEASON_WORDS = [
  "작년", "지난해", "지지난해", "재작년", "통산", "커리어", "역대", "생애", "누적",
  "2025", "2024", "2023", "2022", "2021", "2020",
];

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
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
export function resolveSeasonRecordIntent(question: string): SeasonRecordIntent {
  const compact = normalize(question);

  if (UNTRUSTED_METRIC_ALIASES.some((alias) => compact.includes(normalize(alias)))) {
    return { kind: "untrusted_metric" };
  }
  if (PAST_SEASON_WORDS.some((word) => compact.includes(word))) {
    return { kind: "unsupported_season" };
  }
  if (!NUMERIC_QUESTION.test(compact)) return { kind: "none" };

  // 타자 → 투수 순으로 본다. `hr`·`games` 처럼 양쪽에 있는 지표는 **투수 전용 표현**
  // (피홈런·등판)이 문장에 있을 때만 투수로 간다.
  const pitcherHint = /피안타|피홈런|자책|방어율|평균자책|세이브|홀드|이닝|탈삼진|whip|승률|등판|던졌/.test(compact);

  const table = pitcherHint ? "pitcher" : "batter";
  const metrics: Record<string, { label: string; aliases: readonly string[]; kind: string }> =
    table === "pitcher" ? PITCHER_METRICS : BATTER_METRICS;

  // 더 긴 alias 를 먼저 본다 — `홈런` ⊂ `피홈런` 처럼 짧은 쪽이 먼저 걸리면 오분류된다.
  const matches = Object.entries(metrics)
    .flatMap(([key, def]) => def.aliases.map((alias) => ({ key, def, alias: normalize(alias) })))
    .filter((entry) => compact.includes(entry.alias))
    .sort((left, right) => right.alias.length - left.alias.length);

  if (matches.length === 0) return { kind: "none" };
  const best = matches[0];
  return {
    kind: "query",
    query: {
      table,
      metric: best.key,
      label: best.def.label,
      kind: best.def.kind as SeasonRecordQuery["kind"],
    },
  };
}

/** 명시적으로 올해를 지목했는가. 시즌 표현이 아예 없으면 현재 시즌으로 본다. */
export function mentionsCurrentSeason(question: string): boolean {
  const compact = normalize(question);
  if (PAST_SEASON_WORDS.some((word) => compact.includes(word))) return false;
  return true;
}

export { CURRENT_SEASON_WORDS };

/** DB row (snake_case 그대로). 값 변환은 하지 않는다. */
export interface SeasonRecordRow {
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
 * 여유를 조금 둔다 — cron 이 22:00 에 돌아도 정상이고, 몇 분 지연으로 fail-close 되면 안 된다.
 */
export const STATS_STALE_MS = 30 * 60 * 60 * 1000;

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
): SeasonRecordOutcome {
  // row 0 = 미수집, 2+ = 같은 kboId 가 여러 행 → 어느 게 맞는지 모른다. 둘 다 답하지 않는다.
  if (rows.length !== 1) return rows.length === 0 ? { kind: "missing" } : { kind: "inconsistent" };
  const row = rows[0];
  // 서버가 특정한 선수의 행이 맞는지 재확인 — 조회 조건이 바뀌어도 여기서 걸린다.
  if (row.kbo_id !== expectedKboId) return { kind: "inconsistent" };

  const updatedAt = Date.parse(row.updated_at);
  if (!Number.isFinite(updatedAt)) return { kind: "inconsistent" };
  if (now - updatedAt > STATS_STALE_MS) return { kind: "stale", asOf: row.updated_at };

  const raw = row[query.metric];
  if (raw === null || raw === undefined || raw === "") return { kind: "missing" };

  // **원값 그대로** 낸다. 재계산하지 않는다 — 타율을 hits/ab 로 다시 구하면 DB 표기와 어긋난다.
  let value: string;
  if (query.kind === "count") {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return { kind: "inconsistent" };
    value = String(raw);
  } else {
    if (typeof raw !== "string" && typeof raw !== "number") return { kind: "inconsistent" };
    value = String(raw).trim();
    if (!value) return { kind: "missing" };
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
