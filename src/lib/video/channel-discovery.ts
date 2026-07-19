/**
 * 자동 채널 발굴 — 순수 로직 (검색어 생성 · KBO 관련성 판정 · 활성 게이트).
 *
 * `discover-channels` 크론과 스모크(scripts/qa/channel-discovery-smoke.ts)가 공유하는
 * 단일 SSOT. 네트워크/DB 의존 없는 순수 함수만 둔다.
 *
 * 배경(삼순 조건부 GO, 2026-07-19 #cs):
 *  · 최근 정상 수집된 숏츠 제목에서 팀·선수 패턴을 뽑아 검색어(≤8)를 만든다.
 *  · 검색 결과 채널 후보의 최근 영상 10개를 게이트로 검증(KBO 8+ / 숏츠 3+ / 30일 내).
 *  · 첫 2회는 shadow(로그만), 이후 자동 활성. 실행당 최대 5채널.
 */

import { hasNonBaseballSignal } from "./shorts-relevance";
import { TEAM_MASCOTS, BASEBALL_KEYWORDS } from "@/lib/news-relevance";

/** 10개 구단 팀 약어(검색어/제목 매칭 vocabulary) */
export const TEAM_SHORTS = [
  "LG", "두산", "KT", "SSG", "NC", "KIA", "삼성", "롯데", "한화", "키움",
] as const;

/** 팀 약어 → 검색어용 정식 명칭 */
export const TEAM_FULL_NAMES: Record<string, string> = {
  LG: "LG 트윈스",
  두산: "두산 베어스",
  KT: "KT 위즈",
  SSG: "SSG 랜더스",
  NC: "NC 다이노스",
  KIA: "KIA 타이거즈",
  삼성: "삼성 라이온즈",
  롯데: "롯데 자이언츠",
  한화: "한화 이글스",
  키움: "키움 히어로즈",
};

/** 야구 헤드라인 고유 어휘(정치·비즈니스 칼럼엔 등장 안 함) */
const BASEBALL_TERMS = [
  "홈런", "삼진", "투수", "타자", "선발", "세이브", "도루",
  "만루", "병살", "이닝", "타점", "완봉", "역전", "끝내기", "타석",
];

// KBO positive 시그널을 Latin/Korean으로 나눈다.
//  · Latin 2~3자(LG/KT/NC/KBO…)는 substring이면 concert→NC, algorithm→LG,
//    dance→NC 처럼 영단어에 오탐(2026-07-19 뉴스클리핑 #702 동일 교훈) →
//    ASCII 경계 매칭.
//  · Korean(마스코트·팀명·야구용어)은 substring이 안전.
const LATIN_POSITIVE = ["LG", "KT", "SSG", "NC", "KIA", "KBO"];
const KOREAN_POSITIVE = [
  "두산", "삼성", "롯데", "한화", "키움",
  ...TEAM_MASCOTS,
  ...BASEBALL_KEYWORDS.filter((k) => !/[a-zA-Z]/.test(k)), // "KBO" 제외(Latin에서 처리)
  ...BASEBALL_TERMS,
];

function hasLatinToken(title: string, token: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9])${token.toLowerCase()}([^a-z0-9]|$)`, "i");
  return re.test(title);
}

/**
 * 제목이 KBO(야구) 관련인지 positive 판정.
 *  (1) 정치·종교·비즈니스 등 비-야구 negative가 있으면 즉시 탈락(shorts-relevance SSOT)
 *  (2) 팀 약어/마스코트/야구 키워드/야구 용어 중 하나라도 있어야 통과
 * Latin 약어는 경계 매칭으로 영단어 오탐을 막는다.
 */
export function isKboRelevantTitle(title: string): boolean {
  if (!title) return false;
  if (hasNonBaseballSignal(title)) return false;
  if (KOREAN_POSITIVE.some((k) => title.includes(k))) return true;
  if (LATIN_POSITIVE.some((k) => hasLatinToken(title, k))) return true;
  return false;
}

/** 제목에서 팀 약어 등장 여부(Latin은 경계, Korean은 substring) */
function titleHasTeam(title: string, short: string): boolean {
  return /[a-zA-Z]/.test(short)
    ? hasLatinToken(title, short)
    : title.includes(short);
}

/**
 * 최근 정상 수집된 숏츠 제목 + 로스터 선수명으로 검색어 생성.
 * 팀 빈도 상위 → "{정식명} 숏츠", 선수 빈도 상위 → "{선수명} 숏츠",
 * 마지막에 generic KBO 검색어로 채워 채널 발굴 다양성을 확보한다. 최대 maxQueries개.
 */
export function buildDiscoveryQueries(
  fedTitles: string[],
  rosterNames: string[],
  maxQueries = 8,
): string[] {
  const cap = Math.min(Math.max(maxQueries, 1), 8); // 하드 상한 8(quota 방어)

  // 1) 팀 빈도
  const teamCount = new Map<string, number>();
  for (const t of fedTitles) {
    for (const short of TEAM_SHORTS) {
      if (titleHasTeam(t, short)) {
        teamCount.set(short, (teamCount.get(short) ?? 0) + 1);
      }
    }
  }
  const topTeams = [...teamCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map((e) => e[0]);

  // 2) 선수 빈도 (2자 이름은 오탐이 커서 3자+만)
  const names = rosterNames.filter((n) => n && n.length >= 3);
  const nameCount = new Map<string, number>();
  for (const t of fedTitles) {
    for (const n of names) {
      if (t.includes(n)) nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
    }
  }
  const topPlayers = [...nameCount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map((e) => e[0]);

  const queries: string[] = [];
  const push = (q: string) => {
    if (q && !queries.includes(q) && queries.length < cap) queries.push(q);
  };

  // 팀 상위 3 → 선수 상위 2 → generic 순으로 채우되, 데이터 없으면 generic이 커버
  for (const team of topTeams.slice(0, 3)) push(`${TEAM_FULL_NAMES[team]} 숏츠`);
  for (const p of topPlayers.slice(0, 2)) push(`${p} 숏츠`);
  for (const g of ["KBO 하이라이트", "프로야구 숏츠", "크보 밈", "야구 짤"]) push(g);

  return queries.slice(0, cap);
}

export interface RecentVideo {
  title: string;
  publishedAt: string; // ISO 8601
  durationSeconds: number | null;
}

export interface CandidateEval {
  pass: boolean;
  considered: number;
  kboCount: number;
  shortCount: number;
  recentUploadAt: string | null;
  withinRecent: boolean;
  reason: string;
}

/**
 * 채널 후보 활성 게이트: 최근 10개 중 KBO 관련 minKbo개+, 숏츠(≤70초) minShort개+,
 * 마지막 업로드가 recentDays일 내. duration 미상은 숏츠로 세지 않는다(fail-closed).
 */
export function evaluateChannelCandidate(
  videos: RecentVideo[],
  opts?: { now?: Date; minKbo?: number; minShort?: number; recentDays?: number },
): CandidateEval {
  const now = opts?.now ?? new Date();
  const minKbo = opts?.minKbo ?? 8;
  const minShort = opts?.minShort ?? 3;
  const recentDays = opts?.recentDays ?? 30;

  // ISO 8601(UTC)은 사전순 == 시간순
  const sorted = videos
    .filter((v) => v.publishedAt)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const top = sorted.slice(0, 10);
  const considered = top.length;
  const kboCount = top.filter((v) => isKboRelevantTitle(v.title)).length;
  const shortCount = top.filter(
    (v) => v.durationSeconds != null && v.durationSeconds <= 70,
  ).length;
  const recentUploadAt = top.length ? top[0].publishedAt : null;
  const withinRecent = recentUploadAt
    ? now.getTime() - new Date(recentUploadAt).getTime() <= recentDays * 86400000
    : false;

  const pass =
    considered >= minKbo &&
    kboCount >= minKbo &&
    shortCount >= minShort &&
    withinRecent;

  const reason = pass
    ? `pass: KBO ${kboCount}/${considered}, 숏츠 ${shortCount}, 최근업로드 ${recentUploadAt?.slice(0, 10)}`
    : [
        considered < minKbo ? `표본부족 ${considered}<${minKbo}` : null,
        kboCount < minKbo ? `KBO ${kboCount}/${considered}<${minKbo}` : null,
        shortCount < minShort ? `숏츠 ${shortCount}<${minShort}` : null,
        !withinRecent ? `업로드 ${recentDays}일 초과` : null,
      ]
        .filter(Boolean)
        .join(", ");

  return { pass, considered, kboCount, shortCount, recentUploadAt, withinRecent, reason };
}

/**
 * 완료된 non-degraded shadow 회수가 2 미만이면 shadow, 이상이면 active.
 * 호출부가 status='success' && degraded=false 인 shadow run만 세서 전달해야 한다
 * (삼순 3번: 오류/degraded run이 유효한 shadow 2회를 건너뛰고 조기 active되는 것 방지).
 */
export function decideMode(cleanShadowCount: number): "shadow" | "active" {
  return cleanShadowCount < 2 ? "shadow" : "active";
}

/** 실행당 최대 활성화 하드 상한 (삼순 4번: env가 무엇이든 5 초과 불가) */
export const MAX_ACTIVATIONS_CAP = 5;

/** DISCOVER_MAX_ACTIVATIONS env → 1~5로 clamp (양수 아니면 5) */
export function resolveMaxActivations(raw: string | undefined): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return MAX_ACTIVATIONS_CAP;
  return Math.min(n, MAX_ACTIVATIONS_CAP);
}

// YouTube Data API quota/rate 계열 errors[].reason
const QUOTA_REASONS = new Set([
  "quotaexceeded",
  "dailylimitexceeded",
  "ratelimitexceeded",
  "userratelimitexceeded",
  "usagelimits",
]);

/**
 * quota/rate 하드 게이트 판정(삼순 4번). message 문자열만 보지 않고
 * HTTP status + errors[].reason 까지 본다 — "exceeded your quota" 변형·
 * 구조화 reason(quotaExceeded 등)·403/429를 모두 잡아 fail-closed 로 검색을 멈춘다.
 */
export function isQuotaSignal(input: {
  status?: number;
  reasons?: Array<string | undefined | null>;
  message?: string | null;
}): boolean {
  if (input.status === 403 || input.status === 429) return true;
  if (
    (input.reasons ?? []).some(
      (r) => r != null && QUOTA_REASONS.has(String(r).toLowerCase()),
    )
  ) {
    return true;
  }
  const m = (input.message ?? "").toLowerCase();
  return /quota|exceeded your|rate ?limit|usagelimits|daily ?limit/.test(m);
}

export interface ScoredCandidate {
  channelId: string;
  channelName: string;
  seenCount: number;
  evaluation: CandidateEval;
}

/**
 * 활성화 대상 선정: 게이트 통과 후보를 등장 빈도 desc로 정렬 후 최대 max개.
 * (셔도 모드에서는 호출부가 활성화하지 않고 판정만 기록)
 */
export function pickActivations(
  candidates: ScoredCandidate[],
  max = 5,
): ScoredCandidate[] {
  return candidates
    .filter((c) => c.evaluation.pass)
    .sort((a, b) => b.seenCount - a.seenCount || a.channelId.localeCompare(b.channelId))
    .slice(0, Math.max(0, max));
}
