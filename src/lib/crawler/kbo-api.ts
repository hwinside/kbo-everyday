/* ===== KBO 공식 API 크롤러 ===== */

import { resolvePlayer } from "@/lib/utils/resolve-player";
import { trackFallback } from "@/lib/monitoring/api-fallback-tracker";
import { parseTeamRegister, type RosterEntry } from "@/lib/roster-moves/parse";
import { RosterCollectionError, validateRosterCollection } from "@/lib/roster-moves/collection";
// 수집 sanity 검증/예외는 순수 모듈(roster-moves/collection.ts)에 두고 재노출(스모크가 supabase 의존 없이 import).
export { RosterCollectionError, validateRosterCollection } from "@/lib/roster-moves/collection";
import { decodeBroadcast, type BroadcastChannel } from "@/lib/broadcast-channels";
import { isKboGameCancelled, parseCancelReason } from "@/lib/crawler/kbo-status";
// 순수 상태 헬퍼 재노출 — 스모크가 supabase 의존 없이 import.
export { isKboGameCancelled, parseCancelReason } from "@/lib/crawler/kbo-status";
import { ALLSTAR_CODE_TO_ID, allstarTeamIdByName } from "@/lib/constants/teams";
import { runBeforeDeadline } from "@/lib/async-deadline";

/** 숫자 kboId로 로스터 조회 — 외국인 숫자→영문 변환 포함 */
function findPlayerByNumericId(numericId: string): { name: string } | undefined {
  const resolved = resolvePlayer(String(numericId), undefined, { context: "kbo-api:boxscore" });
  return resolved ? { name: resolved.name } : undefined;
}

const KBO_BASE = "https://www.koreabaseball.com";

// 2026-05-20: KBO 서버가 User-Agent 없는 요청에 IE 분기 에러 페이지를 내려줌 → JSON 파싱 실패.
// Vercel 서버리스 fetch는 기본 UA가 없으므로 모든 KBO 직접 호출에 브라우저 UA를 강제한다.
const KBO_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const KBO_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent": KBO_BROWSER_UA,
  "Referer": "https://www.koreabaseball.com/Schedule/Schedule.aspx",
};
const KBO_HTML_HEADERS = {
  "User-Agent": KBO_BROWSER_UA,
  "Referer": "https://www.koreabaseball.com/",
};

// KBO 팀 코드 → 앱 teamId 매핑
const TEAM_CODE_MAP: Record<string, number> = {
  LG: 1, OB: 2, KT: 3, SK: 4, NC: 5,
  HT: 6, LT: 7, SS: 8, HH: 9, WO: 10,
};

/** KBO 팀 코드 → 앱 teamId. 정규 10구단에 없으면 올스타(코드 → 팀명 순)로 해석,
 *  그래도 없으면 0. 올스타는 코드가 팀맵에 없어 예전엔 0으로 뭉개져 렌더가 터졌다. */
export function resolveTeamId(code: string, name: string): number {
  return TEAM_CODE_MAP[code] ?? ALLSTAR_CODE_TO_ID[code] ?? allstarTeamIdByName(name) ?? 0;
}

export interface KboGame {
  gameId: string;
  date: string;
  time: string;
  stadium: string;
  awayTeamId: number;
  homeTeamId: number;
  awayName: string;
  homeName: string;
  awayScore: number | null;
  homeScore: number | null;
  inning: number;
  isTop: boolean; // 초(true) / 말(false)
  status: "scheduled" | "live" | "final" | "cancelled";
  // 선발 투수
  awayStarterName: string;
  homeStarterName: string;
  // 결과 투수
  winPitcher: string;
  losePitcher: string;
  savePitcher: string;
  // 라이브 데이터
  strikes: number;
  balls: number;
  outs: number;
  runnersOn: { first: boolean; second: boolean; third: boolean };
  runnerOrders?: { first: number; second: number; third: number };
  currentPitcher: string;
  currentBatter: string;
  /**
   * 위 라이브 상세(BSO/주자/현재투타)가 **실제 KBO 관측값**인지 여부(provenance).
   *
   * 왜 필요한가 (삼순 2026-08-15 NO-GO): Naver 매핑은 이 필드들을 항상 `0`/`false` 로
   * degrade 채운다. 값만 보면 "볼카운트 0-0-0, 주자 없음"과 "아직 못 받아왔다"가
   * 구분되지 않아, KBO timeout·시점 불일치에도 UI 가 거짓 0-0-0 을 사실처럼 단정하게 된다.
   * KBO 원본에서 온 값일 때만 true, degrade/미확인이면 false.
   */
  liveDetailFromKbo: boolean;
  /**
   * 취소 사유 원문(KBO `CANCEL_SC_NM`). `status === "cancelled"` 일 때만 채운다.
   *
   * 왜 nullable 인가 (provenance): Naver 폴백 매핑에는 이 필드가 원리적으로 없다.
   * 값이 없다 == "사유가 없는 취소"가 아니라 "사유를 못 받았다" 이므로, 소비처는
   * null 을 "사유 미상"으로 단정하지 말고 기존 고정 문구로 fallback 해야 한다.
   * 실측 사유(2026-08): `우천취소` `폭염취소` `그라운드사정`.
   */
  cancelReason: string | null;
  // 순위
  awayRank: number;
  homeRank: number;
  // 중계방송사(TV/IPTV, 라디오 제외). 없으면 undefined.
  broadcastChannels?: BroadcastChannel[];
}

function parseGameStatus(stateCode: string, cancelCode: string): KboGame["status"] {
  if (isKboGameCancelled(cancelCode)) return "cancelled";
  if (stateCode === "3") return "final";
  if (stateCode === "2") return "live";
  return "scheduled";
}

interface KboGameRaw {
  G_ID: string;
  G_DT: string;
  G_TM: string;
  S_NM: string;
  AWAY_ID: string;
  HOME_ID: string;
  AWAY_NM: string;
  HOME_NM: string;
  T_SCORE_CN: string;
  B_SCORE_CN: string;
  GAME_INN_NO: number;
  GAME_TB_SC: string;
  GAME_STATE_SC: string;
  CANCEL_SC_ID: string;
  /** 취소 사유 원문("우천취소"/"폭염취소"/"그라운드사정"). 정상 경기는 빈 문자열. */
  CANCEL_SC_NM?: string;
  T_PIT_P_NM: string;
  B_PIT_P_NM: string;
  W_PIT_P_NM: string;
  L_PIT_P_NM: string;
  SV_PIT_P_NM: string;
  STRIKE_CN: number;
  BALL_CN: number;
  OUT_CN: number;
  B1_BAT_ORDER_NO: number;
  B2_BAT_ORDER_NO: number;
  B3_BAT_ORDER_NO: number;
  B_P_NM: string;
  T_P_NM: string;
  T_RANK_NO: number;
  B_RANK_NO: number;
  TV_IF?: string;
}

/**
 * raw KBO live 상세 필드가 전부 유효한가 — provenance 판정의 유일한 기준.
 *
 * HTTP 200 이어도 per-game 상세 필드가 빠지는 부분 열화가 있다. `?? 0` 으로 합성하면
 * 그 0 이 "실제 관측된 0"과 구분되지 않으므로, 합성 전에 원본 유효성을 먼저 본다.
 * live 가 아닌 경기는 상세 자체가 의미 없으므로 false(카드도 live 에서만 쓴다).
 */
function hasValidLiveDetail(raw: KboGameRaw, status: KboGame["status"]): boolean {
  if (status !== "live") return false;
  // 정수 + 도메인 상한까지 검증(삼순 2026-08-15): 소수·과대값(예: BALL_CN=99)은 필드 밀린
  // 등 upstream 열화의 신호이며 관측값으로 믿으면 안 된다. 상한은 표기 도메인(3B/2S/2O)이
  // 아니라 순간 관측 도메인이다 — 볼넷/삼진/이닝종료 순간 피드에 4B/3S/3O 가 실재할 수
  // 있으므로 그것까지 거부하면 정상 경기가 '준비 중'으로 오판된다(카드가 표기 상한으로 clamp).
  const inRange = (n: unknown, max: number): boolean =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max;
  return (
    inRange(raw.BALL_CN, 4) &&
    inRange(raw.STRIKE_CN, 3) &&
    inRange(raw.OUT_CN, 3) &&
    // 주자 타순은 0(없음)~9번 타순만 유효하다.
    inRange(raw.B1_BAT_ORDER_NO, 9) &&
    inRange(raw.B2_BAT_ORDER_NO, 9) &&
    inRange(raw.B3_BAT_ORDER_NO, 9)
  );
}

/** KBO raw game → KboGame 순수 매퍼. `mapNaverGameToKbo` 와 동일하게 테스트용으로 export 한다. */
export function parseGame(raw: KboGameRaw): KboGame {
  const status = parseGameStatus(raw.GAME_STATE_SC?.toString(), raw.CANCEL_SC_ID?.toString());
  const isTop = raw.GAME_TB_SC === "T";
  // 상세 유효성을 한 번만 판정해 **값과 플래그를 같은 조건으로** 묶는다.
  // 이렇게 해야 "합성 0 인데 flag만 true" 가 구조적으로 불가능해진다(삼순 P1).
  const liveDetailOk = hasValidLiveDetail(raw, status);
  return {
    gameId: raw.G_ID,
    date: raw.G_DT,
    time: raw.G_TM,
    stadium: raw.S_NM,
    awayTeamId: resolveTeamId(raw.AWAY_ID, raw.AWAY_NM),
    homeTeamId: resolveTeamId(raw.HOME_ID, raw.HOME_NM),
    awayName: raw.AWAY_NM,
    homeName: raw.HOME_NM,
    awayScore: status !== "scheduled" ? parseInt(raw.T_SCORE_CN) || 0 : null,
    homeScore: status !== "scheduled" ? parseInt(raw.B_SCORE_CN) || 0 : null,
    inning: raw.GAME_INN_NO ?? 0,
    isTop,
    status,
    awayStarterName: raw.T_PIT_P_NM?.trim() ?? "",
    homeStarterName: raw.B_PIT_P_NM?.trim() ?? "",
    winPitcher: raw.W_PIT_P_NM?.trim() ?? "",
    losePitcher: raw.L_PIT_P_NM?.trim() ?? "",
    savePitcher: raw.SV_PIT_P_NM?.trim() ?? "",
    strikes: liveDetailOk ? raw.STRIKE_CN : 0,
    balls: liveDetailOk ? raw.BALL_CN : 0,
    outs: liveDetailOk ? raw.OUT_CN : 0,
    runnersOn: {
      first: liveDetailOk && raw.B1_BAT_ORDER_NO > 0,
      second: liveDetailOk && raw.B2_BAT_ORDER_NO > 0,
      third: liveDetailOk && raw.B3_BAT_ORDER_NO > 0,
    },
    // 값과 동일한 조건 — 유효한 원본을 그대로 실은 때만 "실제 관측값"이다.
    liveDetailFromKbo: liveDetailOk,
    cancelReason: parseCancelReason(status, raw.CANCEL_SC_NM),
    currentPitcher: isTop ? (raw.B_P_NM?.trim() ?? "") : (raw.T_P_NM?.trim() ?? ""),
    currentBatter: isTop ? (raw.T_P_NM?.trim() ?? "") : (raw.B_P_NM?.trim() ?? ""),
    awayRank: raw.T_RANK_NO ?? 0,
    homeRank: raw.B_RANK_NO ?? 0,
    broadcastChannels: decodeBroadcast(raw.TV_IF),
  };
}

/** 특정 날짜 경기 목록 조회 */
/**
 * raw KBO 경기 원본 sanity — HTTP 200 이지만 per-game 필수 필드(경기id/날짜/팀)가
 * 결측된 부분 열화(`game:[{}]`)를 정상으로 묻지 않는다. 하나라도 실패면
 * 상위 fetchGames 가 schema-error 로 보고 Naver 폴백을 태운다.
 */
function isRawKboGameSane(raw: Partial<KboGameRaw> | null | undefined): boolean {
  if (!raw?.G_ID || !raw?.G_DT || !raw?.AWAY_NM || !raw?.HOME_NM) return false;
  if (resolveTeamId(raw.AWAY_ID ?? "", raw.AWAY_NM) <= 0) return false;
  if (resolveTeamId(raw.HOME_ID ?? "", raw.HOME_NM) <= 0) return false;
  return true;
}

/**
 * user-facing 경기목록 조회 budget(ms). 홈 SSR·`/api/games` route 등 사용자 응답 경로가
 * 공통으로 쓰는 SSOT — KBO blackhole 에서도 이 시간 안에 Naver 폴백으로 수렴한다.
 * cron/배치 소비자는 opts 없이 기본 10s 를 그대로 쓴다.
 */
export const USER_FACING_GAMES_TIMEOUT_MS = 3500;

/**
 * KBO GetKboGameList 만 호출/파싱(폴백 없음). 성공 시 KboGame[](빈 배열 포함),
 * !ok/스키마 열화/per-game 결측이면 throw. 외부 KBO 호출을 단일 헬퍼로 중앙화한다
 * (헤더/URL 변경 시 1곳만 수정 — 2026-05-20 Referer 정책 변경 교훈).
 * trackFallback·Naver 폴백·soft-empty 는 호출자(fetchGames / fetchGamesUserFacing)가 담당한다.
 */
export async function fetchKboGamesOnly(
  date: string,
  srId = "0,1,3,4,5,7,9",
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<KboGame[]> {
  const res = await fetch(`${KBO_BASE}/ws/Main.asmx/GetKboGameList`, {
    method: "POST",
    headers: KBO_JSON_HEADERS,
    body: JSON.stringify({ leId: "1", srId, date }),
    signal: opts?.signal ?? AbortSignal.timeout(opts?.timeoutMs ?? 10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  // ASP.NET 에러 HTML이 뒤에 붙을 수 있음
  const jsonEnd = text.indexOf("}<!");
  const jsonStr = jsonEnd > 0 ? text.slice(0, jsonEnd + 1) : text;
  const data = JSON.parse(jsonStr);
  // HTTP 200 스키마 열화: game 필드가 배열이 아니면(누락/null) schema-error.
  if (!Array.isArray(data.game)) {
    throw new Error("KBO GetKboGameList schema-error: game 필드 부재/비배열");
  }
  // per-game 부분 열화(`game:[{}]` 등 필수 필드 결측) → schema-error.
  if (data.game.some((g: unknown) => !isRawKboGameSane(g as Partial<KboGameRaw>))) {
    throw new Error("KBO GetKboGameList schema-error: per-game 필수 필드 결측");
  }
  return data.game.map(parseGame);
}

export async function fetchGames(
  date: string,
  srId = "0,1,3,4,5,7,9",
  opts?: { timeoutMs?: number; deadlineAtMs?: number },
): Promise<KboGame[]> {
  const deadlineAtMs = opts?.deadlineAtMs
    ?? Date.now() + (opts?.timeoutMs ?? 10_000);
  const remainingAtStartMs = deadlineAtMs - Date.now();
  if (remainingAtStartMs <= 0) throw new Error("games deadline exceeded");
  // When a caller supplies an absolute route deadline, KBO receives only half
  // of the remaining budget. The other half is reserved for the Naver fallback,
  // while both requests remain bounded by the same wall-clock deadline.
  const kboBudgetMs = opts?.deadlineAtMs == null
    ? remainingAtStartMs
    : Math.max(1, Math.floor(remainingAtStartMs / 2));
  const abortBeforeDeadlineMs = (remainingMs: number) => {
    const settleReserveMs = Math.min(25, Math.max(1, Math.floor(remainingMs / 10)));
    return Math.max(1, remainingMs - settleReserveMs);
  };
  let games: KboGame[];
  try {
    games = await runBeforeDeadline(
      () => fetchKboGamesOnly(date, srId, {
        signal: AbortSignal.timeout(kboBudgetMs),
      }),
      deadlineAtMs,
    );
  } catch (e) {
    const error = e as Error;
    let reason: "timeout" | "http-error" | "schema-error" | "network-error" = "network-error";
    if (error.name === "TimeoutError" || error.message.includes("timeout")) {
      reason = "timeout";
    } else if (error.message.includes("HTTP")) {
      reason = "http-error";
    } else if (error.message.includes("JSON") || error.message.includes("schema-error")) {
      reason = "schema-error";
    }

    // A route-scoped absolute deadline must leave no detached DB write after
    // the response. Callers without such a deadline retain fallback telemetry.
    if (opts?.deadlineAtMs == null) {
      void trackFallback("kbo-games", reason, { errorMessage: error.message }).catch(() => undefined);
    }

    // Fallback: Naver schedule/games. srId 계약 보존(특정 시리즈는 fetchNaverGames 내부 fail-close).
    // Naver 성공 시 그대로 반환(무경기일 빈 배열도 성공) — 무경기일 fallback 500 방지.
    try {
      const { fetchNaverGames } = await import("@/lib/crawler/naver-games");
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) throw new Error("games deadline exceeded before Naver fallback");
      return await runBeforeDeadline(
        () => fetchNaverGames(date, srId, {
          signal: AbortSignal.timeout(abortBeforeDeadlineMs(remainingMs)),
        }),
        deadlineAtMs,
      );
    } catch {
      // Naver 도 실패(또는 series 보존 불가 fail-close) → 원래 KBO 에러로 throw.
    }
    throw error;
  }

  // soft-empty: KBO 200 빈 응답(game:[])을 authoritative empty 로 단정하지 않는다 — 열화(200+빈배열)
  // 일 수 있어 Naver 로 교차확인한다(fetchKboLiveGames 의 ok:false 계약과 동일 fail-close).
  //  - Naver 에 경기 있음 → KBO 빈은 열화 → Naver 사용.
  //  - Naver 도 무경기(성공) → "그날 실제로 경기 없음" 확인 → 정상 무경기일([]) 인정(trackFallback 안 쌓음).
  //  - Naver 확인 실패/timeout/fail-close → empty 를 정상으로 단정 금지 → throw(구값 캐시 불가한 순수
  //    fetch 라 에러로 신호; 호출자가 구값 유지/ok:false 처리). 이전처럼 []로 닫으면 KBO 장애가 홈/일정에
  //    "정상 0경기"로 오인된다(삼순 P1).
  if (games.length === 0) {
    const naver = await import("@/lib/crawler/naver-games");
    try {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) throw new Error("games deadline exceeded before Naver cross-check");
      return await runBeforeDeadline(
        () => naver.fetchNaverGames(date, srId, {
          signal: AbortSignal.timeout(abortBeforeDeadlineMs(remainingMs)),
        }),
        deadlineAtMs,
      );
    } catch (naverErr) {
      throw new Error(
        `KBO 200-empty 미검증: Naver 교차확인 실패로 무경기 단정 금지 (${(naverErr as Error).message})`,
      );
    }
  }
  return games;
}

/** 이전/다음 경기일 조회 */
export async function fetchGameDates(date: string): Promise<{ before: string; current: string; after: string }> {
  const res = await fetch(`${KBO_BASE}/ws/Main.asmx/GetKboGameDate`, {
    method: "POST",
    headers: KBO_JSON_HEADERS,
    body: JSON.stringify({ leId: "1", srId: "0,1", date }),
  });

  const text = await res.text();
  const jsonEnd = text.indexOf("}<!") ;
  const jsonStr = jsonEnd > 0 ? text.slice(0, jsonEnd + 1) : text;
  const data = JSON.parse(jsonStr);

  return {
    before: data.BEFORE_G_DT,
    current: data.NOW_G_DT,
    after: data.AFTER_G_DT,
  };
}

export interface TeamStanding {
  teamName: string;
  teamId: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  gamesBehind: number;
  /** 네이버 API 원본 순위(공동순위 반영). 없으면 0/undefined → 승률 기반 fallback. */
  ranking?: number;
  /** 연승/연패 원본 문자열 (예: "3승", "1패"). 없으면 undefined. */
  continuousGameResult?: string;
}

/**
 * 순위 산정 — 공동순위(ties) 보존 (4/11 핫픽스 001bf82c 기준):
 *  - 네이버 API 원본 `ranking`(공동순위 반영)이 있으면 그대로 사용.
 *  - 없으면(KBO HTML 폴백 등) 승률 내림차순 competition ranking — 동률은 같은 순위(1,2,2,4…).
 * winRate-sort + index+1 단순 방식은 공동순위를 깨므로 쓰지 않는다(삼순 #406 NO-GO).
 */
export function rankStandings(standings: TeamStanding[]): { teamId: number; teamName: string; rank: number }[] {
  const hasRanking = standings.some((s) => s.ranking != null && s.ranking > 0);
  if (hasRanking) {
    return standings
      .filter((s) => s.teamId)
      .map((s) => ({ teamId: s.teamId, teamName: s.teamName, rank: s.ranking as number }));
  }
  const sorted = [...standings].sort((a, b) => b.winRate - a.winRate);
  let currentRank = 1;
  return sorted.map((s, i) => {
    if (i > 0 && s.winRate !== sorted[i - 1].winRate) currentRank = i + 1;
    return { teamId: s.teamId, teamName: s.teamName, rank: currentRank };
  });
}

/** teamId → 순위 맵 (공동순위 보존). 순위표 렌더/프리뷰/요약의 순위 표기에 공통 사용. */
export function buildRankMap(standings: TeamStanding[]): Map<number, number> {
  return new Map(rankStandings(standings).map((r) => [r.teamId, r.rank]));
}

/**
 * team-card standing.rank + self-heal liveRank 공통 소스 — buildRankMap SSOT(공동순위 보존).
 * winRate-sort + idx+1 방식은 공동순위를 깨므로 route에서 직접 쓰지 말고 이 함수로 통일한다(삼순 #729).
 */
export function teamCardRank(standings: TeamStanding[], teamId: number): number | null {
  return buildRankMap(standings).get(teamId) ?? null;
}

/** 팀 순위 (HTML 파싱) */
/** 팀 순위 (네이버 API → KBO HTML 폴백) */
export async function fetchStandings(): Promise<TeamStanding[]> {
  try {
    // Primary: 네이버 실시간 API (빠름)
    const naverRes = await fetch(
      "https://api-gw.sports.naver.com/statistics/categories/kbo/seasons/2026/teams?gameType=REGULAR_SEASON",
      {
        headers: {
          "Referer": "https://sports.news.naver.com/",
          "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
        },
        signal: AbortSignal.timeout(5000),
        cache: "no-store",
      }
    );

    if (naverRes.ok) {
      const data = await naverRes.json();
      if (data.success && data.result?.seasonTeamStats) {
        return data.result.seasonTeamStats.map((team: { teamName: string; teamId: string; gameCount?: number; winGameCount?: number; loseGameCount?: number; drawnGameCount?: number; wra?: number; gameBehind?: number; ranking?: number; continuousGameResult?: string }) => ({
          teamName: team.teamName,
          teamId: TEAM_CODE_MAP[team.teamId] ?? 0,
          games: team.gameCount ?? 0,
          wins: team.winGameCount ?? 0,
          losses: team.loseGameCount ?? 0,
          draws: team.drawnGameCount ?? 0,
          winRate: team.wra ?? 0,
          gamesBehind: team.gameBehind ?? 0,
          ranking: team.ranking ?? 0,
          continuousGameResult: team.continuousGameResult,
        }));
      }
    }
  } catch (e) {
    const error = e as Error;
    console.warn("[fetchStandings] Naver API failed, falling back to KBO HTML:", error.message);

    // Fallback 추적 + 알림
    let reason: "timeout" | "http-error" | "schema-error" | "network-error" = "network-error";
    if (error.name === "TimeoutError" || error.message.includes("timeout")) {
      reason = "timeout";
    } else if (error.message.includes("HTTP") || error.message.includes("status")) {
      reason = "http-error";
    } else if (error.message.includes("JSON") || error.message.includes("schema")) {
      reason = "schema-error";
    }

    await trackFallback("naver-standings", reason, {
      errorMessage: error.message,
    });
  }

  // Fallback: KBO HTML 크롤링 (느림)
  const res = await fetch(`${KBO_BASE}/Record/TeamRank/TeamRank.aspx`, { headers: KBO_HTML_HEADERS });
  const html = await res.text();

  const rows = html.split("<tr").slice(1).map(r => r.split("</tr>")[0]);
  const standings: TeamStanding[] = [];

  for (const row of rows) {
    const cells = row.split("<td").slice(1)
      .map(c => c.split("</td>")[0].replace(/<[^>]+>/g, "").replace(/^[^>]*>/, "").trim());

    if (cells.length >= 8 && /^\d+$/.test(cells[0])) {
      const teamName = cells[1];
      standings.push({
        teamName,
        teamId: Object.entries(TEAM_CODE_MAP).find(([_, id]) => {
          const names: Record<number, string> = {
            1: "LG", 2: "두산", 3: "KT", 4: "SSG", 5: "NC",
            6: "KIA", 7: "롯데", 8: "삼성", 9: "한화", 10: "키움",
          };
          return names[id] === teamName;
        })?.[1] ?? 0,
        games: parseInt(cells[2]) || 0,
        wins: parseInt(cells[3]) || 0,
        losses: parseInt(cells[4]) || 0,
        draws: parseInt(cells[5]) || 0,
        winRate: parseFloat(cells[6]) || 0,
        gamesBehind: parseFloat(cells[7]) || 0,
      });
    }
  }

  return standings;
}

// ===== BoxScore types & parser (shared with game-detail) =====

const KBO_SCHEDULE_BASE = "https://www.koreabaseball.com/ws/Schedule.asmx";
const SCHEDULE_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  // 2026-05-20: KBO가 KboEveryday/1.0 같은 식별 UA를 차단하기 시작 → 일반 브라우저 UA로 전환.
  "User-Agent": KBO_BROWSER_UA,
  "Referer": "https://www.koreabaseball.com/Schedule/ScoreBoard.aspx",
};

export interface BoxScoreBatterRecord {
  order: number;
  position: string;
  name: string;
  atBats: number;
  hits: number;
  runs: number;
  rbi: number;
  hr: number;
  bb: number;
  so: number;
  sb: number;
  avg: string;
  isSubstitute: boolean;
}

export interface BoxScorePitcherRecord {
  name: string;
  inningsPitched: string;
  decision: string;
  pitchCount: number;
  hits: number;
  runs: number;
  hr: number;
  strikeouts: number;
  walks: number;
  earnedRuns: number;
  era: string;
}

export interface BoxScoreResult {
  awayBatters: BoxScoreBatterRecord[];
  homeBatters: BoxScoreBatterRecord[];
  awayPitchers: BoxScorePitcherRecord[];
  homePitchers: BoxScorePitcherRecord[];
}

export interface GameLinescoreSide {
  innings: (number | null)[];
  R: number;
  H: number;
  E: number;
}

export interface GameLinescore {
  status: "scheduled" | "live" | "final" | "cancelled";
  away: GameLinescoreSide;
  home: GameLinescoreSide;
}

/** KBO Schedule GetScoreBoard 응답의 공용 이닝표 파서. game-detail과 summary가 같은 계약을 쓴다. */
export function parseGameLinescoreResponse(data: unknown): GameLinescore | null {
  if (!Array.isArray(data) || data.length < 2 || !data[1]) return null;
  const meta = Array.isArray(data[0]) && data[0].length > 0 ? data[0][0] : null;
  const cancelName = String(meta?.CANCEL_SC_NM ?? "");
  const status: GameLinescore["status"] =
    cancelName.includes("취소") || cancelName.includes("우천")
      ? "cancelled"
      : String(meta?.END_TM ?? "").trim()
        ? "final"
        : Number(meta?.T_SCORE_CN ?? 0) > 0 || Number(meta?.B_SCORE_CN ?? 0) > 0
          ? "live"
          : "scheduled";

  let parsed: { rows?: { row: { Text: string }[] }[] };
  try {
    const raw = Array.isArray(data[1]) && data[1].length > 0 ? data[1][0] : data[1];
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed?.rows || parsed.rows.length < 2) return null;

  function parseRow(row: { Text: string }[]): GameLinescoreSide {
    const cells = row.map((cell) => bsSafeStr(cell.Text));
    // 검증된 game-detail 계약: 앞 2칸(승패/팀), 뒤 4칸(R/H/E/BB)을 제외한다.
    const innings = cells.slice(2, cells.length - 4).map((value) => {
      const stripped = bsStripHtml(value);
      if (!stripped || stripped === "-") return null;
      return bsSafeInt(stripped);
    });
    const tail = cells.slice(cells.length - 4);
    return {
      innings,
      R: bsSafeInt(bsStripHtml(tail[0] ?? "")),
      H: bsSafeInt(bsStripHtml(tail[1] ?? "")),
      E: bsSafeInt(bsStripHtml(tail[2] ?? "")),
    };
  }

  const awayRow = parsed.rows[0]?.row;
  const homeRow = parsed.rows[1]?.row;
  if (!awayRow || !homeRow) return null;
  return { status, away: parseRow(awayRow), home: parseRow(homeRow) };
}

function bsSafeInt(v: unknown): number {
  if (v == null || v === "" || v === "&nbsp;") return 0;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? 0 : n;
}

function bsSafeStr(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "&nbsp;" ? "" : s;
}

function bsStripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

export const BS_POS_MAP: Record<string, string> = {
  "투수": "P", "포수": "C", "1루수": "1B", "2루수": "2B",
  "3루수": "3B", "유격수": "SS", "좌익수": "LF", "중견수": "CF",
  "우익수": "RF", "지명타자": "DH",
  "타지": "DH", "타좌": "LF", "타우": "RF", "타중": "CF",
  "타1": "1B", "타2": "2B", "타3": "3B", "타유": "SS", "타포": "C",
  "주좌": "LF", "주우": "RF", "주중": "CF", "주1": "1B", "주2": "2B", "주3": "3B", "주유": "SS",
  "대타": "DH", "대주": "DH",
};

export function parseBoxScore(data: unknown): BoxScoreResult | null {
  const obj = data as { tables?: unknown[]; code?: string };
  if (!obj?.tables || !Array.isArray(obj.tables) || obj.tables.length < 5) return null;

  // Parse stolen bases from key plays table (table[0])
  const sbMap = new Map<string, number>();
  const keyPlaysTable = obj.tables[0] as { rows?: { row: { Text: string }[] }[] };
  if (keyPlaysTable?.rows) {
    for (const r of keyPlaysTable.rows) {
      const cells = r.row.map(c => bsSafeStr(c.Text));
      if (bsStripHtml(cells[0]) === "도루") {
        const text = bsStripHtml(cells[1] || "");
        const matches = text.matchAll(/([가-힣]+?)(\d*)\(/g);
        for (const m of matches) {
          const name = m[1];
          const count = m[2] ? parseInt(m[2]) : 1;
          sbMap.set(name, (sbMap.get(name) || 0) + count);
        }
      }
    }
  }

  function parseBatters(table: { rows?: { row: { Text: string }[] }[] }, sbLookup: Map<string, number>): BoxScoreBatterRecord[] {
    if (!table?.rows) return [];
    let prevOrder = -1;
    return table.rows.map(r => {
      const cells = r.row.map(c => bsSafeStr(c.Text));
      const tail = cells.slice(cells.length - 5);
      const atBatResults = cells.slice(3, cells.length - 5).map(c => bsStripHtml(c)).filter(c => c && c !== "&nbsp;");

      let hr = 0, bb = 0, so = 0;
      for (const ab of atBatResults) {
        if (ab.includes("홈")) hr++;
        if (ab === "4구") bb++;
        if (ab.includes("삼진")) so++;
      }

      const order = bsSafeInt(bsStripHtml(cells[0]));
      const posRaw = bsStripHtml(cells[1] || "");
      const isSubstitute = order === prevOrder || posRaw.startsWith("타") || posRaw.startsWith("주") || posRaw.startsWith("대");
      prevOrder = order;

      return {
        order,
        position: BS_POS_MAP[posRaw] || posRaw,
        name: bsStripHtml(cells[2] || ""),
        atBats: bsSafeInt(bsStripHtml(tail[0])),
        hits: bsSafeInt(bsStripHtml(tail[1])),
        rbi: bsSafeInt(bsStripHtml(tail[2])),
        runs: bsSafeInt(bsStripHtml(tail[3])),
        hr,
        bb,
        so,
        sb: sbLookup.get(bsStripHtml(cells[2] || "")) || 0,
        avg: bsStripHtml(tail[4]) || ".000",
        isSubstitute,
      };
    }).filter(b => b.name !== "").map(b => {
      if (/^\d+$/.test(b.name)) {
        const player = findPlayerByNumericId(b.name);
        b.name = player ? player.name : `선수(${b.name.slice(-3)})`;
      }
      return b;
    });
  }

  function parsePitchers(table: { rows?: { row: { Text: string }[] }[] }): BoxScorePitcherRecord[] {
    if (!table?.rows) return [];
    return table.rows.map(r => {
      const cells = r.row.map(c => bsSafeStr(c.Text));
      const ip = bsStripHtml(cells[6] || "");
      return {
        name: bsStripHtml(cells[0] || ""),
        inningsPitched: ip,
        decision: bsStripHtml(cells[2] || ""),
        pitchCount: bsSafeInt(bsStripHtml(cells[8])),
        hits: bsSafeInt(bsStripHtml(cells[10])),
        hr: bsSafeInt(bsStripHtml(cells[11])),
        walks: bsSafeInt(bsStripHtml(cells[12])),
        strikeouts: bsSafeInt(bsStripHtml(cells[13])),
        runs: bsSafeInt(bsStripHtml(cells[14])),
        earnedRuns: bsSafeInt(bsStripHtml(cells[15])),
        era: bsStripHtml(cells[16] || "") || "0.00",
      };
    }).filter(p => p.name !== "").map(p => {
      if (/^\d+$/.test(p.name)) {
        const player = findPlayerByNumericId(p.name);
        p.name = player ? player.name : `선수(${p.name.slice(-3)})`;
      }
      return p;
    });
  }

  const tables = obj.tables as { rows?: { row: { Text: string }[] }[] }[];

  return {
    awayBatters: parseBatters(tables[1], sbMap),
    homeBatters: parseBatters(tables[2], sbMap),
    awayPitchers: parsePitchers(tables[3]),
    homePitchers: parsePitchers(tables[4]),
  };
}

/**
 * BoxScore 조회의 공용 absolute deadline 예산(ms).
 * KBO GetBoxScore sub-budget + Naver failover reserve. KBO 무응답/느린 body 로 예산을
 * 전소진해 Naver 진입 전에 끝나던 하드코딩 10s(삼순 NO-GO: 실측 10,013ms)를 막는다.
 * KBO 는 자기 sub-budget(BOXSCORE_KBO_TIMEOUT_MS) 안에서만 끊고, 남은 시간(최소 reserve)을
 * Naver 에 넘겨 response/body stall·dual-fail 을 결정적으로 종료시킨다.
 */
export const BOXSCORE_KBO_TIMEOUT_MS = 6000;
export const BOXSCORE_NAVER_TIMEOUT_MS = 2500;

/** BoxScore 조회 (특정 경기) */
export async function fetchBoxScore(
  gameId: string,
  seasonId?: string,
  opts?: { kboTimeoutMs?: number; naverTimeoutMs?: number },
): Promise<BoxScoreResult | null> {
  const kboBudget = opts?.kboTimeoutMs ?? BOXSCORE_KBO_TIMEOUT_MS;
  const naverReserve = opts?.naverTimeoutMs ?? BOXSCORE_NAVER_TIMEOUT_MS;
  // 공용 absolute deadline: KBO sub-budget + Naver reserve. KBO 가 자기 예산을 다 써도
  // Naver 는 최소 naverReserve 를 확보한다(deadline - now ≥ reserve).
  const deadline = Date.now() + kboBudget + naverReserve;
  const naverBudget = () => Math.max(0, deadline - Date.now());
  const failoverToNaver = async () => {
    const { fetchNaverBoxScore } = await import("@/lib/crawler/naver-record");
    return await fetchNaverBoxScore(gameId, { timeoutMs: naverBudget() });
  };
  try {
    const sid = seasonId || new Date().getFullYear().toString();
    const body = `leId=1&srId=0&seasonId=${sid}&gameId=${gameId}`;
    const res = await fetch(`${KBO_SCHEDULE_BASE}/GetBoxScore`, {
      method: "POST",
      headers: SCHEDULE_HEADERS,
      body,
      // KBO sub-budget 으로 response+body stall 을 함께 bound (같은 signal 이 res.json() 도 중단).
      signal: AbortSignal.timeout(Math.min(kboBudget, naverBudget() || kboBudget)),
    });

    if (!res.ok) {
      // 관제는 fire-and-forget: durable insert·이벤트 카운트(동기 부수효과)는 그대로 실행하되,
      // 임계치 초과 시 legacy Telegram alert 의 timeout 없는 fetch 를 await 하지 않는다.
      // (await 하면 fetchBoxScore 공용 absolute deadline 을 관제가 깨고 Naver failover 를 블록.)
      void trackFallback("kbo-boxscore", "http-error", {
        statusCode: res.status,
        errorMessage: `HTTP ${res.status} ${res.statusText}`,
      }).catch(() => {});
      // KBO 하드실패 → Naver record boxscore 로 failover (summary·daily 공용).
      return await failoverToNaver();
    }

    const data = await res.json();
    const parsed = parseBoxScore(data);
    if (!parsed) {
      // KBO 응답 파싱 실패(스키마 열화) → Naver failover. 관제는 응답 경로를 블록하지 않게 fire-and-forget.
      void trackFallback("kbo-boxscore", "schema-error", {
        errorMessage: "parseBoxScore returned null",
      }).catch(() => {});
      return await failoverToNaver();
    }
    return parsed;
  } catch (e) {
    const error = e as Error;
    let reason: "timeout" | "http-error" | "schema-error" | "network-error" = "network-error";
    if (error.name === "TimeoutError" || error.name === "AbortError" || error.message.includes("timeout")) {
      reason = "timeout";
    } else if (error.message.includes("HTTP")) {
      reason = "http-error";
    } else if (error.message.includes("JSON")) {
      reason = "schema-error";
    }

    // 관제 fire-and-forget: 남은 reserve 를 관제가 소진하지 않도록 await 제거(부수효과는 유지).
    void trackFallback("kbo-boxscore", reason, {
      errorMessage: error.message,
    }).catch(() => {});

    // KBO throw(timeout/network/response·body stall 등) → 남은 reserve 안에서 Naver failover.
    return await failoverToNaver();
  }
}

/** 이닝별 스코어 조회 (특정 경기). 종료 직후 빈 이닝표면 null을 반환해 settle 재시도를 유도한다. */
export async function fetchGameLinescore(gameId: string, seasonId?: string): Promise<GameLinescore | null> {
  try {
    const sid = seasonId || gameId.slice(0, 4);
    const body = `leId=1&srId=0&seasonId=${sid}&gameId=${gameId}`;
    const res = await fetch(`${KBO_SCHEDULE_BASE}/GetScoreBoard`, {
      method: "POST",
      headers: SCHEDULE_HEADERS,
      body,
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!res.ok) return null;

    const data = await res.json();
    const linescore = parseGameLinescoreResponse(data);
    if (!linescore) return null;
    const hasInningBreakdown =
      linescore.away.innings.some((value) => value !== null) ||
      linescore.home.innings.some((value) => value !== null);
    return hasInningBreakdown ? linescore : null;
  } catch {
    return null;
  }
}

export interface PlayerBattingStat {
  rank: number;
  name: string;
  team: string;
  avg: number;
  games: number;
  pa: number;
  ab: number;
  runs: number;
  hits: number;
  doubles: number;
}

/** 타자 기록 (HTML 파싱) */
export async function fetchBatterStats(): Promise<PlayerBattingStat[]> {
  const res = await fetch(`${KBO_BASE}/Record/Player/HitterBasic/Basic1.aspx`, { headers: KBO_HTML_HEADERS });
  const html = await res.text();

  const rows = html.match(/<tr[^>]*>(.*?)<\/tr>/g) ?? [];
  const stats: PlayerBattingStat[] = [];

  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>(.*?)<\/td>/g) ?? [])
      .map(c => c.replace(/<[^>]+>/g, "").trim());

    if (cells.length >= 10 && /^\d+$/.test(cells[0])) {
      stats.push({
        rank: parseInt(cells[0]),
        name: cells[1],
        team: cells[2],
        avg: parseFloat(cells[3]) || 0,
        games: parseInt(cells[4]) || 0,
        pa: parseInt(cells[5]) || 0,
        ab: parseInt(cells[6]) || 0,
        runs: parseInt(cells[7]) || 0,
        hits: parseInt(cells[8]) || 0,
        doubles: parseInt(cells[9]) || 0,
      });
    }
  }

  return stats;
}

/* ===== 선수 등록 현황 (1군 로스터 스냅샷) ===== */
// 2026-07-18: 팀별 선수 등록/말소 내역 기능. Register.aspx는 ASP.NET WebForms —
// 최초 GET으로 폼 토큰(__VIEWSTATE 등)을 얻고, 구단 탭 전환은 hfSearchTeam을 바꿔
// btnCalendarSelect postback으로 요청한다(실측 확인: 동일 __VIEWSTATE로 10개 구단 순회 가능).
const REGISTER_URL = `${KBO_BASE}/Player/Register.aspx`;
const REGISTER_POSTBACK_TARGET = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$btnCalendarSelect";
const REGISTER_TEAM_FIELD = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchTeam";
const REGISTER_DATE_FIELD = "ctl00$ctl00$ctl00$cphContents$cphContents$cphContents$hfSearchDate";
const REGISTER_DATE_HIDDEN_ID = "cphContents_cphContents_cphContents_hfSearchDate";
export const REGISTER_COLLECTION_DEADLINE_MS = 30_000;

export interface TeamRosterSnapshot {
  teamId: number;
  teamCode: string;
  entries: RosterEntry[];
}

export interface RegisterRosters {
  /** KBO 기준 등록명단 일자 (YYYYMMDD). */
  date: string;
  teams: TeamRosterSnapshot[];
}

function extractRegisterHidden(html: string, id: string): string {
  const m = html.match(new RegExp(`id="${id}" value="([^"]*)"`));
  return m ? m[1] : "";
}

async function fetchRegisterPage(
  label: string,
  init: RequestInit,
  deadlineAtMs: number,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; html: string }> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new RosterCollectionError(`${label} absolute deadline exceeded`);
  }
  try {
    const response = await runBeforeDeadline(
      () => fetchImpl(REGISTER_URL, {
        ...init,
        signal: AbortSignal.timeout(Math.max(1, remainingMs)),
      }),
      deadlineAtMs,
    );
    const html = await runBeforeDeadline(() => response.text(), deadlineAtMs);
    return { response, html };
  } catch {
    throw new RosterCollectionError(`${label} absolute deadline exceeded`);
  }
}

/**
 * 10개 구단 1군 등록명단 스냅샷을 GET 1 + 구단별 POST 10회로 수집.
 * 실패를 조용히 성공으로 묻지 않는다(삼순 P1): HTTP status/WebForms 토큰/날짜/인원수를
 * 검증하고 하나라도 실패하면 RosterCollectionError를 throw한다(호출측 cron이 fail-closed).
 */
export async function fetchRegisterRosters(opts?: {
  deadlineAtMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<RegisterRosters> {
  const deadlineAtMs = opts?.deadlineAtMs ?? Date.now() + REGISTER_COLLECTION_DEADLINE_MS;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const { response: initRes, html: initHtml } = await fetchRegisterPage(
    "Register.aspx GET",
    { headers: { ...KBO_HTML_HEADERS, Referer: REGISTER_URL } },
    deadlineAtMs,
    fetchImpl,
  );
  if (!initRes.ok) {
    throw new RosterCollectionError(`Register.aspx GET HTTP ${initRes.status}`);
  }
  const viewState = extractRegisterHidden(initHtml, "__VIEWSTATE");
  const viewStateGen = extractRegisterHidden(initHtml, "__VIEWSTATEGENERATOR");
  const eventValidation = extractRegisterHidden(initHtml, "__EVENTVALIDATION");
  const date = extractRegisterHidden(initHtml, REGISTER_DATE_HIDDEN_ID);
  // WebForms 폼 토큰 추출 실패(마크업 변경/차단) = 명시 에러 — postback이 무의미해진다.
  if (!viewState || !eventValidation) {
    throw new RosterCollectionError("Register.aspx 폼 토큰(__VIEWSTATE/__EVENTVALIDATION) 추출 실패");
  }
  if (!/^\d{8}$/.test(date)) {
    throw new RosterCollectionError(`Register.aspx 등록명단 날짜 추출 이상: "${date}"`);
  }

  const teams: TeamRosterSnapshot[] = [];
  for (const [code, teamId] of Object.entries(TEAM_CODE_MAP)) {
    const body = new URLSearchParams({
      __EVENTTARGET: REGISTER_POSTBACK_TARGET,
      __EVENTARGUMENT: "",
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewStateGen,
      __EVENTVALIDATION: eventValidation,
      [REGISTER_TEAM_FIELD]: code,
      [REGISTER_DATE_FIELD]: date,
    });
    const { response: res, html } = await fetchRegisterPage(
      `Register.aspx POST team ${code}`,
      {
      method: "POST",
      headers: {
        ...KBO_HTML_HEADERS,
        Referer: REGISTER_URL,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      },
      deadlineAtMs,
      fetchImpl,
    );
    if (!res.ok) {
      throw new RosterCollectionError(`Register.aspx POST HTTP ${res.status} (team ${code})`);
    }
    teams.push({ teamId, teamCode: code, entries: parseTeamRegister(html) });
  }

  // 10구단/팀당 인원 sanity — 0명/부분 수집을 성공으로 넣지 않는다.
  const sanity = validateRosterCollection(date, teams);
  if (sanity) {
    throw new RosterCollectionError(sanity);
  }

  return { date, teams };
}
